// Context-window sizes for models, so a session's context use can be shown
// even when no pi process is attached. Sources, in order: what running pi
// processes report, pi's model catalog cache, the user's models.json.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const LEARNED_FILE = path.join(os.homedir(), ".cache", "pi-web", "model-windows.json");

function readJson(file) {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8"));
	} catch {
		return undefined;
	}
}

export class ModelCatalog {
	constructor(agentDir) {
		this.files = [path.join(agentDir, "models-store.json"), path.join(agentDir, "models.json")];
		this.stamp = "";
		this.fromFiles = new Map();
		this.learned = new Map(Object.entries(readJson(LEARNED_FILE) || {}));
	}

	/** Re-read pi's catalog files when they change (cheap stat check). */
	refresh() {
		const stamp = this.files
			.map((f) => {
				try {
					return fs.statSync(f).mtimeMs;
				} catch {
					return 0;
				}
			})
			.join(":");
		if (stamp === this.stamp) return;
		this.stamp = stamp;
		const map = new Map();
		const add = (provider, model) => {
			if (provider && model?.id && Number(model.contextWindow) > 0) map.set(`${provider}/${model.id}`, Number(model.contextWindow));
		};
		const store = readJson(this.files[0]) || {};
		for (const [provider, entry] of Object.entries(store)) {
			for (const model of Array.isArray(entry?.models) ? entry.models : []) add(model.provider || provider, model);
		}
		const custom = readJson(this.files[1]) || {};
		for (const [provider, entry] of Object.entries(custom.providers || {})) {
			for (const model of Array.isArray(entry?.models) ? entry.models : []) add(provider, model);
		}
		this.fromFiles = map;
	}

	/** Remember what a running pi reports (covers extension providers like claude-bridge). */
	learn(models) {
		let changed = false;
		for (const m of models || []) {
			const key = `${m.provider}/${m.id}`;
			const window = Number(m.contextWindow);
			if (window > 0 && this.learned.get(key) !== window) {
				this.learned.set(key, window);
				changed = true;
			}
		}
		if (!changed) return;
		try {
			fs.mkdirSync(path.dirname(LEARNED_FILE), { recursive: true });
			fs.writeFileSync(LEARNED_FILE, JSON.stringify(Object.fromEntries(this.learned)));
		} catch {
			// a cache; fine to lose
		}
	}

	contextWindow(providerAndModel) {
		if (!providerAndModel) return undefined;
		this.refresh();
		return this.learned.get(providerAndModel) ?? this.fromFiles.get(providerAndModel);
	}
}
