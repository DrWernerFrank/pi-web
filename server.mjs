#!/usr/bin/env node
// pi-web: a browser GUI for the pi coding agent.
// Run it where pi runs (e.g. inside WSL) and open http://localhost:3141.

import { execFile, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { AGY_PREFIX, AgyTail, AntigravityIndex, findAntigravityDir, readArtifact } from "./lib/antigravity.mjs";
import { AntigravityLive, antigravityAppExe } from "./lib/antigravity-live.mjs";
import { Bridge } from "./lib/bridge.mjs";
import { loadConfig } from "./lib/config.mjs";
import { configureGemini, geminiRead, geminiStatus, startGeminiLogin } from "./lib/gemini.mjs";
import { ModelCatalog } from "./lib/models.mjs";
import { PiProcess } from "./lib/pi-process.mjs";
import { SessionIndex, SessionTail, readFullEntry, readImage } from "./lib/sessions.mjs";
import { ClaudeUsage } from "./lib/usage.mjs";
import { createLive, dropPersisted } from "./public/js/live.js";

const VERSION = "1.1.0";
const IDLE_STOP_MS = 20 * 60 * 1000;
const DIALOGS = new Set(["select", "confirm", "input", "editor"]);

const USAGE = `pi-web ${VERSION} — a browser GUI for pi

Usage: node server.mjs [options]

  --port <n>        Port to listen on (default 3141, env PI_WEB_PORT)
  --host <addr>     Address to bind (default 127.0.0.1, env PI_WEB_HOST)
  --sessions <dir>  Session folder (default: pi's own, env PI_WEB_SESSIONS_DIR)
  --pi <path>       pi executable (default: pi on PATH, env PI_WEB_PI)
  -h, --help        Show this help

Environment:
  PI_WEB_ASSET_DIRS      Extra folders to search for ![[image.png]] embeds (':'-separated)
  PI_WEB_ALLOWED_HOSTS   Extra Host headers to accept (','-separated), e.g. when binding 0.0.0.0
  PI_WEB_PI_ARGS         Extra arguments for every pi process
  PI_WEB_NO_ENV_CAPTURE  Set to 1 to skip reading your shell's environment for pi
`;

let config;
try {
	config = loadConfig(process.argv.slice(2));
} catch (err) {
	console.error(err.message);
	console.error(USAGE);
	process.exit(2);
}
if (config.help) {
	console.log(USAGE);
	process.exit(0);
}

const PUBLIC = path.join(config.root, "public");
const MODULES = path.join(config.root, "node_modules");
const BRIDGE_EXT = path.join(config.root, "bridge", "pi-web-bridge.ts");
const VENDOR = {
	"markdown-it": path.join(MODULES, "markdown-it", "dist"),
	katex: path.join(MODULES, "katex", "dist"),
	dompurify: path.join(MODULES, "dompurify", "dist"),
	mermaid: path.join(MODULES, "mermaid", "dist"),
	hljs: path.join(MODULES, "@highlightjs", "cdn-assets"),
	vazirmatn: path.join(MODULES, "vazirmatn"),
};
const MIME = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".map": "application/json; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".avif": "image/avif",
	".bmp": "image/bmp",
	".ico": "image/x-icon",
	".woff2": "font/woff2",
	".woff": "font/woff",
	".ttf": "font/ttf",
};
const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".bmp", ".svg"]);
const PAGE_CSP =
	"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; " +
	"connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'";
// Images are served from our origin, so an SVG opened directly must not run scripts.
const IMAGE_CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox";

class HttpError extends Error {
	constructor(status, message) {
		super(message);
		this.status = status;
	}
}

const isDir = (p) => {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
};
const isFile = (p) => {
	try {
		return fs.statSync(p).isFile();
	} catch {
		return false;
	}
};

// ── state ───────────────────────────────────────────────────────────────────

const index = new SessionIndex(config.sessionsDir);
const models = new ModelCatalog(config.agentDir);
index.contextWindowFor = (key) => models.contextWindow(key);
configureGemini({ env: config.env, root: config.root });

// Archived chats: a small list in ~/.cache/pi-web/archived.json. Archiving
// hides a chat from the sidebar (until “Archived” is toggled or you search)
// without touching pi's or Antigravity's files.
const ARCHIVED_FILE = path.join(os.homedir(), ".cache", "pi-web", "archived.json");
function readArchived() {
	try {
		const raw = JSON.parse(fs.readFileSync(ARCHIVED_FILE, "utf8"));
		return Array.isArray(raw) ? new Set(raw) : new Set();
	} catch {
		return new Set();
	}
}
const archived = readArchived();
function writeArchived() {
	try {
		fs.mkdirSync(path.dirname(ARCHIVED_FILE), { recursive: true });
		fs.writeFileSync(ARCHIVED_FILE, JSON.stringify([...archived], null, 2));
	} catch {
		// best effort: hiding is cosmetic
	}
}

// Which git commit this build is (the folder is a git repo — see README's
// "Version control"). Shown in the ⋯ menu and /api/health so "which build is
// running?" is always answerable; a server restarted from old code says so.
const commit = (() => {
	try {
		const r = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: config.root, encoding: "utf8", timeout: 5000 });
		return r.status === 0 ? String(r.stdout).trim() : null;
	} catch {
		return null;
	}
})();
const claudeUsage = new ClaudeUsage(config.agentDir);
const agyDir = process.env.PI_WEB_NO_ANTIGRAVITY === "1" ? undefined : findAntigravityDir();
const agy = agyDir ? new AntigravityIndex(agyDir) : null;
const agyLive = agy ? new AntigravityLive({ index: agy }) : null;
const agyApp = agyDir ? antigravityAppExe(agyDir) : null;
const clients = new Set();

/** Wait until the Antigravity index lists a conversation (new ones take a moment to be saved). */
async function awaitAgyConversation(id, ms = 10_000) {
	const until = Date.now() + ms;
	while (Date.now() < until) {
		agy.stamp = ""; // force a re-read
		await agy.refresh();
		if (agy.get(id)) return true;
		await new Promise((r) => setTimeout(r, 700));
	}
	return false;
}

// ── full-text search over old chats ──────────────────────────────────────
// The sidebar's search box filters by title; this digs through what was
// actually said. Text is extracted once per file version and cached, so
// typing stays fast even with a few hundred sessions.

const SEARCH_CACHE = new Map(); // file -> { mtimeMs, size, segments }
const SEARCH_CACHE_MAX = 300;
const SEARCH_MAX_FILE = 5 * 1024 * 1024;
const SEARCH_MAX_SEGMENTS = 4000;

