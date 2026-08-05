// The Puter Terminal's shell: `node`, `npm`, package binaries, `clear`, `help`, `&&`.
//
// Deliberately not a shell. There is no process to fork, no PATH to search and no `sh` to
// delegate to, so anything it cannot honour exactly it refuses by name rather than
// guessing — a silently misparsed `>` would look like a bug in the runtime.
//
// **This is no longer what the workspace uses.** The workspace has a real one now (`src/shell`),
// built on just-bash, and what remains here serves the Puter Terminal — where this app is a CLI
// launched as `node-beta npm run build` and the *parent* Terminal supplies the shell a user types
// into. So it is small on purpose, and it is not dead: `runArgv` is `main.ts`'s entry point, and
// `runCommand` is what runs a `npm run` script body there.
//
// The programs themselves live in `./programs`, shared with the workspace's shell.

import {
	FAILED,
	OK,
	normalizeRelative,
	runBin,
	runNode,
	runNpm,
	type CommandContext,
	type CommandOutcome,
	type CommandTarget,
} from "./programs";

export type { CommandContext, CommandOutcome, CommandTarget };
export { invalidateBins } from "./programs";

/**
 * A context for this shell, from the parts a caller has to supply.
 *
 * The path seam is filled in here because it is a fact about this shell rather than about its
 * caller: there is no working directory to resolve against, so a path is target-relative and
 * `..` bottoms out at the root.
 */
export function terminalContext(
	parts: Omit<CommandContext, "resolvePath">
): CommandContext {
	return { ...parts, resolvePath: normalizeRelative };
}

/** Run a command line, `&&` chains included. */
export async function runCommand(line: string, ctx: CommandContext): Promise<CommandOutcome> {
	let segments = splitChain(line);
	if (segments.length > 1) return runChain(segments.map(splitArgs), ctx);

	let only = segments[0]?.trim();
	if (!only) return OK;

	let unsupported = unsupportedShellFeature(only);
	if (unsupported) {
		ctx.write(`shell: ${unsupported} is not supported\n`);
		return FAILED;
	}

	return runOne(splitArgs(only), ctx);
}

/**
 * Run an already-split argv, `&&` tokens included.
 *
 * The entry point for the Puter Terminal, which hands over `command_line.args` rather
 * than a string — re-joining that into a line and re-splitting it would lose exactly the
 * quoting the terminal already got right.
 */
export async function runArgv(argv: string[], ctx: CommandContext): Promise<CommandOutcome> {
	let chain: string[][] = [[]];
	for (let arg of argv) {
		if (arg === "&&") chain.push([]);
		else chain[chain.length - 1].push(arg);
	}
	return chain.length > 1 ? runChain(chain, ctx) : runOne(chain[0], ctx);
}

/**
 * Steps in sequence, stopping at the first failure.
 *
 * `npm run build` on the stock vite template is `tsc && vite build`, and there is nothing
 * else to run it with. Each step is its own program; what carries state between them is
 * the filesystem, which is why this works even though both steps call `process.exit`.
 */
async function runChain(chain: string[][], ctx: CommandContext): Promise<CommandOutcome> {
	let last = OK;
	for (let argv of chain) {
		if (argv.length === 0) continue;
		last = await runOne(argv, ctx);
		if (last.exitCode !== 0) return last;
	}
	return last;
}

async function runOne(argv: string[], ctx: CommandContext): Promise<CommandOutcome> {
	let bin = argv[0];
	if (!bin) return OK;

	switch (bin) {
		case "clear":
			ctx.clear?.();
			return OK;
		case "help":
			writeHelp(ctx);
			return OK;
		case "node":
			return runNode(argv.slice(1), ctx);
		case "npm":
			return runNpm(argv.slice(1), ctx, (line) => runCommand(line, ctx));
		default:
			// Anything else is a package binary — which is what a script body like "vite"
			// or "tsc" is asking for, and the only reason `npm run` works.
			return runBin(bin, argv.slice(1), ctx);
	}
}

function writeHelp(ctx: CommandContext) {
	ctx.write("This shell runs two binaries from the in-browser runtime:\n");
	ctx.write("  npm   install, run <script>, exec <bin>\n");
	ctx.write("  node  [options] <file> [args], or node -e <code> — try node --help\n");
	ctx.write("Package binaries in node_modules can be run by name.\n");
	ctx.write("Plus clear and help. Commands can be chained with &&.\n");
}

/** Split a line on top-level `&&`, ignoring the ones inside quotes. */
function splitChain(line: string): string[] {
	let out: string[] = [];
	let current = "";
	let quote: string | undefined;
	for (let i = 0; i < line.length; i++) {
		let ch = line[i];
		if (quote) {
			current += ch;
			if (ch === quote) quote = undefined;
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			current += ch;
			continue;
		}
		if (ch === "&" && line[i + 1] === "&") {
			out.push(current);
			current = "";
			i++;
			continue;
		}
		current += ch;
	}
	out.push(current);
	return out;
}

/** A shell feature this cannot honour, named so the failure is not mysterious. */
function unsupportedShellFeature(line: string): string | undefined {
	// Inside quotes these are ordinary characters, so only look outside them.
	let quote: string | undefined;
	for (let i = 0; i < line.length; i++) {
		let ch = line[i];
		if (quote) {
			if (ch === quote) quote = undefined;
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			continue;
		}
		if (ch === "|") return "piping";
		if (ch === ">" || ch === "<") return "redirection";
		if (ch === ";") return "`;` chaining (use &&)";
		if (ch === "`") return "command substitution";
		if (ch === "$" && line[i + 1] === "(") return "command substitution";
	}
	// VAR=value prefixes: node's env comes from the run, and honouring one here would
	// suggest the rest of shell assignment semantics work too.
	if (/^\s*[A-Za-z_][A-Za-z0-9_]*=/.test(line)) return "environment prefixes";
	return undefined;
}

/** Split on whitespace, respecting single and double quotes. */
function splitArgs(line: string): string[] {
	let out: string[] = [];
	let current = "";
	let quote: string | undefined;
	let started = false;

	for (let ch of line) {
		if (quote) {
			if (ch === quote) quote = undefined;
			else current += ch;
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			// So `-e ''` yields an empty argument rather than dropping it.
			started = true;
			continue;
		}
		if (/\s/.test(ch)) {
			if (started) {
				out.push(current);
				current = "";
				started = false;
			}
			continue;
		}
		current += ch;
		started = true;
	}
	if (started) out.push(current);
	return out;
}
