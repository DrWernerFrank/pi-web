// Gemini in pi-web: read any image in a session (describe it, transcribe its
// text) using the same auth the studio uses:
//   1. your Google account (Google AI Pro / Code Assist subscription) — the
//      login shared with the `gemini` CLI (~/.gemini/oauth_creds.json, WSL and
//      Windows side), refreshed here, no API key needed;
//   2. GEMINI_API_KEY / GOOGLE_API_KEY as a fallback.
// Server-side only: tokens never reach the browser.
//
// Adapted from the studio's gemini-auth.mjs / gemini.mjs.

import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes, createHash } from "node:crypto";

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const EP = "https://cloudcode-pa.googleapis.com";
const REDIRECT_URI = "http://localhost:8085/oauth2callback";
const SCOPES = [
	"https://www.googleapis.com/auth/cloud-platform",
	"https://www.googleapis.com/auth/generative-language", // consumer Gemini API (AI Pro quota)
	"https://www.googleapis.com/auth/userinfo.email",
	"https://www.googleapis.com/auth/userinfo.profile",
].join(" ");
// The Gemini CLI's public embedded OAuth client (the same one the CLI and the
// studio use; base64 is the upstream obfuscation, not a secret).
const CLIENT_ID = Buffer.from("NjgxMjU1ODA5Mzk1LW9vOGZ0Mm9wcmRybnA5ZTNhcWY2" + "YXYzaG1kaWIxMzVqLmFwcHMuZ29vZ2xldXNlcmNvbnRlbnQuY29t", "base64").toString();
const CLIENT_SECRET = Buffer.from("R09DU1BYLTR1SGdNUG0tMW83" + "U2stZ2VWNkN1NWNsWEZzeGw=", "base64").toString();
const HEADERS = {
	"Content-Type": "application/json",
	"User-Agent": "google-cloud-sdk vscode_cloudshelleditor/0.1",
	"X-Goog-Api-Client": "gl-node/22.17.0",
	"Client-Metadata": JSON.stringify({ ideType: "IDE_UNSPECIFIED", platform: "PLATFORM_UNSPECIFIED", pluginType: "GEMINI" }),
};
export const GEMINI_DEFAULT_MODEL = "gemini-2.5-flash";

// Set by server.mjs: the interactive-shell environment (API keys from
// ~/.bashrc) and pi-web's folder (a .env there works too).
let settings = { env: process.env, root: null };
export function configureGemini({ env, root }) {
	settings = { env: env || process.env, root: root || null };
}

function envKey(name) {
	if (settings.env?.[name]) return settings.env[name];
	if (process.env[name]) return process.env[name];
	// .env in the pi-web folder (studio-style)
	if (settings.root) {
		try {
			for (const line of readFileSync(join(settings.root, ".env"), "utf8").split("\n")) {
				const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
				if (m && m[1] === name) return m[2].replace(/^["']|["']$/g, "");
			}
		} catch {
			/* no .env */
		}
	}
	return undefined;
}

// ── credentials: wherever a Gemini CLI login lives ─────────────────────────
export function credsPaths() {
	const out = [];
	for (const p of [settings.env?.GEMINI_OAUTH_CREDS, process.env.GEMINI_OAUTH_CREDS]) if (p) out.push(p);
	out.push(join(homedir(), ".gemini", "oauth_creds.json")); // WSL CLI / our login
	try {
		for (const u of readdirSync("/mnt/c/Users")) {
			if (u === "Public") continue;
			const p = `/mnt/c/Users/${u}/.gemini/oauth_creds.json`;
			if (existsSync(p)) out.push(p); // a Windows-side CLI login
		}
	} catch {
		/* not WSL */
	}
	return [...new Set(out.filter((p) => existsSync(p)))];
}

function readCreds() {
	for (const p of credsPaths()) {
		try {
			const j = JSON.parse(readFileSync(p, "utf8"));
			if (j.access_token || j.refresh_token) return { path: p, j };
		} catch {
			/* skip unreadable */
		}
	}
	return null;
}
const writeCreds = (file, j) => {
	try {
		writeFileSync(file, JSON.stringify(j, null, 2));
	} catch {
		/* read-only Windows side: fine */
	}
};

async function refreshAccessToken(path, j) {
	if (!j.refresh_token) throw new Error("login expired: log in to Gemini again (⋯ menu → Log in to Gemini)");
	const res = await fetch(TOKEN_URL, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, refresh_token: j.refresh_token, grant_type: "refresh_token" }),
	}).catch(() => {
		throw new Error("token refresh network error");
	});
	if (!res.ok) throw new Error(`login expired (refresh ${res.status}): log in to Gemini again (⋯ menu → Log in to Gemini)`);
	const d = await res.json();
	j.access_token = d.access_token;
	if (d.refresh_token) j.refresh_token = d.refresh_token;
	if (d.expires_in) j.expiry_date = Date.now() + (d.expires_in - 240) * 1000;
	writeCreds(path, j);
	return j.access_token;
}