/** Chat text as [{role, text}] — user + assistant messages only. */
function extractSegments(file, kind) {
	let raw;
	try {
		raw = fs.readFileSync(file, "utf8");
	} catch {
		return [];
	}
	const segments = [];
	for (const line of raw.split("\n")) {
		if (!line || segments.length >= SEARCH_MAX_SEGMENTS) continue; // not JSON.parse per char: skip empties first
		let j;
		try {
			j = JSON.parse(line);
		} catch {
			continue;
		}
		if (kind === "agy") {
			// Antigravity transcript lines: {source, content}
			const role = j.source === "USER_EXPLICIT" ? "user" : j.source === "MODEL" ? "pi" : null;
			if (role && typeof j.content === "string" && j.content.trim()) segments.push({ role, text: j.content });
			continue;
		}
		// pi session lines: {type:"message", message:{role, content}}
		if (j.type !== "message" || !j.message) continue;
		const role = j.message.role === "user" ? "user" : j.message.role === "assistant" ? "pi" : null;
		if (!role) continue;
		const c = j.message.content;
		const text = Array.isArray(c)
			? c.filter((b) => b && b.type === "text" && typeof b.text === "string").map((b) => b.text).join("\n")
			: typeof c === "string"
				? c
				: "";
		if (text.trim()) segments.push({ role, text });
	}
	return segments;
}

const SNIPPET_PAD = 70;
function snippetAround(text, at, len) {
	const start = Math.max(0, at - SNIPPET_PAD);
	const end = Math.min(text.length, at + len + SNIPPET_PAD);
	return (start > 0 ? "…" : "") + text.slice(start, end).replace(/\s+/g, " ").trim() + (end < text.length ? "…" : "");
}

async function searchSessions(q) {
	const needle = q.toLowerCase();
	const out = [];
	const consider = (meta, file, kind) => {
		if (!file) return;
		let stat;
		try {
			stat = fs.statSync(file);
		} catch {
			return;
		}
		if (!stat.isFile() || stat.size === 0 || stat.size > SEARCH_MAX_FILE) return;
		let entry = SEARCH_CACHE.get(file);
		if (!entry || entry.mtimeMs !== stat.mtimeMs || entry.size !== stat.size) {
			entry = { mtimeMs: stat.mtimeMs, size: stat.size, segments: extractSegments(file, kind) };
			SEARCH_CACHE.set(file, entry);
			if (SEARCH_CACHE.size > SEARCH_CACHE_MAX) SEARCH_CACHE.delete(SEARCH_CACHE.keys().next().value);
		}
		let count = 0;
		const snippets = [];
		for (const seg of entry.segments) {
			const hay = seg.text.toLowerCase();
			let at = hay.indexOf(needle);
			while (at !== -1) {
				count++;
				if (snippets.length < 3) snippets.push({ role: seg.role, text: snippetAround(seg.text, at, needle.length) });
				if (count >= 500) break;
				at = hay.indexOf(needle, at + needle.length);
			}
			if (count >= 500) break;
		}
		if (count) out.push({ id: meta.id, count, snippets, lastActivity: meta.lastActivity || null });
	};
	for (const meta of index.list()) consider(meta, meta.file, "pi");
	if (agy) {
		for (const meta of agy.list()) {
			try {
				consider(meta, path.join(agy.brainDir(meta.uuid), ".system_generated", "logs", "transcript.jsonl"), "agy");
			} catch {
				// transcript not there yet
			}
		}
	}
	out.sort((a, b) => b.count - a.count || Date.parse(b.lastActivity || "") - Date.parse(a.lastActivity || ""));
	return out.slice(0, 40);
}

const isAgy = (id) => typeof id === "string" && id.startsWith(AGY_PREFIX);

// ── Antigravity projects: working the same folder pi works ────────────────────
// An Antigravity conversation runs inside a project's workspace folder, and a
// project is just a JSON file in ~/.gemini/config/projects/<id>.json. Find the
// one bound to a folder, or write one — no app interaction needed (the same
// discovery the motion-studio bridge uses).
function wslToAgyFolderUri(cwd) {
	const m = /^\/mnt\/([a-z])(\/.*)?$/i.exec(String(cwd || ""));
	if (!m) return null;
	const rest = (m[2] || "/").replace(/\/+$/, "");
	return "file:///" + m[1].toLowerCase() + "%3A" + rest;
}
/** file:///c%3A/Users/x and file://c:/Users/x both → c:/users/x */
function agyFolderKey(uri) {
	return decodeURIComponent(String(uri || "").replace(/^file:\/*\/+/i, "").replace(/\\/g, "/")).toLowerCase();
}
function agyProjectsDir() {
	return agyDir ? path.join(path.dirname(agyDir), "config", "projects") : null;
}
async function findOrCreateAgyProject(cwd) {
	if (!agy) throw new HttpError(404, "Antigravity was not found on this machine.");
	const uri = wslToAgyFolderUri(String(cwd || "").trim());
	if (!uri) throw new HttpError(400, "Antigravity projects live on the Windows side; pick a folder under /mnt.");
	const dir = agyProjectsDir();
	const target = agyFolderKey(uri);
	let files = [];
	try {
		files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
	} catch {
		files = [];
	}
	for (const f of files) {
		try {
			const j = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
			const u = j?.projectResources?.resources?.[0]?.folderUri || "";
			if (u && agyFolderKey(u) === target) return { projectId: j.id || f.replace(/\.json$/, ""), name: j.name || "", created: false };
		} catch {
			/* skip unreadable */
		}
	}
	const id = randomUUID();
	const name = path.basename(String(cwd).replace(/\/+$/, "")) || "project";
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ id, name, projectResources: { resources: [{ folderUri: uri }] }, settings: {}, isWorkspaceOnly: false }, null, 2));
	return { projectId: id, name, created: true };
}

/** Session metadata for a pi session or an Antigravity conversation. */
function metaFor(id) {
	if (isAgy(id)) return agy?.get(id);
	return index.get(id);
}

function decorated(meta) {
	const m = meta.kind === "antigravity" ? meta : index.decorate(meta);
	m.archived = archived.has(m.id);
	return m;
}

function allSessions() {
	const out = agy ? [...index.list(), ...agy.list()] : index.list();
	for (const s of out) s.archived = archived.has(s.id);
	return out;
}
const tails = new Map(); // file -> { tail, refs, timer, watcher }
const procs = new Map(); // sessionId -> PiProcess
const allProcs = new Set(); // every live child, including ones still starting
const sockPath = path.join(os.tmpdir(), `pi-web-${process.getuid?.() ?? "user"}`, `bridge-${config.port}.sock`);
const bridge = new Bridge(sockPath);
let bridgeReady = false;
let piVersion;
let clientSeq = 0;

