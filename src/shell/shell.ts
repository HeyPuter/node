// The workspace's shell: just-bash over the project, with the runtime's binaries wired in.
//
// The old command layer refused pipes, redirection, `;`, globs and `VAR=` by name, because
// honouring them would have meant writing a shell. This is that shell — someone else's, which is
// the point: `ls`, `cat`, `grep`, `sed`, `jq`, `find`, loops and functions are theirs, and what
// remains ours is the part that is actually specific to this app.
//
// What is ours: `node`, `npm` and every binary in `node_modules` are registered as *commands*, and
// they do not return their output. They write it to the terminal as it arrives, because a dev
// server repaints, `tsc` colours its diagnostics and ctrl-C has to reach the program as a byte —
// none of which survives being collected into a string and handed back when the process exits. The
// cost is that a program's output cannot be piped into a builtin, which is the one thing this shell
// does that a real one wouldn't.
//
// State between prompts is `cwd` and the environment, and nothing else: every `exec` starts a fresh
// shell from the instance baseline, so what carries over is what we thread back in. That is why
// `cd` and `export` persist but aliases and functions do not.

import { Bash, defineCommand, getCommandNames } from "just-bash/browser";
import type { Command, ResolvedCommandContext } from "just-bash/browser";

import { PROJECT_ROOT, type ProjectMirror } from "../project/mirror";
import {
	bins,
	runBin,
	runNode,
	runNpm,
	type CommandContext,
	type CommandOutcome,
	type CommandTarget,
} from "../runtime/programs";
import { toProjectRelative } from "./paths";
import { WorkspaceFs } from "./workspace-fs";

/**
 * Shell variables that must not become a program's environment.
 *
 * `env` on a run *replaces* `process.env`, so everything here would be a claim about the runtime
 * rather than a value it can use: `PATH=/usr/bin:/bin` describes the shell's virtual filesystem,
 * and `HOME=/home/user` is a directory that exists only in this shell — a tool that writes to
 * `~/.cache` would be writing into Drive's root. Everything else the user exported goes through,
 * which is how `NODE_ENV=production npm run build` works at all.
 */
const SHELL_ONLY = new Set([
	"PATH",
	"HOME",
	"IFS",
	"OPTIND",
	"OLDPWD",
	"PWD",
	"OSTYPE",
	"MACHTYPE",
	"HOSTTYPE",
	"HOSTNAME",
	"SHELLOPTS",
	"BASHOPTS",
	"SHLVL",
	"PS1",
	"PS2",
	"_",
]);

/**
 * What an environment variable may be called.
 *
 * The shell keeps `$?`, `$#`, `$*` and the positional parameters in the same map as exported
 * variables, and a name like `?` is not something `process.env` should ever contain.
 */
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Names a package binary may not take.
 *
 * `getCommandNames()` lists the ~79 ordinary commands but not the special builtins — `cd`,
 * `export` and friends are handled by the interpreter itself and never reach the registry — so a
 * package shipping a binary called `cd` would otherwise shadow the real thing.
 */
const RESERVED = [
	"cd",
	"export",
	"unset",
	"set",
	"shopt",
	"local",
	"readonly",
	"declare",
	"typeset",
	"exit",
	"return",
	"shift",
	"getopts",
	"break",
	"continue",
	"eval",
	"exec",
	"command",
	"builtin",
	"source",
	".",
	":",
	"trap",
	"wait",
	"type",
	"let",
	"read",
	"test",
	"[",
	"[[",
	"printf",
	"pushd",
	"popd",
	"dirs",
	"jobs",
	"fg",
	"bg",
	"kill",
	"ulimit",
	"umask",
	"caller",
	"mapfile",
	"readarray",
	"hash",
	"times",
	"enable",
	"compgen",
	"complete",
];

/** Commands present in the browser build that cannot work there. */
const NEEDS_ZLIB = ["gzip", "gunzip", "zcat"];

