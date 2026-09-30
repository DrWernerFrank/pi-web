// pi-web: the page controller (sidebar, top bar, composer, dialogs, routing).

import { ansiToHtml, stripAnsi } from "./ansi.js";
import { getJson, post, rpc, streamUrl } from "./api.js";
import { Conversation } from "./conversation.js";
import { icon } from "./icons.js";
import { textOf } from "./live.js";
import { renderInto, rerenderDiagrams } from "./markdown.js";
import { WatchPanel } from "./panel.js";
import { $, copyText, debounce, fmtCost, fmtDuration, fmtRelative, fmtTokens, h, prettyPath, storage, store, textDir, toMs } from "./util.js";

const TUI_ONLY = new Set([
	"settings",
	"scoped-models",
	"login",
	"logout",
	"llama",
	"tree",
	"fork",
	"clone",
	"import",
	"share",
	"bug",
	"trust",
	"reload",
	"hotkeys",
	"changelog",
]);
const WEB_COMMANDS = [
	{ name: "model", description: "Choose the model" },
	{ name: "thinking", description: "Set the thinking level: /thinking high" },
	{ name: "name", description: "Rename this session: /name My topic" },
	{ name: "compact", description: "Summarize older context to free space" },
	{ name: "new", description: "Start a new chat" },
	{ name: "resume", description: "Find another session" },
	{ name: "session", description: "Session file, id and usage" },
	{ name: "copy", description: "Copy the last reply" },
	{ name: "export", description: "Export this session to HTML" },
	{ name: "quit", description: "Stop the pi process for this session" },
];
const EXTERNAL_WINDOW_MS = 2 * 60 * 1000;
// A subagent that has not reported back and whose session has been quiet this long is shown as stopped.
const SUBAGENT_STALE_MS = 15 * 60 * 1000;
// Widgets the page draws natively instead (pi-interactive-subagents' status box).
const NATIVE_WIDGETS = new Set(["subagent-status"]);

const S = {
	settings: {
		theme: "system",
		tools: "compact",
		thinking: true,
		fontSize: 17,
		sidebar: true,
		showSubagents: false,
		showArchived: false,
		...storage("pi-web:settings", {}),
	},
	// Full-text search results (id → {count, snippets}) from /api/search;
	// filled as you type in the sidebar's search box.
	searchHits: new Map(),
	sessions: new Map(),
	byFile: new Map(),
	usage: null,
	agy: null, // Antigravity app status + model quota
	agyStarted: false,
	procs: new Map(),
	attention: new Set(),
	current: null,
	meta: null,
	proc: null,
	home: "",
	server: {},
	search: "",
	commands: null,
	attachments: [],
	sending: false,
	connected: false,
};

// ── app facade used by the conversation view ────────────────────────────────

const app = {
	get settings() {
		return S.settings;
	},
	navigate,
	toast,
	copy,
	lightbox,
	setToolsMode(mode) {
		setSetting("tools", mode);
	},
	isExternallyActive,
	hasProcess,
	subagentInfo,
	watchSubagent,
	onStickChange(stuck, grew) {
		const pill = $("#jump");
		if (stuck) pill.hidden = true;
		else if (grew) pill.hidden = false;
	},
};

let conv;
let panel;

// ── settings, theme ─────────────────────────────────────────────────────────

const systemDark = window.matchMedia("(prefers-color-scheme: dark)");

function applyTheme() {
	const theme = S.settings.theme === "system" ? (systemDark.matches ? "dark" : "light") : S.settings.theme;
	const changed = document.documentElement.dataset.theme !== theme;
	document.documentElement.dataset.theme = theme;
	document.documentElement.style.setProperty("--reading", `${S.settings.fontSize}px`);
	document.body.classList.toggle("tools-hidden", S.settings.tools === "hidden");
	document.body.classList.toggle("hide-thinking", !S.settings.thinking);
	$("#app").classList.toggle("sidebar-hidden", !S.settings.sidebar);
	$("#btn-theme").innerHTML = icon(S.settings.theme === "dark" ? "moon" : S.settings.theme === "light" ? "sun" : "monitor");
	$("#btn-theme").title = `Theme: ${S.settings.theme}`;
	if (changed) rerenderDiagrams(document);
}
systemDark.addEventListener("change", applyTheme);

function setSetting(key, value) {
	const before = S.settings[key];
	S.settings[key] = value;
	store("pi-web:settings", S.settings);
	applyTheme();
	if (key === "tools" && before !== value && conv) conv.rerender();
}

// ── toasts, lightbox, copy ──────────────────────────────────────────────────

function toast(message, level = "info", detail) {
	const el = h(
		"div",
		{ class: `toast ${level}`, role: "status" },
		h("div", { class: "toast-msg", dir: "auto" }, String(message ?? "")),
		detail ? h("details", {}, h("summary", {}, "Details"), h("pre", { dir: "ltr" }, stripAnsi(detail))) : null,
	);
	const close = () => {
		el.classList.add("leaving");
		setTimeout(() => el.remove(), 200);
	};
	el.addEventListener("click", (e) => {
		if (!e.target.closest("details")) close();
	});
	$("#toasts").append(el);
	setTimeout(close, level === "error" ? 12000 : 5000);
	return el;
}

async function copy(text, button) {
	const ok = await copyText(text);
	if (button) {
		const old = button.innerHTML;
		button.innerHTML = ok ? `${icon("check")}Copied` : "Copy failed";
		setTimeout(() => (button.innerHTML = old), 1400);
	}
	if (ok) {
		if (!button) toast("Copied", "info");
	} else {
		toast("Copying failed — the window may not be focused. Click anywhere in the page, then try again; selecting the text and Ctrl+C always works.", "error");
	}
}

const VISION_DEFAULT_PROMPT = "Read this image: transcribe any text it contains, then describe what it shows.";

/** What the read endpoint needs for a given image src: a session ref, a file
 *  path, an embed name, or inline data. External URLs can't be read. */
function visionTarget(src) {
	if (!src) return null;
	if (src.startsWith("data:")) {
		const m = /^data:(image\/[\w.+-]+);base64,(.*)$/s.exec(src);
		return m ? { data: m[2], mimeType: m[1] } : null;
	}
	const u = new URL(src, location.href);
	const session = u.searchParams.get("session");
	if (!session) return null;
	if (u.pathname.startsWith("/api/image")) return { session, ref: u.searchParams.get("ref") || "" };
	if (u.pathname.startsWith("/api/file")) return { session, path: u.searchParams.get("path") || "" };
	if (u.pathname.startsWith("/api/embed")) return { session, name: u.searchParams.get("name") || "" };
	return null;
}

function lightbox(src, alt) {
	const box = $("#lightbox");
	const target = visionTarget(src);
	const img = h("img", { src, alt: alt || "" });
	box.replaceChildren(h("div", { class: "lb-frame" }, img, target ? visionPanel(target) : ""));
	box.hidden = false;
}

/** Side panel in the lightbox: read the image with Claude Sonnet 5.5 (models
 *  that can't see images get eyes; ones that can get a second opinion). */
function visionPanel(target) {
	const prompt = h("input", { class: "lb-prompt", type: "text", value: VISION_DEFAULT_PROMPT, dir: "auto" });
	const read = h("button", { class: "btn primary small lb-read", type: "button" }, h("span", { html: icon("sparkles") }), "Read with Claude");
	const meta = h("div", { class: "lb-model" });
	const out = h("div", { class: "lb-result", hidden: true });
	read.onclick = async () => {
		read.disabled = true;
		out.hidden = false;
		out.replaceChildren(h("div", { class: "live-row" }, h("span", { class: "spinner" }), "Reading with Claude…"));
		meta.textContent = "";
		try {
			const r = await post("/api/vision/read", { ...target, prompt: prompt.value.trim() || undefined });
			meta.textContent = r.model || "Claude";
			out.replaceChildren(renderInto(h("div", { class: "md" }), String(r.text || ""), { sessionId: target.session }));
			out.append(h("button", { class: "meta-btn", type: "button", onclick: (e) => copy(r.text, e.currentTarget) }, h("span", { html: icon("copy") }), "Copy"));
		} catch (err) {
			out.replaceChildren(h("div", { class: "msg-error" }, h("span", { html: icon("alert") }), h("span", {}, err.message)));
		} finally {
			read.disabled = false;
		}
	};
	prompt.addEventListener("keydown", (e) => {
		if (e.key === "Enter") {
			e.preventDefault();
			read.click();
		}
	});
	return h(
		"aside",
		{ class: "lb-panel" },
		h("div", { class: "lb-head" }, h("span", { class: "lb-title" }, h("span", { html: icon("sparkles") }), "Claude vision"), h("span", { class: "lb-note" }, "Sonnet 5.5 · reads images your chat model can’t see")),
		prompt,
		read,
		meta,
		out,
	);
}

// ── helpers ─────────────────────────────────────────────────────────────────

function hasProcess() {
	return !!S.proc && ["starting", "ready"].includes(S.proc.state);
}

function isAgy(meta) {
	return meta?.kind === "antigravity";
}

function isExternallyActive(meta) {
	if (!meta) return false;
	if (isAgy(meta)) return !!meta.running;
	const proc = S.procs.get(meta.id);
	if (proc && proc.state !== "exited") return false;
	return Date.now() - (meta.mtime || 0) < EXTERNAL_WINDOW_MS;
}

function sessionTitle(s) {
	return s?.name || s?.firstUser || "(empty session)";
}

function shortModel(model) {
	if (!model) return "";
	const id = model.includes("/") ? model.slice(model.indexOf("/") + 1) : model;
	return id.replace(/^claude-/, "").replace(/:free$/, "");
}

function activity(s) {
	return toMs(s.lastActivity) || s.mtime || 0;
}

function indexSessions() {
	S.byFile = new Map();
	for (const s of S.sessions.values()) if (s.file) S.byFile.set(s.file, s);
}

/**
 * State of a subagent, from the parent's record (launched / reported back) and
 * its own session's activity: running | done | failed | stopped.
 */
function subagentInfo(file, parent) {
	if (!file) return undefined;
	let sub = parent?.subagents?.find((s) => s.file === file);
	if (!sub) {
		for (const s of S.sessions.values()) {
			sub = s.subagents?.find((x) => x.file === file);
			if (sub) break;
		}
	}
	const child = S.byFile.get(file);
	const info = sub ? { ...sub } : { file, agent: child?.agent, name: child?.agentName };
	const last = child ? Math.max(child.mtime || 0, toMs(child.lastActivity)) : toMs(info.launchedAt);
	if (isAgy(child)) {
		// Antigravity says itself whether a conversation is still working.
		info.agent ??= child.agent;
		info.name ??= child.agentName;
		info.state = child.running ? "running" : child.killed ? "failed" : "done";
	} else if (info.done) info.state = info.exitCode ? "failed" : "done";
	else info.state = Date.now() - last < SUBAGENT_STALE_MS ? "running" : "stopped";
	info.childId = child?.id;
	info.lastActivity = last;
	return info;
}

function runningSubagents(meta) {
	return (meta?.subagents || []).map((s) => subagentInfo(s.file, meta)).filter((i) => i.state === "running");
}

function watchSubagent(sub) {
	if (window.innerWidth < 860) {
		const info = subagentInfo(sub.file);
		if (info?.childId) navigate(info.childId);
		else toast("The subagent hasn't saved anything yet. Try again in a moment.", "info");
		return;
	}
	panel.open(sub);
}

// ── routing ─────────────────────────────────────────────────────────────────

function navigate(id) {
	const hash = id ? `#/s/${encodeURIComponent(id)}` : "#/";
	if (location.hash === hash) route();
	else location.hash = hash;
}

function route() {
	const m = /^#\/s\/(.+)$/.exec(location.hash);
	openSession(m ? decodeURIComponent(m[1]) : null);
	if (window.innerWidth < 860) setSidebarOpenMobile(false);
}

function openSession(id) {
	if (S.current === id && S.es) return;
	saveDraft();
	S.current = id;
	S.meta = id ? S.sessions.get(id) || null : null;
	S.proc = null;
	S.commands = null;
	S.attachments = [];
	S.attention.delete(id);
	conv.clear();
	if (id) conv.showLoading();
	panel.close();
	closeAllDialogs();
	closeTerminal();
	document.body.classList.toggle("no-session", !id);
	renderTopbar();
	renderSessionList();
	renderAttachments();
	renderDock();
	renderStatus();
	loadDraft();
	updateComposer();
	connect(id);
	if (!id) renderHome();
}

