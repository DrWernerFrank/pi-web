// Markdown → safe HTML, tuned for what pi sessions contain: LaTeX, mermaid,
// Obsidian callouts and ![[image|500]] embeds, code, and Persian (RTL) text
// mixed with English.

/* global markdownit, katex, DOMPurify, hljs */

import { esc, textDir } from "./util.js";

const IMAGE_FILE = /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i;

// ── math ────────────────────────────────────────────────────────────────────

const mathCache = new Map();

export function renderMath(src, display) {
	const key = `${display ? "D" : "I"}${src}`;
	let html = mathCache.get(key);
	if (html === undefined) {
		try {
			html = katex.renderToString(src, {
				displayMode: display,
				throwOnError: false,
				strict: "ignore",
				trust: false,
				output: "html",
			});
		} catch (err) {
			html = `<code class="math-error" title="${esc(err.message)}">${esc(src)}</code>`;
		}
		if (mathCache.size > 5000) mathCache.clear();
		mathCache.set(key, html);
	}
	return display ? `<div class="math-display" dir="ltr">${html}</div>` : `<span class="math-inline" dir="ltr">${html}</span>`;
}

const isSpace = (code) => code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;

function mathPlugin(md) {
	md.inline.ruler.before("escape", "math_inline", (state, silent) => {
		const { src, pos, posMax: max } = state;
		const ch = src.charCodeAt(pos);

		if (ch === 0x5c) {
			// \( ... \)  and  \[ ... \]
			const next = src[pos + 1];
			if (next !== "(" && next !== "[") return false;
			const close = next === "(" ? "\\)" : "\\]";
			const end = src.indexOf(close, pos + 2);
			if (end < 0 || end + 2 > max) return false;
			const content = src.slice(pos + 2, end);
			if (!content.trim()) return false;
			if (!silent) {
				const token = state.push("math_inline", "math", 0);
				token.content = content;
				token.info = next === "[" ? "display" : "";
			}
			state.pos = end + 2;
			return true;
		}

		if (ch !== 0x24) return false;

		if (src.charCodeAt(pos + 1) === 0x24) {
			// $$ ... $$ inside a paragraph
			const end = src.indexOf("$$", pos + 2);
			if (end < 0 || end + 2 > max) return false;
			const content = src.slice(pos + 2, end);
			if (!content.trim()) return false;
			if (!silent) {
				const token = state.push("math_inline", "math", 0);
				token.content = content;
				token.info = "display";
			}
			state.pos = end + 2;
			return true;
		}

		// $ ... $ : no space after the opening $, none before the closing $,
		// and no digit right after it (so "$5 and $10" stays text).
		if (pos + 1 >= max || isSpace(src.charCodeAt(pos + 1))) return false;
		let end = pos + 1;
		for (;;) {
			end = src.indexOf("$", end);
			if (end < 0 || end >= max) return false;
			const before = src.charCodeAt(end - 1);
			const after = src.charCodeAt(end + 1);
			if (before === 0x5c || isSpace(before) || (after >= 0x30 && after <= 0x39)) {
				end++;
				continue;
			}
			break;
		}
		if (!silent) {
			const token = state.push("math_inline", "math", 0);
			token.content = src.slice(pos + 1, end);
			token.info = "";
		}
		state.pos = end + 1;
		return true;
	});

	md.block.ruler.before(
		"fence",
		"math_block",
		(state, startLine, endLine, silent) => {
			if (state.sCount[startLine] - state.blkIndent >= 4) return false;
			const first = state.src.slice(state.bMarks[startLine] + state.tShift[startLine], state.eMarks[startLine]);
			let close;
			if (first.startsWith("$$")) close = "$$";
			else if (first.startsWith("\\[")) close = "\\]";
			else return false;

			const rest = first.slice(2);
			let content;
			let last = startLine;
			const sameLine = rest.indexOf(close);
			if (sameLine >= 0) {
				if (rest.slice(sameLine + 2).trim()) return false;
				content = rest.slice(0, sameLine);
			} else {
				const lines = [rest];
				let found = false;
				for (last = startLine + 1; last < endLine; last++) {
					if (state.sCount[last] < state.blkIndent) break;
					const line = state.src.slice(state.bMarks[last] + state.tShift[last], state.eMarks[last]);
					const at = line.indexOf(close);
					if (at >= 0) {
						lines.push(line.slice(0, at));
						found = true;
						break;
					}
					lines.push(line);
				}
				if (!found) return false;
				content = lines.join("\n");
			}
			if (!content.trim()) return false;
			if (silent) return true;
			const token = state.push("math_block", "math", 0);
			token.block = true;
			token.content = content;
			token.map = [startLine, last + 1];
			state.line = last + 1;
			return true;
		},
		{ alt: ["paragraph", "reference", "blockquote", "list"] },
	);

	md.renderer.rules.math_inline = (tokens, idx) => renderMath(tokens[idx].content, tokens[idx].info === "display");
	md.renderer.rules.math_block = (tokens, idx) => `${renderMath(tokens[idx].content, true)}\n`;
}

