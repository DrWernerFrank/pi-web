/**
 * pi-web-bridge: loaded into the pi processes that pi-web starts (--extension).
 *
 * pi's RPC mode forwards the standard dialogs (select / confirm / input /
 * editor) to the browser, but `ctx.ui.custom()` pop-ups resolve to undefined
 * there, which makes tools like `quiz` and `ask_user_question` look cancelled.
 * This extension restores them through a private socket to the pi-web server:
 *
 *   - quiz and ask_user_question are answered with native cards in the page
 *   - any other custom component is rendered as terminal lines in the page and
 *     driven by forwarded key presses
 *   - component-based widgets (e.g. the subagent status box) are rendered to lines
 *
 * Outside pi-web (no PI_WEB_BRIDGE_SOCK in the environment) it does nothing.
 */

import * as net from "node:net";

type Pending = {
	kind: string;
	toolCallId?: string;
	resolve: (value: unknown) => void;
	key?: (data: string) => void;
	resize?: () => void;
	/** Re-send the dialog to the page (used after the socket reconnects, so a
	 *  page that reconnected still sees the quiz it was answering). */
	announce?: () => void;
};

type RunningTool = {
	id: string;
	toolName: string;
	args: any;
	startedAt: number;
	displayOptions?: Array<{ index: number; label: string }>;
	answered?: boolean;
};

type BridgeState = {
	sockPath?: string;
	key?: string;
	sock: net.Socket | null;
	pending: Map<string, Pending>;
	running: Map<string, RunningTool>;
	patched: WeakSet<object>;
	cols: number;
	seq: number;
	// Reconnection state: the server re-attaches by key on every hello, so a
	// dropped socket is always recoverable — the bridge just has to retry.
	reconnectTimer?: ReturnType<typeof setTimeout>;
	connectFailures: number;
	// ui_close messages that arrived while disconnected, flushed on reconnect
	// so the page's cards don't linger after the pipe comes back.
	outbox: Array<Record<string, unknown>>;
};

const STATE_KEY = "__piWebBridge";
const QUESTION_TOOLS = new Set(["quiz", "ask_user_question"]);

function bridgeState(): BridgeState {
	const g = globalThis as any;
	if (!g[STATE_KEY]) {
		const state: BridgeState = {
			sockPath: process.env.PI_WEB_BRIDGE_SOCK || undefined,
			key: process.env.PI_WEB_KEY || undefined,
			sock: null,
			pending: new Map(),
			running: new Map(),
			patched: new WeakSet(),
			cols: 100,
			seq: 0,
			connectFailures: 0,
			outbox: [],
		};
		// Keep the socket address out of every command pi runs from here on.
		delete process.env.PI_WEB_BRIDGE_SOCK;
		delete process.env.PI_WEB_KEY;
		g[STATE_KEY] = state;
		if (state.sockPath && state.key) connect(state);
	}
	return g[STATE_KEY];
}

function connect(state: BridgeState): void {
	const sock = net.createConnection(state.sockPath as string);
	let buffer = "";
	sock.setEncoding("utf8");
	sock.on("connect", () => {
		state.sock = sock;
		state.connectFailures = 0;
		send(state, { t: "hello", key: state.key, pid: process.pid });
		// Back after a drop: re-announce every dialog that was open when the
		// socket died, so a page that reconnected still shows the quiz it was
		// halfway through answering — and can still answer it.
		for (const p of state.pending.values()) {
			try {
				p.announce?.();
			} catch {
				// announcing must never break the connection
			}
		}
		// Cards closed while we were down: tell the page now.
		for (const msg of state.outbox.splice(0)) send(state, msg);
	});
	sock.on("data", (chunk: string) => {
		buffer += chunk;
		let nl: number;
		while ((nl = buffer.indexOf("\n")) >= 0) {
			const line = buffer.slice(0, nl);
			buffer = buffer.slice(nl + 1);
			if (!line.trim()) continue;
			try {
				onMessage(state, JSON.parse(line));
			} catch {
				// ignore malformed lines
			}
		}
	});
	sock.on("error", () => {});
	sock.on("close", () => {
		if (state.sock === sock) state.sock = null;
		// Do NOT resolve pending dialogs here. The server re-attaches by key on
		// hello, and the answer often still arrives through the reconnected
		// socket. Nulling everything out is what made quizzes come back
		// "skipped/empty" — the user never cancelled; the pipe hiccuped.
		scheduleReconnect(state);
	});
	sock.unref();
}