// ── server events ───────────────────────────────────────────────────────────

function connect(id) {
	S.es?.close();
	const es = new EventSource(streamUrl(id));
	S.es = es;
	const on = (name, fn) =>
		es.addEventListener(name, (e) => {
			if (S.es !== es) return;
			let data;
			try {
				data = JSON.parse(e.data);
			} catch {
				return;
			}
			try {
				fn(data);
			} catch (err) {
				console.error(`[pi-web] ${name} handler`, err);
			}
		});
	es.onopen = () => setConnected(true);
	es.onerror = () => {
		setConnected(false);
		// CLOSED means the server refused us, typically a restart with a new token: reload once it's back.
		if (es.readyState === EventSource.CLOSED) reloadWhenServerBack();
	};

	on("hello", onHello);
	on("session_upsert", (meta) => {
		S.sessions.set(meta.id, meta);
		if (meta.file) S.byFile.set(meta.file, meta);
		if (meta.id === S.current) {
			S.meta = meta;
			conv.setMeta(meta);
			renderTopbar();
			renderStatus();
			renderDock();
		} else if (S.meta?.subagents?.some((s) => s.file === meta.file)) {
			// One of this session's subagents changed.
			subagentsChangedSoon();
		}
		panel.onSessions();
		renderSessionListSoon();
	});
	on("session_remove", ({ id: gone }) => {
		S.sessions.delete(gone);
		indexSessions();
		renderSessionListSoon();
	});
	on("snapshot", (snap) => {
		if (!snap) return;
		conv.load(snap, { keepScroll: true });
		S.meta = snap.meta;
		S.proc = snap.proc;
		renderTopbar();
		updateComposer();
		renderDock();
		renderStatus();
	});
	on("entries", ({ entries, links }) => conv.addEntries(entries, links));
	on("rpc", (ev) => {
		conv.onRpc(ev);
		if (ev.type === "agent_start" || ev.type === "agent_settled" || ev.type === "queue_update") {
			updateComposer();
			renderDock();
		}
		if (ev.type === "agent_settled") {
			document.title = pageTitle();
			// A finished run moved the plan usage; the server caches it for a minute.
			if (Date.now() - toMs(S.usage?.fetchedAt) > 30_000) refreshUsage();
		}
	});
	on("ui", onUi);
	on("ui_done", ({ id: dialogId }) => {
		delete conv.live.dialogs[dialogId];
		closeDialog(dialogId);
		conv.releaseDialog(dialogId);
	});
	on("bridge_open", (ui) => {
		conv.onBridgeOpen(ui);
		if (ui.kind === "terminal") openTerminal(ui);
		document.title = pageTitle();
	});
	on("bridge_render", ({ uid, lines }) => {
		const ui = conv.live.bridge[uid];
		if (ui) ui.lines = lines;
		if (term?.uid === uid) paintTerminal(lines);
	});
	on("bridge_close", ({ uid }) => {
		conv.onBridgeClose(uid);
		if (term?.uid === uid) closeTerminal();
		document.title = pageTitle();
	});
	on("widget", ({ key, widget }) => {
		if (widget) conv.live.widgets[key] = widget;
		else delete conv.live.widgets[key];
		renderDock();
	});
	on("proc", (info) => {
		const was = S.proc?.state;
		S.proc = info;
		S.procs.set(info.sessionId || S.current, { sessionId: info.sessionId, state: info.state, busy: info.busy });
		if (info.state === "exited") {
			conv.setLive(null);
			S.commands = null;
			closeAllDialogs();
			closeTerminal();
		}
		if (was !== "ready" && info.state === "ready") loadCommands();
		renderTopbar();
		updateComposer();
		renderDock();
		renderStatus();
		renderSessionListSoon();
	});
	on("proc_summary", (p) => {
		if (p.sessionId) S.procs.set(p.sessionId, p);
		renderSessionListSoon();
	});
	on("attention", ({ sessionId, kind, title }) => {
		if (!sessionId || sessionId === S.current) return;
		S.attention.add(sessionId);
		renderSessionListSoon();
		const what = kind === "quiz" ? "a quiz" : kind === "ask_user_question" ? "a question" : "something";
		const t = toast(`pi is asking ${what} in “${sessionTitle(S.sessions.get(sessionId))}”${title ? `: ${title}` : ""}. Click to open.`, "info");
		t.addEventListener("click", () => navigate(sessionId));
	});
	on("notice", ({ level, message, detail }) => toast(message, level || "info", detail));
	on("moved", ({ to }) => navigate(to));
}

function setConnected(ok) {
	S.connected = ok;
	$("#offline").hidden = ok;
}

function reloadWhenServerBack() {
	clearTimeout(S.reloadTimer);
	S.reloadTimer = setTimeout(async () => {
		try {
			const res = await fetch("/api/health", { cache: "no-store" });
			if (res.ok) {
				saveDraft();
				location.reload();
				return;
			}
		} catch {
			// still down
		}
		reloadWhenServerBack();
	}, 1500);
}

function onHello(data) {
	S.home = data.home || "";
	S.server = data;
	S.sessions = new Map((data.sessions || []).map((s) => [s.id, s]));
	indexSessions();
	panel.onSessions();
	if (data.antigravity && !S.agyStarted) {
		S.agyStarted = true;
		refreshAgy();
	}
	S.procs = new Map((data.procs || []).filter((p) => p.sessionId).map((p) => [p.sessionId, p]));
	if (S.current) {
		const snap = data.session;
		if (!snap) {
			toast("That session no longer exists.", "warn");
			navigate(null);
			return;
		}
		conv.load(snap, { keepScroll: conv.sessionId === S.current && conv.entries.length > 0 });
		S.meta = snap.meta;
		S.proc = snap.proc;
		for (const req of Object.values(snap.live?.dialogs || {})) onUi(req);
		for (const ui of Object.values(snap.live?.bridge || {})) if (ui.kind === "terminal") openTerminal(ui);
		if (hasProcess() && !S.commands) loadCommands();
	} else {
		renderHome();
	}
	renderSessionList();
	renderTopbar();
	updateComposer();
	renderDock();
	renderStatus();
	document.title = pageTitle();
}

function onUi(req) {
	conv.onUi(req);
	switch (req.method) {
		case "notify":
			toast(stripAnsi(req.message), req.notifyType === "error" ? "error" : req.notifyType === "warning" ? "warn" : "info");
			break;
		case "setStatus":
		case "setWidget":
			renderDock();
			break;
		case "setTitle":
			renderTopbar();
			break;
		case "set_editor_text":
			setComposerText(req.text || "");
			break;
		case "select":
		case "confirm":
		case "input":
		case "editor":
			if (!conv.claimDialog(req)) openDialog(req);
			document.title = pageTitle();
			break;
	}
}

function pageTitle() {
	const waiting = conv && (Object.keys(conv.live.dialogs).length || Object.keys(conv.live.bridge).length);
	const base = S.current ? sessionTitle(S.meta) : "pi";
	return `${waiting ? "● " : ""}${base} · pi`;
}

// ── sidebar ─────────────────────────────────────────────────────────────────

const renderSessionListSoon = debounce(() => renderSessionList(), 120);

function matchesSearch(s, q) {
	return [s.name, s.firstUser, s.cwd, s.agent, s.agentName, s.id].some((v) => v && String(v).toLowerCase().includes(q));
}

// ── pinned chats ────────────────────────────────────────────────────────────
// A short list of ids kept in localStorage; pinned chats sit above the folder
// groups, always visible (and never folded away by a group's "Show more").
function pinnedIds() {
	return new Set(storage("pi-web:pinned", []));
}
function togglePinned(s) {
	const ids = pinnedIds();
	if (ids.has(s.id)) ids.delete(s.id);
	else ids.add(s.id);
	store("pi-web:pinned", [...ids]);
	renderSessionList();
}

function renderSessionList() {
	const list = $("#session-list");
	const q = S.search.trim().toLowerCase();
	const all = [...S.sessions.values()];
	const childrenOf = new Map();
	for (const s of all) {
		if (!s.parentId) continue;
		if (!childrenOf.has(s.parentId)) childrenOf.set(s.parentId, []);
		childrenOf.get(s.parentId).push(s);
	}
	const visible = all.filter((s) => {
		if (q) return matchesSearch(s, q) || S.searchHits.has(s.id); // title match or a full-text hit
		// Archived chats stay out of the list — except the one you're reading, or when "Archived" is on.
		if (s.archived && !S.settings.showArchived && s.id !== S.current) return false;
		return !s.parentId || S.settings.showSubagents || s.id === S.current;
	});
	const groups = new Map();
	for (const s of visible) {
		const key = isAgy(s) ? `antigravity:${s.cwd || ""}` : s.cwd || "";
		if (!groups.has(key)) groups.set(key, []);
		groups.get(key).push(s);
	}
	const ordered = [...groups.entries()]
		.map(([key, items]) => {
			const agy = key.startsWith("antigravity:");
			const cwd = agy ? key.slice("antigravity:".length) : key;
			const label = agy ? `Antigravity${cwd ? ` · ${prettyPath(cwd, S.home)}` : ""}` : prettyPath(cwd, S.home) || "(unknown folder)";
			return { cwd: key, label, agy, items: items.sort((a, b) => activity(b) - activity(a)) };
		})
		.sort((a, b) => activity(b.items[0]) - activity(a.items[0]));

	// Pinned chats break out of their folder groups: a flat block above them,
	// always expanded, never behind a group's "Show more". That's the point —
	// a chat you pin is one you don't want to hunt for inside a folder stack.
	const pins = pinnedIds();
	const pinnedRows = q ? [] : visible.filter((s) => pins.has(s.id) && !s.parentId).sort((a, b) => activity(b) - activity(a));

	const frag = document.createDocumentFragment();
	if (pinnedRows.length) {
		frag.append(h("div", { class: "pin-head" }, h("span", { class: "chev", html: icon("pin") }), "Pinned"));
		for (const s of pinnedRows) frag.append(sessionRow(s, childrenOf.get(s.id) || [], true));
	}
	if (!ordered.length && !pinnedRows.length) {
		frag.append(h("div", { class: "list-empty" }, q ? "No chats match — neither by name nor inside their messages." : "No chats yet. Hit “New chat” and say something."));
	}
	for (const group of ordered) {
		const collapsedKey = `pi-web:group:${group.cwd}`;
		// Folders clean themselves up: a folder you haven't been in for two weeks
		// collapses on its own, so old projects stop pushing your active ones down.
		// Touching the folder (expanding it) resets its timer.
		const autoCollapseDays = 14;
		let collapsed = storage(collapsedKey, false);
		if (!q && !collapsed && !group.items.some((s) => s.id === S.current)) {
			const newest = activity(group.items[0]);
			if (Number.isFinite(newest) && Date.now() - newest > autoCollapseDays * 86400_000) {
				collapsed = true;
				store(collapsedKey, true); // so it stays quiet across renders
			}
		}
		if (!collapsed && group.items.some((s) => s.id === S.current)) store(collapsedKey, false);
		const head = h(
			"button",
			{ class: `group-head${group.agy ? " agy" : ""}`, type: "button", title: group.agy ? "Google Antigravity conversations" : group.cwd, "aria-expanded": String(!collapsed) },
			h("span", { class: "chev", html: icon(collapsed ? "chevronRight" : "chevronDown") }),
			group.agy ? h("span", { class: "agy-mark" }, "A") : null,
			h("span", { class: "group-name" }, group.label),
			h("span", { class: "group-count" }, String(group.items.length)),
		);
		head.onclick = () => {
			store(collapsedKey, !collapsed);
			renderSessionList();
		};
		head.addEventListener("contextmenu", (e) => {
			e.preventDefault();
			openGroupMenu(group, e.clientX, e.clientY, collapsedKey, collapsed);
		});
		frag.append(head);
		if (collapsed) continue;
		const limitKey = `pi-web:limit:${group.cwd}`;
		const limit = q ? 200 : storage(limitKey, 25);
		for (const s of group.items.slice(0, limit)) {
			frag.append(sessionRow(s, childrenOf.get(s.id) || []));
			// Running subagents sit under their parent even when subagents are hidden.
			if (!q && !S.settings.showSubagents) {
				for (const sub of runningSubagents(s)) {
					if (sub.childId === S.current) continue; // already listed as the open session
					const child = sub.childId && S.sessions.get(sub.childId);
					if (child) frag.append(sessionRow(child, []));
					else frag.append(pendingSubagentRow(sub));
				}
			}
		}
		if (group.items.length > limit) {
			frag.append(
				h(
					"button",
					{
						class: "show-more",
						type: "button",
						onclick: () => {
							store(limitKey, limit + 50);
							renderSessionList();
						},
					},
					`Show ${Math.min(50, group.items.length - limit)} more`,
				),
			);
		}
	}
	list.replaceChildren(frag);
	$("#toggle-subagents").classList.toggle("on", S.settings.showSubagents);
	$("#toggle-archived").classList.toggle("on", S.settings.showArchived);
}

