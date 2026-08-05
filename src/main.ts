// Entry point. Picks one of three modes and hands off.
//
//   - **Puter terminal** — launched as a child of the Terminal app, with argv. Renders
//     nothing; it is a CLI that happens to be a web page.
//   - **workspace** — the default: /project on this device's storage, an editor and a shell.
//   - **testbed** (`?ui=testbed`) — the original single-eval-module UI against a real
//     Puter Drive path. Kept for the examples/*.js smoke files and as the only
//     page-side exercise of the Drive install target.

import { type TTYState } from "node-worker";

import { runArgv } from "./runtime/command";
import { createDriveCommandTarget } from "./runtime/drive-command";
import {
	anonNet,
	createRuntimeStore,
	defaultCwd,
	driveHome,
	getPuter,
	isAnonMode,
	urlToken,
} from "./runtime-store";

type PuterTerminalMessage = {
	$: string;
	data?: Uint8Array<ArrayBufferLike>;
	termios?: {
		echo?: boolean;
	};
};

type PuterTerminalConnection = {
	postMessage(message: PuterTerminalMessage): void;
	on(event: "message" | "close", listener: (message: any) => void): void;
	off?: (event: "message" | "close", listener: (message: any) => void) => void;
};

type PuterTerminalRuntime = {
	puter: any;
	terminal: PuterTerminalConnection;
	args: string[];
	cwd: string;
	token: string;
};

const terminalTextEncoder = new TextEncoder();

// `env` on a run replaces process.env outright rather than merging into it, so
// everything the runtime would otherwise have defaulted to has to be spelled out.
const BASE_ENV: Record<string, string> = { TERM: "xterm-256color" };

/** The environment a run inherits from the Puter Terminal that launched it. */
function terminalEnv(): Record<string, string> {
	let out: Record<string, string> = { ...BASE_ENV };
	let env = getPuter()?.args?.env;
	if (env && typeof env === "object") {
		for (let [key, value] of Object.entries(env)) {
			if (typeof value === "string") out[key] = value;
		}
	}
	return out;
}

function getPuterTerminalRuntime(): PuterTerminalRuntime | null {
	let puter = getPuter();
	let terminal = puter?.ui?.parentApp?.();
	let args = puter?.args?.command_line?.args;

	if (!terminal || !Array.isArray(args)) return null;

	let cwd =
		typeof puter?.args?.env?.PWD === "string"
			? puter.args.env.PWD.trim() || defaultCwd(puter)
			: defaultCwd(puter);
	let token = typeof puter?.authToken === "string" ? puter.authToken.trim() : "";

	return { puter, terminal, args, cwd, token };
}

function writeToPuterTerminal(terminal: PuterTerminalConnection, data: Uint8Array) {
	terminal.postMessage({ $: "stdout", data });
}

function writeTextToPuterTerminal(terminal: PuterTerminalConnection, text: string) {
	writeToPuterTerminal(terminal, terminalTextEncoder.encode(text));
}

function errorLines(err: unknown): string[] {
	if (err instanceof Error) {
		if (err.stack) return err.stack.split("\n").filter((line) => line.trim().length > 0);
		return [err.message];
	}
	return [String(err)];
}

function asByteChunk(data: unknown): Uint8Array<ArrayBuffer> | null {
	if (data instanceof Uint8Array) {
		let copy = new Uint8Array(new ArrayBuffer(data.byteLength));
		copy.set(data);
		return copy;
	}
	if (data instanceof ArrayBuffer) return new Uint8Array(data.slice(0));
	return null;
}

function forwardReadableToPuterTerminal(
	stream: ReadableStream<Uint8Array<ArrayBuffer>>,
	terminal: PuterTerminalConnection
) {
	let reader = stream.getReader();
	void (async () => {
		try {
			while (true) {
				let { value, done } = await reader.read();
				if (done) break;
				if (value) writeToPuterTerminal(terminal, value);
			}
		} catch {
			// App exits immediately after execution; stream races are expected.
		} finally {
			reader.releaseLock();
		}
	})();
}

async function settleTerminalOutput() {
	await Promise.resolve();
	await new Promise((resolve) => setTimeout(resolve, 100));
}

/**
 * Which argv the Puter Terminal handed over, normalized to a command line.
 *
 * The app doubles as `node` and as a general runner: launched as `node script.js` the
 * terminal passes `["script.js"]`, but launched as `npm install` it passes `["npm",
 * "install"]`. So anything that is an option or looks like a script is node's own
 * arguments, and anything else is a command in its own right.
 */
function terminalArgv(args: string[]): string[] {
	let first = args[0];
	if (first === undefined) return ["node"];
	let looksLikeScript = first.includes("/") || /\.[cm]?[jt]sx?$/.test(first);
	return first.startsWith("-") || looksLikeScript ? ["node", ...args] : args;
}

function normalizeCwd(cwd: string): string {
	let trimmed = cwd.trim() || "/";
	if (trimmed.length > 1 && trimmed.endsWith("/")) trimmed = trimmed.slice(0, -1);
	return trimmed;
}