/** Retry the socket forever, gently: 0.25s doubling to a 5s cap. Unref'd, so
 *  retrying never keeps a shutting-down pi alive. */
function scheduleReconnect(state: BridgeState): void {
	if (state.reconnectTimer) return;
	const attempt = ++state.connectFailures;
	const delay = Math.min(5000, 250 * 2 ** Math.min(attempt - 1, 4));
	const timer = setTimeout(() => {
		state.reconnectTimer = undefined;
		connect(state);
	}, delay);
	timer.unref?.();
	state.reconnectTimer = timer;
}

function send(state: BridgeState, msg: unknown): void {
	if (state.sock && !state.sock.destroyed) {
		state.sock.write(`${JSON.stringify(msg)}\n`);
	} else if ((msg as any)?.t === "ui_close") {
		// A card we closed while disconnected: queue it so the page isn't left
		// with a ghost quiz after the socket returns.
		state.outbox.push(msg as Record<string, unknown>);
	}
}

function cancelled(p: Pending): unknown {
	return p.kind === "terminal" ? undefined : null;
}

function onMessage(state: BridgeState, msg: any): void {
	switch (msg?.t) {
		case "ui_answer":
			state.pending.get(msg.uid)?.resolve(msg.value);
			break;
		case "ui_cancel": {
			const p = state.pending.get(msg.uid);
			if (p) p.resolve(cancelled(p));
			break;
		}
		case "ui_cancel_all":
			for (const p of [...state.pending.values()]) p.resolve(cancelled(p));
			break;
		case "ui_key":
			state.pending.get(msg.uid)?.key?.(String(msg.data ?? ""));
			break;
		case "width":
			state.cols = Math.max(40, Math.min(220, Number(msg.cols) || 100));
			for (const p of state.pending.values()) p.resize?.();
			break;
	}
}

function waitFor(test: () => unknown, ms: number): Promise<boolean> {
	return new Promise((resolve) => {
		if (test()) return resolve(true);
		const started = Date.now();
		const timer = setInterval(() => {
			if (test() || Date.now() - started > ms) {
				clearInterval(timer);
				resolve(!!test());
			}
		}, 20);
	});
}

function normalizeOptions(options: unknown): Array<{ label: string; value: string }> {
	if (!Array.isArray(options)) return [];
	return options
		.map((o: any) => {
			const label = String(o?.label ?? "").trim();
			const value = String(o?.value ?? "").trim() || label;
			return { label, value };
		})
		.filter((o) => o.label.length > 0);
}

/** The quiz extension's QuizResponse, built from the page's answer. */
function toQuizResponse(tool: RunningTool, raw: any) {
	const authored = normalizeOptions(tool.args?.options);
	const shown = tool.displayOptions ?? [];
	const dontKnow = raw?.dontKnow === true;
	const selected: number[] = Array.isArray(raw?.selected) ? raw.selected.map(Number) : [];
	const answers = dontKnow
		? []
		: [...new Set(selected)]
				.filter((index) => shown.some((o) => o.index === index))
				.sort((a, b) => a - b)
				.map((index) => {
					const label = shown.find((o) => o.index === index)!.label;
					const option = authored.find((o) => o.label === label.trim());
					return { index, label, value: option ? option.value : label };
				});
	const note = typeof raw?.note === "string" && raw.note.trim() ? raw.note.trim() : undefined;
	return { dontKnow, unsure: raw?.unsure === true && !dontKnow, note, answers };
}