function sessionRow(s, children, inPinBlock = false) {
	const proc = S.procs.get(s.id);
	const pins = pinnedIds();
	const running = proc && proc.state !== "exited" && proc.state !== "stopping";
	let badge = null;
	if (S.attention.has(s.id)) badge = h("span", { class: "badge attention", title: "pi is waiting for your answer" });
	else if (running && proc.busy) badge = h("span", { class: "badge busy", title: "pi is working" });
	else if (running) badge = h("span", { class: "badge running", title: "pi is running (web)" });
	else if (isAgy(s) && s.running) badge = h("span", { class: "badge busy", title: "Antigravity is working on this" });
	else if (isExternallyActive(s)) badge = h("span", { class: "badge external", title: "Recently active (probably in your terminal)" });

	const when = fmtRelative(activity(s));
	const sub = [
		isAgy(s) ? (s.stepCount ? `${s.stepCount} steps` : null) : s.userCount ? `${s.userCount} msg` : null,
		isAgy(s) ? null : shortModel(s.lastModel),
	]
		.filter(Boolean)
		.join(" · ");
	const title = sessionTitle(s);
	const runningSubs = runningSubagents(s).length;
	const kids = runningSubs
		? h("span", { class: "row-kids running" }, ` · ${runningSubs} subagent${runningSubs > 1 ? "s" : ""} running`)
		: children.length
			? h("span", { class: "row-kids" }, ` · ${children.length} subagent${children.length > 1 ? "s" : ""}`)
			: null;
	const q = S.search.trim();
	const hit = q ? S.searchHits.get(s.id) : null;
	// A full-text hit shows where the words were found, with the match marked.
	const snippet = hit
		? h("div", { class: "row-snippet" },
				h("span", { class: "snippet-role" }, hit.snippets[0]?.role === "user" ? "you: " : hit.snippets[0]?.role === "pi" ? "pi: " : ""),
				h("span", { class: "snippet-text", dir: textDir(hit.snippets[0]?.text || "") || "auto" }, ...highlightParts(hit.snippets[0]?.text || "", q)),
			)
		: null;
	const archBadge = s.archived && !q ? h("span", { class: "row-kids" }, " · archived") : q && s.archived ? h("span", { class: "arch-chip" }, "archived") : null;
	const pinMark = q && pins.has(s.id) ? h("span", { class: "pin-mark", title: "Pinned", html: icon("pin") }) : null;
	const row = h(
		"a",
		{
			class: `session-row${s.id === S.current ? " active" : ""}${s.parentId ? " child" : ""}${hit ? " hit" : ""}${runningSubs ? " kids-live" : ""}${inPinBlock ? " pinned" : ""}`,
			href: `#/s/${encodeURIComponent(s.id)}`,
			title: [title, [when, sub].filter(Boolean).join(" · ")].join("\n"),
		},
		h(
			"div",
			{ class: "row-main" },
			s.parentId ? h("span", { class: "row-agent", html: icon("bot") }) : null,
			h("span", { class: "row-title", dir: textDir(title) || "auto" }, s.parentId && s.agentName ? `${s.agent || "agent"} · ${s.agentName}` : title),
			badge,
			archBadge,
			pinMark,
			h("span", { class: "row-time" }, when),
		),
		h("div", { class: "row-sub" }, sub, kids),
		snippet,
	);
	// Right-click: delete / archive / copy path.
	row.addEventListener("contextmenu", (e) => {
		e.preventDefault();
		openSessionMenu(s, e.clientX, e.clientY);
	});
	return row;
}

/** A subagent that is running but has not written its session file yet. */
function pendingSubagentRow(sub) {
	return h(
		"button",
		{ class: "session-row child pending", type: "button", title: "Starting; watch it live", onclick: () => watchSubagent(sub) },
		h(
			"div",
			{ class: "row-main" },
			h("span", { class: "row-agent", html: icon("bot") }),
			h("span", { class: "row-title" }, [sub.agent || "subagent", sub.name].filter(Boolean).join(" · ")),
			h("span", { class: "badge busy" }),
		),
		h("div", { class: "row-sub" }, "starting…"),
	);
}

// ── top bar ─────────────────────────────────────────────────────────────────

function renderTopbar() {
	const bar = $("#topbar-main");
	if (!S.current) {
		bar.replaceChildren(h("div", { class: "top-title" }, h("span", { class: "title-text" }, "pi")));
		$("#topbar-side").replaceChildren();
		return;
	}
	const meta = S.meta || {};
	const title = sessionTitle(meta);
	const titleEl = h("button", { class: "title-text", type: "button", title: "Rename", dir: textDir(title) || "auto" }, title);
	titleEl.onclick = () => renameSession();
	const subBits = [];
	if (meta.cwd) subBits.push(h("span", { class: "sub-path", title: meta.cwd }, prettyPath(meta.cwd, S.home)));
	if (meta.parentId) {
		const parent = S.sessions.get(meta.parentId);
		subBits.push(
			h(
				"button",
				{ class: "sub-link", type: "button", onclick: () => navigate(meta.parentId) },
				h("span", { html: icon("bot") }),
				`${meta.agent || "subagent"} of “${sessionTitle(parent)}”`,
			),
		);
	}
	if (meta.mdLog) subBits.push(h("span", { class: "sub-note", title: meta.mdLog }, h("span", { html: icon("note") }), meta.mdLog.split("/").pop()));
	const statusText = conv?.live.title ? stripAnsi(conv.live.title) : null;
	bar.replaceChildren(h("div", { class: "top-title" }, titleEl, h("div", { class: "top-sub" }, subBits, statusText ? h("span", { class: "sub-status" }, statusText) : null)));

	const side = [];
	if (isAgy(meta)) {
		side.push(
			h(
				"span",
				{
					class: `proc-pill ${meta.running ? "busy" : S.agy?.running ? "running" : "idle"}`,
					title: meta.running ? "Antigravity is working on this conversation" : S.agy?.running ? "The Antigravity app is open" : "The Antigravity app is closed — messages run on a headless server pi-web starts automatically",
				},
				h("span", { class: "dot" }),
				meta.running ? "Antigravity · working" : S.agy?.running ? "Antigravity · idle" : "Antigravity · headless",
			),
		);
	} else {
		side.push(processPill());
		side.push(modelButton());
	}
	const menu = h("button", { class: "icon-btn", type: "button", title: "More", html: icon("more") });
	menu.onclick = (e) => openMenu(e.currentTarget);
	side.push(menu);
	$("#topbar-side").replaceChildren(...side);
	document.title = pageTitle();
}

function processPill() {
	const p = S.proc;
	let cls = "idle";
	let label = "pi not running";
	let tip = "No pi process is attached. Sending a message starts one.";
	if (p?.state === "starting") {
		cls = "starting";
		label = "starting pi…";
		tip = "Starting pi";
	} else if (p?.state === "ready") {
		cls = conv.live.busy ? "busy" : "running";
		label = conv.live.busy ? "working" : "pi ready";
		tip = `pi is running for this session (pid ${p.pid})${p.bridge ? "" : " · quiz pop-ups unavailable"}`;
	} else if (p?.state === "stopping") {
		cls = "starting";
		label = "stopping…";
	} else if (isExternallyActive(S.meta)) {
		cls = "external";
		label = "live in terminal";
		tip = "This session was written to in the last few minutes, probably by pi in your terminal. The page updates as it changes.";
	}
	return h("span", { class: `proc-pill ${cls}`, title: tip }, h("span", { class: "dot" }), label);
}

function modelButton() {
	const model = S.proc?.model ? `${S.proc.model.provider}/${S.proc.model.id}` : S.meta?.lastModel;
	const thinking = S.proc?.thinkingLevel;
	const btn = h(
		"button",
		{ class: "model-btn", type: "button", title: "Model and thinking level" },
		h("span", { html: icon("cpu") }),
		h("span", { class: "model-name" }, shortModel(model) || "model"),
		thinking && thinking !== "off" ? h("span", { class: "model-think" }, thinking) : null,
		h("span", { html: icon("chevronDown") }),
	);
	btn.onclick = () => openModelPicker(btn);
	return btn;
}

async function renameSession() {
	if (!S.current) return;
	const name = await promptModal("Rename session", "Name", S.meta?.name || "");
	if (name == null) return;
	try {
		await rpc(S.current, { type: "set_session_name", name: name.trim() });
		toast("Renamed.", "info");
	} catch (err) {
		toast(err.message, "error");
	}
}

// ── popovers ───────────────────────────────────────────────────────────────

let popover;
function closePopover() {
	popover?.remove();
	popover = null;
}

function openPopover(anchor, content, cls = "") {
	closePopover();
	popover = h("div", { class: `popover ${cls}` }, content);
	document.body.append(popover);
	const r = anchor.getBoundingClientRect();
	const w = popover.offsetWidth;
	popover.style.top = `${r.bottom + 6}px`;
	popover.style.left = `${Math.max(8, Math.min(window.innerWidth - w - 8, r.right - w))}px`;
	setTimeout(() => {
		const off = (e) => {
			if (popover && !popover.contains(e.target) && !anchor.contains(e.target)) {
				closePopover();
				document.removeEventListener("mousedown", off);
			}
		};
		document.addEventListener("mousedown", off);
	});
	return popover;
}

/** Split text into parts around (case-insensitive) matches of q, for marking. */
function highlightParts(text, q) {
	if (!q) return [text];
	const out = [];
	const lower = text.toLowerCase();
	const needle = q.toLowerCase();
	let at = 0;
	for (;;) {
		const found = lower.indexOf(needle, at);
		if (found < 0) break;
		if (found > at) out.push(text.slice(at, found));
		out.push(h("mark", {}, text.slice(found, found + needle.length)));
		at = found + needle.length;
	}
	if (at < text.length) out.push(text.slice(at));
	return out.length ? out : [text];
}

/** A popover that opens at a point (right-click menus) instead of under a button. */
function openPopoverAt(x, y, content, cls = "") {
	closePopover();
	popover = h("div", { class: `popover ${cls}` }, content);
	document.body.append(popover);
	const w = popover.offsetWidth;
	const hgt = popover.offsetHeight;
	popover.style.top = `${Math.max(8, Math.min(y, window.innerHeight - hgt - 8))}px`;
	popover.style.left = `${Math.max(8, Math.min(x, window.innerWidth - w - 8))}px`;
	setTimeout(() => {
		const off = (e) => {
			if (popover && !popover.contains(e.target)) {
				closePopover();
				document.removeEventListener("mousedown", off);
			}
		};
		document.addEventListener("mousedown", off);
	});
	return popover;
}

// ── chat menu: right-click on a session ──────────────────────────────────────

async function archiveSession(s, on) {
	try {
		await post("/api/session/archive", { session: s.id, archived: on });
		toast(on ? "Archived — hidden from the list (find it via search, or toggle “Archived”)." : "Back in the list.", "info");
	} catch (err) {
		toast(err.message, "error");
	}
}

async function confirmDeleteSession(s) {
	const ok = await confirmModal(
		"Delete this chat?",
		`“${sessionTitle(s)}” will be deleted permanently, together with its session file. This cannot be undone. If pi still has this session open in a terminal, close it first or the file may come back.`,
		"Delete",
	);
	if (!ok) return;
	try {
		await post("/api/session/delete", { session: s.id });
		toast("Chat deleted.", "info");
		if (S.current === s.id) navigate(null);
	} catch (err) {
		toast(err.message, "error");
	}
}

