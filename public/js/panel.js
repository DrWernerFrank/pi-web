// Side panel that follows one subagent's session live, next to its parent.

import { getJson, streamUrl } from "./api.js";
import { Conversation } from "./conversation.js";
import { icon } from "./icons.js";
import { renderInto } from "./markdown.js";
import { fmtDuration, h } from "./util.js";

export class WatchPanel {
	constructor({ el, app }) {
		this.el = el;
		this.app = app;
		this.file = null;
		this.sessionId = null;
		this.es = null;
		this.ticker = null;
	}

	get isOpen() {
		return !this.el.hidden;
	}

	/** Open the panel on a subagent: { file, agent, name } (+ id if the session file already exists). */
	open(sub) {
		this.close(false);
		this.doc = null;
		this.sub = sub;
		this.file = sub.file;
		this.el.hidden = false;
		document.getElementById("app").classList.add("panel-open");

		this.titleEl = h("div", { class: "side-title" });
		this.stateEl = h("div", { class: "side-state" });
		const full = h("button", { class: "icon-btn", type: "button", title: "Open as a full page", html: icon("external") });
		full.onclick = () => {
			const id = this.sessionId || this.app.subagentInfo(this.file)?.childId;
			if (id) {
				this.close();
				this.app.navigate(id);
			}
		};
		const close = h("button", { class: "icon-btn", type: "button", title: "Close", html: icon("x") });
		close.onclick = () => this.close();
		this.scroller = h("div", { class: "side-scroller" });
		const root = h("div", { class: "conversation side-conversation" });
		this.scroller.append(root);
		const parentApp = this.app;
		this.el.replaceChildren(
			h("div", { class: "side-head" }, h("span", { class: "side-icon", html: icon("bot") }), h("div", { class: "side-titles" }, this.titleEl, this.stateEl), full, close),
			this.scroller,
		);
		this.conv = new Conversation({
			root,
			scroller: this.scroller,
			app: {
				get settings() {
					return parentApp.settings;
				},
				navigate: (id) => this.app.navigate(id),
				toast: (...a) => this.app.toast(...a),
				copy: (...a) => this.app.copy(...a),
				lightbox: (...a) => this.app.lightbox(...a),
				setToolsMode: (m) => this.app.setToolsMode(m),
				isExternallyActive: (meta) => this.app.isExternallyActive(meta),
				hasProcess: () => false,
				subagentInfo: (file, parent) => this.app.subagentInfo(file, parent),
				watchSubagent: (s) => this.app.watchSubagent(s),
				onStickChange() {},
			},
		});
		this.paintHead();
		this.ticker = setInterval(() => this.paintHead(), 1000);
		this.connect();
	}

	/** Show an Antigravity artifact (markdown in the conversation's folder), refreshed as it changes. */
	openDoc({ session, name }) {
		this.close(false);
		this.doc = { session, name };
		this.el.hidden = false;
		document.getElementById("app").classList.add("panel-open");
		const close = h("button", { class: "icon-btn", type: "button", title: "Close", html: icon("x") });
		close.onclick = () => this.close();
		const body = h("div", { class: "md" });
		const state = h("div", { class: "side-state" }, "artifact");
		this.scroller = h("div", { class: "side-scroller" }, h("div", { class: "conversation side-conversation" }, body));
		this.el.replaceChildren(
			h("div", { class: "side-head" }, h("span", { class: "side-icon", html: icon("file") }), h("div", { class: "side-titles" }, h("div", { class: "side-title" }, name), state), close),
			this.scroller,
		);
		let last = null;
		const load = async () => {
			try {
				const { text } = await getJson(`/api/agy/artifact?session=${encodeURIComponent(session)}&name=${encodeURIComponent(name)}`);
				if (text === last) return;
				const first = last === null;
				last = text;
				renderInto(body, text, { sessionId: session });
				state.textContent = first ? "artifact" : "artifact · updated just now";
			} catch (err) {
				state.textContent = err.message;
			}
		};
		load();
		this.ticker = setInterval(load, 3000);
	}

	/** Called by the app whenever the session list changes. */
	onSessions() {
		if (!this.isOpen || this.doc) return;
		if (!this.sessionId) this.connect();
		this.paintHead();
	}

	connect() {
		const info = this.app.subagentInfo(this.file);
		const id = info?.childId;
		if (!id) {
			this.conv.clear();
			this.conv.itemsEl.replaceChildren(h("div", { class: "empty-session loading" }, h("span", { class: "spinner" }), " Waiting for the subagent to save its first message…"));
			return;
		}
		if (id === this.sessionId && this.es) return;
		this.sessionId = id;
		this.es?.close();
		this.conv.clear();
		this.conv.showLoading();
		const es = new EventSource(streamUrl(id));
		this.es = es;
		const on = (name, fn) =>
			es.addEventListener(name, (e) => {
				if (this.es !== es) return;
				try {
					fn(JSON.parse(e.data));
				} catch (err) {
					console.error("[pi-web] panel", name, err);
				}
			});
		on("hello", (data) => data.session && this.conv.load(data.session));
		on("snapshot", (snap) => snap && this.conv.load(snap, { keepScroll: true }));
		on("entries", ({ entries, links }) => this.conv.addEntries(entries, links));
		on("rpc", (ev) => this.conv.onRpc(ev));
		on("session_upsert", (meta) => {
			if (meta.id === this.sessionId) this.conv.setMeta(meta);
		});
	}

	paintHead() {
		if (!this.isOpen || this.doc) return;
		const info = this.app.subagentInfo(this.file) || { ...this.sub, state: "running" };
		this.titleEl.textContent = [info.agent || "subagent", info.name].filter(Boolean).join(" · ");
		const since = info.launchedAt ? Date.parse(info.launchedAt) : NaN;
		const labels = {
			running: `running${Number.isFinite(since) ? ` · ${fmtDuration(Date.now() - since)}` : ""}`,
			done: `finished${info.elapsed ? ` in ${fmtDuration(info.elapsed * 1000)}` : ""}`,
			failed: "failed",
			stopped: "no report back (stopped?)",
		};
		this.stateEl.className = `side-state ${info.state}`;
		this.stateEl.textContent = labels[info.state] || "";
	}

	close(updateLayout = true) {
		this.es?.close();
		this.es = null;
		clearInterval(this.ticker);
		this.ticker = null;
		this.sessionId = null;
		this.file = null;
		this.doc = null;
		if (updateLayout) {
			this.el.hidden = true;
			this.el.replaceChildren();
			document.getElementById("app").classList.remove("panel-open");
		}
	}
}
