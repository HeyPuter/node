// The workspace: boot sequence, then the wiring between the mirror, the pool, the
// editor, the tree and the shell.

import type { NodeNetInit, NodeWorker } from "node-worker";

import { createMirrorTarget } from "./install/mirror-target";
import { PROJECT_ROOT, ProjectMirror, type MountEntry } from "./project/mirror";
import { fetchManifest, loadTemplate, type TemplateInfo } from "./project/template";
import { openProjectStore, pruneProjectStores } from "./project/opfs-store";
import { invalidateBins, runCommand, type CommandTarget } from "./runtime/command";
import { exportToDrive } from "./runtime/export";
import { WorkerPool, type PoolStatus } from "./runtime/pool";
import { PortWatcher, previewUrlFor, rewriteLocalhost } from "./runtime/preview";
import { isTextPath, mountEditor, type ProjectFile } from "./monaco";
import { mountTerminal } from "./terminal";
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
	/** Persisted UI state — which template was last used. */
	store: { template: string; flush(): Promise<void> };
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
	// --- template ---------------------------------------------------------
	splash.phase("download", 0, "Looking up the project template…");
	let manifest = await fetchManifest();
	let info =
		manifest.templates.find((t) => t.id === opts.store.template) ??
		manifest.templates.find((t) => t.id === manifest.default) ??
		manifest.templates[0];
	splash.log(`template: ${info.id} (create-vite ${info.createVite})`);

	// The other half of a template swap, done here because here is where nothing holds the
	// outgoing files open — see `pruneProjectStores`. Normally a no-op: there is one project
	// directory and it is the one being opened.
	let pruned = await pruneProjectStores(info.id);
	if (pruned.length > 0) splash.log(`cleaned up: ${pruned.join(", ")}`);

	// The project lives in the origin private filesystem, and the runtime mounts it from there —
	// so the template is unpacked once, on the first visit, and a reload finds it already present.
	// What used to be a 10 MB download and 391 writes on every load is now a directory walk.
	let store = await openProjectStore(info.id);
	let restored = store.existing;
	let entries: MountEntry[];
	if (store.existing) {
		splash.phase("extract", 0, "Opening your project…");
		entries = await store.hydrate((count) => {
			splash.phase("extract", 0, `Reading ${count} files…`);
		});
		splash.log(`project: ${entries.length} entries already on disk`);
	} else {
		entries = await loadTemplate(info, (p) => {
			splash.phase(p.phase, p.fraction ?? 0, `${phaseVerb(p.phase)} ${p.detail}`);
		});
		splash.log(`template: ${entries.length} entries, ${info.packages} packages`);
		splash.phase("extract", 0.9, "Saving the project…");
		await store.writeMany(entries);
	}
	// The mirror is the UI's read model: the tree and the editor want synchronous reads, and OPFS
	// has none. It is no longer a copy the worker needs — writes go through it to the store.
	//
	// Seeded before it has a target, deliberately: seeding *came from* the store, and writing all
	// of it back would double the boot cost for no effect. The target is set once the pool exists,
	// because that is what an edit has to travel through — see `pool.projectTarget`.
	mirror.seed(entries);

	// --- token ------------------------------------------------------------
	let auth = await opts.resolveAuth(() => splash.requestToken());
	let anonymous = !auth.token;
	if (anonymous) {
		splash.log("auth: anonymous — wisp relay + peer token, no Drive");
	}

	// --- terminal, so worker output has somewhere to go from the start ----
	//
	// Preview works either way, but an anonymous peer server is not listed under any user,
	// so the link has to carry the peer token for puter.surf to find it — see
	// `previewUrlFor`. Undefined when signed in, which is the signed-in link unchanged.
	let peerToken = auth.net?.peerToken;
	let watcher = new PortWatcher((port) => showPreview(el, port, peerToken));
	let pool: WorkerPool;
	let terminal = mountTerminal(el.shell, {
		onCommand: (line) => void submit(line),
		onInterrupt: () => void pool.stop(),
		onResize: (size) => void pool.setTerminalSize(size),
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

	renderTemplates(el, manifest.templates, info);

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
	let ctx = {
		target: commandTarget,
		write: (text: string) => terminal.write(text),
		env: () => ({ ...BASE_ENV }),
		nodeVersion: () => nodeVersion,
		clear: () => terminal.clear(),
	};

	let submit = async (line: string) => {
		if (busy) return;
		busy = true;
		setBusy(el, true, runLabel(info));
		watcher.reset();
		hidePreview(el);
		try {
			await runCommand(line, ctx);
			// An install can add package binaries, so the cached index is stale.
			if (/^\s*npm\s+(install|i)\b/.test(line)) invalidateBins(commandTarget);
		} catch (err) {
			terminal.write(`shell: ${err instanceof Error ? err.message : String(err)}\n`);
		} finally {
			busy = false;
			setBusy(el, false, runLabel(info));
			terminal.prompt();
		}
	};

	el.runBtn.addEventListener("click", () => {
		if (busy) void pool.stop();
		else void submit(info.start);
	});
	el.runFileBtn.addEventListener("click", () => {
		let path = tabs.active;
		if (path) void submit(`node ${path}`);
	});
	el.clearBtn.addEventListener("click", () => {
		terminal.clear();
		terminal.fit();
	});
	el.restartBtn.addEventListener("click", () => {
		if (busy) return;
		void (async () => {
			busy = true;
			setBusy(el, true, runLabel(info));
			terminal.write("worker: restarting…\n");
			hidePreview(el);
			try {
				await pool.restart();
				terminal.write("worker: ready\n");
			} catch (err) {
				terminal.write(`worker: restart failed — ${message(err)}\n`);
			} finally {
				busy = false;
				setBusy(el, false, runLabel(info));
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
			setBusy(el, true, runLabel(info));
			try {
				// Where to write is resolved per click, not at boot: an anonymous workspace has
				// no account yet, and this is where it gets one — `prepareExport` runs the
				// puter.js sign-in flow and then answers with that account's directory.
				let destination = await opts.prepareExport();
				await exportToDrive({
					puter: (globalThis as any).puter,
					mirror,
					destination,
					write: (text) => terminal.write(text),
				});
			} catch (err) {
				// Cancelling the sign-in popup lands here, and it is an ordinary outcome
				// rather than a failure worth breaking the workspace over.
				terminal.write(`export: ${message(err)}\n`);
			} finally {
				busy = false;
				setBusy(el, false, runLabel(info));
				terminal.prompt();
			}
		})();
	});
	/**
	 * A template swap replaces the project wholesale, so the simplest correct thing is to
	 * start over — the alternative is reconciling two unrelated trees.
	 *
	 * What the reload does not do by itself is release the outgoing project. It is a
	 * directory in OPFS that this page has *mounted* into every worker it built, and the
	 * next load deletes it (see `pruneProjectStores`) — so the workers have to be gone
	 * first, and the choice of template has to be durably written before navigating, or the
	 * new page prunes on behalf of the template we are leaving.
	 */
	let swapTemplate = async (next: TemplateInfo) => {
		busy = true;
		setBusy(el, true, runLabel(info));
		hidePreview(el);
		terminal.write(`\nswitching to the ${next.id} template…\n`);

		try {
			opts.store.template = next.id;
			await opts.store.flush();
		} catch (err) {
			// Nothing has been torn down yet, so put the workspace back rather than
			// stranding it on a template it did not switch to.
			terminal.write(`switch failed — ${message(err)}\n`);
			el.presetSelect.value = info.id;
			busy = false;
			setBusy(el, false, runLabel(info));
			terminal.prompt();
			return;
		}

		// `beforeunload` would do this too, but a swap is exactly the case where it must
		// not be left to chance: an access handle that outlives the page is a file the
		// next load cannot delete.
		await pool.stop();
		pool.dispose();
		window.location.reload();
	};

	el.presetSelect.addEventListener("change", () => {
		let next = manifest.templates.find((t) => t.id === el.presetSelect.value);
		// Nothing to do for the template already loaded, and a run holds the worker whose
		// files are about to be deleted.
		if (!next || next.id === info.id || busy) {
			el.presetSelect.value = info.id;
			return;
		}
		void swapTemplate(next);
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
			submit: (line: string) => submit(line),
			isBusy: () => busy,
		};
	}

	window.addEventListener("beforeunload", () => {
		editor.dispose();
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
		terminal.writeLine(
			restored
				? `${info.id} template restored from this device (${info.packages} packages)`
				: `${info.id} template unpacked (${info.packages} packages)`
		);
		terminal.writeLine("type help, or hit Run dev server");
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
		el.runBtnLabel.textContent = runLabel(info);
	});
}

// ------------------------------------------------------------------ helpers

function phaseVerb(phase: string): string {
	return phase === "download" ? "Downloading" : "Unpacking";
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

function renderTemplates(el: ShellElements, templates: TemplateInfo[], active: TemplateInfo) {
	el.presetSelect.replaceChildren(
		...templates.map((t) => {
			let option = document.createElement("option");
			option.value = t.id;
			option.textContent = t.label;
			option.selected = t.id === active.id;
			return option;
		})
	);
	el.runBtnLabel.textContent = runLabel(active);
}

function runLabel(info: TemplateInfo): string {
	return info.start === "npm run dev" ? "Run dev server" : `Run ${info.start}`;
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
}

function showPreview(el: ShellElements, port: number, peerToken?: string) {
	el.previewChip.hidden = false;
	el.previewChip.href = previewUrlFor(port, "/", peerToken);
	el.previewChipLabel.textContent = `Preview :${port}`;
}

function hidePreview(el: ShellElements) {
	el.previewChip.hidden = true;
}

function message(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
