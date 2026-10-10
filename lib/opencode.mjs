// Talking to OpenCode (v2): browsing its sessions, reading them live, chatting,
// streaming replies, answering its forms and permission prompts.
//
// OpenCode runs on the Windows side as a background service ("opencode serve"
// / "opencode service start") with an HTTP API on loopback + SSE events. The
// service's URL and password live in %USERPROFILE%\.local\state\opencode\
// service.json — the same file the opencode CLI itself reads, so we never run
// a second server on this machine's mirrored-networking setup (WSL shares the
// host's 127.0.0.1). Sessions driven from the user's terminal flow through
// that service too, so events for them reach pi-web the same way.
//
// Everything OpenCode is converted into pi's own shapes on the way in:
// session metas like Antigravity's, message entries like pi's session files,
// live streaming events like pi's RPC protocol — so the whole front end
// (renderers, tool cards, live partials) works unchanged. IDs are prefixed
// "oc-" to keep them apart from pi sessions (like "agy-" conversations).

import { spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyEvent, createLive, messageKey } from "../public/js/live.js";

export const OC_PREFIX = "oc-";
export const isOcId = (id) => typeof id === "string" && id.startsWith(OC_PREFIX);
const IS_WIN = process.platform === "win32";
const SESSIONS_POLL_MS = 10_000; // safety net only — SSE delivers changes instantly
const FORMS_POLL_MS = 4000;
const MESSAGES_PAGE = 200; // the API caps message pages at 200

// ── finding OpenCode on the Windows side ─────────────────────────────────────

/** npm's global prefix on the Windows side: /mnt/c/Users/<user>/AppData/Roaming/npm (or null). */
function windowsNpmDir() {
	try {
		for (const drive of fs.readdirSync("/mnt")) {
			const users = path.join("/mnt", drive, "Users");
			let names = [];
			try {
				names = fs.readdirSync(users);
			} catch {
				continue;
			}
			for (const user of names) {
				const npm = path.join(users, user, "AppData", "Roaming", "npm");
				if (fs.existsSync(path.join(npm, "node_modules", "@opencode", "cli", "bin"))) return npm;
			}
		}
	} catch {
		// not WSL
	}
	return null;
}

/** The opencode binary. On Windows-from-WSL: the npm shim path; anywhere: PATH. */
export function findOpenCodeBin() {
	if (IS_WIN) return "opencode";
	const npm = windowsNpmDir();
	if (npm) {
		// The real binary, not the .cmd shim: spawn can't run the shim from WSL
		// (it's a batch file), but node can run the exe directly.
		const exe = path.join(npm, "node_modules", "@opencode", "cli", "bin", "opencode.exe");
		if (fs.existsSync(exe)) return exe;
	}
	const r = spawnSync("cmd.exe", ["/c", "where", "opencode"], { timeout: 8000, encoding: "utf8", windowsHide: true });
	const hit = String(r.stdout || "").split(/\r?\n/).find((l) => /\.exe$/i.test(l.trim()));
	return hit ? hit.trim() : null;
}

/** The Windows user folder that owns the opencode install (as a WSL path). */
export function findOpenCodeHome() {
	if (IS_WIN) return os.homedir();
	try {
		for (const drive of fs.readdirSync("/mnt")) {
			const users = path.join("/mnt", drive, "Users");
			let names = [];
			try {
				names = fs.readdirSync(users);
			} catch {
				continue;
			}
			for (const user of names) if (fs.existsSync(path.join(users, user, ".local", "state", "opencode"))) return path.join(users, user);
		}
	} catch {
		// not WSL
	}
	return null;
}

/** %USERPROFILE%\.local\state\opencode\service.json — the CLI's own record of the running service. */
function readServiceJson(home) {
	try {
		return JSON.parse(fs.readFileSync(path.join(home, ".local", "state", "opencode", "service.json"), "utf8"));
	} catch {
		return null;
	}
}

// ── paths ────────────────────────────────────────────────────────────────────

/** C:\Users\me\Desktop → /mnt/c/Users/me/Desktop (mirrored setups stay put). */
export function windowsToWsl(p) {
	if (typeof p !== "string") return p;
	if (IS_WIN) return p;
	const m = /^([a-zA-Z]):[\\/](.*)$/.exec(p);
	return m ? `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, "/")}` : p;
}

/** /mnt/c/Users/me/x → C:\Users\me\x; anything else passes through. */
export function wslToWindows(p) {
	if (typeof p !== "string") return p;
	if (IS_WIN) return p;
	const m = /^\/mnt\/([a-z])\/(.*)$/i.exec(p);
	return m ? `${m[1].toUpperCase()}:\\${m[2].replace(/\//g, "\\")}` : p;
}

// ── the API client ───────────────────────────────────────────────────────────

class ApiError extends Error {
	constructor(status, message) {
		super(message);
		this.status = status;
	}
}

/** One OpenCode server connection: base URL + Basic auth password. */
class Connection {
	constructor(base, password) {
		this.base = base;
		this.password = password;
		this.auth = "Basic " + Buffer.from(`opencode:${password}`).toString("base64");
	}
	toString() {
		return this.base;
	}
}