/** Right-click on a folder header: quick ways to tidy it. */
function openGroupMenu(group, x, y, collapsedKey, collapsed) {
	const entry = (label, iconName, fn) =>
		h(
			"button",
			{
				class: "menu-item",
				type: "button",
				onclick: () => {
					closePopover();
					fn();
				},
			},
			h("span", { html: icon(iconName) }),
			label,
		);
	openPopoverAt(
		x,
		y,
		h(
			"div",
			{ class: "menu" },
			entry(collapsed ? "Expand" : "Collapse", collapsed ? "chevronDown" : "chevronRight", () => {
				store(collapsedKey, !collapsed);
				renderSessionList();
			}),
			entry("Show all its chats", "layers", () => {
				store(`pi-web:limit:${group.cwd}`, 500);
				store(collapsedKey, false);
				renderSessionList();
			}),
			entry("Reset to 25", "refresh", () => {
				store(`pi-web:limit:${group.cwd}`, 25);
				renderSessionList();
			}),
		),
	);
}

function openSessionMenu(s, x, y) {
	const entry = (label, iconName, fn, danger) =>
		h(
			"button",
			{
				class: `menu-item${danger ? " danger" : ""}`,
				type: "button",
				onclick: () => {
					closePopover();
					fn();
				},
			},
			h("span", { html: icon(iconName) }),
			label,
		);
	const items = [entry("Open", "external", () => navigate(s.id))];
	items.push(entry(pinnedIds().has(s.id) ? "Unpin" : "Pin", "pin", () => togglePinned(s)));
	if (!isAgy(s) && s.file) items.push(entry("Copy file path", "copy", () => copy(s.file)));
	items.push(entry(s.archived ? "Unarchive" : "Archive", "archive", () => archiveSession(s, !s.archived)));
	if (isAgy(s)) {
		items.push(h("div", { class: "menu-note" }, "Deleting an Antigravity conversation happens in the Antigravity app."));
	} else {
		items.push(entry("Delete…", "trash", () => confirmDeleteSession(s), true));
	}
	openPopoverAt(x, y, h("div", { class: "menu" }, items));
}

function openMenu(anchor) {
	const item = (label, iconName, fn, extra) =>
		h(
			"button",
			{
				class: "menu-item",
				type: "button",
				onclick: () => {
					closePopover();
					fn();
				},
			},
			h("span", { html: icon(iconName) }),
			label,
			extra || null,
		);
	const seg = (label, key, options) =>
		h(
			"div",
			{ class: "menu-seg" },
			h("span", { class: "seg-label" }, label),
			h(
				"div",
				{ class: "seg" },
				options.map(([value, text]) =>
					h(
						"button",
						{
							type: "button",
							class: S.settings[key] === value ? "on" : "",
							onclick: () => {
								setSetting(key, value);
								openMenu(anchor);
							},
						},
						text,
					),
				),
			),
		);
	const running = hasProcess();
	const piItems = isAgy(S.meta)
		? []
		: [
				running ? item("Stop pi for this session", "power", stopProcess) : item("Start pi for this session", "power", startProcess),
				item("Compact context…", "layers", () => compact()),
				item("Export to HTML", "external", exportHtml),
				item("Session info", "note", sessionInfo),
				item("Copy session file path", "copy", () => copy(S.meta?.file || "")),
				S.server.antigravity && S.meta?.cwd
					? item("Antigravity: chat about this project", "sparkles", () => newChat(null, "antigravity"))
					: null,
				h("div", { class: "menu-sep" }),
			];
	const content = h(
		"div",
		{ class: "menu" },
		piItems,
		seg("Tool calls", "tools", [
			["hidden", "Hide"],
			["compact", "Compact"],
			["expanded", "Expanded"],
		]),
		seg("Thinking", "thinking", [
			[false, "Hide"],
			[true, "Show"],
		]),
		seg("Theme", "theme", [
			["system", "Auto"],
			["light", "Light"],
			["dark", "Dark"],
		]),
		h(
			"div",
			{ class: "menu-seg" },
			h("span", { class: "seg-label" }, "Text size"),
			h(
				"div",
				{ class: "seg" },
				h("button", { type: "button", onclick: () => setSetting("fontSize", Math.max(13, S.settings.fontSize - 1)) }, "A−"),
				h("span", { class: "seg-value" }, `${S.settings.fontSize}px`),
				h("button", { type: "button", onclick: () => setSetting("fontSize", Math.min(24, S.settings.fontSize + 1)) }, "A+"),
			),
		),
		h("div", { class: "menu-foot" }, `pi-web ${S.server?.version || ""}${S.server?.commit ? ` · ${S.server.commit}` : ""}`),
	);
	openPopover(anchor, content, "menu-pop");
}

async function openModelPicker(anchor) {
	if (!S.current) return;
	const box = h("div", { class: "model-picker" }, h("div", { class: "picker-loading" }, h("span", { class: "spinner" }), hasProcess() ? "Loading models…" : "Starting pi…"));
	openPopover(anchor, box, "model-pop");
	// Load independently: a slow model catalog (a cold provider registry can take
	// minutes) must not hide the thinking levels, and a failed levels answer must
	// not hide the models.
	const [models, levels, state] = await Promise.allSettled([
		rpc(S.current, { type: "get_available_models" }),
		rpc(S.current, { type: "get_available_thinking_levels" }),
		rpc(S.current, { type: "get_state" }),
	]);
	if (!popover?.contains(box)) return;
	if (models.status === "rejected" && levels.status === "rejected") {
		box.replaceChildren(h("div", { class: "picker-error" }, models.reason.message));
		return;
	}
	// Fresh state beats a possibly-stale S.proc: a picker on a session with no pi
	// running just spawned one, and S.proc only catches up via SSE a moment later.
	const current = state.status === "fulfilled" ? state.value?.model : S.proc?.model;
	const currentLevel = state.status === "fulfilled" ? state.value?.thinkingLevel : S.proc?.thinkingLevel;
	const levelList = levels.status === "fulfilled" ? levels.value?.levels || [] : null;
	const search = h("input", { type: "search", class: "picker-search", placeholder: "Filter models…", hidden: models.status === "rejected" });
	const list = h("div", { class: "picker-list" });
	const paint = () => {
		const q = search.value.trim().toLowerCase();
		const byProvider = new Map();
		for (const m of (models.status === "fulfilled" ? models.value?.models : []) || []) {
			if (q && !`${m.provider}/${m.id} ${m.name || ""}`.toLowerCase().includes(q)) continue;
			if (!byProvider.has(m.provider)) byProvider.set(m.provider, []);
			byProvider.get(m.provider).push(m);
		}
		const frag = document.createDocumentFragment();
		for (const [provider, items] of byProvider) {
			frag.append(h("div", { class: "picker-group" }, provider));
			for (const m of items) {
				const on = current && current.provider === m.provider && current.id === m.id;
				const btn = h(
					"button",
					{ class: `picker-item${on ? " on" : ""}`, type: "button" },
					h("span", { class: "pi-name" }, m.name || m.id),
					h("span", { class: "pi-id" }, m.id),
					m.reasoning ? h("span", { class: "pi-tag" }, "thinking") : null,
				);
				btn.onclick = async () => {
					closePopover();
					try {
						await rpc(S.current, { type: "set_model", provider: m.provider, modelId: m.id });
						toast(`Model: ${m.name || m.id}`, "info");
					} catch (err) {
						toast(err.message, "error");
					}
				};
				frag.append(btn);
			}
		}
		if (!frag.childNodes.length) frag.append(h("div", { class: "picker-empty" }, "No models match."));
		list.replaceChildren(frag);
	};
	search.addEventListener("input", paint);
	// The effort/thinking picker. Always render the section: a model without
	// levels gets a note saying so, instead of silently vanishing and looking
	// like a setting that cannot be changed.
	const thinking = h(
		"div",
		{ class: "picker-thinking" },
		h("span", { class: "seg-label" }, "Thinking"),
		levelList == null
			? h("span", { class: "picker-hint" }, "Unavailable — try again")
			: levelList.length > 1
				? h(
						"div",
						{ class: "seg wrap" },
						levelList.map((level) => {
							// Capture the button before awaiting: e.currentTarget is null
							// once event dispatch ends, which used to throw and leave
							// the highlight stuck (the level did change, invisibly).
							const btn = h(
								"button",
								{ type: "button", class: currentLevel === level ? "on" : "" },
								level,
							);
							btn.onclick = async () => {
								try {
									await rpc(S.current, { type: "set_thinking_level", level });
									for (const b of btn.parentElement.children) b.classList.toggle("on", b === btn);
								} catch (err) {
									toast(err.message, "error");
								}
							};
							return btn;
						}),
					)
					: h("span", { class: "picker-hint" }, "This model has no thinking levels"),
	);
	const listError =
		models.status === "rejected"
			? h("div", { class: "picker-error" }, `${models.reason.message} — the model list needs a moment. The thinking levels above already work.`)
			: null;
	box.replaceChildren(thinking, listError || "", search, list);
	if (models.status === "fulfilled") {
		paint();
		search.focus();
	}
}

// ── process control ─────────────────────────────────────────────────────────

async function startProcess() {
	try {
		await post("/api/process", { session: S.current, action: "start" });
	} catch (err) {
		toast(err.message, "error");
	}
}

async function stopProcess() {
	try {
		await post("/api/process", { session: S.current, action: "stop" });
	} catch (err) {
		toast(err.message, "error");
	}
}

async function abortRun() {
	try {
		await rpc(S.current, { type: "abort" });
	} catch (err) {
		toast(err.message, "error");
	}
}

async function compact(instructions) {
	if (instructions === undefined) {
		instructions = await promptModal("Compact context", "Optional focus for the summary", "", { allowEmpty: true, multiline: true });
		if (instructions == null) return;
	}
	const t = toast("Compacting the context…", "info");
	try {
		const data = await rpc(S.current, { type: "compact", ...(instructions.trim() ? { customInstructions: instructions.trim() } : {}) });
		t.remove();
		toast(`Compacted: ${fmtTokens(data?.tokensBefore)} → about ${fmtTokens(data?.estimatedTokensAfter)} tokens.`, "info");
	} catch (err) {
		t.remove();
		toast(err.message, "error");
	}
}

async function exportHtml() {
	try {
		const data = await rpc(S.current, { type: "export_html" });
		toast(`Exported to ${data?.path}`, "info");
	} catch (err) {
		toast(err.message, "error");
	}
}

async function sessionInfo() {
	const meta = S.meta || {};
	let stats = S.proc?.stats;
	if (hasProcess()) stats = await rpc(S.current, { type: "get_session_stats" }).catch(() => stats);
	const rows = [
		["Session id", meta.id],
		["File", meta.file],
		["Folder", meta.cwd],
		["Created", meta.created ? new Date(meta.created).toLocaleString() : ""],
		["Messages", `${meta.userCount ?? 0} from you, ${meta.assistantCount ?? 0} from pi, ${meta.toolCount ?? 0} tool calls`],
		["Model", S.proc?.model ? `${S.proc.model.provider}/${S.proc.model.id}` : meta.lastModel],
		["Tokens", stats?.tokens ? `${fmtTokens(stats.tokens.input)} in · ${fmtTokens(stats.tokens.output)} out · ${fmtTokens(stats.tokens.cacheRead)} cache read` : ""],
		["Cost", fmtCost(stats?.cost ?? meta.cost)],
		["Linked note", meta.mdLog],
	].filter(([, v]) => v);
	modal(
		"Session",
		h(
			"dl",
			{ class: "info-list" },
			rows.map(([k, v]) => [h("dt", {}, k), h("dd", { dir: "auto" }, String(v))]),
		),
		[{ label: "Close", primary: true }],
	);
}

// ── dialogs ─────────────────────────────────────────────────────────────────

const dialogs = new Map();

function modal(title, body, buttons, { onClose, cls = "" } = {}) {
	return new Promise((resolve) => {
		const backdrop = h("div", { class: "modal-backdrop" });
		const done = (value) => {
			backdrop.remove();
			onClose?.();
			resolve(value);
		};
		const actions = h(
			"div",
			{ class: "modal-actions" },
			buttons.map((b) =>
				h(
					"button",
					{
						class: `btn ${b.primary ? "primary" : "ghost"}`,
						type: "button",
						onclick: () => done(typeof b.value === "function" ? b.value() : b.value),
					},
					b.label,
				),
			),
		);
		const box = h("div", { class: `modal ${cls}`, role: "dialog", "aria-modal": "true" }, h("div", { class: "modal-title" }, title), body, actions);
		backdrop.append(box);
		backdrop.addEventListener("mousedown", (e) => {
			if (e.target === backdrop) done(undefined);
		});
		backdrop.addEventListener("keydown", (e) => {
			if (e.key === "Escape") {
				e.stopPropagation();
				done(undefined);
			}
		});
		$("#modal-root").append(backdrop);
		setTimeout(() => (box.querySelector("input, textarea, .btn.primary") || box).focus(), 20);
	});
}

