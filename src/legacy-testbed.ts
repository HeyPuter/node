// The original testbed UI, kept as a secondary mode behind `?ui=testbed`.
//
// It is the only thing that drives a *Puter Drive* cwd rather than the in-memory
// project: one editor, one eval module, and a real path you type in. That makes it the
// place the examples/*.js smoke files still run, and the only page-side exercise of the
// Drive install target, so it earns its keep even though the workspace has replaced it
// for everything else.

import { NodeWorker } from "node-worker";
import workerURL from "node-worker/worker?url";

import { mountEditor } from "./monaco";
import { mountTerminal, type TerminalController } from "./terminal";
import { defaultCwd, urlToken, type RuntimeStore } from "./runtime-store";

/** The single pseudo-file this UI edits. Monaco keys models by path. */
const EVAL_PATH = "index.ts";

/**
 * A fresh module path per run.
 *
 * The runtime's module registries are per-worker and this UI reuses one worker across
 * runs, so a stable path would be served from cache the second time and the edited code
 * would never execute. A unique specifier sidesteps that. (The workspace does not need
 * this trick: it gets a new worker, and therefore an empty registry, every run.)
 */
function evalModulePathForRun(cwd: string, runId: number): string {
	let normalized = cwd.trim() || "/";
	if (normalized.length > 1 && normalized.endsWith("/")) {
		normalized = normalized.slice(0, -1);
	}

	return normalized === "/"
		? `/[__node-worker__eval-${runId}].js`
		: `${normalized}/[__node-worker__eval-${runId}].js`;
}

function createAppShell() {
	let shell = document.createElement("div");
	shell.className = "app-shell";
	shell.innerHTML = `
		<header>
			<h1>node-worker frontend testbed</h1>
			<p>Vanilla JS + Monaco + xterm</p>
		</header>
		<div class="controls">
			<label>
				<span>Working directory</span>
				<input id="cwd-input" placeholder="/" />
			</label>
			<div class="token-controls" id="token-controls" hidden>
				<label>
					<span>Puter token</span>
					<input id="token-input" placeholder="token" />
				</label>
				<button id="init-button" type="button">Initialize worker</button>
			</div>
			<div class="worker-status" id="worker-status">Worker: idle</div>
			<div class="actions">
				<button id="run-button" type="button">Run eval module</button>
				<button id="clear-button" type="button">Clear console</button>
			</div>
		</div>
		<main class="panes">
			<section class="panel editor-panel">
				<h2>Editor</h2>
				<div class="editor-host"></div>
			</section>
			<section class="panel console-panel">
				<h2>Console</h2>
				<div class="terminal-host"></div>
			</section>
		</main>
	`;
	return shell;
}