export class OpenCode extends EventEmitter {
	constructor({ bin, home, hasWatcher }) {
		super();
		this.bin = bin;
		this.home = home;
		// "is any page watching this session?" (set by the server). Without a
		// watcher there is nobody to broadcast entries to — refetching a whole
		// 200-message page per streaming step for an unwatched session is pure
		// waste (the next open refetches fresh).
		this.hasWatcher = hasWatcher;
		this.conn = null; // Connection
		this.version = null;
		this.starting = null; // shared in-flight ensure()
		this.metas = new Map(); // ocId -> meta (decorated, kind "opencode")
		this.children = new Map(); // parentOcId -> [childOcId] (subagent sessions)
		this.entries = new Map(); // ocId -> { at, list } converted pi-style entries
		this.partIndexes = new Map(); // "ocId:msgId" -> streamed-part slot allocator (see partSlot)
		this.toolNames = new Map(); // tool call id -> tool name (input.started knows it; later events don't)
		this.dirty = new Set(); // ocIds whose messages changed, refetched lazily
		this.usage = new Map(); // assistantMessageID -> { tokens, cost } (step.ended carries them; the stored message does not)
		this.live = new Map(); // ocId -> pi-style live state (public/js/live.js)
		this.stepUsage = new Map(); // ocId -> current step's usage (for message_end)
		this.forms = new Map(); // formID -> form (pending)
		this.permissions = new Map(); // requestID -> request (pending)
		this.aborted = new Set(); // conn resets, for in-flight fetches
		this.sessionFetchTimer = null;
	}

	// ── connection ─────────────────────────────────────────────────────────

	/** GET /api/info against a candidate connection — cheap liveness probe. */
	async probe(conn, timeout = 2500) {
		try {
			const info = await this.fetchJson(conn, "/api/info", { timeout });
			return info?.version ? info : null;
		} catch {
			return null;
		}
	}

	/** A working connection, starting the background service if needed. */
	async ensure() {
		if (this.conn && (await this.probe(this.conn, 1500))) return this.conn;
		this.conn = null;
		this.starting ??= this.start().finally(() => (this.starting = null));
		return this.starting;
	}

	async start() {
		// 1. The background service the user's own CLI uses (its password is in
		//    service.json). Mirrored networking lets WSL reach it on 127.0.0.1;
		//    on NAT machines the vEthernet host is tried before giving up on it.
		const svc = this.home ? readServiceJson(this.home) : null;
		if (svc?.url && svc.password) {
			const candidates = IS_WIN ? [svc.url] : [svc.url.replace(/\/\/127\.0\.0\.1/, `//${hostCandidate()}`), svc.url];
			for (const base of new Set(candidates)) {
				const conn = new Connection(base, svc.password);
				const info = await this.probe(conn);
				if (info) return this.adopt(conn, info);
			}
		}
		// 2. Start the background service ourselves (what `opencode` does before
		//    its first command; it daemonizes and writes service.json).
		if (this.bin) {
			await this.runCli(["service", "start"]);
			for (let i = 0; i < 20; i++) {
				await new Promise((r) => setTimeout(r, 800));
				const svc2 = this.home ? readServiceJson(this.home) : null;
				if (svc2?.url && svc2.password) {
					const conn = new Connection(svc2.url, svc2.password);
					const info = await this.probe(conn);
					if (info) return this.adopt(conn, info);
				}
			}
		}
		// 3. No shared service reachable (NAT-mode WSL, or a headless Windows
		//    box): run our own serve bound to the WSL-facing host only, like the
		//    Antigravity headless server. Never 0.0.0.0 — that would put an
		//    agent-driving API on the LAN.
		if (this.bin && !IS_WIN) {
			const host = hostCandidate();
			if (!host) throw new ApiError(503, "OpenCode was found, but this WSL has no reachable Windows host address.");
			const port = Number(process.env.PI_WEB_OPENCODE_PORT) || 4196;
			const log = path.join(os.homedir(), ".cache", "pi-web", "opencode-serve.log");
			fs.mkdirSync(path.dirname(log), { recursive: true });
			const fd = fs.openSync(log, "a");
			try {
				const child = spawn(this.bin, ["serve", "--hostname", host, "--port", String(port)], { detached: true, stdio: ["ignore", fd, fd] });
				child.unref();
			} finally {
				fs.closeSync(fd);
			}
			for (let i = 0; i < 15; i++) {
				await new Promise((r) => setTimeout(r, 1000));
				const password = /^server password (\S+)$/m.exec(fs.readFileSync(log, "utf8").slice(-4000))?.[1];
				if (password) {
					const conn = new Connection(`http://${host}:${port}`, password);
					const info = await this.probe(conn);
					if (info) return this.adopt(conn, info);
				}
			}
			throw new ApiError(502, "OpenCode's server did not start in time — see ~/.cache/pi-web/opencode-serve.log");
		}
		throw new ApiError(504, "No OpenCode server is running, and one could not be started.");
	}

	adopt(conn, info) {
		this.conn = conn;
		this.version = info.version;
		this.emit("connected");
		return conn;
	}

