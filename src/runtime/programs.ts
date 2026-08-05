// Running the two binaries the in-browser runtime provides — `node` and `npm` — plus whatever
// binaries `node_modules` provides.
//
// This is the half of the old command layer that is about *programs*, separated from the half
// that was about shell syntax. The workspace now has a real shell (see `src/shell`), which
// dispatches these as commands of its own; the Puter Terminal still has the small `&&` splitter
// in `command.ts`. Both go through the same functions here, so a fix to how `npm run` behaves is
// one fix.
//
// Everything goes through `CommandTarget`, so the same programs serve the workspace (a locally
// stored project, a fresh worker per run) and the Puter Terminal (a real Drive directory, one
// long-lived worker). That is the whole reason the coupling is one interface and not a
// `ProjectMirror` plus a `WorkerPool`.

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
	/**
	 * A path the user typed, as a target-relative one — or undefined if it points outside the
	 * target, which the runtime cannot reach.
	 *
	 * This is where a shell's working directory is applied. The Puter Terminal has none (its cwd
	 * *is* the target root) and passes the plain normalizer; the workspace shell resolves against
	 * whatever `cd` last left it in.
	 */
	resolvePath: (arg: string) => string | undefined;
	/** Absolute directory to run programs in, or undefined for the target root. */
	runCwd?: () => string | undefined;
	/**
	 * A successful `npm install` finished, so anything caching the bin index should rebuild it.
	 *
	 * Reported from here rather than sniffed from the command line, so it also fires for an
	 * install inside a script body, a loop, or one typed with flags.
	 */
	onInstall?: () => void;
}

export interface CommandOutcome {
	exitCode: number;
	/** True if a worker actually ran, so the caller knows to refresh a file tree. */
	ran: boolean;
}

export const OK: CommandOutcome = { exitCode: 0, ran: false };
export const FAILED: CommandOutcome = { exitCode: 1, ran: false };

// --------------------------------------------------------------------- node

export async function runNode(args: string[], ctx: CommandContext): Promise<CommandOutcome> {
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
					cwd: ctx.runCwd?.(),
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
				cwd: ctx.runCwd?.(),
			});
			return report(result, ctx);
		}

		case "script": {
			let path = ctx.resolvePath(invocation.path);
			if (path === undefined) {
				ctx.write(outsideTarget("node", invocation.path, ctx));
				return FAILED;
			}
			if (!(await ctx.target.hasFile(path))) {
				ctx.write(`node: cannot find module '${invocation.path}'\n`);
				return FAILED;
			}
			let result = await ctx.target.run({
				path,
				argv: ["node", ctx.target.absolute(path), ...invocation.args],
				env: ctx.env(),
				module: path.endsWith(".cjs") ? "cjs" : "esm",
				cwd: ctx.runCwd?.(),
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

/**
 * `npm`, with the script runner passed in.
 *
 * `npm run build` on the stock vite template is `tsc && vite build`, and the body has to be run
 * by whatever shell asked for it — the workspace's bash, so a body with a pipe in it works, or
 * the Puter Terminal's `&&` splitter. Taking it as an argument rather than reaching for one keeps
 * this file unaware of both.
 */
export async function runNpm(
	args: string[],
	ctx: CommandContext,
	runLine: (line: string) => Promise<CommandOutcome>
): Promise<CommandOutcome> {
	let sub = args[0];

	if (sub === "install" || sub === "i") {
		let exitCode = await runNpmInstall({
			target: ctx.target.install,
			writeText: ctx.write,
			label: ctx.target.label,
		});
		// An install can add package binaries, so anything holding an index of them is stale.
		if (exitCode === 0) {
			invalidateBins(ctx.target);
			ctx.onInstall?.();
		}
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
		return runLine(appendArgs(script, args.slice(2)));
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

export function bins(target: CommandTarget): Promise<BinIndex> {
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
export async function runBin(
	name: string,
	args: string[],
	ctx: CommandContext
): Promise<CommandOutcome> {
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
			ctx.write("plus the shell's own builtins — try help\n");
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
		cwd: ctx.runCwd?.(),
	});
	return report(result, ctx);
}

// --------------------------------------------------------------------- misc

function report(result: RunResult, ctx: CommandContext): CommandOutcome {
	// Stopping a program is something the user just asked for, so there is nothing to report about
	// it — the terminal already echoed the ctrl-C.
	if (result.interrupted) return { exitCode: result.exitCode, ran: true };
	if (result.error) {
		for (let line of errorLines(result.error)) ctx.write(line + "\n");
	} else if (result.exitCode !== 0) {
		ctx.write(`exited with code ${result.exitCode}\n`);
	}
	return { exitCode: result.exitCode, ran: true };
}

export function errorLines(err: Error): string[] {
	if (err.stack) return err.stack.split("\n").filter((l) => l.trim().length > 0);
	return [err.message];
}

/** What to say about a path the runtime cannot reach at all. */
function outsideTarget(bin: string, arg: string, ctx: CommandContext): string {
	return `${bin}: ${arg}: outside ${ctx.target.label} — the runtime only mounts ${ctx.target.label}\n`;
}

function rootPackageJson(ctx: CommandContext): Promise<{ scripts?: Record<string, string> } | undefined> {
	return ctx.target.install.readPackageJson("");
}

export async function writeScripts(ctx: CommandContext) {
	let scripts = (await rootPackageJson(ctx))?.scripts;
	if (!scripts || Object.keys(scripts).length === 0) {
		ctx.write("no scripts in package.json\n");
		return;
	}
	ctx.write("available scripts:\n");
	for (let [name, body] of Object.entries(scripts)) ctx.write(`  ${name}\t${body}\n`);
}

/** Strip a leading "./" or "/" so paths are target-relative. */
export function normalizeRelative(path: string): string {
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

/** `npm run build -- --flag` passes the extras through to the script body. */
function appendArgs(script: string, extra: string[]): string {
	let passthrough = extra[0] === "--" ? extra.slice(1) : extra;
	if (passthrough.length === 0) return script;
	return `${script} ${passthrough.map(quoteArg).join(" ")}`;
}

function quoteArg(arg: string): string {
	return /[\s"']/.test(arg) ? `'${arg.replace(/'/g, "")}'` : arg;
}
