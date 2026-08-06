// The workspace: boot sequence, then the wiring between the mirror, the pool, the
// editor, the tree and the shell.

import type { NodeNetInit, NodeWorker } from "node-worker";

import { createMirrorTarget } from "./install/mirror-target";
import { PROJECT_ROOT, ProjectMirror } from "./project/mirror";
import { fetchManifest, type TemplateInfo } from "./project/template";
import {
	pickLocalDir,
	localDirSupported,
	loadLocalDir,
	saveLocalDir,
} from "./project/local-dir";
import {
	resolveProject,
	type ResolvedProject,
	type SourceKind,
} from "./project/source";
import { type CommandTarget } from "./runtime/programs";
import { exportToDrive } from "./runtime/export";
import { WorkerPool, type PoolStatus } from "./runtime/pool";
import { PortWatcher, previewUrlFor, rewriteLocalhost } from "./runtime/preview";
import { isTextPath, mountEditor, type ProjectFile } from "./monaco";
import { completeLine } from "./shell/complete";
import { fromProjectRelative } from "./shell/paths";
import { createWorkspaceShell, type WorkspaceShell } from "./shell/shell";
import { mountTerminal } from "./terminal";
import { mountExportDialog } from "./ui/export-dialog";
import { mountFolderDialog } from "./ui/folder-dialog";
import { buildShell, type ShellElements } from "./ui/shell";
import { mountSplash } from "./ui/splash";
import { mountTabs } from "./ui/tabs";
import { mountTree } from "./ui/tree";

/**
 * `env` on a run replaces process.env outright rather than merging, so anything the
 * runtime would otherwise have defaulted to is spelled out here.
 */
const BASE_ENV: Record<string, string> = {
	TERM: "xterm-256color",
	NODE_ENV: "development",
	FORCE_COLOR: "1",
};

/** Where `process.version` is stashed by the boot probe, then read back. */
const PROBE_PATH = ".node-worker/boot.json";

/**
 * Directories kept out of the editor's TypeScript program.
 *
 * `node_modules` supplies declarations, not sources — its implementation files would
 * add tens of thousands of models for no benefit. `dist` is bundled output: checking
 * generated code produces diagnostics about nothing anyone can act on.
 */
const NON_SOURCE_DIRS = ["node_modules/", "dist/"];

/**
 * TypeScript's own bundled standard library, which must not be handed to Monaco.
 *
 * Monaco ships its own copy of these, and loading a second one redeclares every
 * built-in global — thousands of duplicate-identifier errors across the project.
 */
const TS_STDLIB = /^node_modules\/typescript\/lib\/lib\..*\.d\.ts$/;

/** How long to coalesce mirror changes before rebuilding the type set. */
const TYPES_DEBOUNCE_MS = 400;

export interface WorkspaceOptions {
	root: Element;
	/**
	 * Resolves how this workspace is authenticated, prompting only if it has to.
	 *
	 * An empty `token` with a `net` is an anonymous run: no puter token exists, the
	 * runtime's network comes from the relay URL and peer token in `net`, and Drive —
	 * puterfs under "/", and Export — is unavailable.
	 */
	resolveAuth: (
		prompt: () => Promise<string>
	) => Promise<{ token: string; net?: NodeNetInit }>;
	/** Persisted UI state — which source the project came from, and which template. */
	store: { source: string; template: string; flush(): Promise<void> };
	/**
	 * Make Export possible, and answer the Drive directory it should write into.
	 *
	 * Called on each Export, because an anonymous workspace has no account until someone
	 * asks for one: this is where puter.js signs them in (or creates an account), and the
	 * directory it returns is that account's. Rejects if they change their mind.
	 */
	prepareExport: () => Promise<string>;
}

export async function mountWorkspace(opts: WorkspaceOptions): Promise<void> {
	let el: ShellElements = buildShell(opts.root);
	let splash = mountSplash(el);
	let mirror = new ProjectMirror();

	try {
		await boot(el, splash, mirror, opts);
	} catch (err) {
		let text = err instanceof Error ? err.message : String(err);
		splash.fail(text);
		throw err;
	}
}