// ── server-sent events ──────────────────────────────────────────────────────

function sse(client, event, data) {
	if (client.res.writableEnded) return;
	client.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}
function broadcastAll(event, data) {
	for (const c of clients) sse(c, event, data);
}
function broadcastSession(sessionId, event, data) {
	if (!sessionId) return;
	for (const c of clients) if (c.sessionId === sessionId) sse(c, event, data);
}
function broadcastFile(file, event, data) {
	for (const c of clients) if (c.file === file) sse(c, event, data);
}

// ── session tails ───────────────────────────────────────────────────────────

function acquireTail(file) {
	let t = tails.get(file);
	if (!t) {
		const tail = isAgy(file) ? new AgyTail(agy.brainDir(file.slice(AGY_PREFIX.length))) : new SessionTail(file);
		t = { tail, refs: 0 };
		const poll = () => {
			try {
				tail.poll();
			} catch (err) {
				console.error(`[pi-web] reading ${file}: ${err.message}`);
			}
		};
		tail.on("entries", (entries) => onTailEntries(file, entries));
		tail.on("reset", () => onTailReset(file));
		t.timer = setInterval(poll, isAgy(file) ? 1000 : 700);
		if (!isAgy(file)) {
			try {
				t.watcher = fs.watch(file, poll);
				t.watcher.on("error", () => {});
			} catch {
				// not created yet; the timer notices when it is
			}
		}
		tails.set(file, t);
	}
	t.refs++;
	return t.tail;
}

function releaseTail(file) {
	const t = tails.get(file);
	if (!t || --t.refs > 0) return;
	clearInterval(t.timer);
	t.watcher?.close();
	tails.delete(file);
}

function linksFor(entries) {
	const links = {};
	const add = (file) => {
		if (typeof file !== "string" || file in links) return;
		const m = index.getByFile(file);
		links[file] = m ? { id: m.id, title: m.name || m.firstUser || "" } : null;
	};
	for (const e of entries) {
		if (e.type === "message" && e.message?.role === "toolResult") add(e.message.details?.sessionFile);
		else if (e.type === "custom_message") add(e.details?.sessionFile);
	}
	return links;
}

function onTailEntries(file, entries) {
	for (const p of procs.values()) if (p.sessionFile === file) dropPersisted(p.live, entries);
	broadcastFile(file, "entries", { entries, links: linksFor(entries) });
	if (!isAgy(file)) index.scheduleRefresh(file);
}

function onTailReset(file) {
	const t = tails.get(file);
	for (const p of procs.values()) if (p.sessionFile === file && t) dropPersisted(p.live, t.tail.entries);
	for (const c of clients) if (c.file === file) sse(c, "snapshot", snapshot(c.sessionId));
	if (!isAgy(file)) index.scheduleRefresh(file);
}

function snapshot(sessionId) {
	const meta = metaFor(sessionId);
	if (!meta) return null;
	const t = meta.file ? tails.get(meta.file)?.tail : undefined;
	const entries = t ? t.entries : [];
	const proc = procs.get(sessionId);
	return {
		meta: decorated(meta),
		header: t?.header ?? null,
		entries,
		links: linksFor(entries),
		proc: proc ? proc.info() : null,
		live: proc && proc.state !== "exited" ? proc.live : null,
	};
}

// ── pi processes ────────────────────────────────────────────────────────────

function procSummary(p) {
	return { sessionId: p.sessionId, state: p.state, busy: p.live.busy };
}

function spawnPi({ cwd, sessionFile, expectedId }) {
	if (!config.piBin) throw new HttpError(500, "pi was not found on PATH. Start pi-web from a shell where `pi` works, or pass --pi <path>.");
	const p = new PiProcess({
		config,
		cwd,
		sessionFile,
		bridgeSock: bridgeReady ? sockPath : undefined,
		bridgeExt: bridgeReady ? BRIDGE_EXT : undefined,
	});
	p.sessionId = expectedId;
	const sid = () => p.sessionId;

	p.on("event", (ev) => {
		// The file tail may already have delivered this message; don't keep a live copy too.
		if (ev.type === "message_end" && p.tailFile) {
			const t = tails.get(p.tailFile)?.tail;
			if (t) dropPersisted(p.live, t.entries.slice(-30));
		}
		broadcastSession(sid(), "rpc", ev);
		if (ev.type === "agent_start" || ev.type === "agent_settled") broadcastAll("proc_summary", procSummary(p));
	});
	p.on("ui", (req) => {
		broadcastSession(sid(), "ui", req);
		if (!DIALOGS.has(req.method)) return;
		broadcastAll("attention", { sessionId: sid(), kind: "dialog", title: req.title });
		if (req.timeout) {
			setTimeout(() => {
				if (!p.live.dialogs[req.id]) return;
				delete p.live.dialogs[req.id];
				broadcastSession(sid(), "ui_done", { id: req.id });
			}, req.timeout + 250).unref();
		}
	});
	p.on("state", () => {
		broadcastSession(sid(), "proc", p.info());
		broadcastAll("proc_summary", procSummary(p));
	});
	p.on("notice", (notice) => broadcastSession(sid(), "notice", notice));
	p.on("moved", (previousId) => {
		if (procs.get(previousId) === p) procs.delete(previousId);
		procs.set(p.sessionId, p);
		if (p.tailFile !== p.sessionFile) {
			if (p.tailFile) releaseTail(p.tailFile);
			p.tailFile = p.sessionFile;
			if (p.tailFile) acquireTail(p.tailFile);
		}
		if (!index.get(p.sessionId)) index.addPending({ id: p.sessionId, file: p.sessionFile, cwd: p.cwd });
		broadcastSession(previousId, "moved", { to: p.sessionId });
	});
	p.on("exit", (exit) => {
		allProcs.delete(p);
		if (procs.get(sid()) === p) procs.delete(sid());
		// A new chat that never got a reply was never written by pi: drop its placeholder.
		if (index.pending.has(sid()) && !(p.sessionFile && isFile(p.sessionFile))) {
			index.pending.delete(sid());
			broadcastAll("session_remove", { id: sid() });
		}
		if (p.tailFile) {
			releaseTail(p.tailFile);
			p.tailFile = null;
		}
		broadcastSession(sid(), "proc", p.info());
		broadcastAll("proc_summary", procSummary(p));
		if (!p.stopRequested) {
			broadcastSession(sid(), "notice", {
				level: "error",
				message: `pi stopped${exit.code != null ? ` (exit code ${exit.code})` : exit.signal ? ` (${exit.signal})` : ""}${exit.error ? `: ${exit.error}` : ""}`,
				detail: exit.stderr.join("\n"),
			});
		}
	});

	allProcs.add(p);
	p.start();
	return p;
}

