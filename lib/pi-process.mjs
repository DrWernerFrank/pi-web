// One `pi --mode rpc` child process driving one session.

import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import { applyEvent, applyUiRequest, createLive } from "../public/js/live.js";

const STDERR_LINES = 200;

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
	constructor({ config, cwd, sessionFile, bridgeSock, bridgeExt }) {
		super();
		this.config = config;
		this.cwd = cwd;
		this.sessionFile = sessionFile;
		this.bridgeSock = bridgeSock;
		this.bridgeExt = bridgeExt;
		this.key = crypto.randomBytes(12).toString("hex");
		this.live = createLive();
		this.state = "starting";
		this.pending = new Map();
		this.seq = 0;
		this.stderr = [];
		this.startedAt = Date.now();
		this.lastActivity = Date.now();
	}

	start() {
		const args = ["--mode", "rpc"];
		if (this.sessionFile) args.push("--session", this.sessionFile);
		if (this.config.sessionDirArg) args.push("--session-dir", this.config.sessionDirArg);
		if (this.bridgeExt) args.push("--extension", this.bridgeExt);
		args.push(...this.config.extraPiArgs);
		const env = { ...this.config.env, PI_WEB_KEY: this.key, PI_WEB_BRIDGE_SOCK: this.bridgeSock || "" };

		this.child = spawn(this.config.piBin, args, { cwd: this.cwd, env, stdio: ["pipe", "pipe", "pipe"] });
		this.pid = this.child.pid;

		// Strict JSONL: split on LF only (U+2028/U+2029 may appear inside JSON strings).
		let parts = [];
		this.child.stdout.on("data", (chunk) => {
			let start = 0;
			for (;;) {
				const nl = chunk.indexOf(10, start);
				if (nl < 0) {
					if (start < chunk.length) parts.push(chunk.subarray(start));
					break;
				}
				parts.push(chunk.subarray(start, nl));
				let line = parts.length === 1 ? parts[0] : Buffer.concat(parts);
				parts = [];
				start = nl + 1;
				if (line.length && line[line.length - 1] === 13) line = line.subarray(0, -1);
				if (line.length) this.handleLine(line);
			}
		});
		this.child.stderr.setEncoding("utf8");
		this.child.stderr.on("data", (text) => {
			for (const line of text.split("\n")) if (line.trim()) this.logErr(line);
		});
		this.child.stdin.on("error", () => {});
		this.child.on("error", (err) => this.onExit(null, null, err));
		this.child.on("exit", (code, signal) => this.onExit(code, signal));

		this.ready = this.refreshState(90_000).then(() => {
			if (this.state === "starting") this.state = "ready";
			this.emit("state");
			return this;
		});
		this.ready.catch(() => {});
		return this.ready;
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
		if (this.state === "exited" || !this.child) return Promise.reject(new Error("pi is not running"));
		const id = `web-${++this.seq}`;
		return new Promise((resolve, reject) => {
			const timer = timeout
				? setTimeout(() => {
						this.pending.delete(id);
						reject(new Error(`pi did not answer "${command.type}" in time`));
					}, timeout)
				: undefined;
			this.pending.set(id, { resolve, reject, timer });
			this.write({ ...command, id });
		});
	}

	write(record) {
		if (!this.child || this.state === "exited") return false;
		this.child.stdin.write(`${JSON.stringify(record)}\n`);
		return true;
	}

	onExit(code, signal, error) {
		if (this.state === "exited") return;
		this.state = "exited";
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
		if (!this.child || this.state === "exited") return;
		this.state = "stopping";
		this.emit("state");
		try {
			this.child.stdin.end();
		} catch {
			// already closed
		}
		const kill = (sig) => {
			if (this.state !== "exited") {
				try {
					this.child.kill(sig);
				} catch {
					// gone
				}
			}
		};
		setTimeout(() => kill("SIGTERM"), 4000).unref();
		setTimeout(() => kill("SIGKILL"), 9000).unref();
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
			exit: this.exit,
		};
	}
}
