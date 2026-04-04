// The command set: `node`, `npm`, package binaries, `clear`, `help`.
//
// Deliberately not a shell. There is no process to fork, no PATH to search and no `sh` to
// delegate to, so anything it cannot honour exactly it refuses by name rather than
// guessing — a silently misparsed `>` would look like a bug in the runtime.
//
// Everything here goes through `CommandTarget`, so the same commands serve the workspace
// (a locally-stored project, a fresh worker per run) and the Puter Terminal (a real Drive
// directory, one long-lived worker). That is the whole reason the coupling is one
// interface and not a `ProjectMirror` plus a `WorkerPool`.

import { runNpmInstall } from "../npm-install";
import { buildBinIndex, type BinIndex } from "../project/bins";
import type { InstallTarget } from "../install/target";
import { NODE_USAGE, parseNodeArgv } from "./node-cli";
import type { RunRequest, RunResult } from "./run";

export interface CommandTarget {
	/** Where commands run, for log lines — "/project", or a Drive path. */
	readonly label: string;
	/** The absolute path the runtime sees, for a target-relative one. */
	absolute(path: string): string;
	/** Whether a target-relative path is a file that exists. */
	hasFile(path: string): Promise<boolean>;
	/** Reading and writing `node_modules`; also the bin index's source. */
	readonly install: InstallTarget;
	run(request: RunRequest): Promise<RunResult>;
}

export interface CommandContext {
	target: CommandTarget;
	/** Program-style output, newline-terminated by the caller. */
	write: (text: string) => void;
	/** The environment every run gets. */
	env: () => Record<string, string>;
	/**
	 * Reported by `node -v`, when the caller already knows it — the workspace captures
	 * it from a boot probe. Omitted where nothing has asked the runtime yet, and then
	 * `node -v` asks it, which costs a run.
	 */
	nodeVersion?: () => string;
	/** Undefined where there is no screen to clear (the Puter Terminal owns its own). */
	clear?: () => void;
}

export interface CommandOutcome {
	exitCode: number;
	/** True if a worker actually ran, so the caller knows to refresh a file tree. */
	ran: boolean;
}

const OK: CommandOutcome = { exitCode: 0, ran: false };
const FAILED: CommandOutcome = { exitCode: 1, ran: false };

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
			return runNpm(argv.slice(1), ctx);
		default:
			// Anything else is a package binary — which is what a script body like "vite"
			// or "tsc" is asking for, and the only reason `npm run` works.
			return runBin(bin, argv.slice(1), ctx);
	}
}

// --------------------------------------------------------------------- node

async function runNode(args: string[], ctx: CommandContext): Promise<CommandOutcome> {
	let invocation = parseNodeArgv(args);

	switch (invocation.kind) {
		case "version": {
			let known = ctx.nodeVersion?.();
			if (known !== undefined) {
				ctx.write(`${known}\n`);
				return OK;
			}
			// Nobody has asked the runtime yet, so ask it. `process.version` is the only
			// authority on this, and printing a constant that drifted would be worse than
			// the cost of one run.
			let path = `[version-${Date.now()}].cjs`;
			return report(
				await ctx.target.run({
					path,
					argv: ["node"],
					env: ctx.env(),
					module: "cjs",
					virtualModule: { path, code: "console.log(process.version);\n" },
				}),
				ctx
			);
		}

		case "help":
			for (let line of NODE_USAGE) ctx.write(line + "\n");
			return OK;

		case "error":
			ctx.write(invocation.message + "\n");
			return FAILED;

		case "eval": {
			// A virtual module rather than a temp file: it exists only for this run, and
			// giving it a path inside the project means relative imports in the snippet
			// resolve the way they would from the project root.
			let extension = invocation.module ? "mjs" : "cjs";
			let path = `[eval-${Date.now()}].${extension}`;
			let result = await ctx.target.run({
				path,
				// No script slot, as node does for --eval.
				argv: ["node", ...invocation.args],
				env: ctx.env(),
				module: invocation.module ? "esm" : "cjs",
				virtualModule: { path, code: evalSource(invocation.code, invocation.print, invocation.module) },
			});
			return report(result, ctx);
		}

		case "script": {
			let path = normalizeRelative(invocation.path);
			if (!(await ctx.target.hasFile(path))) {
				ctx.write(`node: cannot find module '${invocation.path}'\n`);
				return FAILED;
			}
			let result = await ctx.target.run({
				path,
				argv: ["node", ctx.target.absolute(path), ...invocation.args],
				env: ctx.env(),
				module: path.endsWith(".cjs") ? "cjs" : "esm",
			});
			return report(result, ctx);
		}
	}
}

/**
 * The module body for `--eval` / `--print`.
 *
 * `--print` on CommonJS input goes through `eval`, because that is the only thing that
 * yields a *script's* completion value — so `-p "let x = 2; x * 2"` prints 4, the way it
 * does in node, rather than being a syntax error the way an expression-only wrapper would
 * make it. ES modules have no completion value at all, so there the code has to be an
 * expression, and node is no different.
 */
function evalSource(code: string, print: boolean, module: boolean): string {
	if (!print) return code;
	if (module) return `console.log((${code}));\n`;
	return `console.log(eval(${JSON.stringify(code)}));\n`;
}

// ---------------------------------------------------------------------- npm