async function startFailed(p, err) {
	p.stopRequested = true;
	p.stop();
	await new Promise((r) => setTimeout(r, 300));
	const tail = p.stderr.slice(-15).join("\n");
	return new HttpError(500, `pi failed to start: ${err.message}${tail ? `\n\n${tail}` : ""}`);
}

async function ensureProc(sessionId) {
	let p = procs.get(sessionId);
	if (p?.adopted) {
		// A pi that outlived a crash: fine for answering its open quizzes, but
		// its stdin is gone. Stop it and start a clean one on the same session.
		p.stop();
		procs.delete(sessionId);
		p = undefined;
	}
	if (p && p.state !== "exited" && p.state !== "stopping") {
		await p.ready;
		return p;
	}
	if (isAgy(sessionId)) throw new HttpError(400, "This is an Antigravity conversation; pi can't run it.");
	const meta = index.get(sessionId);
	if (!meta) throw new HttpError(404, "Unknown session");
	if (meta.pending) throw new HttpError(409, "pi never saved this session. Start a new chat instead.");
	if (!meta.cwd) throw new HttpError(400, "This session file does not record its working folder.");
	if (!isDir(meta.cwd)) throw new HttpError(400, `The session's folder no longer exists: ${meta.cwd}`);
	p = spawnPi({ cwd: meta.cwd, sessionFile: meta.file, expectedId: sessionId });
	procs.set(sessionId, p);
	broadcastSession(sessionId, "proc", p.info());
	try {
		await p.ready;
	} catch (err) {
		if (procs.get(sessionId) === p) procs.delete(sessionId);
		throw await startFailed(p, err);
	}
	p.tailFile = p.sessionFile;
	if (p.tailFile) acquireTail(p.tailFile);
	learnModels(p);
	return p;
}

async function newSession(cwd) {
	const dir = path.resolve(cwd || os.homedir());
	if (!isDir(dir)) throw new HttpError(400, `Not a folder: ${dir}`);
	const p = spawnPi({ cwd: dir });
	try {
		await p.ready;
	} catch (err) {
		throw await startFailed(p, err);
	}
	procs.set(p.sessionId, p);
	index.addPending({ id: p.sessionId, file: p.sessionFile, cwd: dir });
	p.tailFile = p.sessionFile;
	if (p.tailFile) acquireTail(p.tailFile);
	learnModels(p);
	return p.sessionId;
}

/** Learn context-window sizes from a freshly started pi (covers extension-provided models). */
function learnModels(p) {
	p.request({ type: "get_available_models" })
		.then((data) => models.learn(data?.models))
		.catch(() => {});
}

function procByKey(key) {
	for (const p of allProcs) if (p.key === key) return p;
	// Adopted orphans (below) live in procs, not allProcs.
	for (const p of procs.values()) if (p.key === key) return p;
	return undefined;
}

/** A pi that survived a pi-web crash: its stdin died with the old server, but
 *  its bridge socket can re-attach (the Bridge re-attaches by key on hello).
 *  Adopt it so its open quizzes stay answerable; the next real message swaps
 *  it for a clean pi on the same session file (see ensureProc). */
function adoptOrphan(key, pid) {
	let args;
	try {
		args = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
	} catch {
		return undefined;
	}
	const i = args.indexOf("--session");
	if (i < 0 || !args[i + 1]) return undefined;
	const meta = index.getByFile(args[i + 1]);
	if (!meta || procs.has(meta.id)) return undefined; // a live server-spawned pi owns it
	const stub = {
		key,
		sessionId: meta.id,
		sessionFile: meta.file,
		sessionName: meta.name,
		cwd: meta.cwd,
		adopted: true,
		pid,
		state: "ready",
		startedAt: Date.now(),
		live: createLive(),
		info() {
			return { state: "ready", pid, adopted: true, sessionId: this.sessionId, sessionFile: this.sessionFile, sessionName: this.sessionName, busy: this.live.busy };
		},
		write() {
			return false; // stdin went with the old server
		},
		request() {
			return Promise.reject(new Error("this pi survived a pi-web restart; it is being replaced"));
		},
		stop() {
			try {
				process.kill(pid, "SIGTERM");
			} catch {
				// already gone
			}
		},
	};
	procs.set(meta.id, stub);
	console.log(`[pi-web] adopted orphan pi (pid ${pid}) for session ${meta.id}`);
	return stub;
}

/** Unblock anything pi is waiting on from the user (used before aborting). */
function cancelInteractive(p) {
	for (const uid of Object.keys(p.live.bridge)) bridge.send(p.key, { t: "ui_cancel", uid });
	for (const id of Object.keys(p.live.dialogs)) {
		p.write({ type: "extension_ui_response", id, cancelled: true });
		delete p.live.dialogs[id];
		broadcastSession(p.sessionId, "ui_done", { id });
	}
}

bridge.on("connect", (key, pid) => {
	let p = procByKey(key);
	if (!p && typeof pid === "number") p = adoptOrphan(key, pid);
	if (!p) return;
	p.bridgeConnected = true;
	broadcastSession(p.sessionId, "proc", p.info());
});
bridge.on("message", (key, msg) => {
	const p = procByKey(key);
	if (!p) return;
	const sid = p.sessionId;
	switch (msg.t) {
		case "ui_open": {
			const ui = {
				uid: msg.uid,
				kind: msg.kind,
				toolCallId: msg.toolCallId,
				args: msg.args,
				displayOptions: msg.displayOptions,
				lines: msg.lines || [],
				openedAt: Date.now(),
			};
			p.live.bridge[msg.uid] = ui;
			broadcastSession(sid, "bridge_open", ui);
			broadcastAll("attention", { sessionId: sid, kind: msg.kind });
			break;
		}
		case "ui_render": {
			const ui = p.live.bridge[msg.uid];
			if (!ui) break;
			ui.lines = msg.lines;
			broadcastSession(sid, "bridge_render", { uid: msg.uid, lines: msg.lines });
			break;
		}
		case "ui_close":
			delete p.live.bridge[msg.uid];
			broadcastSession(sid, "bridge_close", { uid: msg.uid });
			break;
		case "widget":
			if (msg.lines) p.live.widgets[msg.key] = { lines: msg.lines, placement: msg.placement, ansi: true };
			else delete p.live.widgets[msg.key];
			broadcastSession(sid, "widget", { key: msg.key, widget: p.live.widgets[msg.key] ?? null });
			break;
	}
});