// ── Obsidian wikilinks and embeds ───────────────────────────────────────────

function splitOnce(text, sep) {
	const at = text.indexOf(sep);
	return at < 0 ? [text, undefined] : [text.slice(0, at), text.slice(at + 1)];
}

function wikiPlugin(md) {
	md.inline.ruler.before("link", "wikilink", (state, silent) => {
		const { src, pos } = state;
		const embed = src.charCodeAt(pos) === 0x21;
		const start = embed ? pos + 1 : pos;
		if (src.charCodeAt(start) !== 0x5b || src.charCodeAt(start + 1) !== 0x5b) return false;
		const end = src.indexOf("]]", start + 2);
		if (end < 0 || end > state.posMax) return false;
		const inner = src.slice(start + 2, end);
		if (!inner.trim() || inner.includes("\n") || inner.includes("[")) return false;
		if (!silent) {
			const [target, alias] = splitOnce(inner, "|");
			const token = state.push(embed ? "wiki_embed" : "wiki_link", "", 0);
			token.meta = { target: target.trim(), alias: alias?.trim() };
		}
		state.pos = end + 2;
		return true;
	});

	md.renderer.rules.wiki_embed = (tokens, idx, _options, env) => {
		const { target, alias } = tokens[idx].meta;
		const [file] = splitOnce(target, "#");
		if (IMAGE_FILE.test(file)) {
			const size = /^(\d+)(?:x(\d+))?$/.exec(alias || "");
			const src = `/api/embed?session=${encodeURIComponent(env.sessionId || "")}&name=${encodeURIComponent(file)}`;
			const width = size ? ` width="${size[1]}"` : "";
			const height = size?.[2] ? ` height="${size[2]}"` : "";
			const alt = alias && !size ? alias : file;
			return `<img class="embed-img" src="${esc(src)}" alt="${esc(alt)}"${width}${height} loading="lazy">`;
		}
		return `<span class="wikilink" title="${esc(target)}">↪ ${esc(alias || file)}</span>`;
	};
	md.renderer.rules.wiki_link = (tokens, idx) => {
		const { target, alias } = tokens[idx].meta;
		return `<span class="wikilink" title="${esc(target)}">${esc(alias || target)}</span>`;
	};
}

// ── the renderer ────────────────────────────────────────────────────────────

function hostOf(url) {
	try {
		return new URL(url).host;
	} catch {
		return url;
	}
}

function highlight(code, lang) {
	if (lang && typeof hljs !== "undefined" && hljs.getLanguage(lang)) {
		try {
			return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
		} catch {
			// fall through to plain
		}
	}
	return esc(code);
}

export function codeBlock(code, lang) {
	const label = lang || "text";
	return (
		`<div class="code-block"><div class="code-head"><span class="code-lang">${esc(label)}</span>` +
		`<button class="code-copy" type="button" data-copy>Copy</button></div>` +
		`<pre dir="ltr"><code class="hljs${lang ? ` language-${esc(lang)}` : ""}">${highlight(code, lang)}</code></pre></div>`
	);
}

const md = markdownit({ html: true, linkify: true, breaks: true, typographer: false });
md.linkify.set({ fuzzyLink: false, fuzzyEmail: false });
md.use(mathPlugin).use(wikiPlugin);

md.renderer.rules.fence = (tokens, idx) => {
	const token = tokens[idx];
	const lang = (token.info || "").trim().split(/\s+/)[0].toLowerCase();
	const code = token.content;
	if (lang === "mermaid") return `<div class="mermaid-block" data-state="pending"><pre class="mermaid-src" dir="ltr">${esc(code)}</pre></div>`;
	if (lang === "math") return renderMath(code, true);
	return codeBlock(code.replace(/\n$/, ""), lang);
};
md.renderer.rules.code_block = (tokens, idx) => codeBlock(tokens[idx].content.replace(/\n$/, ""), "");

const renderImage = md.renderer.rules.image;
md.renderer.rules.image = (tokens, idx, options, env, self) => {
	const token = tokens[idx];
	const src = token.attrGet("src") || "";
	if (/^https?:/i.test(src)) {
		// Remote images are not loaded: a model can leak data through an image URL.
		return `<a class="remote-img" href="${esc(src)}" target="_blank" rel="noopener noreferrer" title="Remote image (not loaded)">🖼 ${esc(token.content || hostOf(src))}</a>`;
	}
	if (!/^data:image\//i.test(src)) {
		let local = src;
		try {
			local = decodeURI(src);
		} catch {
			// keep as is
		}
		token.attrSet("src", `/api/file?session=${encodeURIComponent(env.sessionId || "")}&path=${encodeURIComponent(local)}`);
	}
	token.attrSet("loading", "lazy");
	return renderImage(tokens, idx, options, env, self);
};