async function runNpm(args: string[], ctx: CommandContext): Promise<CommandOutcome> {
	let sub = args[0];

	if (sub === "install" || sub === "i") {
		let exitCode = await runNpmInstall({
			target: ctx.target.install,
			writeText: ctx.write,
			label: ctx.target.label,
		});
		return { exitCode, ran: false };
	}

	if (sub === "run" || sub === "run-script") {
		let name = args[1];
		if (!name) {
			await writeScripts(ctx);
			return OK;
		}
		let scripts = (await rootPackageJson(ctx))?.scripts;
		let script = scripts?.[name];
		if (script === undefined) {
			ctx.write(`npm: missing script: ${name}\n`);
			await writeScripts(ctx);
			return FAILED;
		}
		ctx.write(`> ${script}\n`);
		// Recurse so the script body goes through the same parsing — including `&&`,
		// which is exactly what the stock `build` script needs.
		return runCommand(appendArgs(script, args.slice(2)), ctx);
	}

	if (sub === "exec" || sub === "x") {
		let rest = args.slice(1);
		if (rest.length === 0) {
			ctx.write("npm: exec requires a command\n");
			return FAILED;
		}
		return runBin(rest[0], rest.slice(1), ctx);
	}

	ctx.write(`npm: unsupported command: ${sub ?? ""}\n`);
	ctx.write("supported: npm install, npm run <script>, npm exec <bin>\n");
	return FAILED;
}

// ----------------------------------------------------------- package binaries

/** Cached per target: over Drive, rebuilding this is a request per installed package. */
let binCache = new WeakMap<CommandTarget, Promise<BinIndex>>();

function bins(target: CommandTarget): Promise<BinIndex> {
	let cached = binCache.get(target);
	if (!cached) {
		cached = buildBinIndex(target.install);
		binCache.set(target, cached);
	}
	return cached;
}

/** Forget a target's bin index — after an install, which may have added binaries. */
export function invalidateBins(target: CommandTarget): void {
	binCache.delete(target);
}

/**
 * Run a package binary by name.
 *
 * The name is resolved through each package's own `bin` field rather than
 * `node_modules/.bin`, which npm creates at install time as symlinks or shell shims — a
 * tarball has none, and the runtime has neither symlinks nor a shell to run them.
 */
async function runBin(name: string, args: string[], ctx: CommandContext): Promise<CommandOutcome> {
	// A path rather than a bare name: `./scripts/x.js` in a script body is a file.
	if (name.includes("/") || name.startsWith(".")) {
		return runNode([name, ...args], ctx);
	}

	let index = await bins(ctx.target);
	let target = index.get(name);
	if (!target) {
		// Covers both readings of a failure here: a mistyped builtin, and a package binary
		// that isn't installed. There is no PATH, so node_modules is the whole search
		// space and saying so is the useful part.
		ctx.write(`${name}: command not found\n`);
		if (index.size > 0) {
			ctx.write(`node_modules provides: ${[...index.keys()].sort().join(", ")}\n`);
			ctx.write("plus npm, node, clear and help — try help\n");
		} else {
			ctx.write("no packages are installed — try npm install\n");
		}
		return FAILED;
	}

	let result = await ctx.target.run({
		path: target,
		argv: ["node", ctx.target.absolute(target), ...args],
		env: ctx.env(),
		module: target.endsWith(".cjs") ? "cjs" : "esm",
	});
	return report(result, ctx);
}

// --------------------------------------------------------------------- misc

function report(result: RunResult, ctx: CommandContext): CommandOutcome {
	if (result.error) {
		for (let line of errorLines(result.error)) ctx.write(line + "\n");
	} else if (result.exitCode !== 0) {
		ctx.write(`exited with code ${result.exitCode}\n`);
	}
	return { exitCode: result.exitCode, ran: true };
}

function errorLines(err: Error): string[] {
	if (err.stack) return err.stack.split("\n").filter((l) => l.trim().length > 0);
	return [err.message];
}

function rootPackageJson(ctx: CommandContext): Promise<{ scripts?: Record<string, string> } | undefined> {
	return ctx.target.install.readPackageJson("");
}

function writeHelp(ctx: CommandContext) {
	ctx.write("This shell runs two binaries from the in-browser runtime:\n");
	ctx.write("  npm   install, run <script>, exec <bin>\n");
	ctx.write("  node  [options] <file> [args], or node -e <code> — try node --help\n");
	ctx.write("Package binaries in node_modules can be run by name.\n");
	ctx.write("Plus clear and help. Commands can be chained with &&.\n");
}

async function writeScripts(ctx: CommandContext) {
	let scripts = (await rootPackageJson(ctx))?.scripts;
	if (!scripts || Object.keys(scripts).length === 0) {
		ctx.write("no scripts in package.json\n");
		return;
	}
	ctx.write("available scripts:\n");
	for (let [name, body] of Object.entries(scripts)) ctx.write(`  ${name}\t${body}\n`);
}

/** Strip a leading "./" or "/" so paths are target-relative. */
function normalizeRelative(path: string): string {
	let parts: string[] = [];
	for (let seg of path.split("/")) {
		if (seg === "" || seg === ".") continue;
		if (seg === "..") {
			parts.pop();
			continue;
		}
		parts.push(seg);
	}
	return parts.join("/");
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

/** `npm run build -- --flag` passes the extras through to the script body. */
function appendArgs(script: string, extra: string[]): string {
	let passthrough = extra[0] === "--" ? extra.slice(1) : extra;
	if (passthrough.length === 0) return script;
	return `${script} ${passthrough.map(quoteArg).join(" ")}`;
}

function quoteArg(arg: string): string {
	return /[\s"']/.test(arg) ? `'${arg.replace(/'/g, "")}'` : arg;
}