/** A usable subscription token, or null. Throws on a login that expired. */
export async function getSubscriptionToken() {
	const c = readCreds();
	if (!c) return null;
	const fresh = c.j.expiry_date && c.j.expiry_date > Date.now() ? c.j.access_token : await refreshAccessToken(c.path, c.j);
	if (!fresh) return null;
	if (String(c.j.scope || "").includes("generative-language")) return { token: fresh, projectId: "", path: c.path, genai: true };
	let projectId = c.j.project_id || settings.env?.GOOGLE_CLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || "";
	if (!projectId) {
		// a CLI login (cloud-platform only): Code Assist needs a project
		try {
			projectId = await discoverProject(fresh);
			c.j.project_id = projectId;
			writeCreds(c.path, c.j);
		} catch (e) {
			return { token: fresh, projectId: "", path: c.path, genai: false, needsLogin: true, why: String(e.message || e) };
		}
	}
	return { token: fresh, projectId, path: c.path, genai: false };
}

/** Light status for the UI: no network, no refresh. */
export function geminiStatus() {
	const c = readCreds();
	const key = envKey("GEMINI_API_KEY") || envKey("GOOGLE_API_KEY");
	// Which login is this? A pi-web login (or a full CLI login) carries the
	// consumer generative-language scope and works directly. A bare CLI login
	// (cloud-platform only) needs a Code Assist project on the account —
	// without one it can read nothing, and must not be reported as ready.
	const scope = String(c?.j?.scope || "");
	const consumer = scope.includes("generative-language");
	const projectId = c?.j?.project_id || "";
	const usable = consumer || !!projectId || !!key;
	return {
		auth: usable ? (c ? "subscription" : "api-key") : c ? "login-only" : key ? "api-key" : "none",
		loginPath: c?.path || null,
		// true when this login can actually read images
		usable,
		consumer,
		apiKey: !!key,
		model: envKey("GEMINI_MODEL") || GEMINI_DEFAULT_MODEL,
		login: loginState,
	};
}

