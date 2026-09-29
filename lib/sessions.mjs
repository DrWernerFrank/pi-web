// pi session files: an index for the sidebar, tails for sessions being
// viewed, and "slimming" so a browser can hold a long session comfortably
// (big base64 images become references, huge tool outputs are cut).

import { EventEmitter } from "node:events";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

const MAX_TOOL_TEXT = 24_000;
const SKILL_BLOCK = /<skill\b([^>]*)>([\s\S]*?)<\/skill>/g;

export function textOf(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((c) => c && c.type === "text" && typeof c.text === "string")
		.map((c) => c.text)
		.join("\n");
}

const FILE_BLOCK = /<file name="([^"]*)">[\s\S]*?<\/file>/g;

/** A one-line title for a user prompt; injected skill bodies become "/skillname", attached files "@name". */
export function describeUserText(text) {
	let skill;
	let file;
	const rest = text
		.replace(SKILL_BLOCK, (_m, attrs) => {
			skill ??= /name="([^"]+)"/.exec(attrs)?.[1];
			return " ";
		})
		.replace(FILE_BLOCK, (_m, name) => {
			file ??= path.basename(name);
			return " ";
		})
		.replace(/\s+/g, " ")
		.trim();
	if (skill) return rest ? `/${skill} ${rest}` : `/${skill}`;
	if (!rest && file) return `@${file}`;
	return rest;
}

function forEachLine(text, fn) {
	let start = 0;
	while (start < text.length) {
		let end = text.indexOf("\n", start);
		if (end === -1) end = text.length;
		const line = text.slice(start, end);
		start = end + 1;
		if (line.trim()) fn(line);
	}
}

export function readSessionMeta(file, root) {
	const stat = fs.statSync(file);
	const text = fs.readFileSync(file, "utf8");
	const meta = {
		id: undefined,
		file,
		rel: path.relative(root, file),
		cwd: undefined,
		created: undefined,
		mtime: stat.mtimeMs,
		size: stat.size,
		name: undefined,
		firstUser: undefined,
		userCount: 0,
		assistantCount: 0,
		toolCount: 0,
		cost: 0,
		lastModel: undefined,
		lastActivity: undefined,
		children: [],
		mdLog: undefined,
		parentSession: undefined,
		// Context size as pi counts it: the last usable assistant usage, unknown after a compaction.
		contextTokens: null,
		contextModel: undefined,
	};
	// Subagents launched from this session, in launch order, and whether each reported back.
	const children = new Map();
	const child = (d, when) => {
		if (!d || typeof d.sessionFile !== "string") return undefined;
		let c = children.get(d.sessionFile);
		if (!c) {
			c = { file: d.sessionFile, agent: d.agent, name: d.name, launchedAt: when, done: false };
			children.set(d.sessionFile, c);
		}
		c.agent ??= d.agent;
		c.name ??= d.name;
		return c;
	};
	let first = true;
	forEachLine(text, (line) => {
		let e;
		try {
			e = JSON.parse(line);
		} catch {
			return;
		}
		if (first) {
			first = false;
			if (e.type === "session") {
				meta.id = e.id;
				meta.cwd = e.cwd;
				meta.created = e.timestamp;
				meta.parentSession = e.parentSession;
				return;
			}
		}
		if (e.timestamp) meta.lastActivity = e.timestamp;
		switch (e.type) {
			case "session_info":
				meta.name = e.name || undefined;
				break;
			case "model_change":
				meta.lastModel = `${e.provider}/${e.modelId}`;
				break;
			case "custom":
				if (e.customType === "md-log") meta.mdLog = e.data?.file || undefined;
				break;
			case "custom_message":
				if (e.customType === "subagent_result") {
					const c = child(e.details, e.timestamp);
					if (c) {
						c.done = true;
						c.exitCode = e.details.exitCode;
						c.elapsed = e.details.elapsed;
						c.finishedAt = e.timestamp;
					}
				}
				break;
			case "compaction":
				meta.contextTokens = null;
				meta.cost += e.usage?.cost?.total || 0;
				break;
			case "branch_summary":
				meta.cost += e.usage?.cost?.total || 0;
				break;
			case "message": {
				const m = e.message;
				if (!m) break;
				if (m.role === "user") {
					meta.userCount++;
					if (meta.firstUser === undefined) meta.firstUser = describeUserText(textOf(m.content)).slice(0, 160);
				} else if (m.role === "assistant") {
					meta.assistantCount++;
					meta.cost += m.usage?.cost?.total || 0;
					if (m.provider && m.model) meta.lastModel = `${m.provider}/${m.model}`;
					if (Array.isArray(m.content)) for (const c of m.content) if (c?.type === "toolCall") meta.toolCount++;
					const u = m.usage;
					const tokens = u ? u.totalTokens || (u.input || 0) + (u.output || 0) + (u.cacheRead || 0) + (u.cacheWrite || 0) : 0;
					if (tokens > 0 && m.stopReason !== "aborted" && m.stopReason !== "error") {
						meta.contextTokens = tokens;
						meta.contextModel = m.provider && m.model ? `${m.provider}/${m.model}` : meta.contextModel;
					}
				} else if (m.role === "toolResult" && m.toolName === "subagent") {
					child(m.details, e.timestamp);
				}
				break;
			}
		}
	});
	meta.id ??= path.basename(file, ".jsonl");
	meta.children = [...children.values()];
	return meta;
}

