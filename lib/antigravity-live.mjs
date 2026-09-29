// Talking to Antigravity: model quotas, starting conversations, sending
// messages. It uses a local language server — either the running app's own
// (found from its process: the command line carries a CSRF token, and it
// listens on two loopback ports — HTTPS for the Connect API, gRPC for the
// `agentapi` CLI)… or one pi-web starts itself, headless, with the same flags
// the app uses (decoded by the motion-studio bridge). So chatting works even
// when the app is closed: the first message spawns the server on demand.
// Nothing here is stored; the token is re-read whenever the app restarts.

import { execFile, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import https from "node:https";

const IS_WIN = process.platform === "win32";

// pi-web's own headless language server. The CSRF token matches the
// motion-studio bridge's on purpose: one running server serves both, whoever
// started it. Detached on purpose: it outlives pi-web and is picked up again by
// the normal discovery on the next start.
const HEADLESS = {
	httpsPort: Number(process.env.PI_WEB_AGY_HEADLESS_PORT) || 5387,
	csrf: "studio-local-token",
};

function netstatText() {
	const exe = IS_WIN ? "netstat" : "/mnt/c/Windows/System32/netstat.exe";
	try {
		const r = spawnSync(exe, ["-ano"], { timeout: 8000, encoding: "utf8", windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
		return String(r.stdout || "");
	} catch {
		return "";
	}
}

/** Loopback LISTENING rows: [{port, pid}]. */
function listeningRows() {
	const rows = [];
	for (const line of netstatText().split("\n").map((l) => l.trim())) {
		const m = /^TCP\s+127\.0\.0\.1:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/.exec(line);
		if (m) rows.push({ port: Number(m[1]), pid: Number(m[2]) });
	}
	return rows;
}

function run(file, args, { env, timeout = 20_000 } = {}) {
	return new Promise((resolve, reject) => {
		execFile(file, args, { env, timeout, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
			if (err && !stdout) reject(new Error(String(stderr || err.message).trim()));
			else resolve(String(stdout));
		});
	});
}

function toWslPath(p) {
	const m = /^([a-zA-Z]):[\\/](.*)$/.exec(p || "");
	return m && !IS_WIN ? `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, "/")}` : p;
}

const DISCOVER = [
	"$p = Get-CimInstance Win32_Process -Filter \"Name='language_server.exe'\" | Where-Object { $_.CommandLine -match 'antigravity' } | Select-Object -First 1",
	"if (-not $p) { '{}'; exit }",
	"$ports = @(Get-NetTCPConnection -OwningProcess $p.ProcessId -State Listen -ErrorAction SilentlyContinue | ForEach-Object LocalPort | Sort-Object -Unique)",
	"[pscustomobject]@{ pid = $p.ProcessId; exe = $p.ExecutablePath; cmd = $p.CommandLine; ports = $ports } | ConvertTo-Json -Compress",
].join("; ");

function postJson(port, path, csrf, body) {
	return new Promise((resolve, reject) => {
		const data = JSON.stringify(body);
		const req = https.request(
			{
				host: "127.0.0.1",
				port,
				path,
				method: "POST",
				rejectUnauthorized: false, // the app's own self-signed loopback certificate
				timeout: 8000,
				headers: {
					"Content-Type": "application/json",
					"Connect-Protocol-Version": "1",
					"X-Codeium-Csrf-Token": csrf,
					"Content-Length": Buffer.byteLength(data),
				},
			},
			(res) => {
				const chunks = [];
				res.on("data", (c) => chunks.push(c));
				res.on("end", () => {
					const text = Buffer.concat(chunks).toString("utf8");
					if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
					try {
						resolve(JSON.parse(text));
					} catch {
						reject(new Error("unexpected response"));
					}
				});
			},
		);
		req.on("timeout", () => req.destroy(new Error("timed out")));
		req.on("error", reject);
		req.end(data);
	});
}

export class AntigravityLive {
	constructor({ index }) {
		this.index = index;
		this.conn = null; // { pid, exe, csrf, httpsPort, grpcAddr }
		this.checkedAt = 0;
		this.quotaCache = null;
		this.pending = null;
	}

	// ── pi-web's own headless language server ────────────────────────────────

	/** The installed language server, or null. */
	headlessExe() {
		const dir = this.index?.dir;
		if (!dir) return null;
		const home = path.dirname(path.dirname(dir)); // ~/.gemini/antigravity → the user folder
		for (const name of ["antigravity", "Antigravity"]) {
			const p = path.join(home, "AppData", "Local", "Programs", name, "resources", "bin", "language_server.exe");
			if (fs.existsSync(p)) return p;
		}
		return null;
	}

	/** A connection for a server we know the token of: probe its ports, find
	 *  the Connect (HTTPS) one, the other is agentapi's gRPC. */
	async connFromPid(pid, exe, csrf) {
		const ports = [...new Set(listeningRows().filter((r) => r.pid === pid).map((r) => r.port))];
		for (const p of ports) {
			try {
				await postJson(p, "/exa.language_server_pb.LanguageServerService/GetUserStatus", csrf, { metadata: { ideName: "antigravity" } });
				const grpcPort = ports.find((x) => x !== p) ?? p;
				return { pid, exe, csrf, httpsPort: p, grpcAddr: `127.0.0.1:${grpcPort}` };
			} catch {
				// not the Connect port
			}
		}
		return null;
	}

	/** Start (or adopt) the headless language server; resolves with its
	 *  connection. Concurrent callers share one start. */
	async ensureHeadless() {
		this.starting ??= this.startHeadless().finally(() => (this.starting = null));
		return this.starting;
	}

	async startHeadless() {
		// Already holding a headless connection (ours or the studio bridge's —
		// same token)? Keep it.
		if (this.conn?.csrf === HEADLESS.csrf && this.conn.pid && listeningRows().some((r) => r.pid === this.conn.pid && r.port === this.conn.httpsPort)) return this.conn;
		const exe = this.headlessExe();
		if (!exe) throw Object.assign(new Error("Antigravity's language server was not found (looked in AppData/Local/Programs)."), { status: 404 });
		const port = HEADLESS.httpsPort;
		const owner = listeningRows().find((r) => r.port === port)?.pid;
		if (owner) {
			// Something already owns the port — a headless server from an earlier
			// run (ours or the studio's, same token). Adopt it if it answers.
			const conn = await this.connFromPid(owner, exe, HEADLESS.csrf);
			if (conn) {
				this.conn = conn;
				this.checkedAt = Date.now();
				return conn;
			}
			throw Object.assign(new Error(`Another server owns port ${port} and did not accept pi-web's Antigravity token.`), { status: 409 });
		}
		// Spawn with the app's own flags (the recipe the motion-studio bridge
		// decoded and proved), detached, logging to pi-web's cache.
		const log = path.join(os.homedir(), ".cache", "pi-web", "agy-headless.log");
		fs.mkdirSync(path.dirname(log), { recursive: true });
		const home = path.dirname(path.dirname(this.index.dir));
		const fd = fs.openSync(log, "a");
		try {
			const child = spawn(exe, [
				"--standalone", "--override_ide_name", "antigravity", "--subclient_type", "hub",
				"--override_ide_version", "1.0.0", "--override_user_agent_name", "antigravity",
				"--https_server_port", String(port), "--csrf_token", HEADLESS.csrf, "--app_data_dir", "antigravity",
				"--api_server_url", "https://generativelanguage.googleapis.com",
				"--cloud_code_endpoint", "https://daily-cloudcode-pa.googleapis.com",
				"--enable_sidecars", "--headless",
			], { cwd: home, env: { ...process.env, HOME: home, USERPROFILE: home }, detached: true, stdio: ["ignore", fd, fd] });
			child.unref();
		} finally {
			fs.closeSync(fd);
		}
		const until = Date.now() + 25_000;
		while (Date.now() < until) {
			await new Promise((r) => setTimeout(r, 700));
			const pid = listeningRows().find((r) => r.port === port)?.pid;
			if (pid) {
				const conn = await this.connFromPid(pid, exe, HEADLESS.csrf);
				if (conn) {
					this.conn = conn;
					this.checkedAt = Date.now();
					return conn;
				}
			}
		}
		throw Object.assign(new Error("The headless Antigravity server did not start in time — see ~/.cache/pi-web/agy-headless.log"), { status: 502 });
	}

	/** The running app's connection details, or null when Antigravity isn't open. */
	async connection({ fresh = false } = {}) {
		if (!fresh && this.conn && Date.now() - this.checkedAt < 15_000) return this.conn;
		this.pending ??= this.discover().finally(() => (this.pending = null));
		return this.pending;
	}

	async discover() {
		this.checkedAt = Date.now();
		let info;
		try {
			const out = await run(IS_WIN ? "powershell.exe" : "powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", DISCOVER]);
			info = JSON.parse(out.trim() || "{}");
		} catch {
			info = {};
		}
		if (!info.pid) {
			this.conn = null;
			return null;
		}
		if (this.conn?.pid === info.pid) return this.conn;
		const csrf = /--csrf_token[= ](\S+)/.exec(info.cmd || "")?.[1];
		const ports = Array.isArray(info.ports) ? info.ports : [info.ports].filter(Boolean);
		if (!csrf || !ports.length) {
			this.conn = null;
			return null;
		}
		// The HTTPS port answers the Connect API; the other one is gRPC for agentapi.
		let httpsPort;
		for (const port of ports) {
			try {
				await postJson(port, "/exa.language_server_pb.LanguageServerService/GetUserStatus", csrf, { metadata: { ideName: "antigravity" } });
				httpsPort = port;
				break;
			} catch {
				// not this one
			}
		}
		const grpcPort = ports.find((p) => p !== httpsPort) ?? httpsPort;
		this.conn = { pid: info.pid, exe: toWslPath(info.exe), csrf, httpsPort, grpcAddr: `127.0.0.1:${grpcPort}` };
		return this.conn;
	}

	/** Plan name and per-model quota; never the account's name or email. */
	async quota({ force = false } = {}) {
		if (!force && this.quotaCache && Date.now() - this.quotaCache.at < 45_000) return this.quotaCache.value;
		let value;
		const conn = await this.connection();
		if (!conn?.httpsPort) {
			value = { available: false, running: !!conn, reason: conn ? "Antigravity is starting…" : "Antigravity isn't open." };
		} else {
			try {
				const body = await postJson(conn.httpsPort, "/exa.language_server_pb.LanguageServerService/GetUserStatus", conn.csrf, { metadata: { ideName: "antigravity" } });
				const status = body?.userStatus || {};
				const models = (status.cascadeModelConfigData?.clientModelConfigs || [])
					.filter((m) => m.quotaInfo)
					.map((m) => ({
						label: m.label,
						modelId: m.modelId,
						remaining: typeof m.quotaInfo.remainingFraction === "number" ? m.quotaInfo.remainingFraction : 1,
						resetsAt: m.quotaInfo.resetTime || null,
					}));
				value = { available: true, running: true, plan: status.planStatus?.planInfo?.planName, models };
			} catch (err) {
				this.conn = null; // app restarted or closed: rediscover next time
				value = { available: false, running: false, reason: `Could not reach Antigravity: ${err.message}` };
			}
		}
		value.fetchedAt = new Date().toISOString();
		this.quotaCache = { at: Date.now(), value };
		return value;
	}

	async agentapi(args, { projectId } = {}) {
		// PI_WEB_AGY_HEADLESS=1: always pi-web's own headless server, never the
		// app's. Otherwise: prefer a server that's already running (the app's,
		// or a headless one from an earlier run) and start one only if there is
		// none — so the first message just works, app or no app.
		let conn = process.env.PI_WEB_AGY_HEADLESS === "1" ? null : await this.connection({ fresh: true });
		if (!conn) conn = await this.ensureHeadless();
		if (!conn) throw Object.assign(new Error("No Antigravity server is running, and one could not be started."), { status: 409 });
		const env = {
			...process.env,
			ANTIGRAVITY_LS_ADDRESS: conn.grpcAddr,
			ANTIGRAVITY_CSRF_TOKEN: conn.csrf,
			...(projectId ? { ANTIGRAVITY_PROJECT_ID: projectId } : {}),
		};
		// WSL only forwards variables listed in WSLENV to Windows programs.
		if (!IS_WIN) env.WSLENV = [process.env.WSLENV, "ANTIGRAVITY_LS_ADDRESS", "ANTIGRAVITY_CSRF_TOKEN", projectId && "ANTIGRAVITY_PROJECT_ID"].filter(Boolean).join(":");
		const out = await run(conn.exe, ["agentapi", ...args], { env, timeout: 60_000 });
		let parsed;
		try {
			parsed = JSON.parse(out);
		} catch {
			throw new Error(`Antigravity answered unexpectedly: ${out.slice(0, 200)}`);
		}
		if (parsed.error) throw new Error(`Antigravity: ${parsed.error}`);
		return parsed.response || {};
	}

	/** The project new conversations belong to: the given one, else the most recently used. */
	projectId(preferred) {
		if (preferred) return preferred;
		const recent = this.index
			.list()
			.filter((m) => m.projectId)
			.sort((a, b) => (b.mtime || 0) - (a.mtime || 0))[0];
		return recent?.projectId;
	}

	async newConversation(prompt, { model = "flash", title, projectId } = {}) {
		const args = ["new-conversation", `--model=${model}`];
		if (title) args.push(`--title=${title}`);
		args.push(prompt);
		const res = await this.agentapi(args, { projectId: projectId || this.projectId() });
		const id = res.newConversation?.conversationId;
		if (!id) throw new Error("Antigravity did not return a conversation id.");
		return id;
	}

	async sendMessage(uuid, text, { projectId } = {}) {
		await this.agentapi(["send-message", uuid, text], { projectId: this.projectId(projectId) });
	}

	/** Open the Antigravity app (a Windows path such as C:\Users\me\AppData\Local\Programs\Antigravity\Antigravity.exe). */
	launch(windowsExe) {
		const child = spawn("cmd.exe", ["/c", "start", "", windowsExe], { detached: true, stdio: "ignore", cwd: IS_WIN ? undefined : "/mnt/c" });
		child.unref();
		this.conn = null;
		this.quotaCache = null;
	}
}

/** Where the Antigravity app is installed, derived from its data folder (…/Users/<me>/.gemini/antigravity). */
export function antigravityAppExe(dataDir) {
	const home = dataDir.replace(/[\\/]\.gemini[\\/]antigravity[\\/]?$/, "");
	const m = /^\/mnt\/([a-z])\/(.*)$/.exec(home);
	const windowsHome = m ? `${m[1].toUpperCase()}:\\${m[2].replace(/\//g, "\\")}` : home;
	const localExe = `${home}/AppData/Local/Programs/Antigravity/Antigravity.exe`;
	return { windows: `${windowsHome}\\AppData\\Local\\Programs\\Antigravity\\Antigravity.exe`, local: localExe };
}
