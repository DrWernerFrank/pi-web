// Google Antigravity conversations, shown next to pi sessions.
//
// Antigravity (a Windows app here) keeps, under ~/.gemini/antigravity:
//   conversation_summaries.db                     titles, previews, running state, parent/subagent links
//   brain/<id>/.system_generated/logs/transcript_full.jsonl   the full step-by-step transcript
//   brain/<id>/*.md                               artifacts (plans, walkthroughs, write-ups)
// Transcripts are converted into pi-shaped entries so the same page renders both.
// Windows writes to these files are invisible to inotify inside WSL, so everything polls.

import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const AGY_PREFIX = "agy:";
const POLL_MS = 3000;

// ── locating the data folder ────────────────────────────────────────────────

export function findAntigravityDir() {
	const explicit = process.env.PI_WEB_ANTIGRAVITY_DIR;
	if (explicit) return fs.existsSync(explicit) ? path.resolve(explicit) : undefined;
	const candidates = [path.join(os.homedir(), ".gemini", "antigravity")];
	// Inside WSL the app lives on the Windows side: /mnt/<drive>/Users/<user>/.gemini/antigravity.
	try {
		for (const drive of fs.readdirSync("/mnt")) {
			const users = path.join("/mnt", drive, "Users");
			let names = [];
			try {
				names = fs.readdirSync(users);
			} catch {
				continue;
			}
			for (const user of names) candidates.push(path.join(users, user, ".gemini", "antigravity"));
		}
	} catch {
		// not WSL
	}
	const found = candidates.filter((dir) => fs.existsSync(path.join(dir, "brain")));
	found.sort((a, b) => mtime(b) - mtime(a));
	return found[0];
}

function mtime(p) {
	try {
		return fs.statSync(p).mtimeMs;
	} catch {
		return 0;
	}
}

// ── reading the summaries database (copied first, so the app's DB is never locked) ─

let sqlite;
async function loadSqlite() {
	if (sqlite !== undefined) return sqlite;
	const emit = process.emitWarning;
	process.emitWarning = (warning, ...rest) => (String(warning).includes("SQLite") ? undefined : emit.call(process, warning, ...rest));
	try {
		sqlite = await import("node:sqlite");
	} catch {
		sqlite = null;
	} finally {
		process.emitWarning = emit;
	}
	return sqlite;
}