const renderLinkOpen = md.renderer.rules.link_open || ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
	const token = tokens[idx];
	const href = token.attrGet("href") || "";
	if (/^(https?:|mailto:)/i.test(href)) {
		token.attrSet("target", "_blank");
		token.attrSet("rel", "noopener noreferrer");
	} else {
		token.attrSet("data-local", "1");
	}
	return renderLinkOpen(tokens, idx, options, env, self);
};

// Raw HTML from a model is sanitized; remote images in it become links too.
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
	if (node.tagName === "IMG") {
		const src = node.getAttribute("src") || "";
		if (!/^(\/api\/|data:image\/)/i.test(src)) {
			const link = document.createElement("a");
			link.className = "remote-img";
			link.href = src;
			link.target = "_blank";
			link.rel = "noopener noreferrer";
			link.textContent = `🖼 ${node.getAttribute("alt") || hostOf(src)}`;
			node.replaceWith(link);
		}
	}
	if (node.tagName === "A" && node.getAttribute("target") === "_blank") node.setAttribute("rel", "noopener noreferrer");
});

const PURIFY = {
	ADD_ATTR: ["target", "data-copy", "data-state", "data-local", "dir", "loading"],
	FORBID_TAGS: ["style", "form", "input", "textarea", "select", "option", "iframe", "frame", "object", "embed", "link", "meta", "base"],
	FORBID_ATTR: ["autofocus"],
};

export function renderMarkdown(text, env = {}) {
	return DOMPurify.sanitize(md.render(String(text ?? ""), env), PURIFY);
}

/** One line of markdown (no paragraph wrapper), e.g. a quiz option with $math$. */
export function renderInline(text, env = {}) {
	return DOMPurify.sanitize(md.renderInline(String(text ?? ""), env), PURIFY);
}

// ── after insertion: callouts, direction, mermaid ───────────────────────────

const CALLOUT_ALIASES = {
	summary: "abstract",
	tldr: "abstract",
	hint: "tip",
	important: "tip",
	check: "success",
	done: "success",
	help: "question",
	faq: "question",
	caution: "warning",
	attention: "warning",
	fail: "failure",
	missing: "failure",
	error: "danger",
	cite: "quote",
};
const CALLOUT_ICONS = {
	note: "✎",
	abstract: "≡",
	info: "ℹ",
	todo: "☐",
	tip: "✦",
	success: "✓",
	question: "?",
	warning: "!",
	failure: "✗",
	danger: "⚡",
	bug: "🐞",
	example: "▸",
	quote: "❝",
};

function makeCallout(bq) {
	const first = bq.firstElementChild;
	if (!first || first.tagName !== "P") return;
	const head = first.firstChild;
	if (!head || head.nodeType !== Node.TEXT_NODE) return;
	const m = /^\s*\[!([\w-]+)\]([+-]?)[ \t]*([^\n]*)/.exec(head.textContent);
	if (!m) return;
	const raw = m[1].toLowerCase();
	const type = CALLOUT_ALIASES[raw] || raw;
	const box = document.createElement(m[2] ? "details" : "div");
	box.className = "callout";
	box.dataset.callout = CALLOUT_ICONS[type] ? type : "note";
	if (m[2] === "+") box.open = true;
	const title = document.createElement(m[2] ? "summary" : "div");
	title.className = "callout-title";
	const icon = document.createElement("span");
	icon.className = "callout-icon";
	icon.textContent = CALLOUT_ICONS[type] || "✎";
	const label = document.createElement("span");
	label.textContent = m[3].trim() || raw.charAt(0).toUpperCase() + raw.slice(1);
	title.append(icon, label);

	// Everything after the title line of the first paragraph is body text.
	head.textContent = head.textContent.slice(m[0].length).replace(/^\s*\n/, "");
	if (!head.textContent) head.remove();
	const body = document.createElement("div");
	body.className = "callout-content";
	if (first.firstChild?.nodeName === "BR") first.firstChild.remove();
	if (!first.textContent.trim() && !first.querySelector("img,.math-inline,.math-display")) first.remove();
	while (bq.firstChild) body.append(bq.firstChild);
	box.append(title, body);
	bq.replaceWith(box);
}

function directionText(el) {
	let text = "";
	const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
		acceptNode(node) {
			const parent = node.parentElement;
			if (parent?.closest(".math-inline, .math-display, code, pre, .katex")) return NodeFilter.FILTER_REJECT;
			return NodeFilter.FILTER_ACCEPT;
		},
	});
	while (walker.nextNode() && text.length < 2000) text += walker.currentNode.nodeValue;
	return text;
}

