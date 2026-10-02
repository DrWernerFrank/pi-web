// The conversation pane: turns a pi session (entries + live RPC events) into
// readable chat, with interactive quiz / question cards.

import { ansiToHtml, hasAnsi } from "./ansi.js";
import { getJson, imageUrl, post } from "./api.js";
import { icon, toolIcon } from "./icons.js";
import { applyEvent, applyUiRequest, createLive, dropPersisted, entryMessageKey, messageKey, textOf } from "./live.js";
import { codeBlock, renderInline, renderInto } from "./markdown.js";
import { basename, esc, fmtBytes, fmtClock, fmtCost, fmtDuration, fmtTokens, h, rafThrottle, textDir, toMs } from "./util.js";

const PAGE = 60;
const SKILL_TAG = /<skill\b([^>]*)>([\s\S]*?)<\/skill>/g;
const QUESTION_TOOLS = new Set(["quiz", "ask_user_question"]);
const ALWAYS_SHOWN = new Set(["quiz", "ask_user_question", "subagent"]);
const LANG_BY_EXT = {
	js: "javascript",
	mjs: "javascript",
	cjs: "javascript",
	ts: "typescript",
	tsx: "typescript",
	jsx: "javascript",
	py: "python",
	sh: "bash",
	bash: "bash",
	json: "json",
	md: "markdown",
	css: "css",
	html: "xml",
	svg: "xml",
	xml: "xml",
	yml: "yaml",
	yaml: "yaml",
	rs: "rust",
	go: "go",
	java: "java",
	c: "c",
	h: "c",
	cpp: "cpp",
	cs: "csharp",
	rb: "ruby",
	php: "php",
	sql: "sql",
	toml: "ini",
	ini: "ini",
	tex: "latex",
};

function langFromPath(p) {
	const ext = String(p || "")
		.split(".")
		.pop()
		.toLowerCase();
	return LANG_BY_EXT[ext] || "";
}

const FILE_TAG = /<file name="([^"]*)">\n?([\s\S]*?)\n?<\/file>/g;

/** Pull injected skill tags and attached-file blocks out of a user prompt. */
function splitSkills(text) {
	const skills = [];
	const files = [];
	const rest = String(text || "")
		.replace(SKILL_TAG, (_m, attrs) => {
			const name = /name="([^"]+)"/.exec(attrs)?.[1];
			if (name) skills.push({ name, location: /location="([^"]+)"/.exec(attrs)?.[1] });
			return "";
		})
		.replace(FILE_TAG, (_m, name, body) => {
			files.push({ name, body });
			return "";
		});
	return { skills, files, text: rest.trim() };
}

function normalizeOptions(options) {
	if (!Array.isArray(options)) return [];
	return options
		.map((o) => {
			const label = String(o?.label ?? "").trim();
			return { label, value: String(o?.value ?? "").trim() || label, description: o?.description };
		})
		.filter((o) => o.label);
}

function coerceCorrect(answer) {
	if (Array.isArray(answer)) return answer.map(String);
	if (typeof answer !== "string") return [];
	const t = answer.trim();
	if (t.startsWith("[") && t.endsWith("]")) {
		try {
			const parsed = JSON.parse(t);
			if (Array.isArray(parsed)) return parsed.map(String);
		} catch {
			// a literal bracketed value
		}
	}
	return t ? [t] : [];
}

function firstLine(text, max = 140) {
	const line = String(text ?? "")
		.split("\n")
		.find((l) => l.trim()) ?? "";
	return line.length > max ? `${line.slice(0, max)}…` : line;
}

function toolSummary(call) {
	const a = call.arguments || {};
	// Antigravity describes each call itself ("Writing markdown file").
	if (call.summary) {
		const target = a.TargetFile || a.AbsolutePath || a.CommandLine || a.Url || a.query;
		return target ? `${call.summary} · ${firstLine(String(target), 90)}` : call.summary;
	}
	switch (call.name) {
		case "bash":
		case "safe_bash":
			return firstLine(a.command);
		case "read": {
			const range = a.offset ? `:${a.offset}${a.limit ? `-${a.offset + a.limit}` : ""}` : "";
			return `${a.path ?? ""}${range}`;
		}
		case "write":
		case "edit":
			return a.path ?? "";
		case "grep":
			return `${a.pattern ?? ""}${a.path ? `  in ${a.path}` : ""}`;
		case "find":
			return `${a.pattern ?? ""}${a.path ? `  in ${a.path}` : ""}`;
		case "ls":
			return a.path ?? ".";
		case "web_search":
			return a.query ?? "";
		case "web_fetch":
			return a.url ?? "";
		default: {
			const value = Object.values(a).find((v) => typeof v === "string" && v.trim());
			return firstLine(value ?? "");
		}
	}
}

function resultText(result) {
	if (!result) return "";
	return textOf(result.content);
}

function renderDiff(diff) {
	const pre = h("pre", { class: "diff", dir: "ltr" });
	for (const line of String(diff).split("\n")) {
		const cls = line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : "ctx";
		pre.append(h("span", { class: `diff-line ${cls}` }, `${line}\n`));
	}
	return pre;
}

function outputPre(text) {
	const pre = h("pre", { class: "tool-output", dir: "ltr" });
	if (hasAnsi(text)) pre.innerHTML = ansiToHtml(text);
	else pre.textContent = text;
	return pre;
}

export class Conversation {
	constructor({ root, scroller, app }) {
		this.root = root;
		this.scroller = scroller;
		this.app = app;
		this.expanded = new Set();
		this.collapsed = new Set();
		this.drafts = new Map(); // toolCallId -> answer being prepared / just sent
		this.inlineDialogs = new Map(); // toolCallId -> editor dialog shown inside a question card
		this.stick = true;
		this.updatePartial = rafThrottle(() => {
			this.renderPartial();
			// The status area includes the live tok/s read-out, which is exactly
			// what changes as deltas arrive — repaint it with the partial.
			this.renderStatus();
		});
		this.toolTimers = new Map();
		scroller.addEventListener(
			"scroll",
			() => {
				this.stick = this.nearBottom();
				this.app.onStickChange?.(this.stick);
				if (scroller.scrollTop < 300 && this.hasMore && !this.loadingEarlier) this.loadEarlier();
			},
			{ passive: true },
		);
		root.addEventListener("click", (e) => this.onClick(e));
		root.addEventListener("focusout", (e) => {
			const id = e.target.closest?.("[data-call-id]")?.dataset.callId;
			if (id && this.toolNodes.get(id)?.pendingRefresh) setTimeout(() => this.refreshTool(id), 0);
		});
		this.clear();
	}

	// ── state ────────────────────────────────────────────────────────────────

	clear() {
		this.sessionId = null;
		this.meta = null;
		this.entries = [];
		this.byId = new Map();
		this.children = new Map();
		this.position = new Map();
		this.results = new Map();
		this.savedKeys = new Set();
		this.links = {};
		this.live = createLive();
		this.leafOverride = null;
		this.window = PAGE;
		this.hasMore = false;
		this.nodes = new Map();
		this.liveNodes = new Map();
		this.toolNodes = new Map();
		this.partial = null;
		// Streaming speed: live estimate while a reply streams (deltas carry no
		// token counts, so estimate from characters ≈ 4 per token), and the exact
		// average stamped per message once it settles.
		this.streamT0 = 0;
		this.streamChars = 0;
		this.tpsBy = new Map();
		this.root.replaceChildren();
		this.moreEl = h("div", { class: "load-earlier" });
		this.itemsEl = h("div", { class: "items" });
		this.liveEl = h("div", { class: "live-items" });
		this.statusEl = h("div", { class: "live-status" });
		this.root.append(this.moreEl, this.itemsEl, this.liveEl, this.statusEl);
	}

	showLoading() {
		this.itemsEl.replaceChildren(h("div", { class: "empty-session loading" }, h("span", { class: "spinner" }), " Loading session…"));
	}

	load(snap, { keepScroll = false } = {}) {
		const previousTop = this.scroller.scrollTop;
		const wasStuck = this.stick;
		const sameSession = snap?.meta?.id === this.sessionId;
		const drafts = sameSession ? this.drafts : new Map();
		this.clear();
		this.drafts = drafts;
		if (!snap) return;
		this.sessionId = snap.meta.id;
		this.meta = snap.meta;
		this.links = snap.links || {};
		if (snap.live) this.live = snap.live;
		this.ingest(snap.entries || []);
		this.pruneFinals();
		this.render();
		if (keepScroll && !wasStuck) this.scroller.scrollTop = previousTop;
		else this.scrollToBottom(true);
	}

