// Runtime configuration: CLI flags, the environment pi children should get,
// where pi lives, and where its sessions are stored.

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const DEFAULT_PORT = 3141;

export function parseArgs(argv) {
	const out = {};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		const [flag, inline] = a.startsWith("--") && a.includes("=") ? [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)] : [a, undefined];
		const value = () => (inline !== undefined ? inline : argv[++i]);
		switch (flag) {
			case "--port":
			case "-p":
				out.port = Number(value());
				break;
			case "--host":
				out.host = value();
				break;
			case "--sessions":
				out.sessions = value();
				break;
			case "--pi":
				out.pi = value();
				break;
			case "--help":
			case "-h":
				out.help = true;
				break;
			default:
				throw new Error(`Unknown option: ${a}`);
		}
	}
	return out;
}

export function expandHome(p) {
	if (!p) return p;
	if (p === "~") return os.homedir();
	if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
	return p;
}

/**
 * The environment of an interactive login shell. pi is usually put on PATH, and
 * its API keys exported, from ~/.bashrc, which a server started from a script
 * or from Windows never sources. Children get this environment so they behave
 * exactly like the pi the user starts in a terminal.
 */
export function captureShellEnv() {
	const base = { ...process.env };
	if (process.platform === "win32" || process.env.PI_WEB_NO_ENV_CAPTURE === "1") return base;
	const shell = process.env.SHELL && /(bash|zsh)$/.test(process.env.SHELL) ? process.env.SHELL : "/bin/bash";
	const marker = "__PI_WEB_ENV_BEGIN__";
	const result = spawnSync(shell, ["-i", "-c", `printf '\\n${marker}\\n'; env -0`], {
		stdio: ["ignore", "pipe", "ignore"],
		timeout: 15000,
		env: base,
	});
	const out = result.stdout;
	if (!out || result.error) return base;
	const at = out.indexOf(Buffer.from(`\n${marker}\n`));
	if (at < 0) return base;
	const env = {};
	for (const pair of out.subarray(at + marker.length + 2).toString("utf8").split("\0")) {
		const eq = pair.indexOf("=");
		if (eq > 0) env[pair.slice(0, eq)] = pair.slice(eq + 1);
	}
	if (!env.PATH) return base;
	// tmux variables must describe where THIS server runs, whatever .bashrc did.
	for (const key of ["TMUX", "TMUX_PANE"]) {
		if (process.env[key]) env[key] = process.env[key];
		else delete env[key];
	}
	return env;
}

export function which(name, pathVar) {
	for (const dir of (pathVar || "").split(path.delimiter)) {
		if (!dir) continue;
		const candidate = path.join(dir, name);
		try {
			fs.accessSync(candidate, fs.constants.X_OK);
			if (fs.statSync(candidate).isFile()) return candidate;
		} catch {
			// not here
		}
	}
	return undefined;
}

function readJson(file) {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8"));
	} catch {
		return undefined;
	}
}

export function loadConfig(argv) {
	const args = parseArgs(argv);
	const env = captureShellEnv();
	const home = os.homedir();

	const agentDir = expandHome(env.PI_CODING_AGENT_DIR) || path.join(home, ".pi", "agent");
	const settings = readJson(path.join(agentDir, "settings.json")) || {};
	const explicitSessions = args.sessions || process.env.PI_WEB_SESSIONS_DIR;
	const sessionsDir = path.resolve(
		expandHome(explicitSessions || env.PI_CODING_AGENT_SESSION_DIR || settings.sessionDir) || path.join(agentDir, "sessions"),
	);

	const piBin = expandHome(args.pi || process.env.PI_WEB_PI) || which("pi", env.PATH);
	if (piBin) {
		// `pi` is a `#!/usr/bin/env node` script: make sure the node next to it wins.
		env.PATH = [path.dirname(piBin), env.PATH].filter(Boolean).join(path.delimiter);
	}

	// Folders searched when a message embeds an image by bare filename, the way
	// Obsidian resolves ![[viz-foo.png|500]] anywhere in the vault.
	const assetDirs = [];
	const addAssetDir = (dir) => {
		if (!dir) return;
		const resolved = path.resolve(expandHome(dir));
		if (!assetDirs.includes(resolved)) assetDirs.push(resolved);
	};
	for (const dir of (process.env.PI_WEB_ASSET_DIRS || "").split(path.delimiter)) addAssetDir(dir);
	if (env.PI_VIZ_DIR) {
		addAssetDir(env.PI_VIZ_DIR);
		addAssetDir(path.dirname(path.resolve(expandHome(env.PI_VIZ_DIR))));
	}
	if (env.PI_KNOWLEDGE_DIR) addAssetDir(path.dirname(path.resolve(expandHome(env.PI_KNOWLEDGE_DIR))));

	const extraPiArgs = (process.env.PI_WEB_PI_ARGS || "").split(/\s+/).filter(Boolean);

	return {
		port: args.port || Number(process.env.PI_WEB_PORT) || DEFAULT_PORT,
		host: args.host || process.env.PI_WEB_HOST || "127.0.0.1",
		help: args.help,
		agentDir,
		sessionsDir,
		// Only pass --session-dir to pi when the user moved sessions away from pi's own default.
		sessionDirArg: explicitSessions ? sessionsDir : undefined,
		piBin,
		env,
		assetDirs,
		extraPiArgs,
		token: crypto.randomBytes(24).toString("hex"),
		root: path.dirname(path.dirname(fileURLToPath(import.meta.url))),
	};
}