function applyStyles() {
	let style = document.createElement("style");
	style.textContent = `
		:root {
			--bg-0: #f8f8f4;
			--bg-1: #ffffff;
			--bg-2: #f1efe6;
			--ink-0: #181818;
			--ink-1: #474038;
			--line: #d9d2c4;
			--brand: #b8572b;
		}

		html,
		body {
			margin: 0;
			padding: 0;
			height: 100%;
		}

		#app {
			height: 100%;
		}

		.app-shell {
			font-family: "Space Grotesk", "IBM Plex Sans", "Segoe UI", sans-serif;
			color: var(--ink-0);
			height: 100%;
			min-height: 100dvh;
			box-sizing: border-box;
			padding: 0.75rem;
			background:
				radial-gradient(circle at 10% 0%, #ffe8c7, transparent 45%),
				radial-gradient(circle at 100% 100%, #ffe2d2, transparent 40%),
				var(--bg-0);
			display: flex;
			flex-direction: column;
			gap: 0.65rem;
			min-height: 0;
		}

		.app-shell * {
			box-sizing: border-box;
		}

		.app-shell header {
			display: flex;
			justify-content: space-between;
			align-items: baseline;
			gap: 0.75rem;
			background: var(--bg-1);
			border: 1px solid var(--line);
			border-radius: 12px;
			padding: 0.5rem 0.75rem;
		}

		.app-shell > header h1 {
			margin: 0;
			font-size: 1rem;
			letter-spacing: 0.02em;
		}

		.app-shell > header p {
			margin: 0;
			color: var(--ink-1);
			font-size: 0.8rem;
		}

		.controls {
			display: grid;
			grid-template-columns: minmax(0, 1.2fr) minmax(0, 1.3fr);
			gap: 0.6rem;
			align-items: end;
			background: var(--bg-1);
			border: 1px solid var(--line);
			border-radius: 12px;
			padding: 0.65rem 0.75rem;
		}

		.token-controls {
			display: grid;
			grid-template-columns: minmax(0, 1fr) auto;
			align-items: end;
			gap: 0.45rem;
		}

		.token-controls > button {
			white-space: nowrap;
		}

		.app-shell label {
			display: flex;
			flex-direction: column;
			gap: 0.35rem;
		}

		.app-shell label > span {
			font-size: 0.75rem;
			font-weight: 600;
			color: var(--ink-1);
		}

		.app-shell input {
			width: 100%;
			height: 2rem;
			padding: 0 0.6rem;
			border-radius: 8px;
			border: 1px solid var(--line);
			background: var(--bg-2);
			font-size: 0.9rem;
		}

		.worker-status {
			font-size: 0.8rem;
			color: var(--ink-1);
			display: flex;
			align-items: center;
			white-space: nowrap;
			grid-column: 1 / -1;
		}

		.actions {
			display: flex;
			gap: 0.45rem;
			align-items: center;
		}

		.app-shell button {
			height: 2rem;
			padding: 0 0.75rem;
			border-radius: 999px;
			border: 1px solid var(--line);
			background: var(--bg-1);
			font-weight: 600;
			font-size: 0.85rem;
			cursor: pointer;
		}

		.app-shell button:disabled {
			opacity: 0.6;
			cursor: not-allowed;
		}

		#run-button {
			background: var(--brand);
			color: #fff;
			border-color: #95421d;
		}

		.panes {
			min-height: 0;
			flex: 1;
			display: grid;
			grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
			gap: 0.65rem;
		}

		.panel {
			min-height: 0;
			height: 100%;
			display: flex;
			flex-direction: column;
			border: 1px solid var(--line);
			border-radius: 12px;
			background: var(--bg-1);
			overflow: hidden;
		}

		.app-shell > .panes .panel > h2 {
			margin: 0;
			font-size: 0.78rem;
			text-transform: uppercase;
			letter-spacing: 0.08em;
			color: var(--ink-1);
			padding: 0.45rem 0.7rem;
			border-bottom: 1px solid var(--line);
			background: #faf6ee;
		}

		.editor-host,
		.terminal-host {
			flex: 1;
			min-height: 0;
			height: 100%;
		}

		@media (max-width: 980px) {
			.controls {
				grid-template-columns: 1fr;
			}

			.panes {
				grid-template-columns: 1fr;
				grid-template-rows: minmax(13rem, 1fr) minmax(13rem, 1fr);
			}

			header {
				flex-direction: column;
				align-items: flex-start;
			}

			.token-controls {
				grid-template-columns: 1fr;
			}
		}
	`;
	document.head.append(style);
}