	setMeta(meta) {
		this.meta = meta;
		if (meta?.subagents?.length) this.refreshSubagents();
	}

	ingest(entries) {
		for (const e of entries) {
			if (!e?.id || this.byId.has(e.id)) continue;
			this.position.set(e.id, this.entries.length);
			this.entries.push(e);
			this.byId.set(e.id, e);
			const parent = e.parentId ?? null;
			if (!this.children.has(parent)) this.children.set(parent, []);
			this.children.get(parent).push(e);
			if (e.type === "message" && e.message?.role === "toolResult") this.results.set(e.message.toolCallId, e.message);
			const key = entryMessageKey(e);
			if (key) this.savedKeys.add(key);
		}
	}

	/** The file tail can deliver a message before pi's own event for it; never show it twice. */
	pruneFinals() {
		const before = this.live.finals.length;
		this.live.finals = this.live.finals.filter((m) => !this.savedKeys.has(messageKey(m)));
		return before !== this.live.finals.length;
	}

	addEntries(entries, links) {
		Object.assign(this.links, links || {});
		const fresh = entries.filter((e) => e?.id && !this.byId.has(e.id));
		if (!fresh.length) return;
		this.ingest(fresh);
		dropPersisted(this.live, fresh);
		this.leafOverride = null;
		for (const e of fresh) {
			if (e.type === "message" && e.message?.role === "toolResult") this.refreshTool(e.message.toolCallId);
		}
		if (fresh.some((e) => e.type === "custom_message" && e.customType === "subagent_result")) this.refreshSubagents();
		this.render();
	}

	env() {
		return { sessionId: this.sessionId };
	}

	isActive() {
		return !!this.live.busy || !!this.app.isExternallyActive?.(this.meta);
	}

	// ── path and items ───────────────────────────────────────────────────────

	path() {
		let id = this.leafOverride && this.byId.has(this.leafOverride) ? this.leafOverride : this.entries.at(-1)?.id;
		const out = [];
		const seen = new Set();
		while (id && !seen.has(id)) {
			seen.add(id);
			const e = this.byId.get(id);
			if (!e) break;
			out.push(e);
			id = e.parentId;
		}
		return out.reverse();
	}

	items() {
		const out = [];
		let model;
		let thinking;
		let shown = "";
		let settingKey;
		const pushVisible = (item) => {
			const current = [model, thinking].filter(Boolean).join(" · thinking ");
			if (current && current !== shown) {
				out.push({ kind: "setting", key: `set:${settingKey}`, text: current });
				shown = current;
			}
			out.push(item);
		};
		for (const e of this.path()) {
			switch (e.type) {
				case "model_change":
					model = e.modelId;
					settingKey = e.id;
					break;
				case "thinking_level_change":
					thinking = e.thinkingLevel;
					settingKey = e.id;
					break;
				case "message": {
					const role = e.message?.role;
					if (role === "user") pushVisible({ kind: "user", key: e.id, entry: e });
					else if (role === "assistant") pushVisible({ kind: "assistant", key: e.id, entry: e });
					else if (role === "bashExecution") pushVisible({ kind: "bash", key: e.id, entry: e });
					else if (role === "custom" && e.message.display !== false) pushVisible({ kind: "custom", key: e.id, entry: e });
					break;
				}
				case "custom_message":
					if (e.display) pushVisible({ kind: "custom", key: e.id, entry: e });
					break;
				case "compaction":
					pushVisible({ kind: "compaction", key: e.id, entry: e });
					break;
				case "branch_summary":
					pushVisible({ kind: "branch", key: e.id, entry: e });
					break;
				case "session_info":
					if (e.name) pushVisible({ kind: "note", key: e.id, text: `Session named “${e.name}”` });
					break;
				case "custom":
					if (e.customType === "md-log") {
						const file = e.data?.file;
						pushVisible({ kind: "note", key: e.id, text: file ? `Mirroring to ${basename(file)}` : "Stopped mirroring to a note", title: file });
					}
					break;
			}
		}
		return out;
	}

	// ── rendering ────────────────────────────────────────────────────────────

	render() {
		const items = this.items();
		this.hasMore = items.length > this.window;
		const visible = items.slice(-this.window);
		const nodes = [];
		let previous;
		for (const [i, item] of visible.entries()) {
			let node = this.nodes.get(item.key);
			if (!node) {
				node = this.renderItem(item);
				this.nodes.set(item.key, node);
			}
			node.classList.toggle("continued", item.kind === "assistant" && previous?.kind === "assistant");
			if (item.kind === "user") this.updateBranchSwitch(node, item.entry);
			// A failed request that pi retried successfully is history, not an alarm.
			if (item.kind === "assistant") node.querySelector(".msg-error")?.classList.toggle("retried", visible[i + 1]?.kind === "assistant");
			nodes.push(node);
			previous = item;
		}
		reconcile(this.itemsEl, nodes);
		this.moreEl.replaceChildren(
			this.hasMore ? h("button", { class: "btn ghost small", type: "button", onclick: () => this.loadEarlier() }, `Show earlier messages (${items.length - this.window})`) : "",
		);
		this.lastItemKind = previous?.kind;
		if (!items.length && !this.live.finals.length && !this.live.partial) {
			this.itemsEl.replaceChildren(h("div", { class: "empty-session" }, h("div", { class: "empty-logo" }, "π"), h("p", {}, "No messages yet. Say something below.")));
		}
		this.renderLive();
		this.afterChange();
	}

	loadEarlier() {
		if (!this.hasMore) return;
		this.loadingEarlier = true;
		const before = this.scroller.scrollHeight;
		const top = this.scroller.scrollTop;
		this.window += PAGE;
		this.render();
		this.scroller.scrollTop = top + (this.scroller.scrollHeight - before);
		requestAnimationFrame(() => (this.loadingEarlier = false));
	}

	rerender() {
		this.nodes.clear();
		this.liveNodes.clear();
		this.toolNodes.clear();
		this.partial = null;
		this.itemsEl.replaceChildren();
		this.liveEl.replaceChildren();
		this.render();
	}

	renderItem(item) {
		switch (item.kind) {
			case "user":
				return this.renderUser(item.entry.message, item.entry.id);
			case "assistant":
				return this.renderAssistant(item.entry.message, item.entry.id);
			case "bash":
				return this.renderBash(item.entry.message);
			case "custom":
				return this.renderCustom(item.entry);
			case "compaction":
				return this.renderCompaction(item.entry);
			case "branch":
				return this.renderBranchSummary(item.entry);
			case "setting":
				return h("div", { class: "item divider setting" }, h("span", { html: icon("cpu") }), item.text);
			case "note":
				return h("div", { class: "item divider", title: item.title || "" }, h("span", { html: icon("note") }), item.text);
			default:
				return h("div");
		}
	}

	md(cls, text) {
		return renderInto(h("div", { class: `md ${cls || ""}` }), text, this.env());
	}

	inline(text) {
		const span = h("span", { class: "md-inline", html: renderInline(text, this.env()) });
		const dir = textDir(span.textContent);
		if (dir) span.setAttribute("dir", dir);
		return span;
	}

	imageThumb(block) {
		const src = imageUrl(this.sessionId, block);
		if (!src) return null;
		return h("img", { class: "thumb", src, loading: "lazy", alt: "image", title: block.bytes ? fmtBytes(block.bytes) : "" });
	}

