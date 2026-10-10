// A private Unix socket that the pi-web-bridge extension (loaded into every
// pi child) connects to. It carries what pi's RPC protocol cannot: custom
// terminal pop-ups such as the quiz and ask_user_question tools.

import { EventEmitter } from "node:events";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

export class Bridge extends EventEmitter {
	constructor(sockPath) {
		super();
		this.sockPath = sockPath;
		this.conns = new Map(); // process key -> socket (the pi-internal bridge)
		this.wrappers = new Map(); // process key -> socket (the detached runners)
	}

	async listen() {
		const dir = path.dirname(this.sockPath);
		fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
		fs.chmodSync(dir, 0o700);
		try {
			fs.unlinkSync(this.sockPath);
		} catch {
			// no stale socket
		}
		this.server = net.createServer((sock) => this.accept(sock));
		await new Promise((resolve, reject) => {
			this.server.once("error", reject);
			this.server.listen(this.sockPath, resolve);
		});
		fs.chmodSync(this.sockPath, 0o600);
	}

	accept(sock) {
		let key;
		let wrapper = false;
		let parts = [];
		sock.on("data", (chunk) => {
			let start = 0;
			for (;;) {
				const nl = chunk.indexOf(10, start);
				if (nl < 0) {
					if (start < chunk.length) parts.push(chunk.subarray(start));
					break;
				}
				parts.push(chunk.subarray(start, nl));
				const line = (parts.length === 1 ? parts[0] : Buffer.concat(parts)).toString("utf8");
				parts = [];
				start = nl + 1;
				let msg;
				try {
					msg = JSON.parse(line);
				} catch {
					continue;
				}
				if (!key) {
					if (msg.t === "hello" && typeof msg.key === "string") {
						key = msg.key;
						// A detached runner (bridge/wrapper.mjs) holds the pi's stdio and
						// speaks on its own socket: same key, its own lane — the quiz
						// bridge inside pi and the runner must not clobber each other.
					wrapper = !!msg.wrapper;
						const map = wrapper ? this.wrappers : this.conns;
						map.get(key)?.destroy();
						map.set(key, sock);
						this.emit(wrapper ? "wrapper" : "connect", key, msg);
					} else {
						sock.destroy();
						return;
					}
					continue;
				}
				this.emit("message", key, msg, wrapper);
			}
		});
		sock.on("error", () => {});
		sock.on("close", () => {
			const map = wrapper ? this.wrappers : this.conns;
			if (key && map.get(key) === sock) {
				map.delete(key);
				this.emit(wrapper ? "wrapper_disconnect" : "disconnect", key);
			}
		});
	}

	send(key, msg) {
		const sock = this.conns.get(key);
		if (!sock || sock.destroyed) return false;
		sock.write(`${JSON.stringify(msg)}\n`);
		return true;
	}

	/** To a detached runner (the process holding a pi's stdio). */
	sendWrapper(key, msg) {
		const sock = this.wrappers.get(key);
		if (!sock || sock.destroyed) return false;
		sock.write(`${JSON.stringify(msg)}\n`);
		return true;
	}

	wrapperAlive(key) {
		const sock = this.wrappers.get(key);
		return !!sock && !sock.destroyed;
	}

	close() {
		for (const sock of [...this.conns.values(), ...this.wrappers.values()]) sock.destroy();
		this.server?.close();
		try {
			fs.unlinkSync(this.sockPath);
		} catch {
			// already gone
		}
	}
}