export interface WorkspaceShellOptions {
	mirror: ProjectMirror;
	/** Where programs run — the pool-backed workspace target. */
	target: CommandTarget;
	/** Program-style output, straight to the terminal. */
	write: (text: string) => void;
	/** The environment a run starts from, before anything the user exports. */
	baseEnv: Record<string, string>;
	nodeVersion: () => string;
	/** A program finished, so the terminal should take the keyboard back. */
	endProgram: () => void;
	/** `cd` happened, so the prompt is stale. */
	onCwdChange: (cwd: string) => void;
	/** Whether a program is running, and how to stop it. */
	pool: { readonly busy: boolean; stop(): Promise<void> };
}

export interface WorkspaceShell {
	/** Where the next command will run. Absolute, and not necessarily inside the project. */
	readonly cwd: string;
	/** Run one command line and report its exit status. Output is written as it is produced. */
	run(line: string): Promise<number>;
	/** ctrl-C: stop the line, and whatever program it is waiting on. */
	interrupt(): void;
	/** Everything that can be typed as a command, for completion. */
	commandNames(): ReadonlySet<string>;
	/** Pick up binaries a fresh install added. */
	refreshBins(): Promise<string[]>;
	dispose(): void;
}

export function createWorkspaceShell(options: WorkspaceShellOptions): WorkspaceShell {
	let fs = new WorkspaceFs(options.mirror);
	let builtins = new Set(getCommandNames());
	let registered = new Set<string>();
	/** Package binaries a builtin already answers to; `npm exec` is how to reach them. */
	let shadowed: string[] = [];
	let abort: AbortController | undefined;

	/** Interruptible, so ctrl-C during `sleep 30` is not a thirty-second wait. */
	let sleep = (ms: number) =>
		new Promise<void>((resolve) => {
			let signal = abort?.signal;
			let timer = setTimeout(resolve, ms);
			signal?.addEventListener(
				"abort",
				() => {
					clearTimeout(timer);
					resolve();
				},
				{ once: true }
			);
		});

	/**
	 * A program's environment, from the shell's.
	 *
	 * `PWD` comes from the invocation rather than from the shell's own field, because `cd src &&
	 * node main.ts` changes the directory *inside* one exec — the shell does not learn about it
	 * until the whole line is done.
	 */
	let programEnv = (env: Map<string, string>, cwd: string): Record<string, string> => {
		let out: Record<string, string> = {};
		for (let [key, value] of env) {
			if (!SHELL_ONLY.has(key) && ENV_NAME.test(key)) out[key] = value;
		}
		out.PWD = cwd;
		return out;
	};

	let programContext = (bctx: ResolvedCommandContext): CommandContext => ({
		target: options.target,
		write: options.write,
		env: () => programEnv(bctx.env, bctx.cwd),
		nodeVersion: options.nodeVersion,
		resolvePath: (arg) => toProjectRelative(fs.resolvePath(bctx.cwd, arg)),
		runCwd: () => bctx.cwd,
		onInstall: () => void refreshBins(),
	});

	/** A program command's result: the output already went to the terminal. */
	let silent = (outcome: CommandOutcome) => ({
		stdout: "",
		stderr: "",
		exitCode: outcome.exitCode,
	});

	let refuse = (text: string) => ({ stdout: "", stderr: text, exitCode: 1 });

	/**
	 * Why a program cannot start right now.
	 *
	 * Both cases are structural rather than incidental. There is one worker per run, so two
	 * programs at once is not something to queue — and the runtime mounts only the project, so a
	 * shell sitting in `/tmp` has nowhere to run one.
	 */
	let blocked = (bctx: ResolvedCommandContext, bin: string): string | undefined => {
		if (toProjectRelative(bctx.cwd) === undefined) {
			return `${bin}: cannot run a program from ${bctx.cwd} — the runtime only mounts ${PROJECT_ROOT}\n`;
		}
		if (options.pool.busy) {
			return `${bin}: a program is already running — the runtime has one worker per run, so programs cannot be piped or backgrounded\n`;
		}
		return undefined;
	};

	/** Run a program, and hand the keyboard back afterwards however it ends. */
	let program = async (
		bctx: ResolvedCommandContext,
		bin: string,
		run: (ctx: CommandContext) => Promise<CommandOutcome>
	) => {
		let reason = blocked(bctx, bin);
		if (reason) return refuse(reason);
		try {
			return silent(await run(programContext(bctx)));
		} finally {
			options.endProgram();
		}
	};

	let nodeCommand = defineCommand("node", (args, bctx) =>
		program(bctx, "node", (ctx) => runNode(args, ctx))
	);

	let npmCommand = defineCommand("npm", async (args, bctx) => {
		// `npm run <script>` runs its body through this same shell, so a script body may use
		// anything a command line may — `tsc && vite build`, but also `vite build | tee log`.
		let nested = async (line: string): Promise<CommandOutcome> => {
			let result = await bctx.exec?.(line, {
				cwd: bctx.cwd,
				env: Object.fromEntries(bctx.env),
				signal: bctx.signal,
			});
			if (!result) return { exitCode: 1, ran: false };
			// A nested line's builtins produce collected output; its programs already wrote theirs.
			if (result.stdout) options.write(result.stdout);
			if (result.stderr) options.write(result.stderr);
			return { exitCode: result.exitCode, ran: false };
		};
		// `npm install` is not a program run, so it is allowed anywhere and needs no worker.
		let sub = args[0];
		if (sub === "install" || sub === "i") {
			return silent(await runNpm(args, programContext(bctx), nested));
		}
		return program(bctx, "npm", (ctx) => runNpm(args, ctx, nested));
	});

	let binCommand = (name: string): Command =>
		defineCommand(name, (args, bctx) => program(bctx, name, (ctx) => runBin(name, args, ctx)));

	/**
	 * `clear` through stdout rather than by reaching for the terminal.
	 *
	 * The builtin emits `2J` and `H`, which leaves the scrollback intact — and going through
	 * stdout is also what keeps `ls && clear` in order, since collected output is written after the
	 * line finishes.
	 */
	let clearCommand = defineCommand("clear", async () => ({
		stdout: "\x1b[2J\x1b[3J\x1b[H",
		stderr: "",
		exitCode: 0,
	}));

	let zlibCommand = (name: string) =>
		defineCommand(name, async () => ({
			stdout: "",
			stderr: `${name}: not available in the browser — it needs node:zlib, which this build has no copy of\n`,
			exitCode: 127,
		}));

	let bash = new Bash({
		fs,
		// A secondary defence layer whose wrapper binds every filesystem method up front, and whose
		// async-context machinery is stubbed out in the browser build anyway. The isolation that
		// matters here is the filesystem's: this shell can reach the project and nothing else.
		defenseInDepth: false,
		executionLimits: {
			// The default is an hour, after which a run is killed — which for `npm run dev` would
			// look like the dev server dying on its own.
			maxExecutionTimeMs: Number.POSITIVE_INFINITY,
		},
		sleep,
		customCommands: [nodeCommand, npmCommand, clearCommand, ...NEEDS_ZLIB.map(zlibCommand)],
	});

	for (let name of ["node", "npm", "clear", ...NEEDS_ZLIB]) registered.add(name);

	// The instance's own defaults supply PATH, IFS, OSTYPE and the rest, which `replaceEnv` would
	// otherwise drop on the first command. Threaded forward from here on.
	let env: Record<string, string> = { ...bash.getEnv(), ...options.baseEnv, PWD: PROJECT_ROOT };
	let cwd = PROJECT_ROOT;

	async function refreshBins(): Promise<string[]> {
		let index = await bins(options.target);
		let added: string[] = [];
		for (let name of index.keys()) {
			if (registered.has(name)) continue;
			if (builtins.has(name) || RESERVED.includes(name)) {
				// The builtin wins. Registering `sort` or `env` from a package instead would break
				// pipelines in a way nobody would think to look for, and `npm exec <name>` reaches
				// the package's copy exactly.
				if (!shadowed.includes(name)) shadowed.push(name);
				continue;
			}
			bash.registerCommand(binCommand(name));
			registered.add(name);
			added.push(name);
		}
		return shadowed;
	}

	/**
	 * One more line after a `command not found`, saying what this shell can do about it.
	 *
	 * The interpreter's own message stays — it is the one worth searching for — because the useful
	 * part is different every time: a binary that is installed but was not registered yet, a
	 * mistyped builtin, or a project with no packages at all.
	 */
	async function notFoundHint(stderr: string): Promise<void> {
		let name = /^bash: (\S+): command not found$/m.exec(stderr)?.[1];
		if (!name) return;
		let index = await bins(options.target);
		if (index.has(name)) {
			await refreshBins();
			options.write(`${name} is installed but was not registered yet — try again\n`);
			return;
		}
		if (index.size === 0) {
			options.write("no packages are installed — try npm install\n");
			return;
		}
		options.write(`node_modules provides: ${[...index.keys()].sort().join(", ")}\n`);
	}

	return {
		get cwd() {
			return cwd;
		},

		async run(line: string): Promise<number> {
			if (!line.trim()) return 0;
			// `help` cannot be a command: the interpreter dispatches it as a special builtin,
			// alongside `cd` and `type`, before it ever consults the command registry. So bare
			// `help` is answered here, and `help <name>` still reaches the builtin's own per-topic
			// documentation — which is the more useful division anyway.
			if (line.trim() === "help") {
				options.write(HELP);
				return 0;
			}
			// Saved and restored rather than cleared: the workspace runs one line at a time, but if
			// a second one ever overlaps, clearing the slot on the way out would leave the line
			// still running with nothing for ctrl-C to abort — and it would fail silently.
			let outer = abort;
			let controller = new AbortController();
			abort = controller;
			try {
				let result = await bash.exec(line, {
					cwd,
					env,
					replaceEnv: true,
					signal: controller.signal,
				});
				// Adopted whatever the exit status: `cd src && false` still changed directory, and a
				// line that was interrupted gets back the environment it went in with.
				env = result.env;
				let next = result.env.PWD ?? cwd;
				if (next !== cwd) {
					cwd = next;
					options.onCwdChange(cwd);
				}
				if (result.stdout) options.write(result.stdout);
				if (controller.signal.aborted) {
					// The interpreter announces an abort on stderr. A shell does not — ctrl-C is its
					// own acknowledgement, and the terminal has already echoed it. Anything the line
					// wrote before being stopped still goes through.
					let quiet = result.stderr.replace(/^bash: execution aborted\n?/m, "");
					if (quiet) options.write(quiet);
					// 130 is what a shell reports for a line ended by an interrupt.
					return 130;
				}
				if (result.stderr) options.write(result.stderr);
				if (result.exitCode === 127) await notFoundHint(result.stderr);
				return result.exitCode;
			} catch (err) {
				// A limit the interpreter treats as fatal arrives as a throw rather than a status.
				options.write(`bash: ${err instanceof Error ? err.message : String(err)}\n`);
				return 1;
			} finally {
				abort = outer;
			}
		},

		interrupt() {
			// Both halves are needed. Aborting cannot reach a program — the interpreter is waiting
			// on our command, which is waiting on a worker — and killing the worker only ends the
			// line if it was an `&&` chain, since a `;` list or a loop would carry on to the next
			// one.
			abort?.abort();
			void options.pool.stop();
		},

		commandNames() {
			return new Set([...builtins, ...registered, ...RESERVED]);
		},

		refreshBins,

		dispose() {
			fs.dispose();
		},
	};
}

// Wrapped well short of the pane's width: a line that reaches the edge leaves its last character
// stranded on a row of its own.
const HELP = `This is a bash shell over ${PROJECT_ROOT}.
  syntax   pipes, redirection (> >> 2> <), && || ;, globs, $VARs,
           if/for/while, functions, $(substitution)
  files    ls cat cp mv rm mkdir touch stat tree find du
  text     grep sed awk cut sort uniq wc head tail tr xargs diff jq
  shell    cd pwd echo env export which alias date seq sleep clear
Commands take --help; "help <name>" covers a shell builtin like cd.
Two binaries come from the runtime, and stream their output live:
  node   [options] <file> [args], or node -e <code> — try node --help
  npm    install, run <script>, exec <bin>
Package binaries in node_modules run by name (vite, tsc, …). Where one
shares a name with a builtin the builtin wins — use "npm exec <name>".
Notes: only ${PROJECT_ROOT} is mounted in the runtime, so a program cannot run
from /tmp, and only one runs at a time. A builtin cannot read a
program's output through a pipe. cd and exported variables persist
between prompts; aliases, functions and $? do not.
`;
