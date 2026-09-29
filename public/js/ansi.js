// ANSI SGR (colors, bold, ...) to HTML. Other escape sequences are dropped.

import { esc } from "./util.js";

const BASE = ["#1e1e1e", "#e5534b", "#57ab5a", "#c69026", "#539bf5", "#b083f0", "#39c5cf", "#d0d7de"];
const BRIGHT = ["#768390", "#ff938a", "#6bc46d", "#daaa3f", "#6cb6ff", "#dcbdfb", "#56d4dd", "#ffffff"];

function color256(n) {
	if (n < 8) return BASE[n];
	if (n < 16) return BRIGHT[n - 8];
	if (n < 232) {
		const v = n - 16;
		const c = (x) => (x ? 55 + x * 40 : 0);
		return `rgb(${c(Math.floor(v / 36))},${c(Math.floor(v / 6) % 6)},${c(v % 6)})`;
	}
	const g = 8 + (n - 232) * 10;
	return `rgb(${g},${g},${g})`;
}

const SEQUENCE = /\x1b\[([0-9;:]*)m|\x1b\[[0-9;?<>=]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][0-9A-Za-z]|\x1b[=>78]/g;

export function stripAnsi(text) {
	return String(text ?? "").replace(SEQUENCE, "");
}

export function hasAnsi(text) {
	return typeof text === "string" && text.includes("\x1b[");
}

export function ansiToHtml(text) {
	const src = String(text ?? "");
	let out = "";
	let last = 0;
	let state = {};
	let open = false;
	SEQUENCE.lastIndex = 0;

	const openSpan = () => {
		const css = [];
		let fg = state.fg;
		let bg = state.bg;
		if (state.inverse) [fg, bg] = [bg || "var(--term-bg, #111)", fg || "var(--term-fg, #ddd)"];
		if (fg) css.push(`color:${fg}`);
		if (bg) css.push(`background:${bg}`);
		if (state.bold) css.push("font-weight:600");
		if (state.dim) css.push("opacity:.65");
		if (state.italic) css.push("font-style:italic");
		const deco = [state.underline && "underline", state.strike && "line-through"].filter(Boolean);
		if (deco.length) css.push(`text-decoration:${deco.join(" ")}`);
		if (css.length) {
			out += `<span style="${css.join(";")}">`;
			open = true;
		}
	};
	const closeSpan = () => {
		if (open) out += "</span>";
		open = false;
	};

	let m;
	while ((m = SEQUENCE.exec(src))) {
		out += esc(src.slice(last, m.index));
		last = SEQUENCE.lastIndex;
		if (m[1] === undefined) continue;
		const codes = m[1] === "" ? [0] : m[1].split(/[;:]/).map((c) => Number(c) || 0);
		for (let i = 0; i < codes.length; i++) {
			const c = codes[i];
			if (c === 0) state = {};
			else if (c === 1) state.bold = true;
			else if (c === 2) state.dim = true;
			else if (c === 3) state.italic = true;
			else if (c === 4) state.underline = true;
			else if (c === 7) state.inverse = true;
			else if (c === 9) state.strike = true;
			else if (c === 22) state.bold = state.dim = false;
			else if (c === 23) state.italic = false;
			else if (c === 24) state.underline = false;
			else if (c === 27) state.inverse = false;
			else if (c === 29) state.strike = false;
			else if (c >= 30 && c <= 37) state.fg = BASE[c - 30];
			else if (c >= 90 && c <= 97) state.fg = BRIGHT[c - 90];
			else if (c >= 40 && c <= 47) state.bg = BASE[c - 40];
			else if (c >= 100 && c <= 107) state.bg = BRIGHT[c - 100];
			else if (c === 39) state.fg = undefined;
			else if (c === 49) state.bg = undefined;
			else if (c === 38 || c === 48) {
				let color;
				if (codes[i + 1] === 5) {
					color = color256(codes[i + 2] ?? 0);
					i += 2;
				} else if (codes[i + 1] === 2) {
					color = `rgb(${codes[i + 2] ?? 0},${codes[i + 3] ?? 0},${codes[i + 4] ?? 0})`;
					i += 4;
				}
				if (c === 38) state.fg = color;
				else state.bg = color;
			}
		}
		closeSpan();
		openSpan();
	}
	out += esc(src.slice(last));
	closeSpan();
	return out;
}