	renderUser(m, id) {
		const raw = textOf(m.content);
		const { skills, files, text } = splitSkills(raw);
		const images = Array.isArray(m.content) ? m.content.filter((c) => c?.type === "image") : [];
		const bubble = h("div", { class: "bubble" });
		if (skills.length) {
			bubble.append(
				h(
					"div",
					{ class: "skill-chips" },
					skills.map((s) => h("span", { class: "skill-chip", title: s.location || "" }, h("span", { html: icon("sparkles") }), s.name)),
				),
			);
		}
		for (const file of files) {
			const details = h("details", { class: "file-block" }, h("summary", {}, h("span", { html: icon("file") }), basename(file.name)));
			details.addEventListener("toggle", () => {
				if (details.open && !details.querySelector(".md")) details.append(this.md("file-body", file.body));
			});
			bubble.append(details);
		}
		if (text) bubble.append(this.md("", text));
		if (images.length) bubble.append(h("div", { class: "user-images" }, images.map((img) => this.imageThumb(img))));
		return h(
			"div",
			{ class: "item user", "data-id": id || "" },
			h("div", { class: "user-row" }, h("div", { class: "branch-slot" }), bubble),
			h(
				"div",
				{ class: `item-meta${m.via ? " via" : ""}` },
				m.via ? "sent from pi-web (Antigravity sees it as a system message) · " : "",
				fmtClock(m.timestamp),
				raw.trim()
					? h(
							"button",
							{
								class: "meta-btn",
								type: "button",
								title: "Copy this prompt",
								onclick: (e) => this.app.copy(raw, e.currentTarget),
							},
							h("span", { html: icon("copy") }),
							"Copy",
						)
					: null,
			),
		);
	}

	renderAssistant(m, id) {
		const body = h("div", { class: "assistant-body" });
		this.fillAssistant(body, m, id);
		const agy = m.provider === "antigravity";
		return h(
			"div",
			{ class: `item assistant${agy ? " agy" : ""}`, "data-id": id || "" },
			h("div", { class: "avatar", title: m.model || "pi" }, agy ? "A" : "π"),
			body,
		);
	}

	fillAssistant(body, m, entryId) {
		const content = Array.isArray(m.content) ? m.content : [];
		let hiddenTools = 0;
		for (const block of content) {
			if (!block) continue;
			if (block.type === "thinking" && block.thinking?.trim()) body.append(this.renderThinking(block.thinking));
			else if (block.type === "text" && block.text?.trim()) body.append(this.md("", block.text));
			else if (block.type === "toolCall") {
				body.append(this.toolNode(block));
				if (!ALWAYS_SHOWN.has(block.name)) hiddenTools++;
			} else if (block.type === "image") body.append(this.imageThumb(block));
		}
		if (hiddenTools) {
			body.append(
				h(
					"button",
					{ class: "tools-chip", type: "button", onclick: () => this.app.setToolsMode("compact") },
					h("span", { html: icon("wrench") }),
					`${hiddenTools} tool call${hiddenTools > 1 ? "s" : ""}`,
				),
			);
		}
		if (m.stopReason === "error") {
			body.append(h("div", { class: "msg-error" }, h("span", { html: icon("alert") }), h("span", {}, m.errorMessage || "The model request failed.")));
		} else if (m.stopReason === "aborted") {
			body.append(h("div", { class: "msg-aborted" }, "Stopped."));
		}
		body.append(this.metaLine(m, entryId));
	}

	metaLine(m, entryId) {
		const usage = m.usage || {};
		const bits = [];
		if (m.model) bits.push(m.model);
		if (usage.output) bits.push(`${fmtTokens(usage.output)} out`);
		const tps = this.tpsBy.get(messageKey(m));
		if (tps) bits.push(`${tps} tok/s`);
		const cost = fmtCost(usage.cost?.total);
		if (cost) bits.push(cost);
		const time = fmtClock(m.timestamp);
		if (time) bits.push(time);
		const text = (Array.isArray(m.content) ? m.content : [])
			.filter((c) => c?.type === "text")
			.map((c) => c.text)
			.join("\n\n")
			.trim();
		return h(
			"div",
			{ class: "item-meta assistant-meta", "data-entry": entryId || "" },
			h("span", {}, bits.join(" · ")),
			text
				? h(
						"button",
						{
							class: "meta-btn",
							type: "button",
							title: "Copy this reply as markdown",
							onclick: (e) => this.app.copy(text, e.currentTarget),
						},
						h("span", { html: icon("copy") }),
						"Copy",
					)
				: null,
		);
	}

	renderThinking(text, streaming = false) {
		const details = h("details", { class: "thinking" });
		const summary = h("summary", {}, h("span", { html: icon("brain") }), streaming ? "Thinking…" : "Thinking");
		const body = h("div", { class: "thinking-body" });
		details.append(summary, body);
		const fill = () => {
			if (body.dataset.filled === text.length.toString()) return;
			renderInto(body, text, this.env(), { diagrams: false });
			body.classList.add("md");
			body.dataset.filled = text.length.toString();
		};
		details.addEventListener("toggle", () => details.open && fill());
		details._setText = (t) => {
			text = t;
			if (details.open) fill();
		};
		return details;
	}

	renderBash(m) {
		const status = m.cancelled ? "cancelled" : m.exitCode === 0 || m.exitCode == null ? "" : `exit ${m.exitCode}`;
		return h(
			"div",
			{ class: "item bash-run" },
			h("div", { class: "bash-head" }, h("span", { html: icon("terminal") }), h("code", { dir: "ltr" }, m.command), status ? h("span", { class: "bash-status" }, status) : null),
			m.output ? outputPre(m.output) : null,
			m.outputTruncated ? h("div", { class: "tool-note" }, "Output shortened.") : null,
		);
	}

	renderCustom(entry) {
		const isEntry = entry.type === "custom_message";
		const type = isEntry ? entry.customType : entry.message?.customType;
		const content = isEntry ? entry.content : entry.message?.content;
		const details = (isEntry ? entry.details : entry.message?.details) || {};
		const text = textOf(content);

		if (type === "subagent_result") {
			const ok = !details.exitCode;
			const title = `${details.agent || "subagent"}${details.name ? ` “${details.name}”` : ""} ${ok ? "finished" : "failed"}${details.elapsed ? ` in ${fmtDuration(details.elapsed * 1000)}` : ""}`;
			const stats = details.stats;
			const sub = details.sessionFile ? { file: details.sessionFile, agent: details.agent, name: details.name } : null;
			const card = h(
				"div",
				{ class: `item card subagent-result ${ok ? "ok" : "bad"}` },
				h("div", { class: "card-head" }, h("span", { html: icon("bot") }), h("span", { class: "card-title" }, title), this.watchButton(sub, "Open")),
			);
			const bodyText = text.replace(/^Sub-agent "[^"]*" (completed|failed)[^\n]*\n+/, "");
			if (bodyText.trim()) card.append(this.collapsible(this.md("card-body", bodyText), 14));
			if (stats) {
				card.append(
					h(
						"div",
						{ class: "card-foot" },
						[stats.model, stats.toolCount != null ? `${stats.toolCount} tools` : null, fmtCost(stats.cost)].filter(Boolean).join(" · "),
					),
				);
			}
			return card;
		}
		if (type === "antigravity_message") {
			const sender = details.sender;
			const info = sender ? this.app.subagentInfo?.(sender, this.meta) : null;
			const who = info?.agent || info?.name || "another conversation";
			return h(
				"div",
				{ class: "item card agy-message" },
				h(
					"div",
					{ class: "card-head" },
					h("span", { html: icon("bot") }),
					h("span", { class: "card-title" }, `Message from ${who}`),
					sender ? this.watchButton({ file: sender, agent: info?.agent, name: info?.name }, "Open") : null,
				),
				this.collapsible(this.md("card-body", text), 12),
			);
		}
		if (type === "antigravity_output" || type === "antigravity_system") {
			const images = Array.isArray(content) ? content.filter((c) => c?.type === "image") : [];
			return h(
				"div",
				{ class: "item card custom muted-card" },
				text ? this.collapsible(this.md("card-body", text), 8) : null,
				images.length ? h("div", { class: "tool-images" }, images.map((img) => this.imageThumb(img))) : null,
			);
		}
		if (type === "subagent_status") {
			return h("div", { class: "item divider status-line", title: text }, h("span", { html: icon("bot") }), firstLine(text.replace(/^Subagent status:\s*/i, ""), 160));
		}
		return h(
			"div",
			{ class: "item card custom" },
			h("div", { class: "card-head" }, h("span", { html: icon("zap") }), h("span", { class: "card-title" }, type || "message")),
			this.collapsible(this.md("card-body", text), 18),
		);
	}