function promptModal(title, label, initial = "", { allowEmpty = false, multiline = false } = {}) {
	const field = multiline ? h("textarea", { class: "field", rows: "4", dir: "auto" }) : h("input", { class: "field", type: "text", dir: "auto" });
	field.value = initial;
	let submitBtnValue;
	const body = h("label", { class: "field-wrap" }, h("span", { class: "field-label" }, label), field);
	const p = modal(title, body, [
		{ label: "Cancel", value: null },
		{ label: "OK", primary: true, value: () => (submitBtnValue = field.value) },
	]);
	field.addEventListener("keydown", (e) => {
		if (e.key === "Enter" && (!multiline || e.ctrlKey) && !e.isComposing) {
			e.preventDefault();
			field.closest(".modal").querySelector(".btn.primary").click();
		}
	});
	return p.then((v) => {
		if (v == null) return null;
		if (!allowEmpty && !String(v).trim()) return null;
		return submitBtnValue ?? v;
	});
}

function confirmModal(title, text, okLabel = "Continue") {
	const body = h("div", { class: "modal-text", dir: "auto" }, text);
	return modal(title, body, [
		{ label: "Cancel", value: false },
		{ label: okLabel, primary: true, value: true },
	]).then((v) => v === true);
}

function openDialog(req) {
	if (dialogs.has(req.id)) return;
	const respond = (payload) => {
		closeDialog(req.id);
		delete conv.live.dialogs[req.id];
		post("/api/ui-response", { session: S.current, id: req.id, ...payload }).catch((err) => toast(err.message, "error"));
	};
	const titleEl = h("div", { class: "md dialog-title" });
	renderInto(titleEl, req.title || "", { sessionId: S.current });
	const body = h("div", { class: "dialog-body" }, titleEl);
	const actions = h("div", { class: "modal-actions" });
	let focusEl;
	switch (req.method) {
		case "select": {
			const list = h("div", { class: "dialog-options" });
			(req.options || []).forEach((opt, i) => {
				const b = h("button", { class: "dialog-option", type: "button", dir: "auto" }, h("span", { class: "qa-mark" }, String(i + 1)), stripAnsi(opt));
				b.onclick = () => respond({ value: opt });
				list.append(b);
			});
			body.append(list);
			actions.append(h("button", { class: "btn ghost", type: "button", onclick: () => respond({ cancelled: true }) }, "Cancel"));
			focusEl = list.firstElementChild;
			break;
		}
		case "confirm": {
			if (req.message) body.append(renderInto(h("div", { class: "md dialog-message" }), req.message, { sessionId: S.current }));
			const no = h("button", { class: "btn ghost", type: "button", onclick: () => respond({ confirmed: false }) }, "No");
			const yes = h("button", { class: "btn primary", type: "button", onclick: () => respond({ confirmed: true }) }, "Yes");
			actions.append(no, yes);
			focusEl = yes;
			break;
		}
		case "input":
		case "editor": {
			const multi = req.method === "editor";
			const field = multi ? h("textarea", { class: "field", rows: "8", dir: "auto" }) : h("input", { class: "field", type: "text", dir: "auto", placeholder: req.placeholder || "" });
			if (req.prefill) field.value = req.prefill;
			field.addEventListener("keydown", (e) => {
				if (e.key === "Enter" && (!multi || e.ctrlKey || e.metaKey) && !e.isComposing) {
					e.preventDefault();
					respond({ value: field.value });
				}
			});
			body.append(field);
			actions.append(
				h("button", { class: "btn ghost", type: "button", onclick: () => respond({ cancelled: true }) }, "Cancel"),
				h("button", { class: "btn primary", type: "button", onclick: () => respond({ value: field.value }) }, multi ? "Send (Ctrl+Enter)" : "OK"),
			);
			focusEl = field;
			break;
		}
	}
	let timer;
	if (req.timeout) {
		const until = (req.receivedAt || Date.now()) + req.timeout;
		const count = h("span", { class: "dialog-timer" });
		actions.prepend(count);
		const tick = () => {
			const left = Math.max(0, Math.ceil((until - Date.now()) / 1000));
			count.textContent = `${left}s`;
			if (left <= 0) closeDialog(req.id);
		};
		tick();
		timer = setInterval(tick, 500);
	}
	const box = h("div", { class: "modal dialog", role: "dialog", "aria-modal": "true" }, h("div", { class: "modal-title" }, h("span", { html: icon("help") }), "pi is asking"), body, actions);
	const backdrop = h("div", { class: "modal-backdrop" }, box);
	backdrop.addEventListener("keydown", (e) => {
		if (e.key === "Escape") {
			e.stopPropagation();
			respond(req.method === "confirm" ? { confirmed: false } : { cancelled: true });
		}
		if (req.method === "select" && /^[1-9]$/.test(e.key) && !e.target.matches("input, textarea")) {
			const opt = req.options?.[Number(e.key) - 1];
			if (opt !== undefined) respond({ value: opt });
		}
	});
	$("#modal-root").append(backdrop);
	dialogs.set(req.id, { el: backdrop, timer });
	setTimeout(() => (focusEl || box).focus(), 30);
}

function closeDialog(id) {
	const d = dialogs.get(id);
	if (!d) return;
	clearInterval(d.timer);
	d.el.remove();
	dialogs.delete(id);
	document.title = pageTitle();
}

function closeAllDialogs() {
	for (const id of [...dialogs.keys()]) closeDialog(id);
}

// Terminal-style pop-up for extensions that draw their own TUI component.
let term = null;

function keyToSequence(e) {
	const keys = {
		ArrowUp: "\x1b[A",
		ArrowDown: "\x1b[B",
		ArrowRight: "\x1b[C",
		ArrowLeft: "\x1b[D",
		Enter: "\r",
		Escape: "\x1b",
		Tab: e.shiftKey ? "\x1b[Z" : "\t",
		Backspace: "\x7f",
		Delete: "\x1b[3~",
		Home: "\x1b[H",
		End: "\x1b[F",
		PageUp: "\x1b[5~",
		PageDown: "\x1b[6~",
	};
	if (keys[e.key]) return keys[e.key];
	if (e.ctrlKey && e.key.length === 1 && /[a-z]/i.test(e.key)) return String.fromCharCode(e.key.toUpperCase().charCodeAt(0) - 64);
	if (!e.ctrlKey && !e.metaKey && e.key.length === 1) return e.key;
	return null;
}

function openTerminal(ui) {
	closeTerminal();
	const screen = h("pre", { class: "term-screen", tabindex: "0", dir: "ltr" });
	const send = (action, data) => post("/api/bridge", { session: S.current, uid: ui.uid, action, data }).catch((err) => toast(err.message, "error"));
	screen.addEventListener("keydown", (e) => {
		const seq = keyToSequence(e);
		if (seq == null) return;
		e.preventDefault();
		e.stopPropagation();
		send("key", seq);
	});
	screen.addEventListener("paste", (e) => {
		const text = e.clipboardData?.getData("text") || "";
		e.preventDefault();
		for (const ch of text) send("key", ch === "\n" ? "\r" : ch);
	});
	const box = h(
		"div",
		{ class: "modal term" },
		h(
			"div",
			{ class: "modal-title" },
			h("span", { html: icon("keyboard") }),
			"An extension opened a terminal pop-up",
			h("button", { class: "icon-btn close", type: "button", title: "Close (sends Esc)", onclick: () => send("cancel"), html: icon("x") }),
		),
		screen,
		h("div", { class: "term-hint" }, "Click here and use your keyboard: arrows, Enter, Esc, Tab, letters and numbers go straight to the pop-up."),
	);
	const backdrop = h("div", { class: "modal-backdrop" }, box);
	$("#modal-root").append(backdrop);
	term = { uid: ui.uid, el: backdrop, screen };
	paintTerminal(ui.lines || []);
	setTimeout(() => {
		screen.focus();
		const probe = h("span", { style: { visibility: "hidden", position: "absolute" } }, "M".repeat(10));
		screen.append(probe);
		const charWidth = probe.getBoundingClientRect().width / 10 || 8;
		probe.remove();
		const cols = Math.max(40, Math.min(200, Math.floor((screen.clientWidth - 24) / charWidth)));
		post("/api/bridge", { session: S.current, action: "resize", cols }).catch(() => {});
	}, 30);
}

function paintTerminal(lines) {
	if (!term) return;
	term.screen.innerHTML = (lines || []).map((l) => ansiToHtml(l)).join("\n") || " ";
}

function closeTerminal() {
	term?.el.remove();
	term = null;
}

// ── new chat ────────────────────────────────────────────────────────────────

async function newChat(initialDir, startKind = isAgy(S.meta) ? "antigravity" : "pi") {
	const projects = [...new Set([...S.sessions.values()].sort((a, b) => activity(b) - activity(a)).map((s) => s.cwd).filter(Boolean))];
	const field = h("input", { class: "field", type: "text", dir: "ltr", spellcheck: "false" });
	field.value = initialDir || S.meta?.cwd || projects[0] || S.home;
	const browser = h("div", { class: "dir-browser" });
	const browse = async (dir) => {
		try {
			const data = await getJson(`/api/dirs?path=${encodeURIComponent(dir)}`);
			field.value = data.path;
			browser.replaceChildren(
				data.parent ? h("button", { class: "dir-item up", type: "button", onclick: () => browse(data.parent) }, "↰ ..") : "",
				...data.dirs.map((d) => h("button", { class: "dir-item", type: "button", onclick: () => browse(`${data.path.replace(/\/$/, "")}/${d}`) }, h("span", { html: icon("folder") }), d)),
			);
		} catch (err) {
			browser.replaceChildren(h("div", { class: "picker-error" }, err.message));
		}
	};
	const recent = h(
		"div",
		{ class: "recent-dirs" },
		projects.slice(0, 8).map((p) =>
			h(
				"button",
				{
					class: "chip",
					type: "button",
					title: p,
					onclick: () => {
						field.value = p;
						browse(p);
					},
				},
				prettyPath(p, S.home),
			),
		),
	);
	const piPane = h(
		"div",
		{ class: "new-pane" },
		h("p", { class: "modal-text" }, "pi works inside a folder: it reads that folder's .pi settings, skills and extensions, and runs its tools there."),
		h("label", { class: "field-wrap" }, h("span", { class: "field-label" }, "Folder"), field),
		projects.length ? h("div", { class: "field-label" }, "Recent") : null,
		recent,
		h("div", { class: "field-label" }, "Browse"),
		browser,
	);
	browse(field.value);
	field.addEventListener("keydown", (e) => {
		if (e.key === "Enter") {
			e.preventDefault();
			field.closest(".modal").querySelector(".btn.primary").click();
		}
	});

	// Antigravity: a new conversation starts with its first message.
	let kind = startKind === "antigravity" && S.server.antigravity ? "antigravity" : "pi";
	const agyModel = h(
		"select",
		{ class: "field" },
		h("option", { value: "flash" }, "Flash"),
		h("option", { value: "pro" }, "Pro"),
		h("option", { value: "flash_lite" }, "Flash Lite"),
	);
	const agyTitle = h("input", { class: "field", type: "text", dir: "auto", placeholder: "Optional" });
	const agyPrompt = h("textarea", { class: "field", rows: "5", dir: "auto", placeholder: "What should Antigravity do?" });
	// The conversation works inside a project's workspace folder — the same
	// folder pi works. Find-or-create happens on the server.
	const agyDirField = h("input", { class: "field", type: "text", dir: "ltr", spellcheck: "false" });
	agyDirField.value = isAgy(S.meta) ? S.meta?.cwd || "" : S.meta?.cwd || projects[0] || "";
	const agyStatus = h("div", { class: "modal-text" });
	const paintAgyStatus = () =>
		agyStatus.replaceChildren(
			S.agy?.running
				? "Antigravity is open. The conversation runs in the app (with its agents and artifacts); you can follow and continue it here."
				: h("span", {}, "The Antigravity app is closed — the conversation will run on a headless Antigravity server that pi-web starts automatically when you send. ", h("button", { class: "link-btn", type: "button", onclick: launchAntigravity }, "Open the app"), " too if you'd like to watch it there."),
		);
	paintAgyStatus();
	const agyPane = h(
		"div",
		{ class: "new-pane" },
		agyStatus,
		h("label", { class: "field-wrap" }, h("span", { class: "field-label" }, "First message"), agyPrompt),
		h("div", { class: "field-row" }, h("label", { class: "field-wrap" }, h("span", { class: "field-label" }, "Model"), agyModel), h("label", { class: "field-wrap grow" }, h("span", { class: "field-label" }, "Title"), agyTitle)),
		h("label", { class: "field-wrap" }, h("span", { class: "field-label" }, "Project folder — the conversation works in this folder"), agyDirField),
		projects.length ? h("div", { class: "recent-dirs" }, projects.slice(0, 6).map((p) => h("button", { class: "chip", type: "button", title: p, onclick: () => (agyDirField.value = p) }, prettyPath(p, S.home)))) : null,
	);
	const kindSeg = S.server.antigravity
		? h(
				"div",
				{ class: "seg kind-seg" },
				["pi", "antigravity"].map((k) =>
					h(
						"button",
						{
							type: "button",
							"data-kind": k,
							onclick: () => {
								kind = k;
								paintKind();
							},
						},
						k === "pi" ? "pi" : "Antigravity",
					),
				),
			)
		: null;
	const paintKind = () => {
		piPane.hidden = kind !== "pi";
		agyPane.hidden = kind !== "antigravity";
		for (const b of kindSeg?.children || []) b.classList.toggle("on", b.dataset.kind === kind);
		if (kind === "antigravity") setTimeout(() => agyPrompt.focus(), 20);
	};
	paintKind();
	const body = h("div", { class: "new-chat" }, kindSeg, piPane, agyPane);

	const choice = await modal(
		"New chat",
		body,
		[
			{ label: "Cancel", value: null },
			{
				label: "Start",
				primary: true,
				value: () =>
					kind === "pi"
						? { kind, cwd: field.value.trim() }
						: { kind, prompt: agyPrompt.value.trim(), model: agyModel.value, title: agyTitle.value.trim(), cwd: agyDirField.value.trim() },
			},
		],
		{ cls: "wide" },
	);
	if (!choice) return;
	if (choice.kind === "antigravity" && !choice.prompt) {
		toast("Write the first message for Antigravity.", "warn");
		return newChat(initialDir, "antigravity");
	}
	const t = toast(choice.kind === "pi" ? "Starting pi…" : "Starting an Antigravity conversation…", "info");
	try {
		const res = await post("/api/new", choice);
		t.remove();
		navigate(res.session);
		setTimeout(() => $("#input").focus(), 100);
	} catch (err) {
		t.remove();
		toast(err.message, "error");
	}
}

