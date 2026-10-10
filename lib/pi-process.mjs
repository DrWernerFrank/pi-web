// One pi child (via a detached runner) driving one session.
//
// The server never holds the pi's stdio pipes: bridge/wrapper.mjs does, and
// commands/events flow over the bridge socket instead. That is what lets a
// running task survive a pi-web restart — the wrapper and its pi keep going,
// and re-attach (with full control) when the new server comes up.

import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import path from "node:path";
import { spawn } from "node:child_process";
import { applyEvent, applyUiRequest, createLive } from "../public/js/live.js";

const STDERR_LINES = 200;
const WRAPPER = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "bridge", "wrapper.mjs").replace(/\\/g, "/");

// How long pi may take to answer each command. 0 = no limit.
// get_available_models can legitimately take minutes on a cold start: pi
// refreshes every provider's model catalog (network) before answering, and a
// short timeout here made the model picker look broken on fresh sessions.
const TIMEOUTS = {
	get_state: 60_000,
	get_available_models: 300_000,
	get_available_thinking_levels: 120_000,
	prompt: 120_000,
	abort: 120_000,
	compact: 0,
	bash: 0,
	new_session: 120_000,
	switch_session: 120_000,
	export_html: 120_000,
};

export class PiProcess extends EventEmitter {
	constructor({ config, bridge, cwd, sessionFile, bridgeExt, key }) {
		super();
		this.config = config;
		this.bridge = bridge; // the Bridge both ends talk on
		this.cwd = cwd;
		this.sessionFile = sessionFile;
		this.key = key || crypto.randomBytes(12).toString("hex");
		this.live = createLive();
		this.state = "starting";
		this.pending = new Map();
		this.seq = 0;
		this.stderr = [];
		this.startedAt = Date.now();
		this.lastActivity = Date.now();
		this.adopted = false;
		this.bridgeAliveOnce = false;
		this.outbox = []; // commands sent while the runner socket was down
		this.onWrapperConnect = (msgKey, msg) => {
			if (msgKey !== this.key) return;
			this.pid = msg.pid;
			this.bridgeAliveOnce = true;
			this.bridgeDownMessage = null;
			clearTimeout(this.lostTimer);
			// A stop that raced the reconnect: deliver it now.
			if (this.state === "stopping") this.bridge.sendWrapper(this.key, { t: "stop" });
			// Commands queued while disconnected.
			if (this.outbox.length) {
				const lines = this.outbox.splice(0, 200);
				for (const line of lines) this.bridge.sendWrapper(this.key, { t: "stdin", line });
			}
			this.emit("state");
		};
		this.onBridgeMessage = (msgKey, msg, wrapper) => {
			if (msgKey !== this.key || !wrapper) return;
			this.lastActivity = Date.now();
			switch (msg.t) {
				case "rpc": {
					// The wrapper forwards whole lines only; parse exactly like
					// the direct-stdio path did.
					let line = msg.line;
					if (line.length && line[line.length - 1] === "\n") line = line.slice(0, -1);
					if (line.length && line[line.length - 1] === "\r") line = line.slice(0, -1);
					if (line.length) this.handleLine(Buffer.from(line, "utf8"));
					break;
				}
				case "stderr":
					this.logErr(msg.line);
					break;
				case "exit":
					this.onExit(msg.code, msg.signal);
					break;
			}
		};
		this.onWrapperLost = (msgKey) => {
			if (msgKey !== this.key || this.state === "exited") return;
			// The runner socket dropped. Most of the time it reconnects within
			// seconds (a server restart); if it truly died, pi died with it
			// (its pipes were the runner's). Give it a moment, then face it.
			clearTimeout(this.lostTimer);
			this.lostTimer = setTimeout(() => {
				if (!this.bridge?.wrapperAlive(this.key)) this.onExit(null, null, new Error("the runner process was lost"));
				else clearTimeout(this.lostTimer);
			}, 8000).unref?.();
			// Reconnected meanwhile? Clear the doubt as soon as it speaks.
		};
	}