	/** Run the opencode CLI on the Windows side; resolve when it exits. */
	runCli(args, timeout = 30000) {
		return new Promise((resolve) => {
			const file = IS_WIN ? this.bin : this.bin.endsWith(".exe") ? this.bin : "cmd.exe";
			const argv = IS_WIN || this.bin.endsWith(".exe") ? args : ["/c", this.bin.replace(/\//g, "\\"), ...args];
			try {
				const child = spawn(file, argv, { detached: true, stdio: "ignore", windowsHide: true });
				child.on("error", () => resolve(null));
				const timer = setTimeout(() => {
					child.kill();
					resolve(null);
				}, timeout);
				child.on("exit", () => {
					clearTimeout(timer);
					resolve(null);
				});
				if (child.pid) child.unref();
			} catch {
				resolve(null);
			}
		});
	}

	/** JSON request/response against a known connection. */
	fetchJson(conn, apiPath, { method = "GET", body, timeout = 20000 } = {}) {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeout);
		return fetch(`${conn.base}${apiPath}`, {
			method,
			headers: { Authorization: conn.auth, ...(body !== undefined ? { "Content-Type": "application/json" } : {}), Accept: "application/json" },
			body: body !== undefined ? JSON.stringify(body) : undefined,
			signal: controller.signal,
		})
			.then(async (res) => {
				const text = await res.text();
				let data = null;
				try {
					data = text ? JSON.parse(text) : null;
				} catch {
					// HTML error page or empty body
				}
				if (!res.ok) throw new ApiError(res.status, data?.message || data?.error || `OpenCode answered HTTP ${res.status}`);
				return data;
			})
			.finally(() => clearTimeout(timer));
	}

	/** Request against the live connection, (re)ensuring it exists. */
	async api(apiPath, opts = {}) {
		const conn = await this.ensure();
		try {
			return await this.fetchJson(conn, apiPath, opts);
		} catch (err) {
			if (err?.name === "AbortError" || err?.name === "TypeError" || err?.status >= 500) {
				// The service went away (user stopped it, or it was replaced):
				// drop the connection so the next call re-ensures.
				this.conn = null;
			}
			throw err;
		}
	}

	// ── lifecycle ──────────────────────────────────────────────────────────

	async begin() {
		await this.refreshSessions(true);
		this.subscribe();
		this.sessionFetchTimer = setInterval(() => this.refreshSessions().catch(() => {}), SESSIONS_POLL_MS);
		this.sessionFetchTimer.unref?.();
		this.formsTimer = setInterval(() => this.pollPending().catch(() => {}), FORMS_POLL_MS);
		this.formsTimer.unref?.();
	}

	async stop() {
		clearInterval(this.sessionFetchTimer);
		clearInterval(this.formsTimer);
		this.es?.abort();
	}

	// ── events ──────────────────────────────────────────────────────────────

	/** SSE subscription to /api/event, reconnected forever with backoff. */
	subscribe() {
		this.es?.abort();
		const controller = new AbortController();
		this.es = controller;
		const run = async () => {
			while (!controller.signal.aborted) {
				const conn = this.conn;
				if (!conn) {
					await new Promise((r) => setTimeout(r, 2000));
					continue;
				}
				try {
					const res = await fetch(`${conn.base}/api/event`, { headers: { Authorization: conn.auth, Accept: "text/event-stream" }, signal: controller.signal });
					if (!res.ok || !res.body) throw new ApiError(res.status, `events: HTTP ${res.status}`);
					this.emit("notice", { level: "info", message: `OpenCode events connected (${this.version})` });
					await this.readEvents(res.body, controller.signal);
				} catch (err) {
					if (controller.signal.aborted) return;
					this.emit("notice", { level: "warn", message: `OpenCode events dropped (${err.message}); reconnecting…` });
					this.conn = null;
					await new Promise((r) => setTimeout(r, 2500));
					await this.ensure().catch(() => {});
				}
			}
		};
		run();
	}

	async readEvents(body, signal) {
		const reader = body.getReader();
		const decoder = new TextDecoder();
		let buf = "";
		while (!signal.aborted) {
			const { done, value } = await reader.read();
			if (done) throw new Error("stream ended");
			buf += decoder.decode(value, { stream: true });
			let nl;
			while ((nl = buf.indexOf("\n")) >= 0) {
				const line = buf.slice(0, nl).replace(/\r$/, "");
				buf = buf.slice(nl + 1);
				if (line.startsWith("data: ")) {
					try {
						this.onEvent(JSON.parse(line.slice(6)));
					} catch {
						// partial or non-JSON: ignore
					}
				}
			}
		}
	}

	/** One OpenCode event → pi-web state + synthetic pi events for the browser. */
	onEvent(ev) {
		if (!ev?.type) return;
		const d = ev.data || {};
		const ocId = d.sessionID;
		if (ocId && ev.type.startsWith("session.")) {
			const live = this.liveFor(ocId);
			const emit = (piEv) => {
				applyEvent(live, piEv);
				this.emit("rpc", { ocId, ev: piEv });
			};
			switch (ev.type) {
				case "session.execution.started":
				case "session.inbox.delivered": {
					if (ev.type === "session.execution.started") {
						live.busy = true;
						live.error = null;
						this.markRunning(ocId, true);
						emit({ type: "agent_start" });
					}
					this.markDirty(ocId, 300);
					break;
				}
				case "session.step.started": {
					// A step = one assistant message. Started before its parts stream.
					this.stepUsage.delete(ocId);
					emit({
						type: "message_start",
						message: {
							role: "assistant",
							id: d.assistantMessageID,
							timestamp: d.started || ev.created,
							model: d.model ? `${d.model.providerID}/${d.model.id}` : undefined,
							content: [],
						},
					});
					break;
				}
				case "session.reasoning.started":
					emit({ type: "message_update", assistantMessageEvent: { type: "thinking_start", contentIndex: this.partSlot(ocId, d.assistantMessageID, `r${d.ordinal || 0}`) } });
					break;
				case "session.reasoning.delta":
					emit({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: this.partSlot(ocId, d.assistantMessageID, `r${d.ordinal || 0}`), delta: d.delta || "" } });
					break;
				case "session.reasoning.ended":
					emit({ type: "message_update", assistantMessageEvent: { type: "thinking_end", contentIndex: this.partSlot(ocId, d.assistantMessageID, `r${d.ordinal || 0}`), content: d.text || "" } });
					break;
				case "session.text.started":
					emit({ type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: this.partSlot(ocId, d.assistantMessageID, `t${d.ordinal || 0}`) } });
					break;
				case "session.text.delta":
					emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: this.partSlot(ocId, d.assistantMessageID, `t${d.ordinal || 0}`), delta: d.delta || "" } });
					break;
				case "session.text.ended":
					emit({ type: "message_update", assistantMessageEvent: { type: "text_end", contentIndex: this.partSlot(ocId, d.assistantMessageID, `t${d.ordinal || 0}`), content: d.text || "" } });
					break;
				// Tool calls stream in four beats: input.started (the call begins,
				// name known), input.ended (arguments complete, raw JSON), called
				// (executing), success/error (result). Bridged onto pi's partial
				// toolcall events + live.tools so running cards show mid-step.
				case "session.tool.input.started": {
					this.toolNames.set(d.id, d.name);
					emit({
						type: "message_update",
						assistantMessageEvent: { type: "toolcall_start", contentIndex: this.partSlot(ocId, d.assistantMessageID, `c${d.id}`), id: d.id, toolName: d.name },
					});
					break;
				}
				case "session.tool.input.ended": {
					let args = {};
					try {
						args = JSON.parse(d.text || "{}");
					} catch {
						// a malformed call arrives as an error result later
					}
					emit({
						type: "message_update",
						assistantMessageEvent: {
							type: "toolcall_end",
							contentIndex: this.partSlot(ocId, d.assistantMessageID, `c${d.id}`),
							toolCall: { type: "toolCall", id: d.id, name: this.toolNames.get(d.id) || "tool", arguments: args },
						},
					});
					break;
				}
				case "session.tool.called": {
					emit({ type: "tool_execution_start", toolCallId: d.id, toolName: this.toolNames.get(d.id) || d.name || "tool", args: d.input || {} });
					break;
				}
				case "session.tool.success": {
					emit({ type: "tool_execution_end", toolCallId: d.id, result: { content: d.content || [] }, isError: false });
					break;
				}
				case "session.tool.error":
				case "session.tool.aborted": {
					const text = d.error?.message || d.message || d.error || "The tool failed.";
					emit({ type: "tool_execution_end", toolCallId: d.id, result: { content: [{ type: "text", text: String(text) }] }, isError: true });
					break;
				}
				case "session.step.ended": {
					// The step's tokens/cost ride this event; the stored message
					// has none. Keep them for the live message_end and re-apply
					// on every re-fetch of the stored form.
					if (d.assistantMessageID && (d.tokens || d.cost)) {
						this.usage.set(d.assistantMessageID, { tokens: d.tokens, cost: d.cost });
						this.stepUsage.set(ocId, { tokens: d.tokens, cost: d.cost });
						// Bounded like every per-id map here (the memory watchdog
						// restarts on bloat): settled steps never come back.
						if (this.usage.size > 2000) this.usage.delete(this.usage.keys().next().value);
					}
					const u = d.tokens || {};
					emit({
						type: "message_end",
						message: {
							role: "assistant",
							id: d.assistantMessageID,
							timestamp: ev.created,
							content: (live.partial?.content || []).slice(),
							model: live.partial?.model,
							usage: {
								input: u.input,
								output: u.output,
								reasoning: u.reasoning,
								cacheRead: u.cache?.read,
								cacheWrite: u.cache?.write,
								totalTokens: (u.input || 0) + (u.output || 0) + (u.reasoning || 0) + (u.cache?.read || 0) + (u.cache?.write || 0),
								cost: { total: d.cost || 0 },
							},
						},
					});
					this.markDirty(ocId, 700); // stored truth (tool parts, final texts)
					break;
				}
				case "session.usage.updated": {
					const meta = this.metas.get(ocId);
					if (meta) {
						meta.tokens = tokenTotal(d.tokens);
						meta.cost = d.cost || 0;
						this.emit("upsert", this.decorate(meta));
					}
					break;
				}
				case "session.execution.succeeded":
				case "session.execution.failed": {
					live.busy = false;
					live.partial = null;
					this.markRunning(ocId, false, ev.type.endsWith("failed") ? "failed" : "succeeded");
					emit({ type: "agent_settled" });
					if (ev.type.endsWith("failed")) {
						live.error = d.error?.message || d.message || "The OpenCode run failed.";
						emit({ type: "agent_settled" });
						this.emit("notice", { level: "error", sessionId: OC_PREFIX + ocId, message: `OpenCode run failed: ${live.error}` });
					}
					this.markDirty(ocId, 300);
					break;
				}
				default:
					// Tool/step-stream events carry state we don't stream: the
					// re-fetch after the step brings the stored form in.
					this.markDirty(ocId, 1200);
			}
			return;
		}
		switch (ev.type) {
			case "session.updated":
			case "session.removed":
			case "project.updated":
			case "model.updated":
			case "agent.updated":
				this.refreshSessions().catch(() => {});
				break;
			default:
				// catalog pings (provider/plugin/command/…) — nothing to do
		}
	}

	// ── state helpers ────────────────────────────────────────────────────────

	/** One content slot per streamed part. OC's ordinals count within a part
	 *  type (first reasoning = 0, first text = 0) while pi's partial indexes
	 *  every block of the message — allocate slots in arrival order so
	 *  thinking, text and tool calls land side by side, never on top of
	 *  each other. */
	partSlot(ocId, msgId, key) {
		const mk = `${ocId}:${msgId}`;
		let m = this.partIndexes.get(mk);
		if (!m) {
			m = { next: 0, byKey: new Map() };
			this.partIndexes.set(mk, m);
			if (this.partIndexes.size > 400) this.partIndexes.delete(this.partIndexes.keys().next().value); // settled messages; slots rebuild on demand
		}
		let i = m.byKey.get(key);
		if (i == null) {
			i = m.next++;
			m.byKey.set(key, i);
		}
		return i;
	}

	liveFor(ocId) {
		let live = this.live.get(ocId);
		if (!live) {
			live = createLive();
			this.live.set(ocId, live);
		}
		return live;
	}

	markRunning(ocId, on, outcome) {
		const meta = this.metas.get(ocId);
		if (!meta) return;
		meta.running = on;
		if (outcome) meta.outcome = outcome;
		this.emit("upsert", this.decorate(meta));
	}

	markDirty(ocId, delay = 400) {
		if (this.hasWatcher && !this.hasWatcher(ocId)) return; // nobody is watching: skip the fetch, stay marked dirty
		this.dirty.add(ocId);
		clearTimeout(this.dirtyTimers?.get(ocId));
		this.dirtyTimers ??= new Map();
		const timer = setTimeout(() => this.pushEntries(ocId).catch(() => {}), delay);
		this.dirtyTimers.set(ocId, timer);
	}

	/** Re-fetch one session's messages and broadcast the converted entries —
	 *  only the ones the watchers don't already have. A session's watchers all
	 *  hold the same history (they got the full list on subscribe or in the
	 *  snapshot), so per-step broadcasts shrink from the whole 200-message
	 *  page to the handful of new entries. */
	async pushEntries(ocId) {
		this.dirty.delete(ocId);
		const prev = this.entries.get(ocId)?.list || [];
		const list = await this.fetchEntries(ocId);
		if (prev.length && list.length >= prev.length) {
			const had = new Set(prev.map((e) => e.id));
			const fresh = list.filter((e) => !had.has(e.id));
			if (fresh.length) this.emit("entries", { ocId, entries: fresh });
			return;
		}
		// shrunk (replaced/truncated?) or first push: send everything
		this.emit("entries", { ocId, entries: list });
	}

	// ── sessions & messages ────────────────────────────────────────────────────

	/** GET /api/session → decorated metas (kind "opencode", id "oc-…"). */
	async refreshSessions(force = false) {
		const [res, active] = await Promise.all([
			this.api("/api/session"),
			// Sessions mid-run (started before pi-web did, or from the user's
			// own terminal) — the active map says which, before any event arrives.
			this.api("/api/session/active").catch(() => null),
		]);
		const activeIds = new Set(Object.keys(active?.data || {}));
		const seen = new Set();
		const parentsToPing = new Set();
		this.children.clear();
		for (const s of res?.data || []) {
			seen.add(s.id);
			if (s.parentID) {
				// A subagent session (spawned by the `subagent` tool): link it to
				// its parent so the sidebar nests it and strips can follow it.
				if (!this.children.has(s.parentID)) this.children.set(s.parentID, []);
				this.children.get(s.parentID).push(s.id);
			}
		}
		for (const s of res?.data || []) {
			const old = this.metas.get(s.id);
			const meta = this.metaFrom(s);
			if (activeIds.has(s.id)) meta.running = true;
			const changed = !old || old.title !== meta.title || old.running !== meta.running || old.lastActivity !== meta.lastActivity || old.tokens !== meta.tokens || old.parentId !== meta.parentId;
			if (changed) {
				this.metas.set(s.id, meta);
				this.emit("upsert", this.decorate(meta));
				// A changed subagent session → its parent's strip cares too (once,
				// not once per child: 30 children must not broadcast the parent 30×
				// every poll — that was a 60-upserts-a-minute storm).
				if (s.parentID) parentsToPing.add(s.parentID);
			} else this.metas.set(s.id, { ...old, ...meta });
			if (old && (old.updated || 0) !== (s.time?.updated || 0)) this.markDirty(s.id, 600); // changed outside our own events (e.g. the user's terminal)
		}
		for (const parentId of parentsToPing) {
			const parent = this.metas.get(parentId);
			if (parent) this.emit("upsert", this.decorate(parent));
		}
		if (!force) {
			for (const id of [...this.metas.keys()]) if (!seen.has(id)) {
				this.metas.delete(id);
				this.live.delete(id);
				this.entries.delete(id);
				this.emit("remove", id);
			}
		}
	}

	metaFrom(s) {
		const wsl = windowsToWsl(s.location?.directory || "");
		const model = s.model ? `${s.model.providerID}/${s.model.id}` : undefined;
		return {
			id: OC_PREFIX + s.id,
			ocId: s.id,
			kind: "opencode",
			file: null,
			cwd: wsl || undefined,
			dirWindows: s.location?.directory || "",
			projectId: s.projectID,
			parentId: s.parentID ? OC_PREFIX + s.parentID : undefined,
			name: s.title || undefined,
			firstUser: s.title || undefined,
			created: s.time?.created ? new Date(s.time.created).toISOString() : undefined,
			updated: s.time?.updated || 0,
			lastActivity: s.time?.updated ? new Date(s.time.updated).toISOString() : undefined,
			mtime: s.time?.updated || s.time?.created || 0,
			tokens: tokenTotal(s.tokens),
			tokenMessages: undefined,
			cost: s.cost || 0,
			lastModel: model,
			agent: s.agent,
			// Child rows read like pi's: "general · graphify chunk 01/30 docs".
			agentName: s.parentID ? s.title : undefined,
			running: !!s.outcome && s.outcome === "running" ? true : this.live.get(s.id)?.busy || false,
			outcome: s.outcome,
			pending: false,
			children: [],
		};
	}

	/** Pi-style subagent records for a parent (the sidebar strip and the
	 *  `subagent` tool cards read these). "file" is the child's routed id —
	 *  the front end treats it as an opaque key, exactly like a session path. */
	decorate(meta) {
		const kids = (this.children.get(meta.ocId) || []).map((childId) => {
			const child = this.metas.get(childId);
			return {
				file: OC_PREFIX + childId,
				agent: child?.agent,
				name: child?.title,
				launchedAt: child?.created,
				finishedAt: child?.lastActivity,
				done: !!child && !child.running,
				failed: child?.outcome === "failed",
				childId: OC_PREFIX + childId,
			};
		});
		return { ...meta, childCount: kids.length, subagents: kids };
	}

	list() {
		return [...this.metas.values()].map((m) => this.decorate(m));
	}

	get(prefixedId) {
		return this.metas.get(String(prefixedId || "").slice(OC_PREFIX.length));
	}

	/** pi-style entries for a session (cached until marked dirty). */
	async entriesFor(prefixedId) {
		const ocId = String(prefixedId).slice(OC_PREFIX.length);
		const cached = this.entries.get(ocId);
		if (cached && !this.dirty.has(ocId)) return cached.list;
		const list = await this.fetchEntries(ocId);
		return list;
	}

	async fetchEntries(ocId) {
		// The message endpoint caps pages at 200 and pages by opaque cursor
		// (cursor.next; "do not combine with order" — the cursor carries it).
		const all = [];
		let path = `/api/session/${ocId}/message?limit=${MESSAGES_PAGE}&order=asc`;
		for (let page = 0; page < 20 && path; page++) {
			const res = await this.api(path);
			all.push(...(res?.data || []));
			path = res?.cursor?.next ? `/api/session/${ocId}/message?limit=${MESSAGES_PAGE}&cursor=${encodeURIComponent(res.cursor.next)}` : null;
		}
		// While a run is streaming, the service already holds the in-flight
		// assistant message (created, not completed) — showing it here would
		// duplicate the live partial. It arrives on the post-step refetch.
		const dropInFlight = !!this.live.get(ocId)?.busy;
		const list = toPiEntries(all, this.usage, { dropInFlight });
		this.entries.set(ocId, { at: Date.now(), list });
		this.dirty.delete(ocId);
		return list;
	}

	/** The live state to ship in a snapshot (browser re-connecting mid-run). */
	liveState(prefixedId) {
		const live = this.live.get(String(prefixedId).slice(OC_PREFIX.length));
		return live || null;
	}

	// ── actions ────────────────────────────────────────────────────────────

	async createSession({ directory, agent, model, title, prompt }) {
		const body = {
			location: { directory: wslToWindows(directory) },
			agent: agent || undefined,
			title: title || undefined,
		};
		if (model) {
			const [providerID, ...rest] = model.split("/");
			body.model = rest.length ? { providerID, id: rest.join("/") } : { id: model };
		}
		const res = await this.api("/api/session", { method: "POST", body });
		const ocId = res?.data?.id;
		if (!ocId) throw new ApiError(502, "OpenCode did not return a session id.");
		await this.refreshSessions();
		const meta = this.metas.get(ocId);
		if (meta) this.emit("upsert", this.decorate(meta));
		if (prompt) await this.prompt(ocId, prompt);
		return OC_PREFIX + ocId;
	}

	async prompt(ocId, text, { delivery = "steer" } = {}) {
		const res = await this.api(`/api/session/${ocId}/prompt`, { method: "POST", body: { text, delivery }, timeout: 30000 });
		// Show the user's message at once; the stored form arrives via events.
		// The inbox id IS the stored message id (verified) — the browser dedupes
		// the live copy against the stored one by it.
		const live = this.liveFor(ocId);
		const msg = { role: "user", id: res?.data?.id, timestamp: res?.data?.time?.created || Date.now(), content: text };
		applyEvent(live, { type: "message_end", message: msg });
		this.emit("rpc", { ocId, ev: { type: "message_end", message: msg } });
		this.markRunning(ocId, true);
		return res;
	}

	async interrupt(ocId) {
		const res = await this.api(`/api/session/${ocId}/interrupt`, { method: "POST", body: {} });
		this.markRunning(ocId, false, "interrupted");
		return res;
	}

	async rename(ocId, title) {
		await this.api(`/api/session/${ocId}`, { method: "PATCH", body: { title } });
		await this.refreshSessions();
	}

	async remove(ocId) {
		await this.api(`/api/session/${ocId}`, { method: "DELETE" });
		this.metas.delete(ocId);
		this.live.delete(ocId);
		this.entries.delete(ocId);
		this.emit("remove", ocId);
	}

	async models() {
		const res = await this.api("/api/model");
		return (res?.data || []).filter((m) => m.enabled !== false && m.status !== "disabled");
	}

	async agents() {
		const res = await this.api("/api/agent");
		return (res?.data || []).filter((a) => !a.hidden);
	}

	async projects() {
		const res = await this.api("/api/project");
		return (res?.data || []).map((p) => ({ id: p.id, directory: p.canonical, wsl: windowsToWsl(p.canonical || ""), active: p.time?.active || 0, vcs: p.vcs }));
	}

	async setModel(ocId, providerID, modelID) {
		// The switch endpoint takes a Model.Ref: {providerID, id, variant?}.
		await this.api(`/api/session/${ocId}/model`, { method: "POST", body: { model: { providerID, id: modelID } } });
		await this.refreshSessions();
	}

	// ── forms & permissions ────────────────────────────────────────────────

	async pollPending() {
		if (!this.conn) return;
		// Forms: an agent asking structured questions (like pi's quiz/ask tools).
		const forms = await this.api("/api/form").catch(() => null);
		if (forms?.data) {
			const seen = new Set();
			for (const f of forms.data) {
				seen.add(f.id);
				const prev = this.forms.get(f.id);
				this.forms.set(f.id, f);
				// A form's fields can update after opening (when-conditions); re-emit so
				// an open dialog re-renders instead of showing stale options.
				if (!prev || JSON.stringify(prev) !== JSON.stringify(f)) this.emit("form", { form: f, open: true });
			}
			for (const [id, f] of this.forms) if (!seen.has(id)) {
				this.forms.delete(id);
				this.emit("form", { form: f, open: false });
			}
		}
		// Permissions: a tool about to run that the ruleset says to ask about.
		const perms = await this.api("/api/permission/request").catch(() => null);
		if (perms?.data) {
			const seen = new Set();
			for (const p of perms.data) {
				seen.add(p.id);
				if (!this.permissions.has(p.id)) {
					this.permissions.set(p.id, p);
					this.emit("permission", { request: p, open: true });
				}
			}
			for (const [id, p] of this.permissions) if (!seen.has(id)) {
				this.permissions.delete(id);
				this.emit("permission", { request: p, open: false });
			}
		}
	}

	async replyForm(ocId, formId, answer) {
		const res = await this.api(`/api/session/${ocId}/form/${formId}/reply`, { method: "POST", body: { answer } });
		this.forms.delete(formId);
		return res;
	}

	async replyPermission(ocId, requestId, decision, message) {
		const res = await this.api(`/api/session/${ocId}/permission/${requestId}/reply`, { method: "POST", body: { decision, message: message || undefined } });
		this.permissions.delete(requestId);
		return res;
	}
}