async function boot(
	el: ShellElements,
	splash: ReturnType<typeof mountSplash>,
	mirror: ProjectMirror,
	opts: WorkspaceOptions
): Promise<void> {
	// --- project ----------------------------------------------------------
	splash.phase("download", 0, "Looking up the project template…");
	let manifest = await fetchManifest();
	// The manifest is fetched even with a folder open, because the source select still lists the
	// templates and an empty folder is offered one to unpack.
	let folderDialog = mountFolderDialog(el);
	let project = await resolveProject({
		manifest,
		source: opts.store.source,
		template: opts.store.template,
		report: splash,
		requestFolder: (req) => splash.requestFolder(req),
		confirmScaffold: (name, info) => folderDialog.confirmScaffold(name, info),
		// Fire-and-forget, as every other write to the store is: nothing reloads here, so
		// there is no navigation for it to lose a race with.
		onSourceChanged: (kind) => {
			opts.store.source = kind;
		},
	});
	let store = project.store;
	let info = project.template;
	// Constant for the life of the page: a source swap reloads rather than reconciling, so the
	// button's idle label is decided here and never recomputed.
	let idleLabel = runLabel(project.start);
	// Read even when a template is loaded, so the select can still offer a folder from a
	// previous visit. `name` is a plain property — reading it needs no permission.
	let rememberedFolder = localDirSupported() ? (await loadLocalDir())?.name : undefined;

	// The mirror is the UI's read model: the tree and the editor want synchronous reads, and a
	// directory handle has none. It is no longer a copy the worker needs — writes go through it
	// to the store.
	//
	// Seeded before it has a target, deliberately: seeding *came from* the store, and writing all
	// of it back would double the boot cost for no effect — and against a folder somebody picked,
	// it would rewrite every file in their project on open. The target is set once the pool
	// exists, because that is what an edit has to travel through — see `pool.projectTarget`.
	splash.phase(
		"save",
		1,
		`Building the file tree from ${project.entries.length.toLocaleString()} entries…`
	);
	mirror.seed(project.entries);

	// --- token ------------------------------------------------------------
	//
	// Reported, because it is not free and it used to run under whatever the project step had
	// last said: an anonymous run mints a peer token, waits for that write to land, then fetches
	// a relay URL. Measured at 360 ms through the dev proxy and worse as a Puter app, where the
	// write is a real round trip and `waitForPuterKV` will sit for up to five seconds waiting for
	// the SDK to show up. However long it takes, the splash used to spend it insisting it was
	// still saving files — which is how a slow connection came to look like a slow save.
	splash.phase("auth", 0, "Connecting…");
	let auth = await opts.resolveAuth(() => splash.requestToken());
	let anonymous = !auth.token;
	if (anonymous) {
		splash.log("auth: anonymous — wisp relay + peer token; Export signs in when asked");
	}

	// --- terminal, so worker output has somewhere to go from the start ----
	//
	// Preview works either way, but an anonymous peer server is not listed under any user,
	// so the link has to carry the peer token for browser.puter.com to find it — see
	// `previewUrlFor`. Undefined when signed in, which is the signed-in link unchanged.
	let peerToken = auth.net?.peerToken;
	let watcher = new PortWatcher((port) => showPreview(el, port, peerToken));
	let pool: WorkerPool;
	// Both are built after the terminal — the shell needs a worker pool to run programs in, and the
	// pool needs somewhere to send their output — so the handlers reach for them lazily. During
	// boot neither exists yet, which is why ctrl-C has something to fall back on.
	let shell: WorkspaceShell | undefined;
	/**
	 * Stop whatever is running.
	 *
	 * The preview chip goes with it: it points at a port a program was serving, and that program is
	 * being killed — so leaving it up would offer a link to a server that is no longer there.
	 */
	function interrupt() {
		watcher.reset();
		hidePreview(el);
		if (shell) shell.interrupt();
		else void pool.stop();
	}

	splash.phase("auth", 1, "Preparing the terminal…");
	let terminal = mountTerminal(el.shell, {
		onCommand: (line) => void submit(line),
		onInterrupt: interrupt,
		onResize: (size) => void pool.setTerminalSize(size),
		onComplete: (line, cursor) =>
			shell &&
			completeLine(line, cursor, {
				mirror,
				cwd: () => shell!.cwd,
				commandNames: () => shell!.commandNames(),
			}),
	});
	terminal.setLinkHandler((uri) => rewriteLocalhost(uri, peerToken));
	// Registered once, not per worker: the tap is on the terminal, which outlives every
	// worker attached to it.
	terminal.onOutput((text) => watcher.observe(text));

	// --- worker -----------------------------------------------------------
	splash.phase("worker", 0.2, "Booting the Node.js worker…");
	pool = new WorkerPool({
		mirror,
		projectHandle: store.handle,
		store,
		token: auth.token,
		net: auth.net,
		attach: (worker: NodeWorker) => terminal.attachConsole(worker.console),
		terminalSize: () => terminal.size,
		onStatus: (status, detail) => setStatus(el, status, detail),
		onLog: (text) => terminal.write(text),
	});
	mirror.setTarget(pool.projectTarget);

	// No populate phase left to report — the worker mounts the project rather than being filled
	// with it — so this is just the runtime's own boot.
	await pool.start();
	splash.log("worker: ready");

	// --- probe ------------------------------------------------------------
	splash.phase("probe", 0.5, "Checking the runtime…");
	let nodeVersion = await probeRuntime(pool, mirror);
	splash.log(`runtime: node ${nodeVersion}`);

	// --- workspace --------------------------------------------------------
	let editor = mountEditor(el.code);
	let tabs = mountTabs(el.tabs, {
		onSelect: (path) => openFile(path),
		onClose: (path) => {
			tabs.close(path);
			editor.close(path);
			showActive();
		},
	});
	let tree = mountTree(el.tree, mirror, (path) => openFile(path));
	let exportDialog = mountExportDialog(el);

	let openFile = (path: string) => {
		if (!mirror.has(path)) return;
		if (!isTextPath(path)) {
			terminal.write(`(${path} is not a text file)\n`);
			return;
		}
		editor.open(path, mirror.readText(path) ?? "");
		tabs.open(path);
		tree.setActive(path);
		tree.reveal(path);
	};

	let showActive = () => {
		let path = tabs.active;
		tree.setActive(path);
		if (path) editor.open(path, mirror.readText(path) ?? "");
	};

	editor.onDirty((path) => tabs.setDirty(path, true));
	// An edit goes to the mirror, which persists it through the running worker's filesystem — so a
	// dev server watching inside that worker sees a save as the filesystem change it is, and
	// rebuilds. There is nothing to push into the next worker: it mounts the same store.
	editor.onEdit((path, contents) => {
		mirror.write(path, contents);
		tabs.setDirty(path, false);
	});

	renderSources(el, manifest.templates, project, rememberedFolder, idleLabel);
	if (!localDirSupported()) {
		// Marked as well as disabled so `setBusy` can tell a browser that will never do this
		// from a run that is only holding it for now, and leave the former alone.
		el.openFolderBtn.dataset.unsupported = "true";
		el.openFolderBtn.disabled = true;
		el.openFolderBtn.title =
			"this browser cannot open a folder from your device — Chrome, Edge and other Chromium browsers can";
	}
	// Set once, not in `setBusy`: this is a property of the project rather than of what is
	// running, so nothing that finishes should hand back a button with nothing behind it.
	if (!project.start) {
		el.runBtn.disabled = true;
		el.runBtn.title =
			"this project has no dev or start script in its package.json — run something from the shell instead";
	}

	// The editor's view of the project: its sources as one program, and its
	// node_modules declarations as ambient types. Sources sync immediately (they are
	// few, and a stale one means a spurious error on screen); types are debounced,
	// because an `npm install` rewrites node_modules a package at a time.
	let syncSources = () => editor.syncSources(collectSources(mirror));
	let typesTimer: number | undefined;
	let syncTypes = () => {
		if (typesTimer !== undefined) clearTimeout(typesTimer);
		typesTimer = setTimeout(() => {
			typesTimer = undefined;
			editor.syncTypeLibs(collectTypeLibs(mirror));
		}, TYPES_DEBOUNCE_MS) as unknown as number;
	};
	syncSources();
	editor.syncTypeLibs(collectTypeLibs(mirror));

	mirror.onChange(() => {
		syncSources();
		syncTypes();
		// A file open in the editor may have been rewritten by a program.
		for (let path of tabs.paths) {
			let latest = mirror.readText(path);
			if (latest !== undefined) editor.setContents(path, latest);
		}
	});

	// --- commands ---------------------------------------------------------
	let busy = false;
	let install = createMirrorTarget(mirror);
	let commandTarget: CommandTarget = {
		label: PROJECT_ROOT,
		install,
		absolute: (path) => (path === "" ? PROJECT_ROOT : `${PROJECT_ROOT}/${path}`),
		hasFile: async (path) => mirror.has(path),
		run: (request) => pool.run(request),
	};
	shell = createWorkspaceShell({
		mirror,
		target: commandTarget,
		write: (text: string) => terminal.write(text),
		baseEnv: BASE_ENV,
		nodeVersion: () => nodeVersion,
		endProgram: () => terminal.endProgram(),
		onCwdChange: (cwd) => terminal.setPrompt(promptFor(cwd)),
		pool,
	});
	// Package binaries are commands of the shell's, so it has to know their names. Refreshed from
	// here at boot, and by the shell itself after an install adds more.
	let shadowed = await shell.refreshBins();

	/**
	 * Run a command line.
	 *
	 * `echo` is for lines nobody typed — the buttons'. Without it the terminal is still sitting on
	 * a drawn prompt waiting for input, so the command's first output would appear immediately
	 * after the `$` as though it were part of what was typed.
	 */
	let submit = async (line: string, echo = false) => {
		if (busy) return;
		if (echo) terminal.echoCommand(line);
		busy = true;
		setBusy(el, true, idleLabel);
		watcher.reset();
		hidePreview(el);
		try {
			await shell!.run(line);
		} catch (err) {
			terminal.write(`shell: ${err instanceof Error ? err.message : String(err)}\n`);
		} finally {
			busy = false;
			setBusy(el, false, idleLabel);
			terminal.prompt();
		}
	};

	el.runBtn.addEventListener("click", () => {
		// Through the shell, so stopping a dev server also ends the rest of the line it was part of.
		if (busy) interrupt();
		// Disabled without a start command, so this is belt and braces rather than a live path.
		else if (project.start) void submit(project.start, true);
	});
	el.runFileBtn.addEventListener("click", () => {
		let path = tabs.active;
		// Absolute, because the shell's directory is wherever the last `cd` left it.
		if (path) void submit(`node ${quoteArg(fromProjectRelative(path))}`, true);
	});
	el.clearBtn.addEventListener("click", () => {
		terminal.clear();
		terminal.fit();
	});
	el.restartBtn.addEventListener("click", () => {
		if (busy) return;
		void (async () => {
			busy = true;
			setBusy(el, true, idleLabel);
			// Leading newline for the same reason `submit` echoes: the prompt is still on screen.
			terminal.write("\nworker: restarting…\n");
			hidePreview(el);
			try {
				await pool.restart();
				terminal.write("worker: ready\n");
			} catch (err) {
				terminal.write(`worker: restart failed — ${message(err)}\n`);
			} finally {
				busy = false;
				setBusy(el, false, idleLabel);
				terminal.prompt();
			}
		})();
	});
	if (anonymous) {
		el.exportBtn.title = "Export copies the project to Puter Drive — asks you to sign in first";
	}
	el.exportBtn.addEventListener("click", () => {
		if (busy) return;
		void (async () => {
			busy = true;
			setBusy(el, true, idleLabel);
			terminal.write("\n");
			// Held until the shell has its prompt back, rather than shown where the export
			// finishes: what the dialog covers should be a finished workspace and the
			// export's own log lines, not a shell still mid-run behind it.
			let exported: string | undefined;
			try {
				// Where to write is resolved per click, not at boot: an anonymous workspace has
				// no account yet, and this is where it gets one — `prepareExport` runs the
				// puter.js sign-in flow and then answers with that account's directory.
				let destination = await opts.prepareExport();
				let exitCode = await exportToDrive({
					puter: (globalThis as any).puter,
					mirror,
					destination,
					write: (text) => terminal.write(text),
				});
				if (exitCode === 0) exported = destination;
			} catch (err) {
				// Cancelling the sign-in popup lands here, and it is an ordinary outcome
				// rather than a failure worth breaking the workspace over.
				terminal.write(`export: ${message(err)}\n`);
			} finally {
				busy = false;
				setBusy(el, false, idleLabel);
				terminal.prompt();
			}
			// A copy on Drive is not visible from this page at all, so this is where an
			// export becomes usable: the steps that run it from the Puter desktop. Only on
			// success, since otherwise they would be steps for files that are not there.
			if (exported !== undefined) {
				exportDialog.show(exported, project.start ?? "npm run dev");
			}
		})();
	});

	/** The option value the source select is showing right now, so a cancel can put it back. */
	let activeValue = () =>
		project.kind === "local" ? "local" : `template:${info.id}`;

	/**
	 * Switching source replaces the project wholesale, so the simplest correct thing is to
	 * start over — the alternative is reconciling two unrelated trees.
	 *
	 * What the reload does not do by itself is release the outgoing project. A template is a
	 * directory in OPFS that this page has *mounted* into every worker it built, and the next
	 * load deletes it (see `pruneProjectStores`) — so the workers have to be gone first, and the
	 * choice has to be durably written before navigating, or the new page prunes on behalf of the
	 * template we are leaving. A picked folder is never deleted, but it is still held open by a
	 * worker, and a lock that outlives the page is somebody's file they cannot write.
	 *
	 * `prepare` runs before anything is torn down and may decline, which is how the folder
	 * picker fits: it needs the click, and cancelling it has to leave the workspace exactly
	 * where it was.
	 */
	let swapSource = async (
		next: { kind: SourceKind; template?: string; describe: string },
		prepare?: () => Promise<boolean>
	) => {
		if (busy) return;
		busy = true;
		setBusy(el, true, idleLabel);

		try {
			if (prepare && !(await prepare())) {
				el.presetSelect.value = activeValue();
				busy = false;
				setBusy(el, false, idleLabel);
				return;
			}
		} catch (err) {
			terminal.write(`\nswitch failed — ${message(err)}\n`);
			el.presetSelect.value = activeValue();
			busy = false;
			setBusy(el, false, idleLabel);
			terminal.prompt();
			return;
		}

		hidePreview(el);
		terminal.write(`\nswitching to ${next.describe}…\n`);

		try {
			opts.store.source = next.kind;
			if (next.template) opts.store.template = next.template;
			await opts.store.flush();
		} catch (err) {
			// Nothing has been torn down yet, so put the workspace back rather than
			// stranding it on a source it did not switch to.
			terminal.write(`switch failed — ${message(err)}\n`);
			el.presetSelect.value = activeValue();
			busy = false;
			setBusy(el, false, idleLabel);
			terminal.prompt();
			return;
		}

		// `beforeunload` would do this too, but a swap is exactly the case where it must
		// not be left to chance: an access handle that outlives the page is a file the
		// next load cannot delete — or, for a folder, cannot write.
		await pool.stop();
		pool.dispose();
		window.location.reload();
	};

	el.openFolderBtn.addEventListener("click", () => {
		// Everything that needs the gesture happens in `prepare`, which `swapSource` calls
		// before it tears anything down — so a dismissed picker costs nothing.
		void swapSource({ kind: "local", describe: "a folder on this device" }, async () => {
			let handle = await pickLocalDir();
			// Dismissed the picker: an ordinary change of mind, not a failure.
			if (!handle) return false;
			if (!(await folderDialog.confirmOpen(handle.name))) return false;
			// Saved before the reload, because the next load has no other way to find it.
			await saveLocalDir(handle);
			return true;
		});
	});

	el.presetSelect.addEventListener("change", () => {
		let value = el.presetSelect.value;
		// A run holds the worker whose files are about to go away.
		if (value === activeValue() || busy) {
			el.presetSelect.value = activeValue();
			return;
		}

		if (value === "local") {
			// The remembered folder, which needs its permission again — so the next load asks
			// for it on the splash rather than this click trying to.
			void swapSource({
				kind: "local",
				describe: `“${rememberedFolder ?? "your folder"}”`,
			});
			return;
		}

		let next = manifest.templates.find((t) => `template:${t.id}` === value);
		if (!next) {
			el.presetSelect.value = activeValue();
			return;
		}
		void swapSource({
			kind: "template",
			template: next.id,
			describe: `the ${next.id} template`,
		});
	});

	// Exposed for the devtools console, and for driving the workspace from a browser
	// automation harness: `submit` is the same entry point the shell prompt uses, so
	// anything exercised through it goes down the real path. Dev-only, as with the
	// `__nodeWorker` handle the testbed has always published.
	if (import.meta.env.DEV) {
		(window as any).__workspace = {
			mirror,
			pool,
			terminal,
			shell,
			// Reachable without an export, which needs a signed-in account and a popup: the
			// dialog's own behaviour is worth exercising on its own.
			exportDialog,
			// Same reason, more so: `showDirectoryPicker` opens a dialog belonging to the
			// operating system, which no automation harness can answer — so the only way to
			// exercise what surrounds it is to reach these directly.
			folderDialog,
			project,
			// Echoes by default, so a transcript read back from an automation harness shows which
			// command produced which output.
			submit: (line: string, echo = true) => submit(line, echo),
			isBusy: () => busy,
		};
	}

	window.addEventListener("beforeunload", () => {
		editor.dispose();
		shell?.dispose();
		terminal.dispose();
		tree.dispose();
		tabs.dispose();
		pool.dispose();
	});

	// --- open -------------------------------------------------------------
	splash.finish(() => {
		splash.hide();
		terminal.fit();
		editor.layout();
		terminal.writeLine(`worker: ready — node ${nodeVersion} on wasm`);
		terminal.writeLine(project.summary);
		// Said in the terminal as well as the startup log, because a source that quietly
		// resolved to something other than what was asked for is exactly the thing someone
		// would otherwise take for a bug.
		if (project.notice) terminal.writeLine(`note: ${project.notice}`);
		if (project.kind === "local") {
			terminal.writeLine(
				"writes here are writes to that folder — .git is mounted but kept out of the tree"
			);
		}
		terminal.writeLine(
			project.start
				? `bash over ${PROJECT_ROOT} — type help, or hit ${idleLabel}`
				: `bash over ${PROJECT_ROOT} — type help (no dev or start script to run)`
		);
		if (shadowed.length > 0) {
			// Said once, at boot, because it is a property of what is installed rather than of any
			// command: the shell's own `sort` is not the package's, and `npm exec` is how to say so.
			terminal.writeLine(
				`note: node_modules also provides ${shadowed.join(", ")} — the shell's own win; use "npm exec <name>"`
			);
		}
		terminal.setPrompt(promptFor(PROJECT_ROOT));
		terminal.prompt();

		// Most specific first: a react template's entry point is `src/main.tsx`, and opening
		// its `index.html` instead would show the one file in the project with nothing in it.
		for (let candidate of [
			"src/App.tsx",
			"src/main.tsx",
			"src/main.ts",
			"src/main.js",
			"index.html",
			"package.json",
		]) {
			if (mirror.has(candidate)) {
				openFile(candidate);
				break;
			}
		}
		el.runBtnLabel.textContent = idleLabel;
	});
}