async function runInPuterTerminal(root: Element, runtime: PuterTerminalRuntime) {
	root.textContent = "Running in terminal.";

	let token = runtime.token || urlToken;
	if (!token) {
		writeTextToPuterTerminal(runtime.terminal, "node-worker-test: missing puter auth token\n");
		runtime.puter.exit?.(1);
		return;
	}

	let write = (text: string) => writeTextToPuterTerminal(runtime.terminal, text);

	// The stdio bridge is re-established per worker, because a chain like
	// `tsc && vite build` gets a fresh one for every step that exits.
	let stdinWriter: WritableStreamDefaultWriter<Uint8Array<ArrayBuffer>> | undefined;
	let inputTail = Promise.resolve();
	let detachTTY = () => {};

	let onTerminalMessage = (message: PuterTerminalMessage) => {
		let writer = stdinWriter;
		if (message.$ !== "stdin" || !writer) return;

		let data = asByteChunk(message.data);
		if (!data) return;

		inputTail = inputTail
			.then(async () => {
				await writer.ready;
				await writer.write(data);
			})
			.catch(() => {});
	};

	runtime.terminal.on("message", onTerminalMessage);

	let target = createDriveCommandTarget({
		puter: runtime.puter,
		token,
		cwd: normalizeCwd(runtime.cwd),
		attach: (workerConsole) => {
			stdinWriter = workerConsole.stdin.getWriter();
			detachTTY = workerConsole.onTTYChange((state: TTYState) => {
				runtime.terminal.postMessage({
					$: "chtermios",
					termios: { echo: workerConsole.isTTY ? state.echo : true },
				});
			});
			forwardReadableToPuterTerminal(workerConsole.stdout, runtime.terminal);
			forwardReadableToPuterTerminal(workerConsole.stderr, runtime.terminal);
		},
		detach: () => {
			detachTTY();
			detachTTY = () => {};
			// The worker is about to be terminated, which tears its stdin down with it.
			stdinWriter = undefined;
		},
	});

	let exitCode = 0;
	try {
		// No `nodeVersion` and no `clear`: the version is answered by asking the runtime,
		// and the screen belongs to the Puter Terminal.
		let outcome = await runArgv(terminalArgv(runtime.args), {
			target,
			write,
			env: terminalEnv,
		});
		exitCode = outcome.exitCode;
		await settleTerminalOutput();
	} catch (err) {
		exitCode = 1;
		for (let line of errorLines(err)) write(line + "\n");
		await settleTerminalOutput();
	} finally {
		detachTTY();
		runtime.terminal.postMessage({ $: "chtermios", termios: { echo: true } });
		runtime.terminal.off?.("message", onTerminalMessage);
		await inputTail.catch(() => {});
		target.dispose();
		runtime.puter.exit?.(exitCode);
	}
}

// ------------------------------------------------------------------ dispatch

async function bootstrap() {
	let root = document.querySelector("#app");
	if (!root) return;

	let puterTerminalRuntime = getPuterTerminalRuntime();
	if (puterTerminalRuntime) {
		await runInPuterTerminal(root, puterTerminalRuntime);
		return;
	}

	let runtimeStore = await createRuntimeStore();

	if (new URLSearchParams(window.location.search).get("ui") === "testbed") {
		let fallback = defaultCwd();
		if (fallback !== "/" && runtimeStore.cwd.trim() === "/") {
			runtimeStore.cwd = fallback;
		}
		let { mountApp } = await import("./legacy-testbed");
		await mountApp(root, runtimeStore);
		return;
	}

	let { mountWorkspace } = await import("./workspace");
	await mountWorkspace({
		root,
		store: runtimeStore,
		prepareExport: async () => {
			let puter = getPuter();
			if (!puter?.auth) {
				throw new Error("puter.js is not available, so there is nowhere to export to");
			}
			// The account flow, which covers signing in *and* creating an account — and
			// resolves immediately when the page already has a session, so a signed-in
			// workspace sees no popup. This is the only way an anonymous run gets a Drive.
			if (!puter.auth.isSignedIn()) await puter.auth.signIn();

			// `driveHome()` knows the username only when Puter launched the app. Otherwise —
			// anonymous, or a hand-pasted token — it is whoever just signed in, and asking is
			// the only way to find out: a Drive path is rooted at the username, so without
			// this the destination would be a top-level directory nobody can create.
			let home = driveHome();
			if (home === "/") {
				let user = await puter.auth.getUser().catch(() => undefined);
				if (user?.username) home = `/${user.username}`;
			}
			return `${home}/Documents/node-worker-project`.replace(/\/{2,}/g, "/");
		},
		resolveAuth: async (prompt) => {
			// A token if there is one, anonymous if there is not. `?anon=1` forces the
			// anonymous path even when a token is available; otherwise a token — from the
			// launch URL, from `VITE_DEV_TOKEN`, or pasted on an earlier visit — still wins.
			let token = isAnonMode ? "" : runtimeStore.token.trim();
			if (token) return { token };

			try {
				return { token: "", net: await anonNet(runtimeStore) };
			} catch (err) {
				// The relay endpoint is origin-gated, so a page it does not recognize cannot
				// go anonymous at all — and that is the one remaining case where a token is
				// the only way in, so it is the only case that still asks for one. Someone
				// who asked for anonymous explicitly gets the error instead: quietly wanting
				// their token would be the opposite of what they asked for.
				if (isAnonMode) throw err;
				console.warn("[node-worker-test] anonymous mode unavailable", err);
				let entered = await prompt();
				runtimeStore.token = entered;
				return { token: entered };
			}
		},
	});
}

void bootstrap();