	renderCompaction(e) {
		const details = h(
			"details",
			{ class: "item divider-card" },
			h("summary", {}, h("span", { html: icon("layers") }), `Context compacted${e.tokensBefore ? ` · ${fmtTokens(e.tokensBefore)} tokens summarized` : ""}`),
		);
		details.addEventListener("toggle", () => {
			if (details.open && !details.querySelector(".md")) details.append(this.md("card-body", e.summary || ""));
		});
		return details;
	}

	renderBranchSummary(e) {
		return h(
			"div",
			{ class: "item card branch-summary" },
			h("div", { class: "card-head" }, h("span", { html: icon("branch") }), h("span", { class: "card-title" }, "Summary of the branch you left")),
			this.collapsible(this.md("card-body", e.summary || ""), 10),
		);
	}

	collapsible(el, lines) {
		el.classList.add("clamp");
		el.style.setProperty("--clamp-lines", String(lines));
		const wrap = h("div", { class: "clamp-wrap" }, el);
		requestAnimationFrame(() => {
			if (el.scrollHeight > el.clientHeight + 8) {
				const btn = h("button", { class: "btn ghost small clamp-toggle", type: "button" }, "Show more");
				btn.onclick = () => {
					const open = el.classList.toggle("open");
					btn.textContent = open ? "Show less" : "Show more";
				};
				wrap.append(btn);
			} else {
				el.classList.add("open");
			}
		});
		return wrap;
	}

	sessionLink(link, label = "Open session") {
		if (!link?.id) return null;
		return h(
			"button",
			{ class: "btn ghost small open-session", type: "button", onclick: () => this.app.navigate(link.id) },
			label,
			h("span", { html: icon("chevronRight") }),
		);
	}

	// ── branches ─────────────────────────────────────────────────────────────

	latestLeaf(entry) {
		let best = entry;
		const stack = [entry];
		while (stack.length) {
			const e = stack.pop();
			if ((this.position.get(e.id) ?? -1) > (this.position.get(best.id) ?? -1)) best = e;
			for (const c of this.children.get(e.id) || []) stack.push(c);
		}
		return best;
	}

	updateBranchSwitch(node, entry) {
		const slot = node.querySelector(".branch-slot");
		if (!slot) return;
		const siblings = (this.children.get(entry.parentId ?? null) || []).filter((e) => e.type === "message" && e.message?.role === "user");
		if (siblings.length < 2) {
			slot.replaceChildren();
			return;
		}
		const at = siblings.findIndex((s) => s.id === entry.id);
		const go = (delta) => {
			const target = siblings[(at + delta + siblings.length) % siblings.length];
			this.leafOverride = this.latestLeaf(target).id;
			this.window = Math.max(this.window, PAGE);
			this.render();
			this.nodes.get(target.id)?.scrollIntoView({ block: "center" });
		};
		slot.replaceChildren(
			h(
				"div",
				{ class: "branch-switch", title: "This message was edited: switch between versions" },
				h("button", { type: "button", onclick: () => go(-1), html: icon("chevronLeft") }),
				h("span", {}, `${at + 1}/${siblings.length}`),
				h("button", { type: "button", onclick: () => go(1), html: icon("chevronRight") }),
			),
		);
	}

	// ── tools ────────────────────────────────────────────────────────────────

	toolState(id) {
		const persisted = this.results.get(id);
		if (persisted) return { status: persisted.isError ? "error" : "done", result: persisted };
		const final = this.live.finals.find((m) => m.role === "toolResult" && m.toolCallId === id);
		if (final) return { status: final.isError ? "error" : "done", result: final };
		const t = this.live.tools[id];
		if (t) {
			if (t.done) return { status: t.isError ? "error" : "done", result: { content: t.result?.content, details: t.result?.details, isError: t.isError } };
			return { status: "running", partial: t.partialResult, startedAt: t.startedAt };
		}
		return { status: this.isActive() ? "waiting" : "none" };
	}

	toolNode(call) {
		const el = this.buildTool(call);
		this.toolNodes.set(call.id, { call, el });
		return el;
	}

	refreshTool(id) {
		const rec = this.toolNodes.get(id);
		if (!rec) return;
		// Don't yank a text box away while someone is typing an answer into it;
		// redraw when they leave it (see the focusout listener).
		const typing = rec.el.contains(document.activeElement) && document.activeElement?.matches("textarea, input");
		const finished = ["done", "error"].includes(this.toolState(id).status);
		if (typing && !finished && !this.drafts.get(id)?.submitted) {
			rec.pendingRefresh = true;
			return;
		}
		rec.pendingRefresh = false;
		const fresh = this.buildTool(rec.call);
		rec.el.replaceWith(fresh);
		rec.el = fresh;
	}

	scheduleToolRefresh(id) {
		if (this.toolTimers.has(id)) return;
		this.toolTimers.set(
			id,
			setTimeout(() => {
				this.toolTimers.delete(id);
				this.refreshTool(id);
			}, 250),
		);
	}

	buildTool(call) {
		const state = this.toolState(call.id);
		if (call.name === "quiz") return this.buildQuiz(call, state);
		if (call.name === "ask_user_question") return this.buildAsk(call, state);
		if (call.name === "subagent") return this.buildSubagent(call, state);
		if (call.name === "invoke_subagent") return this.buildAgySubagents(call, state);
		return this.buildGeneric(call, state);
	}

	/** Antigravity's invoke_subagent: one card per subagent it created. */
	buildAgySubagents(call, state) {
		const specs = Array.isArray(call.arguments?.Subagents) ? call.arguments.Subagents : [];
		const ids = state.result?.details?.subagents || [];
		const wrap = h("div", { class: "agy-subagents", "data-call-id": call.id });
		const count = Math.max(specs.length, ids.length, 1);
		for (let i = 0; i < count; i++) {
			const spec = specs[i] || {};
			const id = ids[i];
			const info = id ? this.app.subagentInfo?.(id, this.meta) : null;
			const sub = id ? { file: id, agent: info?.agent || spec.Name || spec.Role || "subagent", name: info?.name } : null;
			const stateText = state.status === "error" ? "failed to start" : info ? this.subagentLabel(info) : state.status === "running" ? "launching…" : "";
			const card = h(
				"div",
				{ class: `tool subagent status-${state.status} sub-${info?.state || "none"}` },
				h(
					"div",
					{ class: "subagent-head" },
					h("span", { class: "tool-icon", html: icon("bot") }),
					h("span", { class: "subagent-agent" }, info?.agent || spec.Role || spec.Name || "subagent"),
					spec.Model ? h("span", { class: "subagent-name" }, spec.Model) : null,
					h("span", { class: "subagent-state" }, info?.state === "running" ? h("span", { class: "spinner" }) : null, stateText),
					this.watchButton(sub),
				),
			);
			if (spec.Prompt) card.append(this.collapsible(this.md("subagent-task", spec.Prompt), 4));
			wrap.append(card);
		}
		return wrap;
	}

	isExpanded(id) {
		return this.app.settings.tools === "expanded" ? !this.collapsed.has(id) : this.expanded.has(id);
	}

	statusBadge(state) {
		if (state.status === "running" || state.status === "waiting") return h("span", { class: "tool-status running" }, h("span", { class: "spinner" }));
		if (state.status === "error") return h("span", { class: "tool-status error", html: icon("x") });
		if (state.status === "done") return h("span", { class: "tool-status ok", html: icon("check") });
		return h("span", { class: "tool-status none" });
	}

	buildGeneric(call, state) {
		const expanded = this.isExpanded(call.id);
		const el = h("div", { class: `tool generic status-${state.status}${expanded ? " open" : ""}`, "data-call-id": call.id });
		const head = h(
			"button",
			{ class: "tool-head", type: "button", "aria-expanded": String(expanded) },
			h("span", { class: "tool-icon", html: toolIcon(call.name) }),
			h("span", { class: "tool-name" }, call.name),
			h("span", { class: "tool-arg" }, toolSummary(call)),
			this.statusBadge(state),
		);
		head.addEventListener("click", () => {
			const open = !this.isExpanded(call.id);
			if (this.app.settings.tools === "expanded") {
				if (open) this.collapsed.delete(call.id);
				else this.collapsed.add(call.id);
			} else if (open) this.expanded.add(call.id);
			else this.expanded.delete(call.id);
			this.refreshTool(call.id);
		});
		el.append(head);
		if (expanded) el.append(this.toolBody(call, state));
		return el;
	}

