// Folds pi RPC events into a small "what is happening right now" state.
// Shared by the server (so a page opened mid-run can catch up) and the
// browser (so it can stream without waiting for the session file).

export function createLive() {
	return {
		busy: false,
		partial: null, // assistant message being streamed
		finals: [], // finished messages not yet seen in the session file
		tools: {}, // toolCallId -> running/finished tool execution
		queue: { steering: [], followUp: [] },
		retry: null,
		compaction: null,
		error: null,
		dialogs: {}, // extension dialogs waiting for an answer
		bridge: {}, // quiz / question / terminal pop-ups waiting for an answer
		statuses: {},
		widgets: {},
		title: null,
	};
}

export function messageKey(m) {
	if (!m) return "";
	if (m.role === "custom") return `custom|${m.customType}|${textOf(m.content).slice(0, 300)}`;
	// An id (OpenCode conversions carry it) matches exactly; pi's messages
	// (no id) fall back to role+timestamp like before.
	if (m.id) return `${m.role}|${m.id}`;
	return `${m.role}|${m.timestamp}`;
}

export function entryMessageKey(e) {
	if (e.type === "message" && e.message) return messageKey(e.message);
	if (e.type === "custom_message") return `custom|${e.customType}|${textOf(e.content).slice(0, 300)}`;
	return null;
}

export function textOf(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((c) => c && c.type === "text" && typeof c.text === "string")
		.map((c) => c.text)
		.join("\n");
}

/** Best-effort parse of a JSON object that is still streaming in. */
export function parsePartialJson(src) {
	if (!src) return undefined;
	try {
		return JSON.parse(src);
	} catch {
		// close it below
	}
	let out = "";
	const stack = [];
	let inString = false;
	let escaped = false;
	for (const ch of src) {
		out += ch;
		if (inString) {
			if (escaped) escaped = false;
			else if (ch === "\\") escaped = true;
			else if (ch === '"') inString = false;
			continue;
		}
		if (ch === '"') inString = true;
		else if (ch === "{") stack.push("}");
		else if (ch === "[") stack.push("]");
		else if (ch === "}" || ch === "]") stack.pop();
	}
	if (escaped) out = out.slice(0, -1);
	if (inString) out += '"';
	out = out.replace(/[\s,:]+$/, "").replace(/,\s*"[^"]*"$/, "").replace(/\{\s*"[^"]*"$/, "{");
	try {
		return JSON.parse(out + stack.reverse().join(""));
	} catch {
		return undefined;
	}
}

export function applyAssistantDelta(message, ev) {
	if (!message || !ev) return;
	const content = message.content;
	const i = ev.contentIndex;
	switch (ev.type) {
		case "text_start":
			content[i] = { type: "text", text: "" };
			break;
		case "text_delta":
			if (!content[i]) content[i] = { type: "text", text: "" };
			content[i].text += ev.delta ?? "";
			break;
		case "text_end":
			content[i] = { type: "text", text: typeof ev.content === "string" ? ev.content : (content[i]?.text ?? "") };
			break;
		case "thinking_start":
			content[i] = { type: "thinking", thinking: "" };
			break;
		case "thinking_delta":
			if (!content[i]) content[i] = { type: "thinking", thinking: "" };
			content[i].thinking += ev.delta ?? "";
			break;
		case "thinking_end":
			content[i] = { type: "thinking", thinking: typeof ev.content === "string" ? ev.content : (content[i]?.thinking ?? "") };
			break;
		case "toolcall_start":
			content[i] = { type: "toolCall", id: ev.id, name: ev.toolName, arguments: {}, partialJson: "" };
			break;
		case "toolcall_delta":
			if (content[i]) {
				content[i].partialJson = (content[i].partialJson || "") + (ev.delta ?? "");
				content[i].arguments = parsePartialJson(content[i].partialJson) ?? content[i].arguments;
			}
			break;
		case "toolcall_end":
			if (ev.toolCall) content[i] = ev.toolCall;
			break;
	}
}

export function applyEvent(live, ev) {
	switch (ev.type) {
		case "agent_start":
			live.busy = true;
			live.error = null;
			break;
		case "agent_settled":
			live.busy = false;
			live.partial = null;
			live.retry = null;
			live.compaction = null;
			break;
		case "message_start":
			if (ev.message?.role === "assistant") {
				live.partial = { ...ev.message, content: Array.isArray(ev.message.content) ? ev.message.content.slice() : [] };
			}
			break;
		case "message_update":
			if (live.partial) applyAssistantDelta(live.partial, ev.assistantMessageEvent);
			break;
		case "message_end": {
			const m = ev.message;
			if (m?.role === "assistant") live.partial = null;
			if (m && m.role !== "system") {
				const key = messageKey(m);
				if (!live.finals.some((f) => messageKey(f) === key)) live.finals.push(m);
			}
			break;
		}
		case "tool_execution_start":
			live.tools[ev.toolCallId] = {
				toolCallId: ev.toolCallId,
				toolName: ev.toolName,
				args: ev.args,
				startedAt: Date.now(),
				partialResult: null,
				done: false,
			};
			break;
		case "tool_execution_update": {
			const t = live.tools[ev.toolCallId];
			if (t) t.partialResult = ev.partialResult;
			break;
		}
		case "tool_execution_end": {
			const t = live.tools[ev.toolCallId];
			if (t) {
				t.done = true;
				t.result = ev.result;
				t.isError = ev.isError;
			}
			break;
		}
		case "queue_update":
			live.queue = { steering: ev.steering || [], followUp: ev.followUp || [] };
			break;
		case "auto_retry_start":
			live.retry = { attempt: ev.attempt, maxAttempts: ev.maxAttempts, delayMs: ev.delayMs, errorMessage: ev.errorMessage, at: Date.now() };
			break;
		case "auto_retry_end":
			live.retry = null;
			if (!ev.success && ev.finalError) live.error = ev.finalError;
			break;
		case "compaction_start":
			live.compaction = { reason: ev.reason, at: Date.now() };
			break;
		case "compaction_end":
			live.compaction = null;
			if (ev.errorMessage) live.error = ev.errorMessage;
			break;
	}
}

/** An extension UI request from pi (dialogs are kept until answered). */
export function applyUiRequest(live, req) {
	switch (req.method) {
		case "select":
		case "confirm":
		case "input":
		case "editor":
			live.dialogs[req.id] = { ...req, receivedAt: Date.now() };
			break;
		case "setStatus":
			if (req.statusText == null) delete live.statuses[req.statusKey];
			else live.statuses[req.statusKey] = req.statusText;
			break;
		case "setWidget":
			if (req.widgetLines == null) delete live.widgets[req.widgetKey];
			else live.widgets[req.widgetKey] = { lines: req.widgetLines, placement: req.widgetPlacement };
			break;
		case "setTitle":
			live.title = req.title;
			break;
	}
}

/** Forget live copies of messages and tool runs once the session file has them. */
export function dropPersisted(live, entries) {
	const keys = new Set();
	const ids = new Set();
	const results = new Set();
	for (const e of entries) {
		const key = entryMessageKey(e);
		if (key) keys.add(key);
		// OpenCode conversions carry the source message id on every entry —
		// exact dedupe even when the live copy's timestamp differs.
		if (e?.message?.id) ids.add(e.message.id);
		if (e.type === "message" && e.message?.role === "toolResult") results.add(e.message.toolCallId);
	}
	if (keys.size) live.finals = live.finals.filter((m) => !keys.has(messageKey(m)));
	if (ids.size) live.finals = live.finals.filter((m) => !m.id || !ids.has(m.id));
	for (const id of results) delete live.tools[id];
}