// ── project discovery (Code Assist needs a cloudaicompanion project) ───────
async function discoverProject(token) {
	const post = (method, body) => fetch(`${EP}/v1internal:${method}`, { method: "POST", headers: { ...HEADERS, Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
	const meta = { ideType: "IDE_UNSPECIFIED", platform: "PLATFORM_UNSPECIFIED", pluginType: "GEMINI" };
	const envProjectId = settings.env?.GOOGLE_CLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT_ID;
	const load = await post("loadCodeAssist", { cloudaicompanionProject: envProjectId, metadata: meta });
	const loadBody = load.ok ? await load.json().catch(() => null) : null;
	const existing = loadBody?.cloudaicompanionProject || loadBody?.currentCloudaicompanionProject;
	if (existing) return existing;
	// tier comes from the account's allowedTiers (Google AI Pro / Code Assist: standard-tier)
	const def = loadBody?.allowedTiers?.find((t) => t.isDefault && t.id);
	const tierId = def?.id || "free-tier";
	const ob = await post("onboardUser", { tierId, metadata: meta, ...(envProjectId ? { cloudaicompanionProject: envProjectId, metadata: { ...meta, duetProject: envProjectId } } : {}) });
	if (!ob.ok) throw new Error(`onboardUser ${ob.status}: ${(await ob.text().catch(() => "")).slice(0, 200)}`);
	const op = await ob.json();
	const done = await (op.done
		? Promise.resolve(op)
		: new Promise((ok, fail) => {
				const t = setTimeout(() => fail(new Error("onboarding timed out")), 60_000);
				const poll = async () => {
					const r = await fetch(`${EP}${op.name}`, { headers: { Authorization: `Bearer ${token}` } });
					const j = await r.json().catch(() => ({}));
					if (j.done) {
						clearTimeout(t);
						ok(j);
					} else setTimeout(poll, 1500);
				};
				poll();
			}));
	const id = done?.result?.cloudaicompanionProject || done?.result?.project?.id || "";
	if (!id) throw new Error("could not discover a Code Assist project — set GOOGLE_CLOUD_PROJECT or run `gemini` once interactively");
	return id;
}

// ── login: browser PKCE → ~/.gemini/oauth_creds.json (shared with `gemini`) ─
let loginState = { pending: false, url: null, error: null, done: false, result: null };

/** Start (or join) a browser login. Returns the current state; the URL
 *  appears once the callback server on :8085 is listening. */
export async function startGeminiLogin() {
	if (loginState.pending) return loginState;
	loginState = { pending: true, url: null, error: null, done: false, result: null };
	const settle = (patch) => {
		loginState = { ...loginState, ...patch, pending: false };
	};
	loginGemini({ onUrl: (url) => (loginState.url = url) })
		.then((result) => settle({ done: true, result }))
		.catch((error) => settle({ error: String(error.message || error) }));
	// The callback server must be listening before the browser is sent to Google.
	for (let i = 0; i < 30 && !loginState.url; i++) await new Promise((r) => setTimeout(r, 100));
	return loginState;
}

async function loginGemini({ onUrl } = {}) {
	const state = randomBytes(16).toString("hex");
	const verifier = randomBytes(48).toString("base64url");
	const challenge = createHash("sha256").update(verifier).digest("base64url");
	const url = `${AUTH_URL}?${new URLSearchParams({
		client_id: CLIENT_ID,
		redirect_uri: REDIRECT_URI,
		response_type: "code",
		scope: SCOPES,
		access_type: "offline",
		prompt: "consent",
		include_granted_scopes: "true",
		state,
		code_challenge: challenge,
		code_challenge_method: "S256",
	})}`;

	const code = await new Promise((ok, fail) => {
		let done = false;
		let timer = null;
		const srv = createServer((req, res) => {
			const u = new URL(req.url || "/", "http://localhost:8085");
			if (u.pathname !== "/oauth2callback") return;
			if (u.searchParams.get("state") !== state) {
				res.writeHead(400, { "content-type": "text/html" });
				res.end("<h3>state mismatch — start the login again</h3>");
				return finish(fail, new Error("OAuth state mismatch"));
			}
			res.writeHead(200, { "content-type": "text/html" });
			res.end("<h3>pi-web: Gemini login OK — you can close this tab and go back to pi-web.</h3>");
			finish(ok, u.searchParams.get("code"));
		});
		const finish = (fn, arg) => {
			if (!done) {
				done = true;
				if (timer) clearTimeout(timer);
				srv.close();
				try {
					fn(arg);
				} catch {
					/* already settled */
				}
			}
		};
		srv.on("error", (e) => finish(fail, new Error(`callback server on :8085 failed (${e.code}) — another login in progress?`)));
		timer = setTimeout(() => finish(fail, new Error("login timed out after 5 minutes — try again")), 300_000);
		srv.listen(8085, "127.0.0.1", () => onUrl?.(url));
	});

	const tr = await fetch(TOKEN_URL, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, code, grant_type: "authorization_code", redirect_uri: REDIRECT_URI, code_verifier: verifier }),
	});
	if (!tr.ok) throw new Error(`token exchange ${tr.status}: ${(await tr.text().catch(() => "")).slice(0, 200)}`);
	const t = await tr.json();

	let projectId = "";
	try {
		projectId = await discoverProject(t.access_token);
	} catch {
		/* fine: the consumer Gemini API needs no project */
	}
	const dir = join(homedir(), ".gemini");
	mkdirSync(dir, { recursive: true });
	const file = join(dir, "oauth_creds.json");
	writeFileSync(file, JSON.stringify({
		access_token: t.access_token,
		refresh_token: t.refresh_token,
		token_type: "Bearer",
		scope: t.scope,
		id_token: t.id_token,
		expiry_date: Date.now() + ((t.expires_in || 3600) - 240) * 1000,
		project_id: projectId,
	}, null, 2));
	return { file, projectId, refresh: !!t.refresh_token };
}

// ── image reading ────────────────────────────────────────────────────────────
const DEFAULT_PROMPT = "Read this image: transcribe any text it contains, then describe what it shows.";

/** Code Assist (Cloud Code Assist backend, SSE) — a CLI login without the
 *  consumer generative-language scope. */