	toolBody(call, state) {
		const body = h("div", { class: "tool-body" });
		const a = call.arguments || {};
		switch (call.name) {
			case "bash":
			case "safe_bash":
				if (a.command) body.append(h("div", { class: "tool-args", html: codeBlock(a.command, "bash") }));
				break;
			case "write":
				if (typeof a.content === "string") body.append(h("div", { class: "tool-args", html: codeBlock(a.content, langFromPath(a.path)) }));
				break;
			case "write_to_file":
				if (typeof a.CodeContent === "string") body.append(h("div", { class: "tool-args", html: codeBlock(a.CodeContent, langFromPath(a.TargetFile)) }));
				break;
			case "run_command":
				if (a.CommandLine) body.append(h("div", { class: "tool-args", html: codeBlock(String(a.CommandLine), "powershell") }));
				break;
			case "edit":
			case "read":
			case "ls":
			case "grep":
			case "find":
				break;
			default:
				if (Object.keys(a).length) body.append(h("div", { class: "tool-args", html: codeBlock(JSON.stringify(a, null, 2), "json") }));
		}

		const result = state.result || (state.partial ? { content: state.partial.content, details: state.partial.details } : null);
		if (result) {
			const details = result.details || {};
			if (call.name === "edit" && typeof details.diff === "string") body.append(renderDiff(details.diff));
			else if (call.name === "edit" && !result.isError) body.append(this.editArgs(a));
			const text = resultText(result);
			if (text && !(call.name === "edit" && details.diff && !result.isError)) {
				const pre = outputPre(text);
				if (result.isError) pre.classList.add("error");
				body.append(pre);
			}
			const images = Array.isArray(result.content) ? result.content.filter((c) => c?.type === "image") : [];
			if (images.length) body.append(h("div", { class: "tool-images" }, images.map((img) => this.imageThumb(img))));
			const truncated = Array.isArray(result.content) && result.content.find((c) => c?.truncated);
			if (truncated && state.result && this.results.get(call.id)) body.append(this.fullOutputButton(call.id, truncated.truncated));
			if (details.fullOutputPath) body.append(h("div", { class: "tool-note" }, "Full output saved by pi at ", h("code", { dir: "ltr" }, details.fullOutputPath)));
		} else if (state.status === "running" || state.status === "waiting") {
			body.append(h("div", { class: "tool-note" }, "Running…"));
		}
		return body;
	}

	editArgs(a) {
		const edits = Array.isArray(a.edits) ? a.edits : a.oldText != null ? [{ oldText: a.oldText, newText: a.newText }] : [];
		const wrap = h("div", { class: "edit-args" });
		for (const e of edits) {
			wrap.append(renderDiff([...String(e.oldText ?? "").split("\n").map((l) => `-${l}`), ...String(e.newText ?? "").split("\n").map((l) => `+${l}`)].join("\n")));
		}
		return wrap;
	}

	fullOutputButton(callId, chars) {
		const btn = h("button", { class: "btn ghost small", type: "button" }, `Load full output (${fmtBytes(chars)})`);
		btn.onclick = async () => {
			const result = this.results.get(callId);
			const entry = this.entries.find((e) => e.type === "message" && e.message === result);
			if (!entry) return;
			btn.disabled = true;
			try {
				const { entry: full } = await getJson(`/api/entry?session=${encodeURIComponent(this.sessionId)}&entry=${encodeURIComponent(entry.id)}`);
				btn.replaceWith(outputPre(textOf(full.message.content)));
				btn.closest(".tool-body")?.querySelector(".tool-output:not(:last-child)")?.remove();
			} catch (err) {
				btn.disabled = false;
				this.app.toast(err.message, "error");
			}
		};
		return btn;
	}

	bridgeFor(callId) {
		return Object.values(this.live.bridge || {}).find((b) => b.toolCallId === callId && QUESTION_TOOLS.has(b.kind));
	}

	qaCard(kind, call, state, label) {
		const running = state.status === "running" || state.status === "waiting";
		return h("div", { class: `tool qa ${kind}${running ? " pending" : ""}`, "data-call-id": call.id }, h("div", { class: "qa-head" }, h("span", { class: "qa-badge", html: icon(kind === "quiz" ? "checkCircle" : "help") }), h("span", { class: "qa-kind" }, label)));
	}

	// quiz ─────────────────────────────────────────────────────────────────────

	buildQuiz(call, state) {
		const a = call.arguments || {};
		const card = this.qaCard("quiz", call, state, a.multiSelect ? "Quiz · select all that apply" : "Quiz");
		const details = state.result?.details;
		const ui = this.bridgeFor(call.id);
		const draft = this.drafts.get(call.id);

		card.append(this.md("qa-question", a.question || details?.question || ""));
		const context = a.details || details?.context;
		if (context) card.append(this.md("qa-context", context));

		if (details?.status === "answered") {
			card.append(this.quizOutcome(details));
		} else if (draft?.submitted) {
			card.append(this.quizOutcome(this.localQuizOutcome(call, draft)));
		} else if (ui?.displayOptions?.length) {
			card.append(this.quizForm(call, ui));
		} else {
			// The quiz shuffles when it opens; until pi reports the shown order, don't
			// number options (the terminal's numbers could differ).
			const shown = state.partial?.details?.options;
			const rows = shown
				? shown.map((o) => this.optionRow(o.index, o.label, ""))
				: normalizeOptions(a.options).map((o) => this.optionRow(0, o.label, "", "•"));
			card.append(h("div", { class: "qa-options" }, rows));
			card.append(this.qaStatusNote(state, details, "quiz"));
		}
		return card;
	}

	qaStatusNote(state, details, kind) {
		if (details?.status === "cancelled") return h("div", { class: "qa-note warn" }, "Skipped.");
		if (details?.status === "unavailable") return h("div", { class: "qa-note warn" }, details.message || "Not available in this mode.");
		if (state.status === "error") return h("div", { class: "qa-note bad" }, resultText(state.result) || "The tool failed.");
		if (state.status === "running" || state.status === "waiting") {
			const where = this.app.hasProcess?.() ? "Waiting for the question to open…" : "Waiting for your answer in the terminal.";
			return h("div", { class: "qa-note" }, h("span", { class: "spinner" }), where);
		}
		return h("div", { class: "qa-note muted" }, kind === "quiz" ? "No answer recorded." : "No answer recorded.");
	}

	optionRow(index, label, cls, mark) {
		return h("div", { class: `qa-option ${cls}` }, h("span", { class: "qa-mark" }, mark ?? String(index)), h("span", { class: "qa-label" }, this.inline(label)));
	}

	quizOutcome(d) {
		const wrap = h("div", { class: "qa-outcome" });
		const keys = new Set(d.correctIndices || []);
		const selected = new Set((d.answers || []).map((x) => x.index));
		const shown = d.options?.length ? d.options : d.answers || [];
		wrap.append(
			h(
				"div",
				{ class: "qa-options" },
				shown.map((o) => {
					const isKey = keys.has(o.index);
					const isPicked = selected.has(o.index) && !d.dontKnow;
					const cls = [isKey ? "correct" : "", isPicked ? "picked" : "", isPicked && !isKey ? "wrong" : ""].join(" ");
					return this.optionRow(o.index, o.label, cls, isKey ? "✓" : isPicked ? "✗" : String(o.index));
				}),
			),
		);
		let verdict;
		if (d.dontKnow) verdict = h("div", { class: "qa-verdict idk" }, "You said: I don't know");
		else if (d.correct) verdict = h("div", { class: "qa-verdict ok" }, h("span", { html: icon("check") }), "Correct");
		else verdict = h("div", { class: "qa-verdict bad" }, h("span", { html: icon("x") }), "Incorrect");
		if (d.unsure && !d.dontKnow) verdict.append(h("span", { class: "qa-flag" }, "flagged unsure"));
		wrap.append(verdict);
		if (d.note) wrap.append(h("div", { class: "qa-note-text", dir: "auto" }, h("strong", {}, "Your note: "), d.note));
		if (d.explanation) wrap.append(this.md("qa-explanation", d.explanation));
		return wrap;
	}