export async function mountApp(root: Element, runtimeStore: RuntimeStore) {
	applyStyles();

	let needsToken = urlToken.length === 0;
	let running = false;
	let workerInitializing = false;
	let workerReady = false;
	let workerError = "";
	let workerToken = "";
	let worker: NodeWorker | undefined;
	let terminal: TerminalController | undefined;
	let queuedLines: string[] = [];
	let runId = 0;

	let app = createAppShell();
	root.replaceChildren(app);

	let cwdInput = app.querySelector("#cwd-input") as HTMLInputElement;
	let tokenControls = app.querySelector("#token-controls") as HTMLDivElement;
	let tokenInput = app.querySelector("#token-input") as HTMLInputElement;
	let initButton = app.querySelector("#init-button") as HTMLButtonElement;
	let statusEl = app.querySelector("#worker-status") as HTMLDivElement;
	let runButton = app.querySelector("#run-button") as HTMLButtonElement;
	let clearButton = app.querySelector("#clear-button") as HTMLButtonElement;
	let editorHost = app.querySelector(".editor-host") as HTMLDivElement;
	let terminalHost = app.querySelector(".terminal-host") as HTMLDivElement;

	tokenControls.hidden = !needsToken;
	cwdInput.value = runtimeStore.cwd;
	tokenInput.value = runtimeStore.token;

	let editor = mountEditor(editorHost);
	editor.open(EVAL_PATH, runtimeStore.code);
	editor.onEdit((_, contents) => {
		runtimeStore.code = contents;
	});
	// No onCommand/onInterrupt: this UI has a Run button rather than a prompt, so the
	// terminal only ever renders program output and forwards keystrokes to stdin.
	terminal = mountTerminal(terminalHost, { onCommand: () => {}, onInterrupt: () => {} });

	const writeLine = (line: string) => {
		if (terminal) {
			terminal.writeLine(line);
			return;
		}
		queuedLines.push(line);
	};

	for (let line of queuedLines) {
		terminal.writeLine(line);
	}
	queuedLines = [];

	const writeStack = (err: unknown) => {
		if (!(err instanceof Error) || !err.stack) return;
		for (let line of err.stack.split("\n")) {
			if (line.trim()) writeLine(line);
		}
	};

	const updateUI = () => {
		let initLabel = workerInitializing ? "Initializing..." : workerReady ? "Reinitialize worker" : "Initialize worker";
		initButton.textContent = initLabel;
		initButton.disabled = workerInitializing;

		if (workerInitializing) {
			statusEl.textContent = "Worker: initializing";
		} else if (workerReady) {
			statusEl.textContent = "Worker: ready";
		} else if (workerError) {
			statusEl.textContent = "Worker: " + workerError;
		} else {
			statusEl.textContent = "Worker: idle";
		}

		runButton.disabled = running || workerInitializing;
		runButton.textContent = running ? "Running..." : workerInitializing ? "Worker initializing..." : "Run eval module";
	};

	const initWorker = async () => {
		if (workerInitializing) return;

		let token = needsToken ? runtimeStore.token.trim() : urlToken;
		if (!token) {
			workerError = "Missing puter.auth.token";
			writeLine("error: missing puter.auth.token");
			updateUI();
			return;
		}

		let cwd = runtimeStore.cwd.trim() || defaultCwd();

		workerInitializing = true;
		workerReady = false;
		workerError = "";
		updateUI();
		writeLine("worker: initializing...");

		try {
			worker?.terminate();
			worker = new NodeWorker(workerURL, token, cwd);
			terminal?.attachConsole(worker.console);
			await worker.ready;
			workerReady = true;
			workerToken = token;
			// Exposed for the devtools console: the memory-filesystem API
			// (mountMemory / writeMemory) is driven from the *host*, so there is
			// otherwise no way to exercise it from inside the testbed. Dev-only.
			if (import.meta.env.DEV) (window as any).__nodeWorker = worker;
			writeLine("worker: ready");
		} catch (err) {
			console.error("[node-worker-test] worker init failed", err);
			let message = err instanceof Error ? err.message : String(err);
			worker = undefined;
			workerReady = false;
			workerError = message;
			writeLine("worker: init failed - " + message);
			writeStack(err);
		} finally {
			workerInitializing = false;
			updateUI();
		}
	};

	const run = async () => {
		if (running || workerInitializing) return;

		let token = needsToken ? runtimeStore.token.trim() : urlToken;
		if (!token) {
			writeLine("error: missing puter.auth.token");
			return;
		}
		if (needsToken && workerReady && workerToken !== token) {
			writeLine("error: token changed, click Reinitialize worker");
			return;
		}
		if (!workerReady || !worker) {
			if (needsToken) {
				writeLine("error: worker not initialized, click Initialize worker");
				return;
			}
			await initWorker();
			if (!workerReady || !worker) return;
		}

		let cwd = runtimeStore.cwd.trim() || defaultCwd();
		let latestCode = editor.getContents(EVAL_PATH) ?? "";

		running = true;
		updateUI();
		writeLine("");
		writeLine(`$ run (${new Date().toLocaleTimeString()})`);
		writeLine("running...");

		try {
			runId += 1;
			let evalPath = evalModulePathForRun(cwd, runId);
			await worker.setCwd(cwd);
			await worker.registerVirtualModule(evalPath, latestCode);
			try {
				await worker.import(evalPath);
			} finally {
				await worker.removeVirtualModule(evalPath);
			}
		} catch (err) {
			console.error("[node-worker-test] run failed", err);
			let message = err instanceof Error ? err.message : String(err);
			writeLine("error: " + message);
			writeStack(err);
		} finally {
			running = false;
			updateUI();
		}
	};

	cwdInput.addEventListener("input", () => {
		runtimeStore.cwd = cwdInput.value;
	});
	tokenInput.addEventListener("input", () => {
		runtimeStore.token = tokenInput.value;
	});
	initButton.addEventListener("click", () => {
		void initWorker();
	});
	runButton.addEventListener("click", () => {
		void run();
	});
	clearButton.addEventListener("click", () => {
		terminal?.clear();
	});

	if (!needsToken || runtimeStore.token.trim().length > 0) {
		void initWorker();
	}

	updateUI();

	window.addEventListener("beforeunload", () => {
		editor.dispose();
		terminal?.dispose();
		worker?.terminate();
	});
}

