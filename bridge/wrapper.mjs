// One detached runner per pi process pi-web drives.
//
// Why: pi's RPC mode speaks on its stdin/stdout pipes. When the pi-web server
// dies, those pipes die with it — and pi aborts the run it was streaming (an
// EPIPE on its event stream is fatal to the task). So the server no longer
// holds the pipes: this wrapper does. It is spawned detached, it holds pi's
// stdio, and it shuttles commands and events over the bridge socket instead —
// a socket that reconnects. A server restart (crash, update, OOM kill) then
// costs nothing: the wrapper and its pi keep working, the reply keeps landing
// in the session file, and when the new server comes up the wrapper re-attaches
// with full control (steering, aborts, model picks — everything stdin could do).
//
// Protocol (newline-delimited JSON on the bridge socket):
//   → {t:"hello", wrapper:true, key, pid, sessionFile}     on connect
//   → {t:"rpc", line}                                      pi stdout, forwarded
//   → {t:"stderr", line}                                   pi stderr, forwarded
//   → {t:"exit", code, signal}                             pi exited
//   ← {t:"stdin", line}                                    a command for pi's stdin
//   ← {t:"stop"}                                           graceful stop (EOF, then signals)
//   ← {t:"kill"}                                           immediate SIGTERM→SIGKILL

import * as net from "node:net";
import { spawn } from "node:child_process";

const [sockPath, key, piBin, ...piArgs] = process.argv.slice(2);
if (!sockPath || !key || !piBin) {
	console.error("usage: wrapper.mjs <sockPath> <key> <piBin> [pi args…]");
	process.exit(2);
}

const sessionFile = (() => {
	const i = piArgs.indexOf("--session");
	return i >= 0 ? piArgs[i + 1] : undefined;
})();

// The pi-internal bridge extension (quiz pop-ups) shares the socket and the
// key; the server tells the two hellos apart by `wrapper: true`.
const child = spawn(piBin, piArgs, { stdio: ["pipe", "pipe", "pipe"] });
const pid = child.pid;

let sock = null;
let buffer = "";
let connectFails = 0;
let reconnectTimer = null;
let lastRpc = Date.now(); // pi stdout activity (an idle pi is safe to retire)
let stopped = false;

const send = (msg) => {
	if (sock && !sock.destroyed) sock.write(`${JSON.stringify(msg)}\n`);
};

const connect = () => {
	const s = net.createConnection(sockPath);
	s.setEncoding("utf8");
	s.on("connect", () => {
		sock = s;
		connectFails = 0;
		// "recent rpc activity" lets the server tell a mid-run pi from an idle
		// one right after a restart (before any event can arrive).
		send({ t: "hello", wrapper: true, key, pid, sessionFile, busy: Date.now() - lastRpc < 15000 });
	});
	s.on("data", (chunk) => {
		buffer += chunk;
		let nl;
		while ((nl = buffer.indexOf("\n")) >= 0) {
			const line = buffer.slice(0, nl);
			buffer = buffer.slice(nl + 1);
			if (!line.trim()) continue;
			try {
				onMessage(JSON.parse(line));
			} catch {
				// malformed line: ignore
			}
		}
	});
	s.on("error", () => {});
	s.on("close", () => {
		if (sock === s) sock = null;
		scheduleReconnect();
	});
	s.unref();
};

const scheduleReconnect = () => {
	if (reconnectTimer || stopped) return;
	const delay = Math.min(5000, 250 * 2 ** Math.min(connectFails++, 4));
	reconnectTimer = setTimeout(() => {
		reconnectTimer = null;
		connect();
	}, delay);
	reconnectTimer.unref?.();
};

const stopPi = (graceful) => {
	if (stopped) return;
	stopped = true;
	try {
		if (graceful) child.stdin.end();
	} catch {
		// already closed
	}
	const kill = (sig, ms) =>
		setTimeout(() => {
			try {
				child.kill(sig);
			} catch {
				// gone
			}
		}, ms).unref?.();
	if (graceful) {
		kill("SIGTERM", 4000);
		kill("SIGKILL", 9000);
	} else {
		kill("SIGTERM", 0);
		kill("SIGKILL", 5000);
	}
};

const onMessage = (msg) => {
	switch (msg?.t) {
		case "stdin":
			lastRpc = Date.now();
			try {
				child.stdin.write(msg.line);
			} catch {
				// pi gone; its exit event says so
			}
			break;
		case "stop":
			stopPi(true);
			break;
		case "kill":
			stopPi(false);
			break;
	}
};

child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
	lastRpc = Date.now();
	// Forward whole lines only, like the server did: RPC records are
	// newline-delimited and a record must not be split across messages.
	let start = 0;
	for (;;) {
		const nl = chunk.indexOf("\n", start);
		if (nl < 0) {
			if (start < chunk.length) tail += chunk.slice(start);
			break;
		}
		send({ t: "rpc", line: tail + chunk.slice(start, nl + 1) });
		tail = "";
		start = nl + 1;
	}
});
let tail = "";
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => {
	for (const line of chunk.split("\n")) if (line.trim()) send({ t: "stderr", line });
});
child.stdin.on("error", () => {});
child.on("exit", (code, signal) => {
	stopped = true;
	send({ t: "exit", code, signal });
	setTimeout(() => process.exit(0), 250).unref?.();
});
// The wrapper dies with the pi if pi is killed hard (defensive; not expected).
process.on("SIGTERM", () => stopPi(true));

// Server gone for good ("pi-web stop") + pi idle: retire instead of leaking.
// A busy pi keeps working as long as it takes — no server needed to finish.
setInterval(() => {
	if (sock || stopped) return;
	if (Date.now() - lastRpc > 10 * 60_000) stopPi(true);
}, 30_000).unref();

connect();