	localQuizOutcome(call, draft) {
		const a = call.arguments || {};
		const shown = draft.options;
		const authored = normalizeOptions(a.options);
		const correctValues = new Set(coerceCorrect(a.correctAnswer).map((v) => v.trim()));
		const correctIndices = shown
			.filter((o) => {
				const opt = authored.find((x) => x.label === String(o.label).trim());
				return opt && correctValues.has(opt.value);
			})
			.map((o) => o.index);
		const picked = draft.submitted.selected;
		const correct = !draft.submitted.dontKnow && picked.length === correctIndices.length && picked.every((i) => correctIndices.includes(i));
		return {
			status: "answered",
			options: shown,
			answers: picked.map((index) => ({ index })),
			correctIndices,
			correct,
			dontKnow: draft.submitted.dontKnow,
			unsure: draft.submitted.unsure,
			note: draft.submitted.note,
			explanation: a.explanation,
		};
	}

	quizForm(call, ui) {
		const multi = !!call.arguments?.multiSelect;
		let draft = this.drafts.get(call.id);
		if (!draft || draft.uid !== ui.uid) {
			draft = { uid: ui.uid, kind: "quiz", options: ui.displayOptions, selected: new Set(), unsure: false, note: "", submitted: null };
			this.drafts.set(call.id, draft);
		}
		const form = h("div", { class: "qa-form", "data-quiz": call.id });
		const submit = h("button", { class: "btn primary", type: "button" }, "Submit answer");
		const refresh = () => {
			for (const btn of form.querySelectorAll(".qa-option.choice")) {
				const on = draft.selected.has(Number(btn.dataset.index));
				btn.classList.toggle("selected", on);
				btn.setAttribute("aria-pressed", String(on));
				if (multi) btn.querySelector(".qa-mark").textContent = on ? "☑" : "☐";
			}
			submit.disabled = draft.selected.size === 0;
			unsure.classList.toggle("on", draft.unsure);
		};
		const list = h("div", { class: "qa-options" });
		for (const o of draft.options) {
			const btn = h(
				"button",
				{ class: "qa-option choice", type: "button", "data-index": o.index },
				h("span", { class: "qa-mark" }, multi ? "☐" : String(o.index)),
				h("span", { class: "qa-label" }, this.inline(o.label)),
			);
			btn.onclick = () => {
				if (multi) {
					if (!draft.selected.delete(o.index)) draft.selected.add(o.index);
				} else {
					draft.selected = new Set([o.index]);
				}
				refresh();
			};
			list.append(btn);
		}
		const idk = h("button", { class: "btn ghost", type: "button" }, "I don't know");
		idk.onclick = () => this.submitQuiz(call.id, true);
		const unsure = h("button", { class: "chip-toggle", type: "button", title: "Shortcut: U" }, "? I'm not sure");
		unsure.onclick = () => {
			draft.unsure = !draft.unsure;
			refresh();
		};
		const note = h("textarea", { class: "qa-note-input", rows: "1", dir: "auto", placeholder: "Note (optional): what were you thinking?" });
		note.value = draft.note;
		note.addEventListener("input", () => {
			draft.note = note.value;
			note.style.height = "auto";
			note.style.height = `${Math.min(note.scrollHeight, 160)}px`;
		});
		submit.onclick = () => this.submitQuiz(call.id, false);
		form.append(
			list,
			h("div", { class: "qa-extra" }, unsure, note),
			h("div", { class: "qa-actions" }, h("span", { class: "qa-keys" }, multi ? "1–9 toggle · Enter submit" : "1–9 choose · Enter submit · U unsure"), idk, submit),
		);
		refresh();
		return form;
	}

	async submitQuiz(callId, dontKnow) {
		const draft = this.drafts.get(callId);
		if (!draft || draft.submitted) return;
		if (!dontKnow && draft.selected.size === 0) return;
		const value = {
			selected: dontKnow ? [] : [...draft.selected].sort((x, y) => x - y),
			dontKnow,
			unsure: draft.unsure && !dontKnow,
			note: draft.note.trim() || undefined,
		};
		draft.submitted = value;
		this.refreshTool(callId);
		try {
			await post("/api/bridge", { session: this.sessionId, uid: draft.uid, action: "answer", value });
		} catch (err) {
			draft.submitted = null;
			this.refreshTool(callId);
			this.app.toast(`Could not send the answer: ${err.message}`, "error");
		}
	}

	/** Keyboard shortcuts for the open quiz (called by the app for unhandled keys). */
	handleKey(e) {
		const form = [...this.root.querySelectorAll(".qa-form[data-quiz]")].pop();
		if (!form) return false;
		const callId = form.dataset.quiz;
		const draft = this.drafts.get(callId);
		if (!draft || draft.submitted) return false;
		if (/^[1-9]$/.test(e.key)) {
			const btn = form.querySelector(`.qa-option.choice[data-index="${e.key}"]`);
			if (!btn) return false;
			btn.click();
			return true;
		}
		if (e.key === "Enter" && draft.selected.size) {
			this.submitQuiz(callId, false);
			return true;
		}
		if (e.key === "u" || e.key === "U") {
			form.querySelector(".chip-toggle")?.click();
			return true;
		}
		return false;
	}

	// ask_user_question ────────────────────────────────────────────────────────

	buildAsk(call, state) {
		const a = call.arguments || {};
		const options = normalizeOptions(a.options);
		const multi = !!a.multiSelect;
		const card = this.qaCard("ask", call, state, options.length ? (multi ? "Question · choose any" : "Question") : "Question · free answer");
		const details = state.result?.details;
		const ui = this.bridgeFor(call.id);
		const dialog = this.inlineDialogs.get(call.id);
		const draft = this.drafts.get(call.id);

		card.append(this.md("qa-question", a.question || details?.question || ""));
		const context = a.details || details?.context;
		if (context) card.append(this.md("qa-context", context));

		if (details?.status === "answered") {
			card.append(this.askOutcome(details, options));
		} else if (draft?.submitted) {
			card.append(h("div", { class: "qa-note" }, h("span", { class: "spinner" }), "Answer sent."));
		} else if (ui) {
			card.append(this.askForm(call, ui, options, multi));
		} else if (dialog) {
			card.append(this.askTextForm(call, dialog));
		} else {
			if (options.length) card.append(h("div", { class: "qa-options" }, options.map((o, i) => this.optionRow(i + 1, o.label, ""))));
			card.append(this.qaStatusNote(state, details, "ask"));
		}
		return card;
	}

	askOutcome(d, options) {
		const wrap = h("div", { class: "qa-outcome" });
		const answers = d.answers || [];
		if (d.mode === "text") {
			const text = answers[0]?.label || "";
			wrap.append(h("div", { class: "qa-answer-text" }, text ? this.md("", text) : h("em", {}, "(empty answer)")));
			return wrap;
		}
		const picked = new Set(answers.filter((x) => x.type === "option").map((x) => x.index));
		if (options.length) {
			wrap.append(h("div", { class: "qa-options" }, options.map((o, i) => this.optionRow(i + 1, o.label, picked.has(i + 1) ? "picked chosen" : "dim", picked.has(i + 1) ? "✓" : String(i + 1)))));
		}
		for (const other of answers.filter((x) => x.type === "other")) {
			wrap.append(h("div", { class: "qa-answer-text" }, h("strong", {}, "Other: "), this.inline(other.label)));
		}
		return wrap;
	}