// Stop pi processes nobody has looked at for a while (like closing a terminal).
setInterval(() => {
	const now = Date.now();
	for (const [id, p] of procs) {
		if (p.state !== "ready" || p.live.busy) continue;
		const watched = [...clients].some((c) => c.sessionId === id);
		const waiting = Object.keys(p.live.dialogs).length + Object.keys(p.live.bridge).length > 0;
		if (!watched && !waiting && now - p.lastActivity > IDLE_STOP_MS) {
			p.stopRequested = true;
			p.stop();
		}
	}
}, 60_000).unref();

// ── images referenced by messages ───────────────────────────────────────────

const imageCache = new Map();
function cachedImage(file, ref) {
	const key = `${file}#${ref}`;
	if (imageCache.has(key)) return imageCache.get(key);
	const img = readImage(file, ref);
	if (img) {
		imageCache.set(key, img);
		if (imageCache.size > 40) imageCache.delete(imageCache.keys().next().value);
	}
	return img;
}

// Obsidian resolves ![[name.png]] by filename anywhere in the vault; mimic that.
let assetIndex = { builtAt: 0, byName: new Map() };
function buildAssetIndex() {
	const byName = new Map();
	let budget = 40_000;
	const walk = (dir, depth) => {
		let items;
		try {
			items = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const item of items) {
			if (budget-- <= 0) return;
			if (item.name.startsWith(".") || item.name === "node_modules") continue;
			const full = path.join(dir, item.name);
			if (item.isDirectory()) {
				if (depth < 6) walk(full, depth + 1);
			} else if (IMAGE_EXT.has(path.extname(item.name).toLowerCase()) && !byName.has(item.name.toLowerCase())) {
				byName.set(item.name.toLowerCase(), full);
			}
		}
	};
	for (const dir of config.assetDirs) walk(dir, 0);
	assetIndex = { builtAt: Date.now(), byName };
}

function windowsToWsl(p) {
	const m = /^([a-zA-Z]):[\\/](.*)$/.exec(p);
	return m ? `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, "/")}` : p;
}

function resolveEmbed(meta, name) {
	const clean = windowsToWsl(name.trim());
	const base = path.basename(clean);
	if (path.isAbsolute(clean) && isFile(clean)) return clean;
	const dirs = [...config.assetDirs];
	if (meta?.cwd) dirs.push(path.join(meta.cwd, "viz"), meta.cwd);
	for (const dir of dirs) {
		for (const candidate of [path.join(dir, clean), path.join(dir, base)]) if (isFile(candidate)) return candidate;
	}
	if (!config.assetDirs.length) return undefined;
	let hit = assetIndex.byName.get(base.toLowerCase());
	if ((!hit || !isFile(hit)) && Date.now() - assetIndex.builtAt > 15_000) {
		buildAssetIndex();
		hit = assetIndex.byName.get(base.toLowerCase());
	}
	return hit && isFile(hit) ? hit : undefined;
}

function sendImageFile(res, file) {
	const ext = path.extname(file).toLowerCase();
	if (!IMAGE_EXT.has(ext)) throw new HttpError(403, "Only images can be served");
	const stat = fs.statSync(file);
	res.writeHead(200, {
		"Content-Type": MIME[ext],
		"Content-Length": stat.size,
		"Cache-Control": "private, max-age=60",
		"Content-Security-Policy": IMAGE_CSP,
	});
	fs.createReadStream(file).pipe(res);
}

// ── HTTP plumbing ───────────────────────────────────────────────────────────

const allowedHosts = new Set(
	[`localhost:${config.port}`, `127.0.0.1:${config.port}`, `[::1]:${config.port}`]
		.concat((process.env.PI_WEB_ALLOWED_HOSTS || "").split(","))
		.map((h) => h.trim().toLowerCase())
		.filter(Boolean),
);

function sendJson(res, status, body) {
	const text = JSON.stringify(body);
	res.writeHead(status, {
		"Content-Type": "application/json; charset=utf-8",
		"Content-Length": Buffer.byteLength(text),
		"Cache-Control": "no-store",
	});
	res.end(text);
}

function readJsonBody(req, limit = 48 * 1024 * 1024) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let size = 0;
		req.on("data", (chunk) => {
			size += chunk.length;
			if (size > limit) {
				reject(new HttpError(413, "Request too large"));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => {
			try {
				resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {});
			} catch {
				reject(new HttpError(400, "Invalid JSON"));
			}
		});
		req.on("error", reject);
	});
}

function serveStatic(req, res, baseDir, relPath, cacheSeconds) {
	let rel;
	try {
		rel = decodeURIComponent(relPath);
	} catch {
		throw new HttpError(400, "Bad path");
	}
	const full = path.resolve(baseDir, `.${path.posix.normalize(`/${rel}`)}`);
	if (full !== baseDir && !full.startsWith(baseDir + path.sep)) throw new HttpError(403, "Forbidden");
	let stat;
	try {
		stat = fs.statSync(full);
	} catch {
		throw new HttpError(404, "Not found");
	}
	if (!stat.isFile()) throw new HttpError(404, "Not found");
	const lastModified = stat.mtime.toUTCString();
	if (req.headers["if-modified-since"] === lastModified) {
		res.writeHead(304);
		res.end();
		return;
	}
	res.writeHead(200, {
		"Content-Type": MIME[path.extname(full).toLowerCase()] || "application/octet-stream",
		"Content-Length": stat.size,
		"Last-Modified": lastModified,
		"Cache-Control": cacheSeconds ? `public, max-age=${cacheSeconds}` : "no-cache",
	});
	fs.createReadStream(full).pipe(res);
}

function servePage(res) {
	const html = fs.readFileSync(path.join(PUBLIC, "index.html"), "utf8").replace("__PI_WEB_TOKEN__", config.token);
	res.writeHead(200, {
		"Content-Type": "text/html; charset=utf-8",
		"Cache-Control": "no-store",
		"Content-Security-Policy": PAGE_CSP,
	});
	res.end(html);
}

function handleStream(req, res, url) {
	const sessionId = url.searchParams.get("session") || null;
	res.writeHead(200, {
		"Content-Type": "text/event-stream; charset=utf-8",
		"Cache-Control": "no-cache, no-transform",
		Connection: "keep-alive",
		"X-Accel-Buffering": "no",
	});
	res.write("retry: 2000\n\n");
	const client = { id: ++clientSeq, res, sessionId, file: null };
	const meta = sessionId ? metaFor(sessionId) : undefined;
	if (meta?.file) {
		acquireTail(meta.file);
		client.file = meta.file;
	}
	clients.add(client);
	sse(client, "hello", {
		version: VERSION,
		commit,
		piVersion,
		piBin: config.piBin || null,
		bridge: bridgeReady,
		home: os.homedir(),
		sessionsDir: config.sessionsDir,
		antigravity: !!agy,
		sessions: allSessions(),
		procs: [...procs.values()].map(procSummary),
		session: sessionId ? snapshot(sessionId) : null,
	});
	const ping = setInterval(() => res.write(": ping\n\n"), 20_000);
	req.on("close", () => {
		clearInterval(ping);
		clients.delete(client);
		if (client.file) releaseTail(client.file);
	});
}