const BLOCKS = "p, li, h1, h2, h3, h4, h5, h6, td, th, dt, dd, summary, .callout-title, ul, ol, blockquote, .callout, table";

function nodeDirText(node) {
	if (node.nodeType === Node.TEXT_NODE) return node.nodeValue;
	if (node.nodeType !== Node.ELEMENT_NODE || node.matches(".math-inline, .math-display, code, pre, .katex")) return "";
	return directionText(node);
}

/**
 * A paragraph whose lines (soft breaks) switch between Persian and English,
 * e.g. a question asked in both languages, gets one direction per line.
 */
function splitMixedLines(root) {
	for (const p of root.querySelectorAll("p")) {
		if (!p.querySelector(":scope > br")) continue;
		const groups = [[]];
		for (const node of [...p.childNodes]) {
			if (node.nodeName === "BR") groups.push([]);
			else groups.at(-1).push(node);
		}
		const dirs = groups.map((nodes) => textDir(nodes.map(nodeDirText).join("")));
		if (new Set(dirs.filter(Boolean)).size < 2) continue;
		p.replaceChildren(
			...groups.map((nodes, i) => {
				const line = document.createElement("span");
				line.className = "line";
				if (dirs[i]) line.setAttribute("dir", dirs[i]);
				line.append(...nodes);
				return line;
			}),
		);
	}
}

function applyDirection(root) {
	splitMixedLines(root);
	for (const code of root.querySelectorAll("code, .wikilink")) {
		if (!code.closest("pre") && !code.hasAttribute("dir") && textDir(code.textContent) !== "rtl") code.setAttribute("dir", "ltr");
	}
	for (const el of root.querySelectorAll(BLOCKS)) {
		if (el.hasAttribute("dir")) continue;
		const dir = textDir(directionText(el));
		if (dir) el.setAttribute("dir", dir);
	}
}

let mermaidLoading;
let mermaidQueue = Promise.resolve();
let mermaidSeq = 0;
let mermaidTheme;

function loadMermaid() {
	mermaidLoading ??= new Promise((resolve, reject) => {
		const script = document.createElement("script");
		script.src = "/vendor/mermaid/mermaid.min.js";
		script.onload = () => resolve(window.mermaid);
		script.onerror = () => reject(new Error("Could not load the diagram library"));
		document.head.append(script);
	});
	return mermaidLoading;
}

function currentMermaidTheme() {
	return document.documentElement.dataset.theme === "dark" ? "dark" : "default";
}

function renderMermaidBlock(block) {
	block.dataset.state = "queued";
	mermaidQueue = mermaidQueue.then(async () => {
		const src = block.dataset.src ?? block.querySelector(".mermaid-src")?.textContent ?? "";
		block.dataset.src = src;
		let mermaid;
		try {
			mermaid = await loadMermaid();
		} catch (err) {
			block.dataset.state = "error";
			block.insertAdjacentHTML("beforeend", `<div class="mermaid-error">${esc(err.message)}</div>`);
			return;
		}
		const theme = currentMermaidTheme();
		if (mermaidTheme !== theme) {
			mermaid.initialize({
				startOnLoad: false,
				securityLevel: "strict",
				theme,
				fontFamily: getComputedStyle(document.body).fontFamily,
			});
			mermaidTheme = theme;
		}
		const id = `pi-mermaid-${++mermaidSeq}`;
		try {
			const { svg } = await mermaid.render(id, src);
			block.innerHTML = svg;
			block.dataset.state = "done";
		} catch (err) {
			document.getElementById(id)?.remove();
			document.getElementById(`d${id}`)?.remove();
			block.innerHTML = `<pre class="mermaid-src" dir="ltr">${esc(src)}</pre>`;
			block.insertAdjacentHTML("beforeend", `<div class="mermaid-error">Diagram error: ${esc(String(err?.message || err).split("\n")[0])}</div>`);
			block.dataset.state = "error";
		}
	});
}

export function rerenderDiagrams(root = document) {
	for (const block of root.querySelectorAll('.mermaid-block[data-state="done"]')) renderMermaidBlock(block);
}

/** Call once the rendered HTML is in the page. */
export function enhance(root, { diagrams = true } = {}) {
	for (const bq of root.querySelectorAll("blockquote")) makeCallout(bq);
	applyDirection(root);
	if (diagrams) for (const block of root.querySelectorAll('.mermaid-block[data-state="pending"]')) renderMermaidBlock(block);
}

/** Render markdown into an element in one step. */
export function renderInto(el, text, env = {}, options = {}) {
	el.innerHTML = renderMarkdown(text, env);
	enhance(el, options);
	return el;
}