async function listSessionFiles(root) {
	const out = [];
	async function walk(dir, depth) {
		let items;
		try {
			items = await fsp.readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const item of items) {
			const full = path.join(dir, item.name);
			if (item.isDirectory()) {
				// Subagent launch scripts and activity logs live here, never sessions.
				if (item.name !== "artifacts" && depth < 4) await walk(full, depth + 1);
			} else if (item.isFile() && item.name.endsWith(".jsonl")) {
				out.push(full);
			}
		}
	}
	await walk(root, 0);
	return out;
}

export class SessionIndex extends EventEmitter {
	constructor(root) {
		super();
		this.root = root;
		this.byFile = new Map();
		this.pending = new Map(); // id -> meta for sessions pi has not flushed to disk yet
		this.timers = new Map();
		this.parents = new Map(); // child file -> { parentId, agent, name }
		// Subagent sessions stored outside the root (pi-interactive-subagents always
		// writes to pi's default folder); followed so they can still be opened.
		this.external = new Set();
	}

	async scan() {
		const files = await listSessionFiles(this.root);
		const seen = new Set(files);
		for (const file of files) this.refreshNow(file, this.ready);
		for (const file of this.external) this.refreshNow(file, this.ready);
		for (const file of [...this.byFile.keys()]) if (!seen.has(file) && !this.external.has(file)) this.remove(file);
		this.ready = true;
	}

	isUnderRoot(file) {
		return file === this.root || file.startsWith(this.root + path.sep);
	}

	refreshNow(file, emit = true) {
		let stat;
		try {
			stat = fs.statSync(file);
		} catch {
			if (this.byFile.has(file)) this.remove(file);
			return;
		}
		const old = this.byFile.get(file);
		if (old && old.mtime === stat.mtimeMs && old.size === stat.size) return;
		let meta;
		try {
			meta = readSessionMeta(file, this.root);
		} catch {
			return;
		}
		this.byFile.set(file, meta);
		for (const [id, p] of this.pending) {
			if (p.file === file || id === meta.id) this.pending.delete(id);
		}
		const changedChildren = [];
		for (const child of meta.children) {
			const prev = this.parents.get(child.file);
			if (!prev || prev.parentId !== meta.id) changedChildren.push(child.file);
			this.parents.set(child.file, { parentId: meta.id, agent: child.agent, name: child.name });
			if (!this.isUnderRoot(child.file) && !this.external.has(child.file)) {
				this.external.add(child.file);
				this.scheduleRefresh(child.file);
			}
		}
		if (!emit) return;
		this.emit("upsert", this.decorate(meta));
		for (const childFile of changedChildren) {
			const child = this.byFile.get(childFile);
			if (child) this.emit("upsert", this.decorate(child));
		}
	}

	scheduleRefresh(file) {
		clearTimeout(this.timers.get(file));
		this.timers.set(
			file,
			setTimeout(() => {
				this.timers.delete(file);
				this.refreshNow(file);
			}, 150),
		);
	}

	remove(file) {
		const meta = this.byFile.get(file);
		this.byFile.delete(file);
		if (meta) this.emit("remove", meta.id);
	}

	watch() {
		try {
			this.watcher = fs.watch(this.root, { recursive: true }, (_event, name) => {
				if (name && String(name).endsWith(".jsonl")) this.scheduleRefresh(path.join(this.root, String(name)));
			});
			this.watcher.on("error", () => {});
		} catch {
			// Polling below still catches everything, just more slowly.
		}
		this.poller = setInterval(() => this.scan().catch(() => {}), 8000);
	}

	close() {
		this.watcher?.close();
		clearInterval(this.poller);
	}