/** The ask_user_question extension's AskAnswer[], built from the page's answer. */
function toAskAnswers(tool: RunningTool, raw: any) {
	const options = normalizeOptions(tool.args?.options);
	const selected: number[] = Array.isArray(raw?.selected) ? raw.selected.map(Number) : [];
	const answers: any[] = [];
	for (const index of [...new Set(selected)].sort((a, b) => a - b)) {
		const option = options[index - 1];
		if (option) answers.push({ type: "option", index, label: option.label, value: option.value });
	}
	const other = typeof raw?.other === "string" ? raw.other.trim() : "";
	if (other) answers.push({ type: "other", label: other, value: other });
	return answers.length ? answers : null;
}

function nativeQuestion(state: BridgeState, tool: RunningTool): Promise<unknown> {
	const uid = `q${++state.seq}`;
	tool.answered = true;
	const announce = () =>
		send(state, {
			t: "ui_open",
			uid,
			kind: tool.toolName,
			toolCallId: tool.id,
			args: tool.args,
			displayOptions: tool.displayOptions ?? null,
		});
	return new Promise((resolve) => {
		state.pending.set(uid, {
			kind: tool.toolName,
			toolCallId: tool.id,
			announce,
			resolve: (raw) => {
				if (!state.pending.has(uid)) return;
				state.pending.delete(uid);
				send(state, { t: "ui_close", uid });
				if (raw == null) return resolve(null);
				const response = tool.toolName === "quiz" ? toQuizResponse(tool, raw) : toAskAnswers(tool, raw);
				// A selection that maps to zero answers is a display-order mismatch,
				// not an answer. Hand back null (the quiz re-asks, honestly labelled)
				// rather than report "answered, selected nothing" — that false empty
				// is exactly what made quizzes look broken.
				if (
					tool.toolName === "quiz" &&
					!response.dontKnow &&
					Array.isArray(raw?.selected) &&
					raw.selected.length > 0 &&
					response.answers.length === 0
				) {
					return resolve(null);
				}
				resolve(response);
			},
		});
		announce();
	});
}

function fakeTui(state: BridgeState, requestRender: () => void): any {
	const base: Record<string | symbol, unknown> = {
		requestRender,
		invalidate: requestRender,
		terminal: {
			get columns() {
				return state.cols;
			},
			get rows() {
				return 40;
			},
			write() {},
		},
	};
	return new Proxy(base, {
		get(target, prop) {
			if (prop in target) return target[prop];
			if (prop === "then") return undefined;
			return () => undefined;
		},
	});
}

const keybindingsStub = new Proxy(
	{},
	{
		get(_target, prop) {
			if (prop === "then") return undefined;
			return () => undefined;
		},
	},
);

/**
 * Any other custom component: stream its lines to the page, feed key presses
 * back. `contextToolCallId` only tells the page which tool is probably asking.
 */
function terminalPopup(state: BridgeState, ui: any, factory: any, contextToolCallId?: string): Promise<unknown> {
	const uid = `t${++state.seq}`;
	return new Promise((resolve) => {
		let component: any;
		let closed = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const render = () => {
			timer = undefined;
			if (closed || !component) return;
			let lines: string[];
			try {
				lines = component.render(state.cols);
			} catch (error) {
				lines = [`(pop-up failed to render: ${(error as Error)?.message ?? error})`];
			}
			send(state, { t: "ui_render", uid, lines });
		};
		const schedule = () => {
			if (!timer) timer = setTimeout(render, 16);
		};
	const done = (result: unknown) => {
			if (closed) return;
			closed = true;
			state.pending.delete(uid);
			if (timer) clearTimeout(timer);
			try {
				component?.dispose?.();
			} catch {
				// ignore
			}
			send(state, { t: "ui_close", uid });
			resolve(result);
		};
		const open = () => {
			send(state, { t: "ui_open", uid, kind: "terminal", toolCallId: contextToolCallId, lines: [] });
			render();
		};
		state.pending.set(uid, {
			kind: "terminal",
			announce: open,
			resolve: done,
			key: (data) => {
				try {
					component?.handleInput?.(data);
				} catch {
					// a broken key handler must not take pi down
				}
				schedule();
			},
			resize: () => {
				try {
					component?.invalidate?.();
				} catch {
					// ignore
				}
				schedule();
			},
		});
		Promise.resolve()
			.then(() => factory(fakeTui(state, schedule), ui.theme, keybindingsStub, done))
			.then((created: any) => {
				component = created;
				if (closed) return;
				open();
			})
			.catch(() => done(undefined));
	});
}