// ── home ────────────────────────────────────────────────────────────────────

function renderHome() {
	const root = $("#conversation");
	const recent = [...S.sessions.values()].filter((s) => !s.parentId).sort((a, b) => activity(b) - activity(a)).slice(0, 8);
	const warn = S.server && S.server.piBin === null
		? h("div", { class: "msg-error" }, h("span", { html: icon("alert") }), h("span", {}, "pi was not found on PATH, so you can read sessions but not chat. Start pi-web from a shell where the `pi` command works."))
		: null;
	root.replaceChildren(
		h(
			"div",
			{ class: "home" },
			h("div", { class: "home-logo" }, "π"),
			h("h1", {}, "pi, in your browser"),
			h("p", { class: "home-lead" }, "Pick a session on the left to read it (it updates live while pi works in your terminal), or start a new chat right here."),
			warn,
			h("div", { class: "home-actions" }, h("button", { class: "btn primary", type: "button", onclick: () => newChat() }, h("span", { html: icon("plus") }), "New chat")),
			S.usage
				? h(
						"div",
						{ class: "home-usage" },
						h("div", { class: "home-usage-title" }, "Claude plan usage"),
						S.usage.available
							? S.usage.windows.map((w) => meter(w.label, w.percent, resetText(w.resetsAt), `${w.label} limit`))
							: h("span", { class: "meter-note" }, S.usage.reason || "Unavailable right now."),
					)
				: null,
			S.agy?.installed
				? h(
						"div",
						{ class: "home-usage" },
						h("div", { class: "home-usage-title" }, `Antigravity${S.agy.plan ? ` ${S.agy.plan}` : ""} quota`),
						agyMeters(8),
					)
				: null,
			recent.length ? h("h2", {}, "Recent") : null,
			h(
				"div",
				{ class: "home-recent" },
				recent.map((s) =>
					h(
						"a",
						{ class: "home-card", href: `#/s/${encodeURIComponent(s.id)}` },
						h("div", { class: "home-card-title", dir: textDir(sessionTitle(s)) || "auto" }, sessionTitle(s)),
						h("div", { class: "home-card-sub" }, `${prettyPath(s.cwd, S.home)} · ${fmtRelative(activity(s))}`),
					),
				),
			),
			h(
				"div",
				{ class: "home-foot" },
				[S.server.piVersion ? `pi ${S.server.piVersion}` : null, S.server.sessionsDir ? `sessions: ${prettyPath(S.server.sessionsDir, S.home)}` : null, S.server.bridge === false ? "quiz pop-ups unavailable" : null]
					.filter(Boolean)
					.join(" · "),
			),
		),
	);
}

// ── status bar: context window, Claude plan usage, cost ─────────────────────

function level(percent) {
	return percent >= 90 ? "critical" : percent >= 70 ? "warning" : "normal";
}

function resetText(iso) {
	const t = toMs(iso);
	if (!t) return "";
	const d = new Date(t);
	const time = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
	if (t - Date.now() < 20 * 3600 * 1000) return `resets ${time}`;
	return `resets ${d.toLocaleDateString(undefined, { weekday: "short" })} ${time}`;
}

// Meters are rebuilt on every status refresh; remembering the last fill lets the
// bar glide from where it was (or grow in from empty the first time).
const meterMemory = new Map();
function meter(label, percent, detail, title, cls = "") {
	const p = Math.max(0, Math.min(100, percent ?? 0));
	const from = meterMemory.get(label) ?? 0;
	meterMemory.set(label, p);
	const fill = h("span", { class: "meter-fill", style: { width: `${from}%` } });
	requestAnimationFrame(() => requestAnimationFrame(() => (fill.style.width = `${p}%`)));
	return h(
		"div",
		{ class: `meter ${cls} ${percent == null ? "unknown" : level(percent)}`, title },
		h("span", { class: "meter-label" }, label),
		h("span", { class: "meter-bar" }, fill),
		h("span", { class: "meter-value" }, percent == null ? "?" : `${Math.round(percent)}%`),
		detail ? h("span", { class: "meter-detail" }, detail) : null,
	);
}

/** Context as pi reports it for a running pi, else computed from the session file. */
function contextInfo() {
	const live = hasProcess() ? S.proc?.stats?.contextUsage : null;
	if (live?.contextWindow) return { tokens: live.tokens, window: live.contextWindow, percent: live.percent };
	const m = S.meta;
	if (!m) return null;
	const window = m.contextWindow || (S.proc?.model?.contextWindow ?? null);
	if (m.contextTokens == null) return window ? { tokens: null, window, percent: null } : null;
	return { tokens: m.contextTokens, window, percent: window ? (m.contextTokens / window) * 100 : null };
}

function shortModelLabel(label) {
	return String(label || "")
		.replace(/^(Claude|Gemini)\s+/, "")
		.replace(/\s*\(Thinking\)/i, "")
		.replace(/\s*\((\w+)\)/, " $1");
}

function agyMeters(limit = 3) {
	const a = S.agy;
	if (!a?.installed) return [];
	if (!a.available) {
		return [
			h(
				"span",
				{ class: "meter-note" },
				a.running ? "Antigravity is starting…" : "Antigravity closed · headless on demand",
				a.running ? null : h("button", { class: "link-btn", type: "button", onclick: launchAntigravity }, "Open it"),
			),
		];
	}
	const models = [...(a.models || [])].sort((x, y) => x.remaining - y.remaining).slice(0, limit);
	return models.map((m) => {
		const used = (1 - m.remaining) * 100;
		return meter(shortModelLabel(m.label), used, resetText(m.resetsAt), `Antigravity ${a.plan || ""} · ${m.label}: ${Math.round(m.remaining * 100)}% left${m.resetsAt ? `, ${resetText(m.resetsAt)}` : ""}`);
	});
}

let agyTimer;
async function refreshAgy({ force = false } = {}) {
	clearTimeout(agyTimer);
	try {
		S.agy = await getJson(`/api/agy/status${force ? "?force=1" : ""}`);
	} catch {
		// keep the last state
	}
	renderStatus();
	if (isAgy(S.meta)) {
		renderTopbar();
		updateComposer();
	}
	if (!S.current) renderHome();
	agyTimer = setTimeout(refreshAgy, 60_000);
}

async function launchAntigravity() {
	try {
		await post("/api/agy/launch", {});
		toast("Opening Antigravity…", "info");
		setTimeout(() => refreshAgy({ force: true }), 8000);
		setTimeout(() => refreshAgy({ force: true }), 20000);
	} catch (err) {
		toast(err.message, "error");
	}
}

function renderStatus() {
	const el = $("#status-meters");
	if (!S.current) {
		el.replaceChildren();
		return;
	}
	if (isAgy(S.meta)) {
		el.replaceChildren(...agyMeters());
		return;
	}
	const parts = [];
	const ctx = contextInfo();
	if (ctx) {
		const detail = ctx.window ? `${ctx.tokens == null ? "?" : fmtTokens(ctx.tokens)} / ${fmtTokens(ctx.window)}` : `${fmtTokens(ctx.tokens)} tokens`;
		const title =
			ctx.tokens == null
				? "Context size is unknown until pi's next reply (just compacted)."
				: `Context window: ${ctx.tokens.toLocaleString()} of ${ctx.window ? ctx.window.toLocaleString() : "?"} tokens used`;
		parts.push(meter("Context", ctx.percent, detail, title, "ctx"));
	}
	if (S.usage && !S.usage.available) parts.push(h("span", { class: "meter-note", title: S.usage.reason || "" }, "Claude usage unavailable"));
	for (const w of S.usage?.available ? S.usage.windows : []) {
		if (!/^(session|five_hour|weekly_all|seven_day)$/.test(w.id) && !(w.percent > 0)) continue;
		const short = w.id === "session" || w.id === "five_hour" ? "5h" : w.label.replace(/^Weekly/, "Week");
		parts.push(meter(short, w.percent, resetText(w.resetsAt), `Claude plan · ${w.label} limit: ${Math.round(w.percent)}% used${w.resetsAt ? `, ${resetText(w.resetsAt)}` : ""}`));
	}
	const cost = S.proc?.stats?.cost ?? S.meta?.cost;
	if (cost) parts.push(h("span", { class: "meter-cost", title: "Total cost of this session (list prices; subscriptions are not billed per token)" }, fmtCost(cost)));
	el.replaceChildren(...parts);
}

let usageTimer;
async function refreshUsage() {
	clearTimeout(usageTimer);
	try {
		S.usage = await getJson("/api/usage");
	} catch {
		// keep the last numbers
	}
	renderStatus();
	if (!S.current) renderHome();
	usageTimer = setTimeout(refreshUsage, 60_000);
}

// ── subagents strip ─────────────────────────────────────────────────────────

const subagentsChangedSoon = debounce(() => {
	conv.refreshSubagents();
	renderDock();
}, 300);