// ------------------------------------------------------------------ helpers

/**
 * The prompt for a working directory.
 *
 * Truncated from the left when it gets long, because the prompt shares one row with whatever is
 * being typed — and `redraw` rewrites exactly one row, so a prompt that pushes the line into a
 * second one redraws imperfectly.
 */
function promptFor(cwd: string): string {
	let shown = cwd;
	if (shown.length > 28) {
		let parts = shown.split("/").filter(Boolean);
		if (parts.length > 2) shown = `…/${parts.slice(-2).join("/")}`;
	}
	return `\x1b[38;2;154;161;173m${shown} $\x1b[0m `;
}

/** Quote a path for the shell, since a file name may contain spaces. */
function quoteArg(arg: string): string {
	return /[^A-Za-z0-9_./@+-]/.test(arg) ? `'${arg.replace(/'/g, "'\\''")}'` : arg;
}

/** The project's own files, as the editor's program. */
function collectSources(mirror: ProjectMirror): ProjectFile[] {
	let out: ProjectFile[] = [];
	for (let { path } of mirror.allFiles()) {
		if (NON_SOURCE_DIRS.some((dir) => path.startsWith(dir))) continue;
		if (!isTextPath(path)) continue;
		let contents = mirror.readText(path);
		if (contents !== undefined) out.push({ path, contents });
	}
	return out;
}