	start() {
		if (!this.bridge) throw new Error("no bridge socket: cannot hold the runner");
		this.bridge.on("message", this.onBridgeMessage);
		this.bridge.on("wrapper", this.onWrapperConnect);
		this.bridge.on("wrapper_disconnect", this.onWrapperLost);

		const args = ["--mode", "rpc"];
		if (this.sessionFile) args.push("--session", this.sessionFile);
		if (this.config.sessionDirArg) args.push("--session-dir", this.config.sessionDirArg);
		if (this.bridgeExt) args.push("--extension", this.bridgeExt);
		args.push(...this.config.extraPiArgs);
		const env = { ...this.config.env, PI_WEB_KEY: this.key, PI_WEB_BRIDGE_SOCK: this.bridge.sockPath || "" };

		// The runner holds the pipes; it is detached so a pi-web crash cannot
		// take the task down with it (that was the whole point).
		this.child = spawn(
			process.execPath,
			[WRAPPER, this.bridge.sockPath, this.key, this.config.piBin, ...args],
			{ cwd: this.cwd, env, stdio: ["ignore", "ignore", "pipe"], detached: true },
		);
		this.child.unref();
		this.child.stderr?.setEncoding("utf8");
		this.child.stderr?.on("data", (text) => {
			for (const line of text.split("\n")) if (line.trim()) this.logErr(`[wrapper] ${line}`);
		});
		this.child.on("error", (err) => this.onExit(null, null, err));

		this.ready = this.refreshState(90_000).then(() => {
			if (this.state === "starting") this.state = "ready";
			this.emit("state");
			return this;
		});
		this.ready.catch(() => {});
		return this.ready;
	}

	/** A runner that came back after a restart: full control, no replacement needed. */
	adopt({ pid, sessionFile, sessionId, busy }) {
		this.adopted = true;
		this.state = "ready";
		this.pid = pid;
		this.sessionFile = sessionFile ?? this.sessionFile;
		this.sessionId = sessionId ?? this.sessionId;
		this.startedAt = Date.now();
		this.live.busy = !!busy;
		this.bridge.on("message", this.onBridgeMessage);
		this.bridge.on("wrapper", this.onWrapperConnect);
		this.bridge.on("wrapper_disconnect", this.onWrapperLost);
		this.ready = Promise.resolve(this);
		this.emit("state");
		// Catch up on what moved while the server was down, then keep serving.
		this.refreshState(30_000)
			.then(() => {
				this.adoptedSynced = true;
				this.emit("state");
			})
			.catch(() => {});
		// A run that was streaming when the server went down shows as busy; if
		// it settled during the gap, no rpc lines will ever arrive — clear the
		// flag once the pi has been quiet, so the pill doesn't say working forever.
		this.adoptedBusyTimer = setInterval(() => {
			if (this.state === "exited" || !this.live.busy) {
					clearInterval(this.adoptedBusyTimer);
				return;
			}
			if (Date.now() - this.lastActivity > 60_000) {
				this.live.busy = false;
				clearInterval(this.adoptedBusyTimer);
				this.emit("state");
			}
		}, 15_000);
		this.adoptedBusyTimer.unref?.();
		return this;
	}

	logErr(line) {
		this.stderr.push(line);
		if (this.stderr.length > STDERR_LINES) this.stderr.splice(0, this.stderr.length - STDERR_LINES);
	}

	handleLine(line) {
		let rec;
		try {
			rec = JSON.parse(line.toString("utf8"));
		} catch {
			this.logErr(`[pi-web] unparsable record: ${line.toString("utf8").slice(0, 200)}`);
			return;
		}
		this.lastActivity = Date.now();
		if (rec.type === "response") {
			const waiting = rec.id ? this.pending.get(rec.id) : undefined;
			if (waiting) {
				this.pending.delete(rec.id);
				clearTimeout(waiting.timer);
				if (rec.success) waiting.resolve(rec.data);
				else waiting.reject(new Error(rec.error || `${rec.command} failed`));
			} else if (!rec.success) {
				this.emit("notice", { level: "error", message: rec.error || `pi rejected "${rec.command}"` });
			}
			return;
		}
		if (rec.type === "extension_ui_request") {
			applyUiRequest(this.live, rec);
			this.emit("ui", rec);
			return;
		}
		if (rec.type === "extension_error") {
			this.emit("notice", { level: "error", message: `Extension error in ${rec.event}: ${rec.error}`, detail: rec.extensionPath });
			return;
		}
		applyEvent(this.live, rec);
		this.emit("event", rec);
		if (rec.type === "agent_settled") this.afterSettled();
	}