const PASSTHROUGH = new Set([
	"get_state",
	"set_model",
	"get_available_models",
	"set_thinking_level",
	"get_available_thinking_levels",
	"abort",
	"clear_queue",
	"steer",
	"follow_up",
	"compact",
	"set_auto_compaction",
	"abort_retry",
	"bash",
	"abort_bash",
	"get_session_stats",
	"export_html",
	"get_commands",
	"set_session_name",
	"get_last_assistant_text",
]);
// Commands that only make sense for a pi that is already running.
const NO_SPAWN = new Set(["abort", "clear_queue", "abort_bash", "abort_retry"]);
const REFRESH_AFTER = new Set(["set_model", "set_thinking_level", "set_session_name"]);

async function handleApiPost(route, body) {
	switch (route) {
		case "/api/prompt": {
			const { session, message, images, behavior } = body;
			const hasImages = Array.isArray(images) && images.length > 0;
			if (typeof message !== "string" || (!message.trim() && !hasImages)) throw new HttpError(400, "Nothing to send");
			if (isAgy(session)) {
				const meta = metaFor(session);
				if (!meta || !agyLive) throw new HttpError(404, "Unknown Antigravity conversation");
				if (hasImages) throw new HttpError(400, "Images can't be sent to Antigravity from here yet.");
				try {
					await agyLive.sendMessage(meta.uuid, message, { projectId: meta.projectId });
				} catch (err) {
					throw new HttpError(err.status || 502, err.message);
				}
				setTimeout(() => agy.refresh().catch(() => {}), 1500);
				return { ok: true };
			}
			const p = await ensureProc(session);
			const command = { type: "prompt", message, streamingBehavior: behavior === "followUp" ? "followUp" : "steer" };
			if (hasImages) {
				command.images = images
					.filter((i) => i && typeof i.data === "string" && /^image\/(png|jpeg|gif|webp)$/.test(i.mimeType))
					.map((i) => ({ type: "image", data: i.data, mimeType: i.mimeType }));
			}
			await p.request(command);
			return { ok: true };
		}
		case "/api/upload": {
			// A file from the browser, saved into the session's folder, so its path
			// can be pasted into the message box and pi can read it like any file.
			const { session, name, data } = body;
			if (isAgy(session)) throw new HttpError(400, "Files can be attached to pi sessions; Antigravity conversations can't read local files.");
			if (typeof data !== "string" || !data) throw new HttpError(400, "No file data");
			const meta = index.get(session);
			if (!meta) throw new HttpError(404, "Unknown session");
			if (!meta.cwd || !isDir(meta.cwd)) throw new HttpError(400, "This session's folder doesn't exist, so there's nowhere to put the file.");
			const buffer = Buffer.from(data, "base64");
			if (!buffer.length) throw new HttpError(400, "That file is empty.");
			if (buffer.length > 32 * 1024 * 1024) throw new HttpError(413, "That file is larger than 32 MB.");
			const dir = path.join(meta.cwd, "pi-web-uploads");
			fs.mkdirSync(dir, { recursive: true });
			// Keep the name readable but harmless: no path parts, no control characters.
			const safe = (String(name || "file")
				.replace(/[/\\?%*:|"<>\x00-\x1f]/g, "_")
				.replace(/^[.\s]+/, "")
				.slice(0, 120) || "file");
			// Same name as before: same content = reuse, different = a numbered copy.
			let file = path.join(dir, safe);
			for (let n = 2; fs.existsSync(file); n++) {
				if (isFile(file) && fs.statSync(file).size === buffer.length) break; // same file again
				file = path.join(dir, `${n}-${safe}`);
			}
			fs.writeFileSync(file, buffer);
			return { ok: true, path: file, name: path.basename(file) };
		}
		case "/api/gemini/login": {
			const state = await startGeminiLogin();
			if (state.error) throw new HttpError(502, state.error);
			return { ok: true, ...state };
		}
		case "/api/gemini/read": {
			const { session, ref, path: filePath, name, data, mimeType, prompt, model } = body;
			let image;
			let mime = typeof mimeType === "string" && /^image\/.+$/.test(mimeType) ? mimeType : "";
			if (typeof data === "string" && data) {
				image = Buffer.from(data, "base64");
				if (!mime) mime = "image/png";
			} else if (ref) {
				const meta = index.get(session);
				if (!meta) throw new HttpError(404, "Unknown session");
				const img = readImage(meta.file, String(ref));
				if (!img) throw new HttpError(404, "Image not found");
				image = img.data;
				mime = img.mimeType;
			} else if (filePath || name) {
				let p = windowsToWsl(String(filePath || name));
				const meta = index.get(session);
				if (!path.isAbsolute(p)) {
					// An embed by bare name resolves the way ![[image.png]] does.
					if (name && !filePath) {
						const resolved = resolveEmbed(meta, String(name));
						if (!resolved) throw new HttpError(404, "Image not found");
						p = resolved;
					} else p = path.resolve(meta?.cwd || os.homedir(), p);
				}
				if (!isFile(p)) throw new HttpError(404, "File not found");
				if (!/^\.(png|jpe?g|webp|gif)$/i.test(path.extname(p))) throw new HttpError(400, "Only PNG, JPEG, WebP and GIF images can be read");
				image = fs.readFileSync(p);
				mime = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif" }[path.extname(p).toLowerCase()] || "image/png";
			} else throw new HttpError(400, "Nothing to read: no image");
			try {
				const out = await geminiRead({ image, mimeType: mime, prompt, model });
				return { ok: true, ...out };
			} catch (err) {
				throw new HttpError(502, String(err.message || err));
			}
		}
		case "/api/command": {
			const { session, command } = body;
			if (!command || !PASSTHROUGH.has(command.type)) throw new HttpError(400, "That command is not available here");
			if (isAgy(session)) {
				if (NO_SPAWN.has(command.type)) return { ok: true, data: null };
				throw new HttpError(400, "That only works for pi sessions; manage Antigravity conversations in the Antigravity app.");
			}
			if (NO_SPAWN.has(command.type) && !procs.get(session)) return { ok: true, data: null };
			const p = await ensureProc(session);
			if (command.type === "abort") cancelInteractive(p);
			const { id: _clientId, ...rest } = command;
			const data = await p.request(rest);
			if (REFRESH_AFTER.has(command.type)) p.refreshState().catch(() => {});
			return { ok: true, data };
		}
		case "/api/ui-response": {
			const { session, id, value, confirmed, cancelled } = body;
			const p = procs.get(session);
			if (!p || !p.live.dialogs[id]) return { ok: true, stale: true };
			const record = { type: "extension_ui_response", id };
			if (cancelled) record.cancelled = true;
			else if (typeof confirmed === "boolean") record.confirmed = confirmed;
			else record.value = value;
			p.write(record);
			delete p.live.dialogs[id];
			broadcastSession(session, "ui_done", { id });
			return { ok: true };
		}
		case "/api/bridge": {
			const { session, uid, action, value, data, cols } = body;
			const p = procs.get(session);
			if (!p) return { ok: true, stale: true };
			if (action === "resize") {
				bridge.send(p.key, { t: "width", cols });
				return { ok: true };
			}
			if (!p.live.bridge[uid]) return { ok: true, stale: true };
			if (action === "answer") bridge.send(p.key, { t: "ui_answer", uid, value });
			else if (action === "key") bridge.send(p.key, { t: "ui_key", uid, data: String(data ?? "") });
			else if (action === "cancel") bridge.send(p.key, { t: "ui_cancel", uid });
			else throw new HttpError(400, "Unknown action");
			return { ok: true };
		}
		case "/api/session/archive": {
			const { session } = body;
			const on = body.archived !== false;
			const meta = metaFor(session);
			if (!meta) throw new HttpError(404, "Unknown session");
			if (on) archived.add(session);
			else archived.delete(session);
			writeArchived();
			const fresh = metaFor(session);
			if (fresh) {
				fresh.archived = archived.has(session);
				broadcastAll("session_upsert", fresh);
			}
			return { ok: true, archived: archived.has(session) };
		}
		case "/api/session/delete": {
			const { session } = body;
			if (isAgy(session)) throw new HttpError(400, "Antigravity conversations live in the Antigravity app — archive it here instead, or delete it there.");
			const meta = index.get(session);
			if (!meta) throw new HttpError(404, "Unknown session");
			if (meta.pending) throw new HttpError(409, "pi has not saved this session yet; stop pi first, then delete.");
			if (!meta.file) throw new HttpError(400, "This session has no file to delete.");
			const file = path.resolve(meta.file);
			if (!file.startsWith(path.resolve(config.sessionsDir) + path.sep)) throw new HttpError(403, "Refusing to delete a file outside pi's sessions folder.");
			const p = procs.get(session);
			if (p) {
				// A pi that keeps running would recreate the file on its next message.
				cancelInteractive(p);
				p.stopRequested = true;
				p.stop();
			}
			fs.rmSync(file, { force: true });
			archived.delete(session);
			writeArchived();
			index.remove(file); // the watcher would too; do it now
			broadcastAll("session_remove", { id: session });
			return { ok: true };
		}
		case "/api/process": {
			const { session, action } = body;
			if (action === "start") return { ok: true, proc: (await ensureProc(session)).info() };
			if (action === "stop") {
				const p = procs.get(session);
				if (p) {
					cancelInteractive(p);
					p.stopRequested = true;
					p.stop();
				}
				return { ok: true };
			}
			throw new HttpError(400, "Unknown action");
		}
		case "/api/new": {
			if (body.kind !== "antigravity") return { ok: true, session: await newSession(body.cwd) };
			if (!agyLive) throw new HttpError(404, "Antigravity was not found on this machine.");
			const prompt = String(body.prompt || "").trim();
			if (!prompt) throw new HttpError(400, "Write the first message for Antigravity.");
			const model = ["flash_lite", "flash", "pro"].includes(body.model) ? body.model : "flash";
			let projectId = typeof body.projectId === "string" && body.projectId ? body.projectId : null;
			if (!projectId && body.cwd) projectId = (await findOrCreateAgyProject(body.cwd)).projectId;
			let uuid;
			try {
				uuid = await agyLive.newConversation(prompt, { model, title: String(body.title || "").trim() || undefined, projectId: projectId || undefined });
			} catch (err) {
				throw new HttpError(err.status || 502, err.message);
			}
			await awaitAgyConversation(AGY_PREFIX + uuid);
			return { ok: true, session: AGY_PREFIX + uuid };
		}
		case "/api/agy/project": {
			// Open (find-or-create) an Antigravity project for a folder, so its
			// agents can work the same folder pi works.
			const r = await findOrCreateAgyProject(body.cwd);
			return { ok: true, ...r };
		}
		case "/api/agy/launch": {
			if (!agyApp || !fs.existsSync(agyApp.local)) throw new HttpError(404, "The Antigravity app was not found.");
			agyLive.launch(agyApp.windows);
			return { ok: true };
		}
		default:
			throw new HttpError(404, "Not found");
	}
}

function listDirs(dir) {
	const target = path.resolve(windowsToWsl(dir || os.homedir()));
	const items = fs.readdirSync(target, { withFileTypes: true });
	return {
		path: target,
		parent: path.dirname(target) !== target ? path.dirname(target) : null,
		dirs: items
			.filter((d) => d.isDirectory() && !d.name.startsWith("."))
			.map((d) => d.name)
			.sort((a, b) => a.localeCompare(b))
			.slice(0, 300),
	};
}

function handleApiGet(req, res, url) {
	const route = url.pathname;
	const session = url.searchParams.get("session");
	switch (route) {
		case "/api/health":
			return sendJson(res, 200, { ok: true, version: VERSION, commit, piVersion, piBin: config.piBin || null });
		case "/api/sessions":
			return sendJson(res, 200, { sessions: index.list(), projects: index.projects() });
		case "/api/projects":
			return sendJson(res, 200, { projects: index.projects(), home: os.homedir() });
		case "/api/usage":
			return claudeUsage.get({ force: url.searchParams.get("force") === "1" }).then((usage) => sendJson(res, 200, usage));
		case "/api/search": {
			const q = (url.searchParams.get("q") || "").trim();
			if (q.length < 2) return sendJson(res, 200, { q, results: [] });
			return searchSessions(q)
				.then((results) => sendJson(res, 200, { q, results }))
				.catch((err) => sendJson(res, 200, { q, results: [], error: String(err.message || err) }));
		}
		case "/api/agy/status": {
			if (!agyLive) return sendJson(res, 200, { installed: false });
			return agyLive.quota({ force: url.searchParams.get("force") === "1" }).then((q) => sendJson(res, 200, { installed: true, ...q }));
		}
		case "/api/gemini/status":
			return sendJson(res, 200, geminiStatus());
		case "/api/agy/artifact": {
			const meta = agy && metaFor(session);
			const text = meta ? readArtifact(agyDir, meta.uuid, url.searchParams.get("name") || "") : undefined;
			if (text === undefined) throw new HttpError(404, "Artifact not found");
			return sendJson(res, 200, { name: url.searchParams.get("name"), text });
		}
		case "/api/dirs": {
			try {
				return sendJson(res, 200, listDirs(url.searchParams.get("path")));
			} catch (err) {
				throw new HttpError(400, err.message);
			}
		}
		case "/api/entry": {
			const meta = index.get(session);
			const entry = meta?.file ? readFullEntry(meta.file, url.searchParams.get("entry") || "") : undefined;
			if (!entry) throw new HttpError(404, "Entry not found");
			return sendJson(res, 200, { entry });
		}
		case "/api/image": {
			const meta = index.get(session);
			const ref = url.searchParams.get("ref") || "";
			const img = meta?.file && ref ? cachedImage(meta.file, ref) : undefined;
			if (!img) throw new HttpError(404, "Image not found");
			const type = /^image\/(png|jpeg|gif|webp|avif|bmp)$/.test(img.mimeType) ? img.mimeType : "application/octet-stream";
			res.writeHead(200, {
				"Content-Type": type,
				"Content-Length": img.data.length,
				"Cache-Control": "private, max-age=86400",
				"Content-Security-Policy": IMAGE_CSP,
			});
			return res.end(img.data);
		}
		case "/api/embed": {
			const file = resolveEmbed(index.get(session), url.searchParams.get("name") || "");
			if (!file) throw new HttpError(404, "Image not found");
			return sendImageFile(res, file);
		}
		case "/api/file": {
			const meta = metaFor(session);
			let p = windowsToWsl(url.searchParams.get("path") || "");
			// Antigravity artifacts refer to files next to them, in the conversation's own folder.
			const base = meta?.kind === "antigravity" ? agy.brainDir(meta.uuid) : meta?.cwd;
			if (!path.isAbsolute(p)) p = path.resolve(base || os.homedir(), p);
			if (!isFile(p)) throw new HttpError(404, "File not found");
			return sendImageFile(res, p);
		}
		case "/api/stream":
			if (url.searchParams.get("token") !== config.token) throw new HttpError(403, "Bad token");
			return handleStream(req, res, url);
		default:
			throw new HttpError(404, "Not found");
	}
}

async function handle(req, res) {
	res.setHeader("X-Content-Type-Options", "nosniff");
	res.setHeader("Referrer-Policy", "no-referrer");
	res.setHeader("X-Frame-Options", "DENY");

	// Refuse other hostnames: stops DNS-rebinding pages from reading this API.
	if (!allowedHosts.has(String(req.headers.host || "").toLowerCase())) throw new HttpError(403, "Unexpected Host header");

	const url = new URL(req.url, "http://localhost");
	const route = url.pathname;

	if (req.method === "POST") {
		const origin = req.headers.origin;
		if (origin && !allowedHosts.has(origin.replace(/^https?:\/\//, "").toLowerCase())) throw new HttpError(403, "Cross-origin request refused");
		if (req.headers["x-pi-web-token"] !== config.token) throw new HttpError(403, "Missing or wrong token (reload the page)");
		const body = await readJsonBody(req);
		return sendJson(res, 200, await handleApiPost(route, body));
	}
	if (req.method !== "GET" && req.method !== "HEAD") throw new HttpError(405, "Method not allowed");

	if (route === "/" || route === "/index.html") return servePage(res);
	if (route.startsWith("/api/")) return handleApiGet(req, res, url);
	if (route.startsWith("/vendor/")) {
		const [, , name, ...rest] = route.split("/");
		const base = VENDOR[name];
		if (!base) throw new HttpError(404, "Not found");
		return serveStatic(req, res, base, rest.join("/"), 86400);
	}
	if (/^\/(js|css|img)\//.test(route) || route === "/favicon.svg" || route === "/favicon.ico") return serveStatic(req, res, PUBLIC, route, 0);
	throw new HttpError(404, "Not found");
}

const server = http.createServer((req, res) => {
	handle(req, res).catch((err) => {
		const status = err instanceof HttpError ? err.status : 500;
		if (status === 500) console.error(`[pi-web] ${req.method} ${req.url}:`, err);
		if (res.headersSent) {
			res.end();
			return;
		}
		sendJson(res, status, { error: err.message || "Internal error" });
	});
});

// ── startup ─────────────────────────────────────────────────────────────────

index.on("upsert", (meta) => { meta.archived = archived.has(meta.id); broadcastAll("session_upsert", meta); });
index.on("remove", (id) => broadcastAll("session_remove", { id }));

function shutdown() {
	for (const p of allProcs) {
		p.stopRequested = true;
		p.stop();
	}
	bridge.close();
	server.close();
	setTimeout(() => process.exit(0), 1500).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("SIGHUP", shutdown);

await index.scan();
index.watch();
if (agy) {
	agy.on("upsert", (meta) => { meta.archived = archived.has(meta.id); broadcastAll("session_upsert", meta); });
	agy.on("remove", (id) => broadcastAll("session_remove", { id }));
	await agy.start().catch((err) => console.warn(`[pi-web] Antigravity: ${err.message}`));
}

try {
	await bridge.listen();
	bridgeReady = true;
} catch (err) {
	console.warn(`[pi-web] quiz/question pop-ups disabled (bridge socket failed: ${err.message})`);
}

if (config.piBin) {
	execFile(config.piBin, ["--version"], { env: config.env, timeout: 20_000 }, (err, stdout) => {
		if (!err) piVersion = stdout.trim().split("\n").pop();
	});
}

server.on("error", (err) => {
	if (err.code === "EADDRINUSE") console.error(`[pi-web] Port ${config.port} is already in use. Is pi-web already running? Or pick another: --port ${config.port + 1}`);
	else console.error(`[pi-web] ${err.message}`);
	process.exit(1);
});

server.listen(config.port, config.host, () => {
	console.log(`pi-web ${VERSION}`);
	console.log(`  open      http://localhost:${config.port}`);
	console.log(`  sessions  ${config.sessionsDir} (${index.byFile.size} found)`);
	console.log(`  pi        ${config.piBin || "NOT FOUND — reading works, chatting does not"}`);
	if (config.assetDirs.length) console.log(`  images    ${config.assetDirs.join(", ")}`);
	if (agy) console.log(`  antigrav. ${agyDir} (${agy.list().length} conversations)`);
	if (!process.env.TMUX) console.log("  note      not inside tmux: pi subagents (tmux panes) will not work from the GUI");
});