function subagentStrip() {
	const subs = (S.meta?.subagents || []).map((s) => subagentInfo(s.file, S.meta));
	// Running ones, plus ones that finished in the last few minutes.
	const shown = subs.filter((i) => i.state === "running" || ((i.state === "done" || i.state === "failed") && Date.now() - toMs(i.finishedAt) < 5 * 60_000));
	if (!shown.length) return null;
	return h(
		"div",
		{ class: "subagent-strip" },
		h("span", { class: "strip-label", html: `${icon("bot")}<span>Subagents</span>` }),
		shown.map((i) => {
			const since = toMs(i.launchedAt);
			const text = i.state === "running" ? (since ? fmtDuration(Date.now() - since) : "running") : i.state === "failed" ? "failed" : "done";
			const watching = panel.isOpen && panel.file === i.file;
			return h(
				"button",
				{
					class: `subagent-chip ${i.state}${watching ? " watching" : ""}`,
					type: "button",
					title: watching ? "Shown in the side panel" : "Watch this subagent live",
					onclick: () => watchSubagent({ file: i.file, agent: i.agent, name: i.name }),
				},
				i.state === "running" ? h("span", { class: "spinner" }) : h("span", { class: "chip-mark", html: icon(i.state === "failed" ? "x" : "check") }),
				h("span", { class: "chip-name" }, [i.agent, i.name].filter(Boolean).join(" · ")),
				h("span", { class: "chip-time" }, text),
			);
		}),
	);
}

/** Antigravity artifacts (plans, write-ups) of the open conversation; click to read in the side panel. */
function artifactStrip() {
	const list = isAgy(S.meta) ? S.meta.artifacts || [] : [];
	if (!list.length) return null;
	const recent = Date.now() - 2 * 60_000;
	return h(
		"div",
		{ class: "subagent-strip artifact-strip" },
		h("span", { class: "strip-label", html: `${icon("file")}<span>Artifacts</span>` }),
		list.map((a) => {
			const open = panel.isOpen && panel.doc?.name === a.name && panel.doc?.session === S.current;
			return h(
				"button",
				{
					class: `subagent-chip${open ? " watching" : ""}${a.mtime > recent ? " running" : ""}`,
					type: "button",
					title: a.mtime > recent ? "Updated in the last few minutes" : "Read it in the side panel",
					onclick: () => {
						if (window.innerWidth < 860) {
							toast("Widen the window to read artifacts beside the chat.", "info");
							return;
						}
						panel.openDoc({ session: S.current, name: a.name });
						renderDock();
					},
				},
				h("span", { class: "chip-name" }, a.name.replace(/\.(md|markdown|txt)$/i, "")),
			);
		}),
	);
}

// ── dock: widgets, statuses, queue ──────────────────────────────────────────

function renderDock() {
	const live = conv?.live;
	const above = $("#dock-above");
	const below = $("#dock-below");
	if (!live || !S.current) {
		above.replaceChildren();
		below.replaceChildren();
		return;
	}
	const widgets = { aboveEditor: [], belowEditor: [] };
	for (const [key, w] of Object.entries(live.widgets || {})) {
		const lines = w?.lines || [];
		if (!lines.length || NATIVE_WIDGETS.has(key)) continue;
		const pre = h("pre", { class: "widget", dir: "ltr", "data-key": key });
		pre.innerHTML = lines.map((l) => ansiToHtml(l)).join("\n");
		(w.placement === "belowEditor" ? widgets.belowEditor : widgets.aboveEditor).push(pre);
	}
	const queue = [...(live.queue?.steering || []).map((t) => ["steer", t]), ...(live.queue?.followUp || []).map((t) => ["follow-up", t])];
	const queueEl = queue.length
		? h(
				"div",
				{ class: "queue" },
				queue.map(([kind, text]) => h("span", { class: "queue-chip", title: text, dir: "auto" }, h("b", {}, kind === "steer" ? "Queued" : "After this"), ` ${text.slice(0, 80)}`)),
				h(
					"button",
					{
						class: "btn ghost small",
						type: "button",
						onclick: async () => {
							const data = await rpc(S.current, { type: "clear_queue" }).catch((err) => toast(err.message, "error"));
							const texts = [...(data?.steering || []), ...(data?.followUp || [])];
							if (texts.length && !$("#input").value.trim()) setComposerText(texts.join("\n\n"));
						},
					},
					"Unqueue",
				),
			)
		: null;
	above.replaceChildren(subagentStrip() || "", artifactStrip() || "", ...widgets.aboveEditor, queueEl || "");
	const statuses = Object.entries(live.statuses || {}).map(([key, text]) => h("span", { class: "status-chip", title: key, html: ansiToHtml(text) }));
	below.replaceChildren(...widgets.belowEditor, statuses.length ? h("div", { class: "statuses" }, statuses) : "");
}

// ── composer ────────────────────────────────────────────────────────────────

function updateComposer() {
	const input = $("#input");
	const busy = !!conv?.live.busy;
	const disabled = !S.current;
	input.disabled = disabled;
	$("#composer").classList.toggle("busy", busy);
	$("#btn-stop").hidden = !busy;
	$("#btn-send").disabled = disabled || S.sending;
	$("#btn-send").title = busy ? "Queue this message (Enter). Alt+Enter: after pi finishes" : "Send (Enter)";
	const starting = S.proc?.state === "starting";
	const hint = !S.current
		? "Open a session or start a new chat"
		: starting
			? "Starting pi…"
			: busy
				? "Enter queues · Alt+Enter after pi finishes · Esc stops"
				: hasProcess()
					? "Enter send · Shift+Enter new line · / commands · ! shell"
					: isExternallyActive(S.meta)
						? "Live in your terminal: reading is safe; sending here starts a second pi"
						: "Enter send (starts pi) · Shift+Enter new line · / commands";
	$("#composer-hint").textContent = hint;
	input.placeholder = S.current ? (busy ? "Steer pi while it works…" : "Message pi…") : "";
	if (isAgy(S.meta)) {
		// Antigravity: messages go into the conversation through the app; it can't be stopped from here.
		$("#btn-stop").hidden = true;
		$("#composer").classList.toggle("busy", !!S.meta.running);
		$("#btn-send").title = "Send to Antigravity (Enter)";
		input.placeholder = "Message Antigravity…";
		$("#composer-hint").textContent = !S.agy?.running
			? "Antigravity app closed — a headless server starts when you send (reading works anyway)"
			: S.meta.running
				? "Antigravity is working; your message joins the conversation"
				: "Enter sends into this Antigravity conversation";
	}
}

function autoGrow() {
	const input = $("#input");
	input.style.height = "auto";
	input.style.height = `${Math.min(input.scrollHeight, Math.round(window.innerHeight * 0.4))}px`;
	input.dir = textDir(input.value) || "auto";
}

function setComposerText(text) {
	const input = $("#input");
	input.value = text;
	autoGrow();
	input.focus();
	input.setSelectionRange(text.length, text.length);
}

function saveDraft() {
	if (!S.current) return;
	const drafts = storage("pi-web:drafts", {});
	const text = $("#input").value;
	if (text.trim()) drafts[S.current] = text;
	else delete drafts[S.current];
	store("pi-web:drafts", drafts);
}
const saveDraftSoon = debounce(saveDraft, 400);

function loadDraft() {
	const text = S.current ? storage("pi-web:drafts", {})[S.current] || "" : "";
	$("#input").value = text;
	autoGrow();
}

/** Full-text search over all chats (server-side). Runs while you type; the
 *  results merge into the sidebar's list, with snippets under each hit. */
const fetchSearchHits = debounce(async () => {
	const q = S.search.trim();
	if (q.length < 2) {
		if (S.searchHits.size) {
			S.searchHits = new Map();
			renderSessionList();
		}
		return;
	}
	try {
		const data = await getJson(`/api/search?q=${encodeURIComponent(q)}`);
		// A later keystroke may have won the race; only apply the freshest answer.
		if (S.search.trim() !== q) return;
		S.searchHits = new Map((data.results || []).map((r) => [r.id, r]));
		} catch {
		// the server will say so on the next word
	}
	renderSessionList();
}, 300);

let warmed = null;
function prewarm() {
	if (!S.current || isAgy(S.meta) || hasProcess() || warmed === S.current || isExternallyActive(S.meta) || !S.server.piBin) return;
	warmed = S.current;
	post("/api/process", { session: S.current, action: "start" }).catch(() => {});
}

async function loadCommands() {
	if (!S.current || !hasProcess()) return;
	const session = S.current;
	try {
		const data = await rpc(session, { type: "get_commands" });
		if (S.current === session) S.commands = data?.commands || [];
	} catch {
		// commands are a nicety
	}
}

function slashCandidates(prefix) {
	const seen = new Set();
	const out = [];
	const add = (name, description, source) => {
		if (seen.has(name)) return;
		seen.add(name);
		out.push({ name, description, source });
	};
	for (const c of WEB_COMMANDS) add(c.name, c.description, "web");
	for (const c of S.commands || []) add(c.name, c.description || "", c.source);
	const q = prefix.toLowerCase();
	return out.filter((c) => c.name.toLowerCase().includes(q)).sort((a, b) => a.name.toLowerCase().indexOf(q) - b.name.toLowerCase().indexOf(q)).slice(0, 60);
}

const slash = { open: false, items: [], index: 0 };

function updateSlashMenu() {
	const input = $("#input");
	const menu = $("#slash-menu");
	const m = /^\/(\S*)$/.exec(input.value);
	if (!m || !S.current || isAgy(S.meta)) {
		slash.open = false;
		menu.hidden = true;
		return;
	}
	if (hasProcess() && !S.commands) loadCommands().then(() => slash.open && updateSlashMenu());
	slash.items = slashCandidates(m[1]);
	slash.index = Math.min(slash.index, Math.max(0, slash.items.length - 1));
	slash.open = slash.items.length > 0;
	menu.hidden = !slash.open;
	menu.replaceChildren(
		...slash.items.map((c, i) =>
			h(
				"button",
				{
					class: `slash-item${i === slash.index ? " on" : ""}`,
					type: "button",
					onmousedown: (e) => {
						e.preventDefault();
						pickSlash(i);
					},
				},
				h("span", { class: "slash-name" }, `/${c.name}`),
				h("span", { class: "slash-desc", dir: "auto" }, c.description || ""),
				c.source && c.source !== "web" ? h("span", { class: "slash-src" }, c.source) : null,
			),
		),
		!hasProcess() ? h("div", { class: "slash-note" }, "Skills and extension commands appear once pi is running.") : "",
	);
}

function pickSlash(i) {
	const item = slash.items[i];
	if (!item) return;
	setComposerText(`/${item.name} `);
	slash.open = false;
	$("#slash-menu").hidden = true;
}

function onComposerKey(e) {
	if (slash.open) {
		if (e.key === "ArrowDown" || e.key === "ArrowUp") {
			e.preventDefault();
			slash.index = (slash.index + (e.key === "ArrowDown" ? 1 : -1) + slash.items.length) % slash.items.length;
			updateSlashMenu();
			return;
		}
		if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey && $("#input").value.trim().length > 1 && !slash.items.some((c) => `/${c.name}` === $("#input").value.trim()))) {
			e.preventDefault();
			pickSlash(slash.index);
			return;
		}
		if (e.key === "Escape") {
			e.preventDefault();
			slash.open = false;
			$("#slash-menu").hidden = true;
			return;
		}
	}
	if (e.key === "Enter" && !e.shiftKey && !e.isComposing && !e.ctrlKey) {
		e.preventDefault();
		submit({ followUp: e.altKey });
		return;
	}
	if (e.key === "Escape" && conv.live.busy && !isAgy(S.meta)) {
		e.preventDefault();
		abortRun();
	}
}

async function builtinCommand(text) {
	const m = /^\/([\w:-]+)(?:\s+([\s\S]*))?$/.exec(text);
	if (!m) return false;
	const [, name, argRaw] = m;
	const arg = (argRaw || "").trim();
	switch (name) {
		case "model": {
			if (arg.includes("/")) {
				const [provider, ...rest] = arg.split("/");
				await rpc(S.current, { type: "set_model", provider, modelId: rest.join("/") }).then(
					() => toast(`Model: ${arg}`, "info"),
					(err) => toast(err.message, "error"),
				);
			} else openModelPicker($(".model-btn") || $("#topbar-side"));
			return true;
		}
		case "thinking":
			if (arg) await rpc(S.current, { type: "set_thinking_level", level: arg }).then(() => toast(`Thinking: ${arg}`, "info"), (err) => toast(err.message, "error"));
			else openModelPicker($(".model-btn") || $("#topbar-side"));
			return true;
		case "name":
			if (arg) await rpc(S.current, { type: "set_session_name", name: arg }).then(() => toast("Renamed.", "info"), (err) => toast(err.message, "error"));
			else renameSession();
			return true;
		case "compact":
			compact(arg);
			return true;
		case "new":
			newChat();
			return true;
		case "resume":
			$("#search").focus();
			return true;
		case "session":
			sessionInfo();
			return true;
		case "copy": {
			const last = [...conv.entries].reverse().find((e) => e.type === "message" && e.message?.role === "assistant" && textOf(e.message.content).trim());
			if (last) copy(textOf(last.message.content));
			else toast("No reply to copy yet.", "warn");
			return true;
		}
		case "export":
			exportHtml();
			return true;
		case "quit":
			stopProcess();
			return true;
		default:
			if (TUI_ONLY.has(name)) {
				toast(`/${name} only works in pi's terminal interface.`, "warn");
				return true;
			}
			return false;
	}
}