	addPending({ id, file, cwd }) {
		if (!id || [...this.byFile.values()].some((m) => m.id === id)) return;
		const now = new Date().toISOString();
		const meta = {
			id,
			file,
			rel: file ? path.relative(this.root, file) : "",
			cwd,
			created: now,
			mtime: Date.now(),
			size: 0,
			name: undefined,
			firstUser: undefined,
			userCount: 0,
			assistantCount: 0,
			toolCount: 0,
			cost: 0,
			children: [],
			lastActivity: now,
			pending: true,
		};
		this.pending.set(id, meta);
		this.emit("upsert", this.decorate(meta));
	}

	get(id) {
		for (const meta of this.byFile.values()) if (meta.id === id) return meta;
		return this.pending.get(id);
	}

	getByFile(file) {
		return this.byFile.get(file);
	}

	decorate(meta) {
		const parent = this.parents.get(meta.file);
		const { children, ...rest } = meta;
		return {
			...rest,
			childCount: children.length,
			subagents: children.map((c) => {
				const childMeta = this.byFile.get(c.file);
				return { ...c, id: childMeta?.id, mtime: childMeta?.mtime };
			}),
			contextWindow: this.contextWindowFor?.(meta.contextModel || meta.lastModel),
			parentId: parent?.parentId,
			agent: parent?.agent,
			agentName: parent?.name,
		};
	}

	list() {
		return [...this.byFile.values(), ...this.pending.values()].map((m) => this.decorate(m));
	}

	/** Every pi project folder seen in the sessions, most recently used first. */
	projects() {
		const latest = new Map();
		for (const m of this.byFile.values()) {
			if (!m.cwd) continue;
			const t = Date.parse(m.lastActivity || "") || m.mtime;
			if (!latest.has(m.cwd) || latest.get(m.cwd) < t) latest.set(m.cwd, t);
		}
		return [...latest.entries()].sort((a, b) => b[1] - a[1]).map(([cwd]) => cwd);
	}
}

// ── slimming ────────────────────────────────────────────────────────────────

function imageRef(entryId, ptr, block) {
	return {
		type: "image",
		mimeType: block.mimeType,
		ref: `${entryId}|${ptr}`,
		bytes: typeof block.data === "string" ? Math.floor(block.data.length * 0.75) : 0,
	};
}

function stripSkillBodies(text) {
	return typeof text === "string" ? text.replace(SKILL_BLOCK, (_m, attrs) => `<skill${attrs}></skill>`) : text;
}

function slimBlocks(content, entryId, ptr, limitText) {
	if (!Array.isArray(content)) return content;
	return content.map((b, i) => {
		if (!b || typeof b !== "object") return b;
		if (b.type === "image") return imageRef(entryId, `${ptr}.${i}`, b);
		if (b.type === "thinking") {
			const { thinkingSignature: _sig, ...rest } = b;
			return rest;
		}
		if (b.type === "text" && limitText && typeof b.text === "string" && b.text.length > MAX_TOOL_TEXT) {
			return { type: "text", text: b.text.slice(0, MAX_TOOL_TEXT), truncated: b.text.length };
		}
		return b;
	});
}

function slimDetails(details, limitText) {
	if (!details || typeof details !== "object" || Array.isArray(details)) return details;
	const out = { ...details };
	if (out.truncation && typeof out.truncation === "object") {
		const { content: _dup, ...rest } = out.truncation;
		out.truncation = rest;
	}
	if (typeof out.diff === "string" && typeof out.patch === "string") delete out.patch;
	if (limitText) {
		for (const [k, v] of Object.entries(out)) {
			if (typeof v === "string" && v.length > MAX_TOOL_TEXT) out[k] = `${v.slice(0, MAX_TOOL_TEXT)}\n…`;
		}
	}
	return out;
}

function slimMessage(m, id, limitText) {
	if (!m || typeof m !== "object") return m;
	switch (m.role) {
		case "system":
			return { role: "system", timestamp: m.timestamp, sections: m.sections ? Object.keys(m.sections) : [] };
		case "assistant":
			return { ...m, content: slimBlocks(m.content, id, "message.content", false) };
		case "toolResult":
			return { ...m, content: slimBlocks(m.content, id, "message.content", limitText), details: slimDetails(m.details, limitText) };
		case "user": {
			const content =
				typeof m.content === "string"
					? stripSkillBodies(m.content)
					: slimBlocks(m.content, id, "message.content", false)?.map((b) => (b?.type === "text" ? { ...b, text: stripSkillBodies(b.text) } : b));
			return { ...m, content };
		}
		case "bashExecution":
			if (limitText && typeof m.output === "string" && m.output.length > MAX_TOOL_TEXT) {
				return { ...m, output: m.output.slice(0, MAX_TOOL_TEXT), outputTruncated: m.output.length };
			}
			return m;
		case "custom":
			return { ...m, content: slimBlocks(m.content, id, "message.content", false), details: slimDetails(m.details, limitText) };
		default:
			return m;
	}
}

