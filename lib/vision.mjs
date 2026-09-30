// Claude Sonnet vision for pi-web: read any image (describe it, transcribe its
// text) by asking Claude Code — the same login and subscription quota that
// runs the claude-bridge models. No API key, no extra login.
//
// Images on /mnt/c can be permission-blocked for Claude Code, so every image
// is staged into a fixed folder under /tmp first (proven readable), and the
// prompt sends the staged path.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

const DEFAULT_MODEL = process.env.PI_WEB_VISION_MODEL || "claude-sonnet-5-5";
const CLAUDE_BIN = process.env.PI_WEB_CLAUDE_BIN || path.join(os.homedir(), ".local", "bin", "claude");
const MAX_BYTES = 14 * 1024 * 1024;
const STAGE_DIR = path.join(os.tmpdir(), "pi-web-vision");
const EXT_FOR = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };

function claudeAvailable() {
	try {
		return fs.existsSync(CLAUDE_BIN) || process.env.PI_WEB_CLAUDE_BIN !== undefined;
	} catch {
		return false;
	}
}

/** Stage an image where Claude Code can read it; resolves the staged path. */
function stage(image, mime) {
	const bytes = Buffer.isBuffer(image) ? image : Buffer.from(image);
	if (!bytes.length) throw new Error("the image is empty");
	if (bytes.length > MAX_BYTES) throw new Error(`the image is ${(bytes.length / 1048576).toFixed(1)} MB; the limit is 14 MB`);
	const ext = EXT_FOR[mime] || "png";
	fs.mkdirSync(STAGE_DIR, { recursive: true });
	const file = path.join(STAGE_DIR, `img-${randomUUID().slice(0, 8)}.${ext}`);
	fs.writeFileSync(file, bytes);
	return file;
}

/** Run claude CLI in print mode; resolves its stdout text. */
function askClaude(prompt, model, timeoutMs) {
	return new Promise((resolve, reject) => {
		const child = spawn(CLAUDE_BIN, ["--model", model, "--print", prompt], { cwd: STAGE_DIR, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
		let out = "";
		let err = "";
		const timer = setTimeout(() => {
			try {
				child.kill("SIGKILL");
			} catch {
				/* already gone */
			}
			reject(new Error(`Claude did not answer within ${Math.round(timeoutMs / 1000)}s`));
		}, timeoutMs);
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (c) => (out += c));
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (c) => (err += c));
		child.on("error", (e) => {
			clearTimeout(timer);
			reject(new Error(`Claude Code could not be started (${e.message}) — is ${CLAUDE_BIN} installed?`));
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			const text = out.trim();
			if (text) return resolve(text);
			reject(new Error(`Claude Code exited${code != null ? ` (code ${code})` : ""}${err.trim() ? `: ${err.trim().slice(0, 200)}` : " with no output"}`));
		});
	});
}

export function visionStatus() {
	return { available: claudeAvailable(), model: DEFAULT_MODEL };
}

/** Image bytes (or nothing, with `file` given) → { text, model }. `file` is an
 *  already-staged readable path (the read_image tool passes one). */
export async function readImage({ image, file, mimeType = "image/png", prompt, model, timeoutMs = 180_000 } = {}) {
	if (!claudeAvailable()) throw new Error(`Claude Code was not found at ${CLAUDE_BIN} — vision reading needs it`);
	const m = String(model || DEFAULT_MODEL);
	let staged = null;
	let target = file || null;
	try {
		if (!target && image != null) {
			staged = stage(image, mimeType);
			target = staged;
		}
		if (!target || !fs.existsSync(target)) throw new Error("nothing to read: no image");
		const question = String(prompt || "").trim() || "Read this image: transcribe any text it contains, then describe what it shows.";
		const full = `${question}\n\nThe image is at this absolute path: ${target}\nRead that image file first — it is the subject of this task. Answer only about what you SEE in it.`;
		const text = await askClaude(full, m, timeoutMs);
		return { text, model: `Claude Sonnet 5.5` };
	} finally {
		if (staged) {
			try {
				fs.unlinkSync(staged);
			} catch {
				/* already gone */
			}
		}
	}
}
