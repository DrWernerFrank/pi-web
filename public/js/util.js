// Small DOM and formatting helpers.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** Tiny element builder: h("div", { class: "x", onclick }, child, [more], "text"). */
export function h(tag, attrs, ...children) {
	const el = document.createElement(tag);
	if (attrs) {
		for (const [key, value] of Object.entries(attrs)) {
			if (value == null || value === false) continue;
			if (key === "class") el.className = value;
			else if (key === "html") el.innerHTML = value;
			else if (key === "text") el.textContent = value;
			else if (key === "dataset") Object.assign(el.dataset, value);
			else if (key === "style" && typeof value === "object") Object.assign(el.style, value);
			else if (key.startsWith("on") && typeof value === "function") el.addEventListener(key.slice(2), value);
			else if (value === true) el.setAttribute(key, "");
			else el.setAttribute(key, value);
		}
	}
	append(el, children);
	return el;
}

function append(el, children) {
	for (const child of children) {
		if (child == null || child === false) continue;
		if (Array.isArray(child)) append(el, child);
		else el.append(child instanceof Node ? child : String(child));
	}
}

export function esc(value) {
	return String(value ?? "")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

export function toMs(ts) {
	if (typeof ts === "number") return ts;
	const n = Date.parse(ts || "");
	return Number.isFinite(n) ? n : 0;
}

export function fmtRelative(ts) {
	const t = toMs(ts);
	if (!t) return "";
	const diff = Date.now() - t;
	const min = Math.round(diff / 60000);
	if (min < 1) return "now";
	if (min < 60) return `${min}m`;
	const hours = Math.round(min / 60);
	if (hours < 24) return `${hours}h`;
	const days = Math.round(hours / 24);
	if (days < 7) return `${days}d`;
	const d = new Date(t);
	const sameYear = d.getFullYear() === new Date().getFullYear();
	return d.toLocaleDateString(undefined, sameYear ? { month: "short", day: "numeric" } : { year: "numeric", month: "short", day: "numeric" });
}

export function fmtClock(ts) {
	const t = toMs(ts);
	if (!t) return "";
	const d = new Date(t);
	const today = new Date();
	const time = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
	if (d.toDateString() === today.toDateString()) return time;
	return `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${time}`;
}

export function fmtDuration(ms) {
	if (!Number.isFinite(ms) || ms < 0) return "";
	const s = Math.round(ms / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m ${s % 60}s`;
	return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function fmtTokens(n) {
	if (!Number.isFinite(n)) return "";
	if (n < 1000) return String(n);
	if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
	return `${(n / 1_000_000).toFixed(1)}M`;
}

export function fmtCost(n) {
	if (!n) return "";
	if (n < 0.01) return "<$0.01";
	return `$${n.toFixed(n < 10 ? 2 : 1)}`;
}

export function fmtBytes(n) {
	if (!n) return "";
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
	return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

const RTL_CHAR = /[֐-ࣿיִ-﷿ﹰ-﻿]/g;
const LTR_CHAR = /[A-Za-zÀ-ɏͰ-ϿЀ-ӿ]/g;

/**
 * Direction of a mixed Persian/English text by letter majority. Persian words
 * carry fewer letters (no short vowels), so RTL gets a head start.
 */
export function textDir(text) {
	if (!text) return null;
	const sample = text.length > 2000 ? text.slice(0, 2000) : text;
	const rtl = (sample.match(RTL_CHAR) || []).length;
	if (!rtl) return (sample.match(LTR_CHAR) || []).length ? "ltr" : null;
	const ltr = (sample.match(LTR_CHAR) || []).length;
	return rtl * 1.6 >= ltr ? "rtl" : "ltr";
}

export function prettyPath(p, home) {
	if (!p) return "";
	const win = /^\/mnt\/([a-z])(\/.*)?$/.exec(p);
	if (win) return `${win[1].toUpperCase()}:${(win[2] || "\\").replace(/\//g, "\\")}`;
	if (home && (p === home || p.startsWith(`${home}/`))) return `~${p.slice(home.length)}`;
	return p;
}

export function basename(p) {
	return String(p || "").split(/[\\/]/).filter(Boolean).pop() || p;
}

export function debounce(fn, ms) {
	let timer;
	return (...args) => {
		clearTimeout(timer);
		timer = setTimeout(() => fn(...args), ms);
	};
}

/** Run fn at most once per animation frame. */
export function rafThrottle(fn) {
	let queued = false;
	return () => {
		if (queued) return;
		queued = true;
		requestAnimationFrame(() => {
			queued = false;
			fn();
		});
	};
}

export async function copyText(text) {
	try {
		await navigator.clipboard.writeText(text);
		return true;
	} catch {
		const area = h("textarea", { style: { position: "fixed", opacity: "0" } });
		area.value = text;
		document.body.append(area);
		area.select();
		const ok = document.execCommand("copy");
		area.remove();
		return ok;
	}
}

export function storage(key, fallback) {
	try {
		const raw = localStorage.getItem(key);
		return raw == null ? fallback : JSON.parse(raw);
	} catch {
		return fallback;
	}
}

export function store(key, value) {
	try {
		localStorage.setItem(key, JSON.stringify(value));
	} catch {
		// private window or storage full: settings just won't persist
	}
}