/**
 * The declarations the project's dependencies provide.
 *
 * `package.json` is included alongside the `.d.ts` files because module resolution
 * needs it: `types`/`exports` is how a bare `import … from "vite"` finds
 * `dist/node/index.d.ts`, and Monaco's language service resolves against exactly the
 * file set it is given.
 */
function collectTypeLibs(mirror: ProjectMirror): ProjectFile[] {
	let out: ProjectFile[] = [];
	for (let { path } of mirror.allFiles()) {
		if (!path.startsWith("node_modules/")) continue;
		let isDecl = path.endsWith(".d.ts");
		let isManifest = path.endsWith("/package.json");
		if (!isDecl && !isManifest) continue;
		if (TS_STDLIB.test(path)) continue;
		let contents = mirror.readText(path);
		if (contents !== undefined) out.push({ path, contents });
	}
	return out;
}


/**
 * Run a throwaway module that records what the runtime says about itself, then read it
 * back out of the mount.
 *
 * Doubles as a smoke test: if resolution, execution and read-back all work, the
 * workspace is genuinely usable, and if they don't the splash says so rather than the
 * first command failing mysteriously.
 */
async function probeRuntime(pool: WorkerPool, mirror: ProjectMirror): Promise<string> {
	let code = [
		`import { mkdirSync, writeFileSync } from "node:fs";`,
		`mkdirSync("${PROJECT_ROOT}/.node-worker", { recursive: true });`,
		`writeFileSync(`,
		`  "${PROJECT_ROOT}/${PROBE_PATH}",`,
		`  JSON.stringify({ version: process.version, cwd: process.cwd() })`,
		`);`,
	].join("\n");

	let path = "[probe].mjs";
	let result = await pool.run({
		path,
		argv: ["node"],
		env: { ...BASE_ENV },
		virtualModule: { path, code },
	});
	if (result.error) throw result.error;

	let probe = mirror.readJson<{ version?: string }>(PROBE_PATH);
	mirror.delete(".node-worker");
	if (!probe?.version) throw new Error("runtime probe wrote nothing back");
	return probe.version;
}