function latestTool(state: BridgeState, filter: (t: RunningTool) => boolean): RunningTool | undefined {
	let best: RunningTool | undefined;
	for (const tool of state.running.values()) {
		if (filter(tool) && (!best || tool.startedAt >= best.startedAt)) best = tool;
	}
	return best;
}

function patchUi(state: BridgeState, ctx: any): void {
	let ui: any;
	try {
		if (ctx?.mode !== "rpc") return;
		ui = ctx.ui;
	} catch {
		return;
	}
	if (!ui || typeof ui !== "object" || state.patched.has(ui)) return;
	state.patched.add(ui);

	const originalCustom = typeof ui.custom === "function" ? ui.custom.bind(ui) : undefined;
	ui.custom = async (factory: any, options: any) => {
		if (!state.sock) {
			// The socket can be mid-reconnect (the server re-attaches by key on
			// hello). Wait briefly instead of instantly cancelling — an instant
			// undefined here is what made quizzes come back "empty".
			const back = await waitFor(() => state.sock, 8000);
			if (!back) return originalCustom ? originalCustom(factory, options) : undefined;
		}
		const question = latestTool(state, (t) => QUESTION_TOOLS.has(t.toolName) && !t.answered);
		if (question) {
			// quiz shuffles its options and announces the shown order just before
			// opening the pop-up; answers must use that order.
			if (question.toolName === "quiz") await waitFor(() => question.displayOptions, 1500);
			if (question.toolName !== "quiz" || question.displayOptions) return nativeQuestion(state, question);
		}
		return terminalPopup(state, ui, factory, latestTool(state, () => true)?.id);
	};

	const originalSetWidget = typeof ui.setWidget === "function" ? ui.setWidget.bind(ui) : undefined;
	if (originalSetWidget) {
		ui.setWidget = (key: string, content: any, options: any) => {
			if (typeof content === "function" && state.sock) {
				try {
					const component = content(fakeTui(state, () => {}), ui.theme);
					const lines = component?.render?.(state.cols);
					if (Array.isArray(lines)) {
						send(state, { t: "widget", key, lines, placement: options?.placement });
						return;
					}
				} catch {
					// fall through to pi's own handling
				}
			}
			if (content === undefined) send(state, { t: "widget", key, lines: null });
			return originalSetWidget(key, content, options);
		};
	}
}

export default function piWebBridge(pi: any) {
	const state = bridgeState();
	if (!state.sockPath || !state.key) return;

	pi.on("session_start", (_event: any, ctx: any) => patchUi(state, ctx));

	pi.on("tool_execution_start", (event: any, ctx: any) => {
		patchUi(state, ctx);
		state.running.set(event.toolCallId, {
			id: event.toolCallId,
			toolName: event.toolName,
			args: event.args ?? {},
			startedAt: Date.now(),
		});
	});

	pi.on("tool_execution_update", (event: any) => {
		const tool = state.running.get(event.toolCallId);
		const shown = event.partialResult?.details?.options;
		if (tool && Array.isArray(shown) && shown.length > 0) tool.displayOptions = shown;
	});

	pi.on("tool_execution_end", (event: any) => {
		state.running.delete(event.toolCallId);
		for (const p of [...state.pending.values()]) {
			if (p.toolCallId === event.toolCallId) p.resolve(cancelled(p));
		}
	});
}