export function slimEntry(e, { limitText = true } = {}) {
	if (!e || typeof e !== "object") return e;
	switch (e.type) {
		case "message":
			return { ...e, message: slimMessage(e.message, e.id, limitText) };
		case "custom_message":
			return { ...e, content: slimBlocks(e.content, e.id, "content", false), details: slimDetails(e.details, limitText) };
		case "compaction": {
			const { systemMessage: _s, retainedTail: _t, ...rest } = e;
			return rest;
		}
		case "custom": {
			let small = e.data;
			try {
				if (JSON.stringify(e.data ?? null).length > 4000) small = { omitted: true };
			} catch {
				small = { omitted: true };
			}
			return { ...e, data: small };
		}
		default:
			return e;
	}
}

// ── random access into a session file ───────────────────────────────────────

function findEntryInBuffer(buf, entryId) {
	const needle = Buffer.from(`"id":"${entryId}"`);
	let at = buf.indexOf(needle);
	while (at >= 0) {
		const start = buf.lastIndexOf(10, at) + 1;
		let end = buf.indexOf(10, at);
		if (end < 0) end = buf.length;
		try {
			const e = JSON.parse(buf.toString("utf8", start, end));
			if (e.id === entryId) return e;
		} catch {
			// not a whole entry
		}
		at = buf.indexOf(needle, end);
	}
	return undefined;
}

export function readFullEntry(file, entryId) {
	const e = findEntryInBuffer(fs.readFileSync(file), entryId);
	return e ? slimEntry(e, { limitText: false }) : undefined;
}

export function readImage(file, ref) {
	const bar = ref.indexOf("|");
	if (bar < 0) return undefined;
	const entry = findEntryInBuffer(fs.readFileSync(file), ref.slice(0, bar));
	if (!entry) return undefined;
	const block = ref
		.slice(bar + 1)
		.split(".")
		.reduce((obj, key) => (obj == null ? obj : obj[key]), entry);
	if (!block || block.type !== "image" || typeof block.data !== "string") return undefined;
	return { mimeType: block.mimeType || "image/png", data: Buffer.from(block.data, "base64") };
}

// ── tailing ─────────────────────────────────────────────────────────────────

/**
 * Follows one session file. pi only ever appends whole lines, so new entries
 * are read from the last known byte offset. A shrink or replaced inode means
 * the file was rewritten: listeners get "reset" and should reload.
 */
export class SessionTail extends EventEmitter {
	constructor(file) {
		super();
		this.file = file;
		this.header = null;
		this.entries = [];
		this.offset = 0;
		this.ino = undefined;
		this.exists = false;
		this.load();
	}

	load() {
		this.header = null;
		this.entries = [];
		this.offset = 0;
		this.exists = false;
		let buf;
		try {
			buf = fs.readFileSync(this.file);
			this.ino = fs.statSync(this.file).ino;
		} catch (err) {
			if (err.code === "ENOENT") return;
			throw err;
		}
		this.exists = true;
		const end = buf.lastIndexOf(10) + 1;
		this.entries = this.parse(buf.subarray(0, end), true);
		this.offset = end;
	}

	parse(buf, fromStart) {
		const out = [];
		let start = 0;
		while (start < buf.length) {
			let nl = buf.indexOf(10, start);
			if (nl < 0) nl = buf.length;
			const line = buf.toString("utf8", start, nl).trim();
			start = nl + 1;
			if (!line) continue;
			let e;
			try {
				e = JSON.parse(line);
			} catch {
				continue;
			}
			if (fromStart && !this.header && out.length === 0 && e.type === "session") {
				this.header = e;
				continue;
			}
			out.push(slimEntry(e));
		}
		return out;
	}

	poll() {
		let stat;
		try {
			stat = fs.statSync(this.file);
		} catch (err) {
			if (err.code === "ENOENT" && this.exists) {
				this.load();
				this.emit("reset");
			}
			return;
		}
		if (!this.exists || stat.ino !== this.ino || stat.size < this.offset) {
			this.load();
			this.emit("reset");
			return;
		}
		if (stat.size === this.offset) return;
		const length = stat.size - this.offset;
		const buf = Buffer.alloc(length);
		const fd = fs.openSync(this.file, "r");
		try {
			fs.readSync(fd, buf, 0, length, this.offset);
		} finally {
			fs.closeSync(fd);
		}
		const end = buf.lastIndexOf(10) + 1;
		if (end === 0) return;
		const fresh = this.parse(buf.subarray(0, end), false);
		this.offset += end;
		if (fresh.length) {
			this.entries.push(...fresh);
			this.emit("entries", fresh);
		}
	}
}