/**
 * The source select: every template, plus the folder this device remembers.
 *
 * Grouped rather than flat because the two are not alternatives of the same kind — a template is
 * something this app unpacks into its own storage, and the folder is somewhere on the user's
 * machine. The folder option only appears once there is one to offer, which is also why a fresh
 * visit sees an unchanged template picker.
 */
function renderSources(
	el: ShellElements,
	templates: TemplateInfo[],
	active: ResolvedProject,
	folderName: string | undefined,
	idleLabel: string
) {
	let group = (label: string, options: HTMLOptionElement[]) => {
		let optgroup = document.createElement("optgroup");
		optgroup.label = label;
		optgroup.append(...options);
		return optgroup;
	};
	let option = (value: string, text: string, selected: boolean) => {
		let el = document.createElement("option");
		el.value = value;
		el.textContent = text;
		el.selected = selected;
		return el;
	};

	let children: HTMLElement[] = [
		group(
			"Templates",
			templates.map((t) =>
				option(
					`template:${t.id}`,
					t.label,
					active.kind === "template" && t.id === active.template.id
				)
			)
		),
	];
	if (folderName) {
		children.push(
			group("This device", [
				option("local", `📁 ${folderName}`, active.kind === "local"),
			])
		);
	}

	el.presetSelect.replaceChildren(...children);
	el.runBtnLabel.textContent = idleLabel;
}