	async afterSettled() {
		try {
			await this.refreshState();
			this.stats = await this.request({ type: "get_session_stats" });
			this.emit("state");
		} catch {
			// the process may be shutting down
		}
	}

	async refreshState(timeout = TIMEOUTS.get_state) {
		const s = await this.request({ type: "get_state" }, timeout);
		const previousId = this.sessionId;
		this.sessionId = s.sessionId;
		this.sessionFile = s.sessionFile ?? this.sessionFile;
		this.sessionName = s.sessionName;
		this.thinkingLevel = s.thinkingLevel;
		this.autoCompaction = s.autoCompactionEnabled;
		this.model = s.model
			? {
					provider: s.model.provider,
					id: s.model.id,
					name: s.model.name,
					reasoning: s.model.reasoning,
					input: s.model.input,
					contextWindow: s.model.contextWindow,
				}
			: undefined;
		if (previousId && previousId !== this.sessionId) this.emit("moved", previousId);
		this.emit("state");
		return s;
	}

	request(command, timeout = TIMEOUTS[command.type] ?? 30_000) {
		if (this.state === "exited") return Promise.reject(new Error("pi is not running"));
		const id = `web-${++this.seq}`;
		return new Promise((resolve, reject) => {
			const timer = timeout
				? setTimeout(() => {
						this.pending.delete(id);
						reject(new Error(`pi did not answer "${command.type}" in time`));
					}, timeout)
				: undefined;
			this.pending.set(id, { resolve, reject, timer });
			if (!this.write({ ...command, id })) {
				this.pending.delete(id);
				clearTimeout(timer);
				reject(new Error(this.bridgeDownMessage || "pi is not attached (its runner is reconnecting) — try again in a moment"));
			}
		});
	}

	write(record) {
		if (this.state === "exited") return false;
		if (this.bridge.sendWrapper(this.key, { t: "stdin", line: `${JSON.stringify(record)}\n` })) {
			this.bridgeDownMessage = null;
			return true;
		}
		// Runner socket down (server restarting, reconnect backoff): hold the
		// command — it flushes the moment the runner says hello again.
		if (this.outbox.length < 200) {
			this.outbox.push(`${JSON.stringify(record)}\n`);
			this.bridgeDownMessage = "pi is not attached (its runner is reconnecting) — try again in a moment";
			return true;
		}
		this.bridgeDownMessage = "pi is not attached (its runner is gone)";
		return false;
	}

	onExit(code, signal, error) {
		if (this.state === "exited") return;
		this.state = "exited";
		clearTimeout(this.lostTimer);
		try {
			this.bridge.removeListener("message", this.onBridgeMessage);
			this.bridge.removeListener("wrapper", this.onWrapperConnect);
			this.bridge.removeListener("wrapper_disconnect", this.onWrapperLost);
		} catch {
			// bridge gone (server shutting down)
		}
		this.exit = { code, signal, error: error ? String(error.message || error) : undefined, stderr: this.stderr.slice(-40) };
		for (const waiting of this.pending.values()) {
			clearTimeout(waiting.timer);
			waiting.reject(new Error(this.exit.error || `pi exited${code != null ? ` with code ${code}` : ""}`));
		}
		this.pending.clear();
		this.live = createLive();
		this.emit("exit", this.exit);
	}

	stop() {
		if (this.state === "exited" || this.state === "stopping") return;
		this.state = "stopping";
		this.emit("state");
		this.bridge.sendWrapper(this.key, { t: "stop" });
		// The runner escalates on its own (SIGTERM at 4s, SIGKILL at 9s).
	}

	kill() {
		this.bridge.sendWrapper(this.key, { t: "kill" });
	}

	info() {
		return {
			state: this.state,
			pid: this.pid,
			busy: this.live.busy,
			sessionId: this.sessionId,
			sessionFile: this.sessionFile,
			sessionName: this.sessionName,
			model: this.model,
			thinkingLevel: this.thinkingLevel,
			stats: this.stats,
			startedAt: this.startedAt,
			bridge: !!this.bridgeConnected,
			adopted: this.adopted,
			exit: this.exit,
		};
	}
}
