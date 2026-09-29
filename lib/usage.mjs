// Claude subscription limits (the 5-hour session window and the weekly
// windows), read with the OAuth sign-in pi already stored in auth.json.
// The token is only ever sent to api.anthropic.com and never to the page.
// pi refreshes that token when it talks to Claude; we only read it.

import fs from "node:fs";
import path from "node:path";

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const FRESH_MS = 60_000;
const RETRY_MS = 20_000;

const LABELS = {
	session: "5-hour",
	five_hour: "5-hour",
	weekly_all: "Weekly",
	seven_day: "Weekly",
	weekly_opus: "Weekly Opus",
	seven_day_opus: "Weekly Opus",
	weekly_sonnet: "Weekly Sonnet",
	seven_day_sonnet: "Weekly Sonnet",
};

function label(kind) {
	return LABELS[kind] || kind.replace(/[_-]+/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

function severityFor(percent) {
	return percent >= 90 ? "critical" : percent >= 70 ? "warning" : "normal";
}

/** Normalize Anthropic's response into [{ id, label, percent, resetsAt, severity, active }]. */
export function parseClaudeUsage(body) {
	const windows = [];
	if (Array.isArray(body?.limits) && body.limits.length) {
		for (const l of body.limits) {
			if (typeof l?.percent !== "number" || !l.kind) continue;
			windows.push({
				id: l.kind,
				label: label(l.kind) + (l.scope ? ` (${l.scope})` : ""),
				percent: l.percent,
				resetsAt: l.resets_at || null,
				severity: l.severity || severityFor(l.percent),
				active: !!l.is_active,
			});
		}
	} else {
		for (const key of ["five_hour", "seven_day", "seven_day_opus", "seven_day_sonnet"]) {
			const w = body?.[key];
			if (!w || typeof w.utilization !== "number") continue;
			windows.push({ id: key, label: label(key), percent: w.utilization, resetsAt: w.resets_at || null, severity: severityFor(w.utilization), active: false });
		}
	}
	return windows;
}

export class ClaudeUsage {
	constructor(agentDir) {
		this.authFile = path.join(agentDir, "auth.json");
		this.cache = null;
		this.inflight = null;
	}

	credential() {
		try {
			const auth = JSON.parse(fs.readFileSync(this.authFile, "utf8"));
			const cred = auth?.anthropic;
			return cred?.type === "oauth" && typeof cred.access === "string" ? cred : undefined;
		} catch {
			return undefined;
		}
	}

	async get({ force = false } = {}) {
		const now = Date.now();
		if (!force && this.cache && now - this.cache.at < (this.cache.ok ? FRESH_MS : RETRY_MS)) return this.cache.value;
		this.inflight ??= this.fetch().finally(() => (this.inflight = null));
		return this.inflight;
	}

	async fetch() {
		const cred = this.credential();
		let value;
		if (!cred) {
			value = { available: false, reason: "Not signed in to Claude in pi (/login)." };
		} else if (typeof cred.expires === "number" && cred.expires < Date.now()) {
			value = { available: false, reason: "pi's Claude sign-in expired; it renews the next time pi uses Claude." };
		} else {
			try {
				const res = await fetch(USAGE_URL, {
					headers: {
						Authorization: `Bearer ${cred.access}`,
						"anthropic-beta": "oauth-2025-04-20",
						Accept: "application/json",
						"User-Agent": "pi-web",
					},
					signal: AbortSignal.timeout(10_000),
				});
				if (!res.ok) {
					value = { available: false, reason: `Claude usage request failed (${res.status}).` };
				} else {
					value = { available: true, provider: "Claude", windows: parseClaudeUsage(await res.json()) };
				}
			} catch (err) {
				value = { available: false, reason: `Could not reach Claude: ${err.message}` };
			}
		}
		value.fetchedAt = new Date().toISOString();
		this.cache = { at: Date.now(), ok: value.available, value };
		return value;
	}
}