async function runBash(text) {
	const excluded = text.startsWith("!!");
	const command = text.slice(excluded ? 2 : 1).trim();
	if (!command) return;
	const t = toast(`Running: ${command}`, "info");
	try {
		const data = await rpc(S.current, { type: "bash", command, excludeFromContext: excluded });
		t.remove();
		if (data?.exitCode) toast(`Exited with code ${data.exitCode}`, "warn");
	} catch (err) {
		t.remove();
		toast(err.message, "error");
	}
}

async function submitAntigravity(text, images) {
	if (images.length) {
		toast("Images can't be sent to Antigravity from here yet.", "warn");
		return;
	}
	// No app needed: pi-web starts a headless Antigravity server on demand.
	if (!S.agy?.running) toast("No Antigravity app is running — pi-web will start a headless server for this message.", "info");
	const input = $("#input");
	input.value = "";
	autoGrow();
	saveDraft();
	S.sending = true;
	updateComposer();
	conv.stick = true;
	try {
		await post("/api/prompt", { session: S.current, message: text });
	} catch (err) {
		toast(err.message, "error");
		if (!input.value.trim()) setComposerText(text);
		refreshAgy({ force: true });
	} finally {
		S.sending = false;
		updateComposer();
	}
}

async function submit({ followUp = false } = {}) {
	const input = $("#input");
	const text = input.value;
	const images = S.attachments.slice();
	if (!S.current || (!text.trim() && !images.length) || S.sending) return;
	const trimmed = text.trim();
	if (isAgy(S.meta)) return submitAntigravity(text, images);
	if (!images.length && trimmed.startsWith("/")) {
		const handled = await builtinCommand(trimmed);
		if (handled) {
			input.value = "";
			autoGrow();
			saveDraft();
			return;
		}
	}
	if (!images.length && trimmed.startsWith("!")) {
		input.value = "";
		autoGrow();
		saveDraft();
		runBash(trimmed);
		return;
	}
	if (!hasProcess() && isExternallyActive(S.meta)) {
		const ok = await confirmModal(
			"This session is open in your terminal",
			"pi in your terminal wrote to this session in the last few minutes. Sending from here starts a second pi on the same session, and the two will not see each other's new messages (the conversation forks). Continue anyway?",
			"Send anyway",
		);
		if (!ok) return;
	}
	input.value = "";
	S.attachments = [];
	renderAttachments();
	autoGrow();
	saveDraft();
	S.sending = true;
	updateComposer();
	conv.stick = true;
	try {
		await post("/api/prompt", {
			session: S.current,
			message: text,
			images: images.map((i) => ({ data: i.data, mimeType: i.mimeType })),
			behavior: followUp ? "followUp" : "steer",
		});
	} catch (err) {
		toast(err.message, "error");
		if (!input.value.trim()) setComposerText(text);
		S.attachments = images;
		renderAttachments();
	} finally {
		S.sending = false;
		updateComposer();
	}
}

// attachments (images)
function renderAttachments() {
	const wrap = $("#attachments");
	wrap.hidden = !S.attachments.length;
	wrap.replaceChildren(
		...S.attachments.map((a, i) =>
			h(
				"div",
				{ class: "attachment" },
				h("img", { src: `data:${a.mimeType};base64,${a.data}`, alt: a.name || "image" }),
				h(
					"button",
					{
						class: "attachment-x",
						type: "button",
						title: "Remove",
						html: icon("x"),
						onclick: () => {
							S.attachments.splice(i, 1);
							renderAttachments();
						},
					},
				),
			),
		),
	);
}

function addImageFiles(files) {
	for (const file of files) {
		if (!/^image\/(png|jpeg|gif|webp)$/.test(file.type)) {
			toast(`${file.name || "That file"} is not a PNG, JPEG, GIF or WebP image.`, "warn");
			continue;
		}
		if (file.size > 15 * 1024 * 1024) {
			toast(`${file.name} is larger than 15 MB.`, "warn");
			continue;
		}
		const reader = new FileReader();
		reader.onload = () => {
			const data = String(reader.result).split(",")[1];
			S.attachments.push({ name: file.name, mimeType: file.type, data });
			renderAttachments();
		};
		reader.readAsDataURL(file);
	}
}

/** Attach anything: images go into the chat, every other file is uploaded to
 *  the session's folder and its path is pasted into the message box, where pi
 *  can read it. */
async function addFiles(files) {
	if (!S.current) {
		toast("Open a session first — uploads go into its folder.", "warn");
		return;
	}
	if (isAgy(S.meta)) {
		toast("Files can be attached to pi sessions; Antigravity can't read local files.", "warn");
		return;
	}
	for (const file of files) {
		if (/^image\/(png|jpeg|gif|webp)$/.test(file.type)) {
			addImageFiles([file]);
			continue;
		}
		await uploadFile(file);
	}
}

async function uploadFile(file) {
	if (file.size > 32 * 1024 * 1024) {
		toast(`${file.name || "That file"} is larger than 32 MB.`, "warn");
		return;
	}
	const readAsBase64 = () =>
		new Promise((resolve, reject) => {
			const reader = new FileReader();
			reader.onload = () => resolve(String(reader.result).split(",")[1]);
			reader.onerror = () => reject(new Error(`Could not read ${file.name}`));
			reader.readAsDataURL(file);
		});
	let data;
	try {
		data = await readAsBase64();
	} catch (err) {
		toast(err.message, "error");
		return;
	}
	const name = file.name || "file";
	try {
		const { path: uploaded } = await post("/api/upload", { session: S.current, name, data });
		insertComposerText(uploaded);
		toast(`Added ${name} — its path is in the message box.`, "info");
	} catch (err) {
		toast(err.message, "error");
	}
}

/** Append text (an uploaded file's path) to the message box on its own line. */
function insertComposerText(text) {
	const input = $("#input");
	input.focus();
	if (input.value && !input.value.endsWith("\n")) input.value += "\n";
	input.value += text;
	autoGrow();
	updateSlashMenu();
	saveDraftSoon();
	input.setSelectionRange(input.value.length, input.value.length);
}

// ── mobile sidebar ──────────────────────────────────────────────────────────

function setSidebarOpenMobile(open) {
	$("#app").classList.toggle("sidebar-open", open);
}

// ── wiring ──────────────────────────────────────────────────────────────────

function wire() {
	$("#btn-new").innerHTML = `${icon("plus")}<span>New chat</span>`;
	$("#btn-new").onclick = () => newChat();
	$("#btn-sidebar").innerHTML = icon("sidebar");
	$("#btn-sidebar").onclick = () => {
		if (window.innerWidth < 860) setSidebarOpenMobile(!$("#app").classList.contains("sidebar-open"));
		else setSetting("sidebar", !S.settings.sidebar);
	};
	$("#btn-theme").onclick = () => setSetting("theme", S.settings.theme === "system" ? "light" : S.settings.theme === "light" ? "dark" : "system");
	$("#toggle-subagents").innerHTML = `${icon("bot")}<span>Subagents</span>`;
	$("#toggle-subagents").onclick = () => {
		setSetting("showSubagents", !S.settings.showSubagents);
		renderSessionList();
	};
	$("#toggle-archived").innerHTML = `${icon("archive")}<span>Archived</span>`;
	$("#toggle-archived").title = "Show archived chats";
	$("#toggle-archived").onclick = () => {
		setSetting("showArchived", !S.settings.showArchived);
		renderSessionList();
	};
	$("#scrim").onclick = () => setSidebarOpenMobile(false);

	const search = $("#search");
	search.addEventListener(
		"input",
		debounce(() => {
			S.search = search.value;
			renderSessionList();
			fetchSearchHits();
		}, 80),
	);

	const input = $("#input");
	input.addEventListener("keydown", onComposerKey);
	input.addEventListener("input", () => {
		autoGrow();
		updateSlashMenu();
		saveDraftSoon();
		prewarm();
	});
	input.addEventListener("blur", () =>
		setTimeout(() => {
			slash.open = false;
			$("#slash-menu").hidden = true;
		}, 150),
	);
	input.addEventListener("paste", (e) => {
		const files = [...(e.clipboardData?.files || [])];
		if (files.length) {
			e.preventDefault();
			addFiles(files);
		}
	});
	const composer = $("#composer");
	composer.addEventListener("dragover", (e) => {
		if ([...(e.dataTransfer?.items || [])].some((i) => i.kind === "file")) {
			e.preventDefault();
			composer.classList.add("drop");
		}
	});
	composer.addEventListener("dragleave", () => composer.classList.remove("drop"));
	composer.addEventListener("drop", (e) => {
		composer.classList.remove("drop");
		const files = [...(e.dataTransfer?.files || [])];
		if (files.length) {
			e.preventDefault();
			addFiles(files);
		}
	});
	// Dropping a file anywhere else in the app attaches it too — otherwise the
	// browser would just open the file, losing the page.
	const dragging = (e) => e.dataTransfer && [...e.dataTransfer.types].includes("Files");
	document.addEventListener("dragover", (e) => {
		if (dragging(e)) e.preventDefault();
	});
	document.addEventListener("drop", (e) => {
		if (!dragging(e)) return;
		e.preventDefault();
		addFiles([...(e.dataTransfer?.files || [])]);
	});
	$("#btn-send").innerHTML = icon("send");
	$("#btn-send").onclick = () => submit();
	$("#btn-stop").innerHTML = `${icon("stop")}<span>Stop</span>`;
	$("#btn-stop").onclick = () => abortRun();
	$("#btn-attach").innerHTML = icon("paperclip");
	$("#btn-attach").title = "Attach files: images go into the chat, other files' paths land in the box";
	$("#btn-attach").onclick = () => $("#file-input").click();
	$("#file-input").addEventListener("change", (e) => {
		addFiles([...e.target.files]);
		e.target.value = "";
	});
	$("#jump").innerHTML = `${icon("arrowDown")}<span>Latest</span>`;
	$("#jump").onclick = () => {
		$("#jump").hidden = true;
		conv.scrollToBottom(true);
	};
	$("#lightbox").onclick = (e) => {
		// Clicks inside the vision side panel are its own.
		if (e.target.closest(".lb-panel")) return;
		$("#lightbox").hidden = true;
	};

	document.addEventListener("keydown", (e) => {
		if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
			e.preventDefault();
			if (window.innerWidth < 860) setSidebarOpenMobile(true);
			$("#search").focus();
			$("#search").select();
			return;
		}
		if (e.key === "Escape") {
			if (!$("#lightbox").hidden) {
				$("#lightbox").hidden = true;
				return;
			}
			if (popover) {
				closePopover();
				return;
			}
		}
		const typing = e.target.matches?.("input, textarea, [contenteditable]") || e.target.closest?.(".modal");
		if (!typing && !e.ctrlKey && !e.metaKey && !e.altKey && conv.handleKey(e)) {
			e.preventDefault();
		}
	});
	window.addEventListener("hashchange", route);
	window.addEventListener("beforeunload", saveDraft);
	setInterval(() => {
		renderSessionList();
		if (S.current && !hasProcess()) {
			renderTopbar();
			updateComposer();
		}
		// Running/stopped is time-based for subagents in other processes.
		if (S.meta?.subagents?.length) conv.refreshSubagents();
	}, 30_000);
	// Keep the subagent strip's elapsed times ticking.
	setInterval(() => {
		if (runningSubagents(S.meta).length) renderDock();
	}, 5_000);
}

// ── start ───────────────────────────────────────────────────────────────────

conv = new Conversation({ root: $("#conversation"), scroller: $("#scroller"), app });
panel = new WatchPanel({ el: $("#side"), app });
window.piWeb = { S, conv, panel }; // for poking around in the browser console
applyTheme();
wire();
route();
refreshUsage();