	askForm(call, ui, options, multi) {
		let draft = this.drafts.get(call.id);
		if (!draft || draft.uid !== ui.uid) {
			draft = { uid: ui.uid, kind: "ask", selected: new Set(), other: "", submitted: null };
			this.drafts.set(call.id, draft);
		}
		const form = h("div", { class: "qa-form" });
		const submit = h("button", { class: "btn primary", type: "button" }, "Send answer");
		const otherInput = h("textarea", { class: "qa-note-input", rows: "1", dir: "auto", placeholder: "Other: type your own answer" });
		otherInput.value = draft.other;
		const refresh = () => {
			for (const btn of form.querySelectorAll(".qa-option.choice")) {
				const on = draft.selected.has(Number(btn.dataset.index));
				btn.classList.toggle("selected", on);
				if (multi) btn.querySelector(".qa-mark").textContent = on ? "☑" : "☐";
			}
			submit.disabled = draft.selected.size === 0 && !draft.other.trim();
		};
		const list = h("div", { class: "qa-options" });
		options.forEach((o, i) => {
			const index = i + 1;
			const btn = h(
				"button",
				{ class: "qa-option choice", type: "button", "data-index": index },
				h("span", { class: "qa-mark" }, multi ? "☐" : String(index)),
				h("span", { class: "qa-label" }, this.inline(o.label), o.description ? h("span", { class: "qa-desc" }, this.inline(o.description)) : null),
			);
			btn.onclick = () => {
				if (multi) {
					if (!draft.selected.delete(index)) draft.selected.add(index);
					refresh();
				} else {
					draft.selected = new Set([index]);
					draft.other = "";
					this.submitAsk(call.id);
				}
			};
			list.append(btn);
		});
		otherInput.addEventListener("input", () => {
			draft.other = otherInput.value;
			if (!multi && draft.other.trim()) draft.selected.clear();
			refresh();
		});
		otherInput.addEventListener("keydown", (e) => {
			if (e.key === "Enter" && !e.shiftKey && !e.isComposing && !submit.disabled) {
				e.preventDefault();
				this.submitAsk(call.id);
			}
		});
		submit.onclick = () => this.submitAsk(call.id);
		const skip = h("button", { class: "btn ghost", type: "button" }, "Skip");
		skip.onclick = () => post("/api/bridge", { session: this.sessionId, uid: draft.uid, action: "cancel" }).catch((err) => this.app.toast(err.message, "error"));
		form.append(list, otherInput, h("div", { class: "qa-actions" }, skip, submit));
		refresh();
		return form;
	}

	async submitAsk(callId) {
		const draft = this.drafts.get(callId);
		if (!draft || draft.submitted) return;
		const value = { selected: [...draft.selected].sort((x, y) => x - y), other: draft.other.trim() || null };
		if (!value.selected.length && !value.other) return;
		draft.submitted = value;
		this.refreshTool(callId);
		try {
			await post("/api/bridge", { session: this.sessionId, uid: draft.uid, action: "answer", value });
		} catch (err) {
			draft.submitted = null;
			this.refreshTool(callId);
			this.app.toast(`Could not send the answer: ${err.message}`, "error");
		}
	}