/** The Windows host as seen from this WSL: mirrored mode shares loopback, NAT
 *  mode exposes the vEthernet adapter (it's the SMB listener on port 139). */
function hostCandidate() {
	try {
		const out = spawnSync("netstat.exe", ["-ano"], { timeout: 8000, encoding: "utf8", windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
		const m = /^TCP\s+(\d+\.\d+\.\d+\.1):139\s+\S+\s+LISTENING\s+\d+/m.exec(String(out.stdout || ""));
		if (m) return m[1];
	} catch {
		// netstat not reachable: fall back to the default gateway
	}
	try {
		const route = spawnSync("ip", ["route", "show", "default"], { encoding: "utf8", timeout: 3000 });
		const m = /via (\d+\.\d+\.\d+\.\d+)/.exec(String(route.stdout || ""));
		if (m) return m[1];
	} catch {
		// no route either
	}
	return "127.0.0.1";
}

function tokenTotal(t) {
	if (!t) return 0;
	return (t.input || 0) + (t.output || 0) + (t.reasoning || 0) + (t.cache?.read || 0) + (t.cache?.write || 0);
}

// ── OpenCode messages → pi entries ──────────────────────────────────────────
// The browser renders pi's session format; OpenCode's messages are converted
// here so conversation.js, tool cards and live partials all work unchanged.

function iso(ms) {
	return typeof ms === "number" ? new Date(ms).toISOString() : undefined;
}

const MAX_TOOL_TEXT = 24_000; // same cap pi's slimming applies

function toolText(state) {
	const raw = (state?.content || [])
		.map((c) => (c?.type === "text" ? c.text : c?.type === "file" ? `${c.name || c.uri || "file"}` : ""))
		.filter(Boolean)
		.join("\n");
	return raw.length > MAX_TOOL_TEXT ? `${raw.slice(0, MAX_TOOL_TEXT)}\n…` : raw || undefined;
}

/** OpenCode tool-call arguments → pi-shaped ones (the cards read these). */
function piToolArgs(name, input) {
	if (name === "subagent") {
		// OpenCode: {agent, description, prompt} → pi: {agent, name, task}.
		return { agent: input?.agent, name: input?.description, task: input?.prompt };
	}
	if (name === "question") {
		// OpenCode's ask-user tool → pi's ask_user_question card.
		const q = Array.isArray(input?.questions) ? input.questions[0] : input;
		return {
			question: q?.question || q?.header,
			options: (q?.options || []).map((o) => ({ label: o.label, description: o.description })),
			multiSelect: !!q?.multi,
		};
	}
	return input || {};
}

/** OpenCode tool results → pi-shaped details (buildSubagent reads sessionFile).
 *  An OC child session's routed id ("oc-ses_…") plays the role of pi's
 *  session-file path: the front end uses it as the opaque key. */
function piToolDetails(name, state) {
	if (name === "subagent") {
		const sid = state?.metadata?.sessionID;
		const status = state?.metadata?.status;
		if (!sid) return {};
		return {
			sessionFile: OC_PREFIX + sid,
			done: status === "completed",
			failed: status === "failed" || status === "error",
			exitCode: status === "completed" ? 0 : status ? 1 : undefined,
		};
	}
	if (name === "question") {
		// Answered history renders on the ask card (pi's answered shape).
		if (state?.status === "completed") return { status: "answered", mode: "text", answers: [{ type: "text", label: toolText(state) || "" }] };
		return {};
	}
	return { state: state?.status, metadata: state?.metadata };
}

/** One OpenCode message array (oldest first) → pi-style entries.
 *  Entries are linked parent→child (pi's session files are a tree; the
 *  browser walks parentId chains): user → assistant → its results. */
export function toPiEntries(messages, usageByMessage = new Map(), { dropInFlight = false } = {}) {
	const out = [];
	let last = null;
	const push = (e, parent = last) => {
		e.parentId = parent?.id ?? null;
		out.push(e);
		last = e;
		return e;
	};
	for (const m of messages || []) {
		switch (m.type) {
			case "user": {
				push({
					type: "message",
					id: m.id,
					message: { role: "user", timestamp: iso(m.time?.created), content: m.text || "" },
				});
				break;
			}
			case "assistant": {
				if (dropInFlight && m.time?.created && !m.time?.completed) break; // streamed live instead
				const blocks = [];
				const results = [];
				for (const part of m.content || []) {
					if (!part) continue;
					if (part.type === "text") blocks.push({ type: "text", text: part.text || "" });
					else if (part.type === "reasoning") blocks.push({ type: "thinking", thinking: part.text || "" });
					else if (part.type === "tool") {
						blocks.push({ type: "toolCall", id: part.id, name: part.name === "question" ? "ask_user_question" : part.name, arguments: piToolArgs(part.name, part.state?.input) });
						results.push({
							type: "message",
							id: `${m.id}:r:${part.id}`,
							parentId: m.id,
							message: {
								role: "toolResult",
								timestamp: iso(m.time?.completed || m.time?.created),
								toolCallId: part.id,
								content: toolText(part.state) || "",
								details: piToolDetails(part.name, part.state),
								isError: part.state?.status === "error",
							},
						});
					}
				}
				const usage = usageByMessage.get(m.id);
				push({
					type: "message",
					id: m.id,
					message: {
						role: "assistant",
						timestamp: iso(m.time?.created),
						model: m.model ? `${m.model.providerID}/${m.model.id}` : undefined,
						content: blocks,
						usage: usage
							? {
									input: usage.tokens?.input,
									output: usage.tokens?.output,
									reasoning: usage.tokens?.reasoning,
									cacheRead: usage.tokens?.cache?.read,
									cacheWrite: usage.tokens?.cache?.write,
									totalTokens: tokenTotal(usage.tokens),
									cost: { total: usage.cost || 0 },
								}
							: undefined,
					},
				});
				for (const r of results) {
					out.push(r);
					last = r;
				}
				break;
			}
			case "compaction": {
				push({
					type: "compaction",
					id: m.id,
					tokensBefore: m.tokensBefore,
					summary: m.text || "",
				});
				break;
			}
			default:
				// idle markers, system/synthetic bookkeeping: not conversation content
		}
	}
	return out;
}
export { messageKey };