async function codeAssistRead({ token, projectId, image, prompt, model, timeoutMs, mimeType = "image/png" }) {
	if (!projectId) throw new Error("this Gemini login has no Code Assist project — log in again (⋯ menu → Log in to Gemini)");
	const res = await fetch(`${EP}/v1internal:streamGenerateContent?alt=sse`, {
		method: "POST",
		headers: { ...HEADERS, Authorization: `Bearer ${token}`, Accept: "text/event-stream" },
		signal: AbortSignal.timeout(timeoutMs),
		body: JSON.stringify({
			project: projectId,
			model,
			request: {
				contents: [{ role: "user", parts: [{ text: prompt }, { inlineData: { mimeType, data: Buffer.from(image).toString("base64") } }] }],
				generationConfig: { temperature: 0.4, maxOutputTokens: 4096 },
			},
		}),
	}).catch((e) => {
		throw new Error(`Code Assist fetch failed: ${e.message}`);
	});
	if (!res.ok) {
		const txt = await res.text().catch(() => "");
		throw new Error(`Code Assist ${res.status}: ${(/"message":\s*"([^"]+)"/.exec(txt)?.[1] || txt).slice(0, 220)}`);
	}
	const sse = await res.text();
	let out = "";
	for (const chunk of sse.split("\n")) {
		if (!chunk.startsWith("data: ") || chunk.includes("[DONE]")) continue;
		try {
			const j = JSON.parse(chunk.slice(6));
			out += (j.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("");
		} catch {
			/* partial chunk */
		}
	}
	if (!out.trim()) throw new Error("Code Assist returned no text (quota or policy? log in to Gemini again)");
	return { text: out.trim(), model: `${model} · subscription` };
}

/** Image bytes → text. Auth order: Google-account subscription → API key. */
export async function geminiRead({ image, mimeType = "image/png", prompt = DEFAULT_PROMPT, model, timeoutMs = 120_000 }) {
	const bytes = Buffer.isBuffer(image) ? image : Buffer.from(image);
	if (!bytes.length) throw new Error("empty image");
	if (bytes.length > 14 * 1024 * 1024) throw new Error("image too large for inline upload (>14 MB)");
	const m = String(model || envKey("GEMINI_MODEL") || GEMINI_DEFAULT_MODEL).trim();
	const body = JSON.stringify({
		contents: [{ role: "user", parts: [{ text: prompt }, { inline_data: { mime_type: mimeType, data: bytes.toString("base64") } }] }],
		generationConfig: { temperature: 0.4, maxOutputTokens: 4096 },
	});

	const sub = await getSubscriptionToken().catch((error) => ({ error }));
	if (sub && !sub.error && sub.token && (sub.genai || sub.projectId)) {
		if (sub.genai) {
			// consumer Gemini API on subscription quota
			const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(m)}:generateContent`, {
				method: "POST",
				headers: { "content-type": "application/json", Authorization: `Bearer ${sub.token}`, "X-Goog-Api-Client": "gl-node/22.17.0" },
				signal: AbortSignal.timeout(timeoutMs),
				body,
			}).catch((e) => {
				throw new Error(`Gemini fetch failed: ${e.message}`);
			});
			if (!res.ok) {
				const t = await res.text().catch(() => "");
				const detail = /"message":\s*"([^"]+)"/.exec(t)?.[1] || t.slice(0, 200);
				throw new Error(`Gemini ${res.status} (subscription): ${detail}`);
			}
			const j = await res.json();
			const text = (j.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("").trim();
			if (!text) throw new Error(`Gemini returned no text (${j.candidates?.[0]?.finishReason || j.promptFeedback?.blockReason || "empty"})`);
			return { text, model: `${m} · subscription` };
		}
		return codeAssistRead({ token: sub.token, projectId: sub.projectId, image: bytes, prompt, model: m, timeoutMs, mimeType });
	}

	const key = envKey("GEMINI_API_KEY") || envKey("GOOGLE_API_KEY");
	if (!key) {
		const why = sub?.needsLogin ? ` (${String(sub.why || "").slice(0, 140)})` : sub?.error ? ` (${String(sub.error.message || sub.error).slice(0, 140)})` : "";
		throw new Error(`no Gemini auth${why} — use ⋯ → Log in to Gemini once (browser login with the Google account of your subscription, no API key), or set GEMINI_API_KEY`);
	}
	const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(m)}:generateContent`, {
		method: "POST",
		headers: { "content-type": "application/json", "x-goog-api-key": key },
		signal: AbortSignal.timeout(timeoutMs),
		body,
	}).catch((e) => {
		throw new Error(`Gemini fetch failed: ${e.message}`);
	});
	if (!res.ok) {
		const t = await res.text().catch(() => "");
		const detail = /"message":\s*"([^"]+)"/.exec(t)?.[1] || t.slice(0, 200);
		throw new Error(`Gemini ${res.status}: ${detail}`);
	}
	const j = await res.json();
	const text = (j.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("").trim();
	if (!text) throw new Error(`Gemini returned no text (${j.candidates?.[0]?.finishReason || j.promptFeedback?.blockReason || "empty"})`);
	return { text, model: m };
}