	askTextForm(call, dialog) {
		const form = h("div", { class: "qa-form" });
		const area = h("textarea", { class: "qa-answer-input", rows: "3", dir: "auto", placeholder: "Write your answer…" });
		if (dialog.prefill) area.value = dialog.prefill;
		const send = async (cancelled) => {
			this.drafts.set(call.id, { submitted: true });
			this.refreshTool(call.id);
			try {
				await post("/api/ui-response", cancelled ? { session: this.sessionId, id: dialog.id, cancelled: true } : { session: this.sessionId, id: dialog.id, value: area.value });
			} catch (err) {
				this.drafts.delete(call.id);
				this.refreshTool(call.id);
				this.app.toast(err.message, "error");
			}
		};
		area.addEventListener("keydown", (e) => {
			if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
				e.preventDefault();
				send(false);
			}
		});
		form.append(
			area,
			h(
				"div",
				{ class: "qa-actions" },
				h("span", { class: "qa-keys" }, "Ctrl+Enter to send"),
				h("button", { class: "btn ghost", type: "button", onclick: () => send(true) }, "Skip"),
				h("button", { class: "btn primary", type: "button", onclick: () => send(false) }, "Send answer"),
			),
		);
		setTimeout(() => area.focus(), 50);
		return form;
	}

	/** Show an extension `editor` dialog inside the ask_user_question card it belongs to. */
	claimDialog(req) {
		if (req.method !== "editor") return false;
		const running = Object.values(this.live.tools).find((t) => t.toolName === "ask_user_question" && !t.done && !normalizeOptions(t.args?.options).length);
		if (!running || !this.toolNodes.has(running.toolCallId)) return false;
		this.inlineDialogs.set(running.toolCallId, req);
		this.drafts.delete(running.toolCallId);
		this.refreshTool(running.toolCallId);
		this.toolNodes.get(running.toolCallId)?.el.scrollIntoView({ block: "center", behavior: "smooth" });
		return true;
	}

	releaseDialog(id) {
		for (const [callId, req] of this.inlineDialogs) {
			if (req.id === id) {
				this.inlineDialogs.delete(callId);
				this.refreshTool(callId);
			}
		}
	}

	// subagent ────────────────────────────────────────────────────────────────

	subagentLabel(info) {
		if (!info) return "";
		const since = Date.parse(info.launchedAt || "");
		switch (info.state) {
			case "running":
				return `running${Number.isFinite(since) ? ` · ${fmtDuration(Date.now() - since)}` : ""}`;
			case "done":
				return `finished${info.elapsed ? ` in ${fmtDuration(info.elapsed * 1000)}` : ""}`;
			case "failed":
				return "failed";
			case "stopped":
				return "never reported back";
			default:
				return "";
		}
	}

	watchButton(sub, label = "Watch") {
		if (!sub?.file || !this.app.watchSubagent) return null;
		return h(
			"button",
			{ class: "btn ghost small open-session", type: "button", title: "Follow this subagent live in a side panel", onclick: () => this.app.watchSubagent(sub) },
			h("span", { html: icon("layers") }),
			label,
		);
	}

	/** Re-draw subagent cards (their running/finished state lives in other sessions). */
	refreshSubagents() {
		for (const [id, rec] of this.toolNodes) if (rec.call.name === "subagent" || rec.call.name === "invoke_subagent") this.refreshTool(id);
	}

	buildSubagent(call, state) {
		const a = call.arguments || {};
		const d = state.result?.details || {};
		const error = state.status === "error" ? resultText(state.result) : d.error;
		const sub = d.sessionFile ? { file: d.sessionFile, agent: a.agent || d.agent, name: a.name || d.name } : null;
		const info = sub ? this.app.subagentInfo?.(sub.file, this.meta) : null;
		const stateText = error ? "failed to start" : info ? this.subagentLabel(info) : state.status === "running" ? "launching…" : state.status === "done" ? "launched" : "";
		const el = h(
			"div",
			{ class: `tool subagent status-${state.status} sub-${info?.state || "none"}`, "data-call-id": call.id },
			h(
				"div",
				{ class: "subagent-head" },
				h("span", { class: "tool-icon", html: icon("bot") }),
				h("span", { class: "subagent-agent" }, a.agent || d.agent || "subagent"),
				a.name || d.name ? h("span", { class: "subagent-name" }, a.name || d.name) : null,
				h("span", { class: "subagent-state" }, info?.state === "running" ? h("span", { class: "spinner" }) : null, stateText),
				this.watchButton(sub),
			),
		);
		if (a.task) el.append(this.collapsible(this.md("subagent-task", a.task), 4));
		if (error) el.append(h("div", { class: "qa-note bad" }, firstLine(error, 300)));
		return el;
	}

	// ── live (RPC) updates ───────────────────────────────────────────────────

	onRpc(ev) {
		applyEvent(this.live, ev);
		switch (ev.type) {
			case "message_update":
				this.updatePartial();
				return;
			case "message_start":
				if (ev.message?.role === "assistant") {
					this.streamT0 = Date.now();
					this.streamChars = 0;
					this.renderPartial();
				}
				return;
			case "message_end":
				if (ev.message?.role === "assistant" && this.streamT0) {
					// Exact: real output tokens over the true streamed seconds.
					const secs = (Date.now() - this.streamT0) / 1000;
					const out = Number(ev.message.usage?.output) || 0;
					if (secs > 0.4 && out > 3) this.tpsBy.set(messageKey(ev.message), Math.round(out / secs));
					this.streamT0 = 0;
					this.streamChars = 0;
				}
				this.partial = null;
				this.pruneFinals();
				if (ev.message?.role === "toolResult") this.refreshTool(ev.message.toolCallId);
				this.renderLive();
				break;
			case "tool_execution_start":
			case "tool_execution_end":
				this.refreshTool(ev.toolCallId);
				break;
			case "tool_execution_update":
				this.scheduleToolRefresh(ev.toolCallId);
				return;
			case "agent_start":
				this.busySince = Date.now();
				this.renderStatus();
				break;
			case "agent_settled":
				this.renderLive();
				break;
			default:
				this.renderStatus();
		}
		this.afterChange();
	}

	setLive(live) {
		this.live = live || createLive();
		this.partial = null;
		this.renderLive();
		for (const id of this.toolNodes.keys()) this.refreshTool(id);
	}

	onUi(req) {
		applyUiRequest(this.live, req);
	}

	onBridgeOpen(ui) {
		this.live.bridge[ui.uid] = ui;
		if (ui.toolCallId && QUESTION_TOOLS.has(ui.kind)) {
			this.refreshTool(ui.toolCallId);
			const node = this.toolNodes.get(ui.toolCallId)?.el;
			if (node) requestAnimationFrame(() => node.scrollIntoView({ block: "center", behavior: "smooth" }));
		}
	}

	onBridgeClose(uid) {
		const ui = this.live.bridge[uid];
		delete this.live.bridge[uid];
		if (ui?.toolCallId) this.refreshTool(ui.toolCallId);
	}

	renderLive() {
		const nodes = [];
		const keep = new Set();
		for (const m of this.live.finals) {
			if (m.role === "toolResult") continue;
			const key = messageKey(m);
			keep.add(key);
			let node = this.liveNodes.get(key);
			if (!node) {
				if (m.role === "user") node = this.renderUser(m, "");
				else if (m.role === "assistant") node = this.renderAssistant(m, "");
				else if (m.role === "bashExecution") node = this.renderBash(m);
				else if (m.role === "custom") node = this.renderCustom({ type: "message", message: m });
				else continue;
				this.liveNodes.set(key, node);
			}
			nodes.push(node);
		}
		for (const key of [...this.liveNodes.keys()]) if (!keep.has(key)) this.liveNodes.delete(key);
		if (this.live.partial) nodes.push(this.partialNode());
		let previous = this.lastItemKind;
		for (const node of nodes) {
			const isAssistant = node.classList.contains("assistant");
			node.classList.toggle("continued", isAssistant && previous === "assistant");
			previous = isAssistant ? "assistant" : "other";
		}
		reconcile(this.liveEl, nodes);
		this.renderStatus();
	}

	partialNode() {
		if (!this.partial) {
			const body = h("div", { class: "assistant-body" });
			this.partial = { el: h("div", { class: "item assistant streaming" }, h("div", { class: "avatar" }, "π"), body), body, blocks: [] };
		}
		this.fillPartial();
		return this.partial.el;
	}

	renderPartial() {
		if (!this.live.partial) return;
		if (!this.partial || !this.partial.el.isConnected) {
			this.renderLive();
		} else {
			this.fillPartial();
		}
		this.afterChange();
	}

	fillPartial() {
		const msg = this.live.partial;
		const p = this.partial;
		if (!msg || !p) return;
		const content = msg.content || [];
		content.forEach((block, i) => {
			if (!block) return;
			let slot = p.blocks[i];
			if (!slot || slot.type !== block.type) {
				let el;
				if (block.type === "thinking") el = this.renderThinking(block.thinking || "", true);
				else if (block.type === "text") el = h("div", { class: "md" });
				else if (block.type === "toolCall") el = h("div", { class: "tool generic status-running forming" });
				else el = h("div");
				slot = { type: block.type, el, len: -1 };
				if (p.blocks[i]?.el) p.blocks[i].el.replaceWith(el);
				else p.body.append(el);
				p.blocks[i] = slot;
			}
			if (block.type === "text" && block.text.length !== slot.len) {
				renderInto(slot.el, block.text, this.env(), { diagrams: false });
				slot.len = block.text.length;
			} else if (block.type === "thinking" && (block.thinking || "").length !== slot.len) {
				slot.el._setText?.(block.thinking || "");
				slot.len = (block.thinking || "").length;
			} else if (block.type === "toolCall") {
				const label = toolSummary(block);
				if (slot.len !== label.length) {
					slot.el.replaceChildren(
						h(
							"div",
							{ class: "tool-head" },
							h("span", { class: "tool-icon", html: toolIcon(block.name) }),
							h("span", { class: "tool-name" }, block.name),
							h("span", { class: "tool-arg" }, label),
							h("span", { class: "tool-status running" }, h("span", { class: "spinner" })),
						),
					);
					slot.len = label.length;
				}
			}
		});
	}

	renderStatus() {
		const live = this.live;
		const parts = [];
		if (live.retry) {
			parts.push(
				h("div", { class: "live-row warn" }, h("span", { class: "spinner" }), `Retrying (attempt ${live.retry.attempt}/${live.retry.maxAttempts})${live.retry.errorMessage ? `: ${firstLine(live.retry.errorMessage, 160)}` : ""}`),
			);
		} else if (live.compaction) {
			parts.push(h("div", { class: "live-row" }, h("span", { class: "spinner" }), "Compacting the context…"));
		} else if (live.busy && !live.partial && !Object.values(live.tools).some((t) => !t.done)) {
			parts.push(h("div", { class: "live-row" }, h("span", { class: "dots" }, h("i"), h("i"), h("i")), "Working"));
		}
		// Live speed while the reply streams: characters ≈ 4 per token.
		if (live.partial && this.streamT0) {
			const chars = (live.partial.content || []).filter((b) => b?.type === "text").reduce((n, b) => n + (b.text?.length || 0), this.streamChars);
			if (chars > this.streamChars) this.streamChars = chars;
			const secs = (Date.now() - this.streamT0) / 1000;
			const est = Math.round(this.streamChars / 4 / Math.max(secs, 0.4));
			if (est > 2) parts.push(h("div", { class: "live-row tps-row" }, h("span", { html: icon("zap") }), `streaming ~${est} tok/s`));
		}
		if (live.error) parts.push(h("div", { class: "msg-error" }, h("span", { html: icon("alert") }), h("span", {}, live.error)));
		// While a reply streams, its Copy button only exists once it settles —
		// and the text re-renders constantly, which also breaks selecting it with
		// the mouse. Offer the text so far right here instead. The click is handled
		// by delegation (like code copies) so re-renders never lose it.
		if (live.partial && (live.partial.content || []).some((b) => b?.type === "text" && b.text?.trim()))
			parts.push(
				h(
					"div",
					{ class: "live-row copy-row" },
					h(
						"button",
						{ class: "meta-btn copy-so-far", type: "button", title: "Copy the reply so far" },
						h("span", { html: icon("copy") }),
						"Copy text so far",
					),
				),
			);
		this.statusEl.replaceChildren(...parts);
	}

	// ── clicks, scrolling ────────────────────────────────────────────────────

	onClick(e) {
		const soFar = e.target.closest(".copy-so-far");
		if (soFar) {
			// Read the partial at click time: it is always the newest text.
			const txt = ((this.live.partial?.content || []) || [])
				.filter((b) => b?.type === "text" && b.text?.trim())
				.map((b) => b.text)
				.join("\n\n")
				.trim();
			if (txt) this.app.copy(txt, soFar);
			return;
		}
		const copyBtn = e.target.closest(".code-copy");
		if (copyBtn) {
			const code = copyBtn.closest(".code-block")?.querySelector("code");
			if (code) this.app.copy(code.textContent, copyBtn);
			return;
		}
		const img = e.target.closest("img.thumb, img.embed-img, .md img");
		if (img) {
			this.app.lightbox(img.src, img.alt);
			return;
		}
		const local = e.target.closest("a[data-local]");
		if (local) {
			e.preventDefault();
			this.app.toast(`Local link: ${local.getAttribute("href")}`, "info");
		}
	}

	nearBottom() {
		const s = this.scroller;
		return s.scrollHeight - s.scrollTop - s.clientHeight < 140;
	}

	scrollToBottom(force = false) {
		if (!force && !this.stick) return;
		requestAnimationFrame(() => {
			this.scroller.scrollTop = this.scroller.scrollHeight;
			this.stick = true;
		});
	}

	afterChange() {
		if (this.stick) this.scrollToBottom();
		else this.app.onStickChange?.(false, true);
	}
}

function reconcile(container, nodes) {
	let i = 0;
	for (const node of nodes) {
		const current = container.children[i];
		if (current !== node) container.insertBefore(node, current || null);
		i++;
	}
	while (container.children.length > nodes.length) container.lastElementChild.remove();
}

export { esc, toMs };