/**
 * What the Run button says.
 *
 * Undefined is a real answer, not a missing one: a folder whose `package.json` has no `dev` and no
 * `start` has nothing for this button to do, and saying so beats a button that reliably fails.
 */
function runLabel(start: string | undefined): string {
	if (!start) return "Nothing to run";
	return start === "npm run dev" ? "Run dev server" : `Run ${start}`;
}

function setStatus(el: ShellElements, status: PoolStatus, detail?: string) {
	let state = status === "error" ? "error" : status === "ready" || status === "running" ? "ready" : "booting";
	el.statusPill.dataset.state = state;
	el.statusText.textContent =
		status === "running"
			? "running"
			: status === "ready"
				? "ready"
				: status === "error"
					? (detail ?? "crashed")
					: "starting";
}

function setBusy(el: ShellElements, busy: boolean, idleLabel: string) {
	// The mock's Run button becomes Stop: with one worker per run there is nothing else
	// to press while a program holds it, and a dev server holds it indefinitely.
	el.runBtnLabel.textContent = busy ? "Stop" : idleLabel;
	el.runBtnIcon.style.display = busy ? "none" : "";
	el.runFileBtn.disabled = busy;
	el.exportBtn.disabled = busy;
	el.restartBtn.disabled = busy;
	el.presetSelect.disabled = busy;
	// Says *why* it is unavailable, which the greying alone cannot: a switch reloads the page,
	// so it has to wait for whatever holds the worker. See `.select-pill[data-locked]`.
	el.presetPill.dataset.locked = busy ? "true" : "false";
	if (busy) {
		el.presetPill.title = "Stop what is running first — switching project reloads the page";
	} else {
		el.presetPill.removeAttribute("title");
	}
	// Opening a folder swaps the project the same way the select does, so it waits for the same
	// reason — `swapSource` already declines while busy, and this stops the click that goes
	// nowhere. The button keeps its own title: a disabled one shows no tooltip in every browser,
	// which is why the reason sits on the pill beside it.
	el.openFolderBtn.disabled = busy || el.openFolderBtn.dataset.unsupported === "true";
}

function showPreview(el: ShellElements, port: number, peerToken?: string) {
	el.previewBtn.hidden = false;
	el.previewBtn.href = previewUrlFor(port, "/", peerToken);
	el.previewBtnLabel.textContent = `Preview :${port}`;
}

function hidePreview(el: ShellElements) {
	el.previewBtn.hidden = true;
}

function message(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
