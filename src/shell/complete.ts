// Tab completion for the shell prompt.
//
// Synchronous, and that is the whole design constraint: a keystroke has to resolve before the line
// is redrawn, so completion can only see things that can be looked up without awaiting. Both
// sources qualify — the mirror is a map, and the command name set is a set — which is also why
// completion stops at the project boundary. Completing `/tmp/` would mean asking the shell's
// scratch filesystem, whose interface is async.
//
// The terminal knows nothing about any of this; it asks for a replacement and gets one.

import { normalizePath, resolveAgainst, toProjectRelative } from "./paths";
import type { ProjectMirror } from "../project/mirror";

export interface CompletionSources {
	mirror: ProjectMirror;
	/** Where the shell currently is, absolute. */
	cwd: () => string;
	/** Builtins, the runtime's binaries, and whatever `node_modules` provides. */
	commandNames: () => ReadonlySet<string>;
}

export interface Completion {
	/** Index in the line where the replacement starts. */
	from: number;
	/** Whole replacement texts, not suffixes. Directories end in "/". */
	items: string[];
}

/** Where a command name may appear: at the start, or after one of these. */
const OPERATORS = new Set(["|", "||", "&&", ";", "&", "(", "{", "!", "time", "then", "do", "else"]);

interface Token {
	text: string;
	start: number;
	/** Whether it contains a quote, in which case completing it would need to re-quote it. */
	quoted: boolean;
}

/** Split the text before the cursor the way the shell would, keeping each token's position. */
function tokenize(prefix: string): Token[] {
	let tokens: Token[] = [];
	let text = "";
	let start = 0;
	let started = false;
	let quoted = false;
	let quote: string | undefined;

	let flush = () => {
		if (!started) return;
		tokens.push({ text, start, quoted });
		text = "";
		started = false;
		quoted = false;
	};

	for (let i = 0; i < prefix.length; i++) {
		let ch = prefix[i];
		if (quote) {
			if (ch === quote) quote = undefined;
			else text += ch;
			continue;
		}
		if (ch === "'" || ch === '"') {
			if (!started) {
				started = true;
				start = i;
			}
			quoted = true;
			quote = ch;
			continue;
		}
		if (/\s/.test(ch)) {
			flush();
			continue;
		}
		if (!started) {
			started = true;
			start = i;
		}
		text += ch;
	}
	// An unterminated quote leaves the token open, which is still the token being typed.
	flush();
	// A trailing space means the cursor sits on a new, empty token.
	if (prefix.length > 0 && /\s/.test(prefix[prefix.length - 1])) {
		tokens.push({ text: "", start: prefix.length, quoted: false });
	}
	if (tokens.length === 0) tokens.push({ text: "", start: 0, quoted: false });
	return tokens;
}

export function completeLine(
	line: string,
	cursor: number,
	sources: CompletionSources
): Completion | undefined {
	let tokens = tokenize(line.slice(0, cursor));
	let current = tokens[tokens.length - 1];
	// Re-quoting a completion correctly is more trouble than it is worth; leave the line alone.
	if (current.quoted) return undefined;

	let previous = tokens[tokens.length - 2];
	let looksLikePath = current.text.includes("/") || current.text.startsWith(".");
	let commandPosition =
		!looksLikePath && (previous === undefined || OPERATORS.has(previous.text));

	let items = commandPosition
		? [...sources.commandNames()].filter((name) => name.startsWith(current.text)).sort()
		: completePath(current.text, sources);

	if (!items || items.length === 0) return undefined;
	return { from: current.start, items };
}

function completePath(token: string, sources: CompletionSources): string[] | undefined {
	let cut = token.lastIndexOf("/");
	let typedDir = cut === -1 ? "" : token.slice(0, cut + 1);
	let leaf = cut === -1 ? token : token.slice(cut + 1);

	let absolute = typedDir === "" ? normalizePath(sources.cwd()) : resolveAgainst(sources.cwd(), typedDir);
	let relative = toProjectRelative(absolute);
	if (relative === undefined) return undefined;
	if (!sources.mirror.isDir(relative)) return undefined;

	let out: string[] = [];
	for (let entry of sources.mirror.list(relative)) {
		if (!entry.name.startsWith(leaf)) continue;
		// Dotfiles only when they were asked for, as bash does.
		if (entry.name.startsWith(".") && !leaf.startsWith(".")) continue;
		out.push(`${typedDir}${entry.name}${entry.kind === "dir" ? "/" : ""}`);
	}
	return out;
}

/** The longest text every candidate starts with — what a Tab press with several matches inserts. */
export function commonPrefix(items: string[]): string {
	if (items.length === 0) return "";
	let prefix = items[0];
	for (let item of items.slice(1)) {
		let i = 0;
		while (i < prefix.length && i < item.length && prefix[i] === item[i]) i++;
		prefix = prefix.slice(0, i);
	}
	return prefix;
}

/** Candidates laid out in columns that fit the terminal, the way a shell lists them. */
export function formatColumns(items: string[], columns: number): string[] {
	let widest = items.reduce((max, item) => Math.max(max, item.length), 0);
	let width = widest + 2;
	let perRow = Math.max(1, Math.floor(columns / width));
	let rows: string[] = [];
	for (let i = 0; i < items.length; i += perRow) {
		let row = items.slice(i, i + perRow);
		rows.push(row.map((item, at) => (at === row.length - 1 ? item : item.padEnd(width))).join(""));
	}
	return rows;
}