function isoTime(value) {
	if (!value) return undefined;
	const m = /^(\d{4}-\d\d-\d\d)[ T](\d\d:\d\d:\d\d)(\.\d+)?(.*)$/.exec(String(value));
	if (!m) return undefined;
	const ms = Date.parse(`${m[1]}T${m[2]}${m[3] ? m[3].slice(0, 4) : ""}${m[4] || "Z"}`);
	return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

function workspacePath(uris) {
	const m = /file:\/\/\/?([^\s,"\]]+)/.exec(uris || "");
	if (!m) return "";
	let p = decodeURIComponent(m[1]);
	const win = /^([a-zA-Z]):[\\/](.*)$/.exec(p);
	if (win && process.platform !== "win32") p = `/mnt/${win[1].toLowerCase()}/${win[2].replace(/\\/g, "/")}`;
	return p;
}

// ── the index (sidebar list) ────────────────────────────────────────────────

export class AntigravityIndex extends EventEmitter {
	constructor(dir) {
		super();
		this.dir = dir;
		this.metas = new Map();
		this.stamp = "";
		this.tmp = path.join(os.tmpdir(), `pi-web-${process.getuid?.() ?? "user"}`, "antigravity");
	}

	brainDir(uuid) {
		return path.join(this.dir, "brain", uuid);
	}

	async start() {
		await this.refresh();
		this.timer = setInterval(() => this.refresh().catch(() => {}), POLL_MS);
		this.timer.unref?.();
	}

	close() {
		clearInterval(this.timer);
	}

	/** A cheap fingerprint: the summaries DB and each transcript's size/mtime. */
	fingerprint() {
		const parts = [];
		for (const f of ["conversation_summaries.db", "conversation_summaries.db-wal"]) {
			try {
				const s = fs.statSync(path.join(this.dir, f));
				parts.push(`${s.mtimeMs}:${s.size}`);
			} catch {
				parts.push("-");
			}
		}
		let ids = [];
		try {
			ids = fs.readdirSync(path.join(this.dir, "brain"));
		} catch {
			// none yet
		}
		for (const id of ids) parts.push(`${id}:${mtime(transcriptFile(this.brainDir(id)) || "")}`);
		return parts.join("|");
	}

	async refresh() {
		const stamp = this.fingerprint();
		if (stamp === this.stamp) return;
		this.stamp = stamp;
		const rows = (await this.readSummaries()) ?? this.scanBrain();
		const next = new Map();
		for (const row of rows) next.set(row.id, row);
		// Parents list their subagents.
		for (const meta of next.values()) {
			meta.subagents = [];
			meta.children = [];
		}
		for (const meta of next.values()) {
			const parent = meta.parentId && next.get(meta.parentId);
			if (!parent) continue;
			parent.subagents.push({
				file: meta.file,
				id: meta.id,
				agent: meta.agent || "subagent",
				name: meta.agentName,
				launchedAt: meta.created || meta.lastActivity,
				done: !meta.running,
				exitCode: meta.killed ? 1 : 0,
			});
		}
		for (const meta of next.values()) meta.childCount = meta.subagents.length;
		const changed = [];
		for (const [id, meta] of next) {
			const old = this.metas.get(id);
			if (!old || JSON.stringify(old) !== JSON.stringify(meta)) changed.push(meta);
		}
		const removed = [...this.metas.keys()].filter((id) => !next.has(id));
		this.metas = next;
		for (const meta of changed) this.emit("upsert", meta);
		for (const id of removed) this.emit("remove", id);
	}

	async readSummaries() {
		const lib = await loadSqlite();
		const src = path.join(this.dir, "conversation_summaries.db");
		if (!lib || !fs.existsSync(src)) return undefined;
		try {
			fs.mkdirSync(this.tmp, { recursive: true });
			const copy = path.join(this.tmp, "summaries.db");
			for (const ext of ["", "-wal", "-shm"]) {
				try {
					fs.copyFileSync(src + ext, copy + ext);
				} catch {
					fs.rmSync(copy + ext, { force: true });
				}
			}
			const db = new lib.DatabaseSync(copy);
			try {
				const rows = db
					.prepare(
						"SELECT conversation_id, title, preview, step_count, last_modified_time, workspace_uris, status, agent_name, parent_conversation_id, not_fully_idle, killed, last_user_input_time, project_id FROM conversation_summaries",
					)
					.all();
				return rows.map((r) => this.metaFromRow(r));
			} finally {
				db.close();
			}
		} catch {
			return undefined;
		}
	}

	metaFromRow(r) {
		const uuid = r.conversation_id;
		const title = String(r.title || "").trim();
		const transcript = transcriptFile(this.brainDir(uuid));
		let preview = String(r.preview || "").trim();
		// Antigravity sometimes titles a conversation "<thinking>": use the first request instead.
		if (!preview || /^<[^>]+>$/.test(preview)) preview = firstRequest(transcript) || preview;
		const usefulTitle = title && !/^<[^>]+>$/.test(title) ? title : "";
		const lastActivity = isoTime(r.last_modified_time);
		const running = Number(r.not_fully_idle) === 1 || /RUNNING/.test(String(r.status || ""));
		return {
			id: AGY_PREFIX + uuid,
			uuid,
			kind: "antigravity",
			file: AGY_PREFIX + uuid,
			cwd: workspacePath(r.workspace_uris),
			created: isoTime(r.last_user_input_time),
			lastActivity,
			mtime: Math.max(Date.parse(lastActivity || "") || 0, mtime(transcript || "")),
			name: usefulTitle || undefined,
			firstUser: preview.split("\n")[0].slice(0, 160),
			stepCount: Number(r.step_count) || 0,
			status: r.status,
			running,
			killed: Number(r.killed) === 1,
			parentId: r.parent_conversation_id ? AGY_PREFIX + r.parent_conversation_id : undefined,
			agent: r.agent_name || undefined,
			agentName: usefulTitle || preview.split("\n")[0].slice(0, 60),
			lastModel: "Antigravity",
			contextTokens: null,
			cost: 0,
			projectId: r.project_id || undefined,
			artifacts: listArtifacts(this.brainDir(uuid)),
		};
	}

	/** Without SQLite: list conversations from the brain folders and their transcripts. */
	scanBrain() {
		let ids = [];
		try {
			ids = fs.readdirSync(path.join(this.dir, "brain"));
		} catch {
			return [];
		}
		return ids.map((uuid) => {
			const transcript = transcriptFile(this.brainDir(uuid));
			let firstUser = "";
			try {
				const first = fs.readFileSync(transcript, "utf8").split("\n").find((l) => l.includes('"USER_INPUT"'));
				if (first) firstUser = userText(JSON.parse(first).content).split("\n")[0].slice(0, 160);
			} catch {
				// unreadable
			}
			let title;
			try {
				title = /title:"([^"]*)"/.exec(fs.readFileSync(path.join(this.dir, "annotations", `${uuid}.pbtxt`), "utf8"))?.[1];
			} catch {
				// no annotation
			}
			const t = mtime(transcript || this.brainDir(uuid));
			return {
				id: AGY_PREFIX + uuid,
				uuid,
				kind: "antigravity",
				file: AGY_PREFIX + uuid,
				cwd: "",
				lastActivity: new Date(t).toISOString(),
				mtime: t,
				name: title && !/^<[^>]+>$/.test(title) ? title : undefined,
				firstUser,
				running: Date.now() - t < 60_000,
				lastModel: "Antigravity",
				contextTokens: null,
				cost: 0,
				artifacts: listArtifacts(this.brainDir(uuid)),
			};
		});
	}

	get(id) {
		return this.metas.get(id);
	}

	list() {
		return [...this.metas.values()];
	}
}

const firstRequestCache = new Map();
function firstRequest(transcript) {
	if (!transcript) return "";
	const stamp = `${transcript}:${mtime(transcript)}`;
	if (firstRequestCache.has(stamp)) return firstRequestCache.get(stamp);
	let text = "";
	try {
		const line = fs.readFileSync(transcript, "utf8").split("\n").find((l) => l.includes('"USER_INPUT"'));
		if (line) text = userText(JSON.parse(line).content).replace(/\s+/g, " ").slice(0, 160);
	} catch {
		// unreadable
	}
	firstRequestCache.set(stamp, text);
	return text;
}

function transcriptFile(brainDir) {
	for (const name of ["transcript_full.jsonl", "transcript.jsonl"]) {
		const f = path.join(brainDir, ".system_generated", "logs", name);
		if (fs.existsSync(f)) return f;
	}
	return undefined;
}

export function listArtifacts(brainDir) {
	try {
		return fs
			.readdirSync(brainDir, { withFileTypes: true })
			.filter((d) => d.isFile() && /\.(md|markdown|txt)$/i.test(d.name))
			.map((d) => ({ name: d.name, mtime: mtime(path.join(brainDir, d.name)) }))
			.sort((a, b) => a.name.localeCompare(b.name));
	} catch {
		return [];
	}
}

/** An artifact's text, only from that conversation's own folder. */
export function readArtifact(dir, uuid, name) {
	if (!/^[0-9a-f-]{36}$/i.test(uuid) || !name || name !== path.basename(name) || !/\.(md|markdown|txt)$/i.test(name)) return undefined;
	try {
		return fs.readFileSync(path.join(dir, "brain", uuid, name), "utf8");
	} catch {
		return undefined;
	}
}

// ── transcript → pi-shaped entries ──────────────────────────────────────────

export function userText(content) {
	const text = String(content ?? "");
	const req = /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/.exec(text);
	return (req ? req[1] : text).trim();
}

function stripStepHeader(text) {
	return String(text ?? "").replace(/^(?:(?:Created|Completed) At: [^\n]*\n)+/, "").trim();
}

function fileUriToPath(uri) {
	if (!uri) return undefined;
	try {
		return decodeURIComponent(String(uri).replace(/^file:\/\/\/?/, ""));
	} catch {
		return String(uri).replace(/^file:\/\/\/?/, "");
	}
}

/** transcript.jsonl stores some argument values JSON-encoded; transcript_full does not. */
function cleanArgs(args) {
	const out = {};
	for (const [k, v] of Object.entries(args || {})) {
		if (typeof v === "string" && /^".*"$/s.test(v)) {
			try {
				out[k] = JSON.parse(v);
				continue;
			} catch {
				// keep as is
			}
		}
		out[k] = v;
	}
	return out;
}

const SYSTEM_MESSAGE = /\[Message\] timestamp=(\S+) sender=(\S+) priority=(\S+) content=([\s\S]*?)\s*<\/SYSTEM_MESSAGE>/;

export function convertTranscript(records) {
	const out = [];
	const pending = [];
	let prev = null;
	let n = 0;
	const push = (entry) => {
		entry.id = `agy${n++}`;
		entry.parentId = prev;
		prev = entry.id;
		out.push(entry);
	};
	for (const r of records) {
		const iso = r.created_at || undefined;
		const ts = Date.parse(iso || "") || 0;
		switch (r.type) {
			case "USER_INPUT": {
				const text = userText(r.content);
				if (text) push({ type: "message", timestamp: iso, message: { role: "user", content: [{ type: "text", text }], timestamp: ts } });
				break;
			}
			case "PLANNER_RESPONSE": {
				const content = [];
				if (r.thinking) content.push({ type: "thinking", thinking: String(r.thinking).replace(/^\[K\]\n?/, "") });
				if (r.content) content.push({ type: "text", text: String(r.content).replace(/^\[K\]\n?/, "") });
				(r.tool_calls || []).forEach((call, i) => {
					const { toolAction, toolSummary, ...args } = cleanArgs(call.args);
					const block = { type: "toolCall", id: `agy-${r.step_index}-${i}`, name: call.name, arguments: args, summary: toolSummary || toolAction };
					content.push(block);
					pending.push(block);
				});
				if (!content.length) break;
				push({
					type: "message",
					timestamp: iso,
					message: { role: "assistant", content, provider: "antigravity", model: "Antigravity", stopReason: r.tool_calls?.length ? "toolUse" : "stop", timestamp: ts },
				});
				break;
			}
			case "GENERIC": {
				if (r.status === "RUNNING") break; // its result is not in yet
				const call = pending.shift();
				const text = stripStepHeader(r.content);
				const content = [];
				const isError = r.status === "ERROR" || r.status === "INVALID";
				if (isError && r.error) content.push({ type: "text", text: String(r.error) });
				if (text) content.push({ type: "text", text });
				for (const m of r.media || []) {
					const p = fileUriToPath(m.uri);
					if (p) content.push({ type: "image", mimeType: m.mime_type || "image/png", path: p });
				}
				if (call) {
					const details = {};
					if (call.name === "invoke_subagent") details.subagents = [...text.matchAll(/"conversationId":\s*"([0-9a-f-]{36})"/g)].map((m) => AGY_PREFIX + m[1]);
					push({ type: "message", timestamp: iso, message: { role: "toolResult", toolCallId: call.id, toolName: call.name, content, isError, details, timestamp: ts } });
				} else if (content.length) {
					push({ type: "custom_message", customType: "antigravity_output", content, display: true, timestamp: iso });
				}
				break;
			}
			case "SYSTEM_MESSAGE": {
				const m = SYSTEM_MESSAGE.exec(String(r.content || ""));
				if (m && m[2] === "system") {
					// Sent through agentapi from outside the app (e.g. pi-web): it is the user talking.
					push({ type: "message", timestamp: iso, message: { role: "user", content: [{ type: "text", text: m[4] }], timestamp: ts, via: "outside" } });
				} else if (m) {
					push({
						type: "custom_message",
						customType: "antigravity_message",
						content: m[4],
						display: true,
						details: { sender: AGY_PREFIX + m[2], priority: m[3], sentAt: m[1] },
						timestamp: iso,
					});
				} else if (r.content) {
					push({ type: "custom_message", customType: "antigravity_system", content: String(r.content), display: true, timestamp: iso });
				}
				break;
			}
			case "CHECKPOINT":
				push({ type: "compaction", summary: String(r.content || "").replace(/^\{\{ CHECKPOINT \d+ \}\}\s*/, ""), timestamp: iso });
				break;
			case "ERROR_MESSAGE":
				push({
					type: "message",
					timestamp: iso,
					message: {
						role: "assistant",
						content: [],
						provider: "antigravity",
						model: "Antigravity",
						stopReason: "error",
						errorMessage: String(r.error || r.content || "Antigravity reported an error."),
						timestamp: ts,
					},
				});
				break;
		}
	}
	return out;
}

/**
 * Follows one Antigravity transcript. The file can be rewritten (a running
 * step becomes done), so each change re-reads it: if the old entries are
 * still a prefix, only the new ones are sent; otherwise listeners get "reset".
 */
export class AgyTail extends EventEmitter {
	constructor(brainDir) {
		super();
		this.brainDir = brainDir;
		this.header = null;
		this.entries = [];
		this.stamp = "";
		this.load();
	}

	read() {
		const file = transcriptFile(this.brainDir);
		if (!file) return { stamp: "-", entries: [] };
		let stat;
		try {
			stat = fs.statSync(file);
		} catch {
			return { stamp: "-", entries: [] };
		}
		const stamp = `${file}:${stat.mtimeMs}:${stat.size}`;
		if (stamp === this.stamp) return { stamp, entries: null };
		const records = [];
		for (const line of fs.readFileSync(file, "utf8").split("\n")) {
			if (!line.trim()) continue;
			try {
				records.push(JSON.parse(line));
			} catch {
				// partial line mid-write: picked up next time
			}
		}
		return { stamp, entries: convertTranscript(records) };
	}

	load() {
		const { stamp, entries } = this.read();
		this.stamp = stamp;
		if (entries) this.entries = entries;
	}

	poll() {
		const { stamp, entries } = this.read();
		if (!entries) return;
		this.stamp = stamp;
		const old = this.entries;
		const prefix = old.length <= entries.length && old.every((e, i) => JSON.stringify(e) === JSON.stringify(entries[i]));
		this.entries = entries;
		if (!prefix) this.emit("reset");
		else if (entries.length > old.length) this.emit("entries", entries.slice(old.length));
	}
}
