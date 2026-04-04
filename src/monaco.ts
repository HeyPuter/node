import * as monaco from "monaco-editor";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import jsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import cssWorker from "monaco-editor/esm/vs/language/css/css.worker?worker";
import htmlWorker from "monaco-editor/esm/vs/language/html/html.worker?worker";
import tsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";

(self as any).MonacoEnvironment = {
	getWorker(_: unknown, label: string) {
		if (label === "json") return new jsonWorker();
		if (label === "css" || label === "scss" || label === "less") return new cssWorker();
		if (label === "html" || label === "handlebars" || label === "razor") return new htmlWorker();
		if (label === "typescript" || label === "javascript") return new tsWorker();
		return new editorWorker();
	},
};

/**
 * `@types/node`, from *this repo's* node_modules at build time.
 *
 * A fallback only. It is what makes `node:fs` resolve in a project that does not depend
 * on `@types/node` itself, and it is dropped the moment the project provides its own —
 * two copies of the same globals is thousands of duplicate-identifier errors.
 */
const fallbackNodeTypes = import.meta.glob("/node_modules/@types/node/**/*.d.ts", {
	query: "?raw",
	import: "default",
	eager: true,
}) as Record<string, string>;

// ts.ModuleResolutionKind.Bundler. Monaco's `ModuleResolutionKind` enum still only names
// Classic and NodeJs, but the compiler its worker runs is TS 5.x and understands the
// modern modes — so the value is real and only the declaration is behind.
const MODULE_RESOLUTION_BUNDLER = 100 as monaco.typescript.ModuleResolutionKind;

let compilerOptions: monaco.typescript.CompilerOptions = {
	target: monaco.typescript.ScriptTarget.ESNext,
	module: monaco.typescript.ModuleKind.ESNext,
	// What a vite project's own tsconfig says, and it has to match: create-vite's
	// template writes `import { setupCounter } from "./counter.ts"` — an explicit .ts
	// extension, which every other resolution mode rejects outright.
	moduleResolution: MODULE_RESOLUTION_BUNDLER,
	allowImportingTsExtensions: true,
	noEmit: true,
	allowNonTsExtensions: true,
	allowJs: true,
	esModuleInterop: true,
	// So a package.json handed over for module resolution is parsed as JSON rather
	// than as TypeScript.
	resolveJsonModule: true,
	// The project's node_modules declarations are supplied wholesale; type-checking
	// their interiors would be a lot of diagnostics about code nobody here wrote.
	skipLibCheck: true,
	lib: ["es2023", "dom", "dom.iterable"],
	// The react templates are `.tsx` all the way down, and without this every one of
	// them is a wall of syntax errors: JSX is only *syntax* to the TS service once it
	// has been told which runtime the elements compile to. `react-jsx` matches what
	// create-vite's own tsconfig sets, so the automatic runtime needs no React import.
	jsx: monaco.typescript.JsxEmit.ReactJSX,
};

monaco.typescript.typescriptDefaults.setCompilerOptions(compilerOptions);
monaco.typescript.javascriptDefaults.setCompilerOptions(compilerOptions);
monaco.typescript.typescriptDefaults.setEagerModelSync(true);
monaco.typescript.javascriptDefaults.setEagerModelSync(true);

// tsconfig.json is JSONC by convention and create-vite's ships with comments in it, so
// the strict-JSON reading of it reports two errors in a project nobody has touched yet.
// Editors treat these files as JSON-with-comments; this is that, and the setting is
// global because the JSON service has no per-file mode.
monaco.json.jsonDefaults.setDiagnosticsOptions({
	validate: true,
	allowComments: true,
	trailingCommas: "ignore",
});

/** Monaco's language id for a path, by extension. */
export function languageFor(path: string): string {
	let ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
	switch (ext) {
		case "ts":
		case "mts":
		case "cts":
		// Monaco has no separate language for the x variants: the TS service picks the
		// JSX script kind off the file's extension, so a `.tsx` model wants to be
		// "typescript" and gets its JSX handling from the uri it was created with.
		case "tsx":
			return "typescript";
		case "js":
		case "mjs":
		case "cjs":
		case "jsx":
			return "javascript";
		case "json":
			return "json";
		case "css":
			return "css";
		case "html":
		case "htm":
			return "html";
		case "md":
			return "markdown";
		case "svg":
		case "xml":
			return "xml";
		case "yml":
		case "yaml":
			return "yaml";
		default:
			return "plaintext";
	}
}

/** Extensions worth opening in the editor at all. Anything else is bytes. */
export function isTextPath(path: string): boolean {
	return languageFor(path) !== "plaintext" || /(^|\/)(\.gitignore|LICENSE|README)$/i.test(path);
}

export interface ProjectFile {
	/** Project-relative, no leading slash. */
	path: string;
	contents: string;
}

export interface EditorController {
	/**
	 * Give Monaco the project's source files, so they form one program.
	 *
	 * Without this only *opened* files have models, and Monaco's TypeScript service
	 * knows nothing about the rest — so `import { setupCounter } from "./counter.ts"`
	 * is an unresolved module until the moment someone happens to open counter.ts.
	 * Cross-file go-to-definition and rename depend on the same thing.
	 *
	 * Only models whose language is typescript/javascript join the TS program, so
	 * passing css/html/json here is free: they become editable buffers and nothing more.
	 */
	syncSources(files: ProjectFile[]): void;

	/**
	 * Give Monaco the project's `node_modules` type declarations.
	 *
	 * This is what supplies ambient declarations the project depends on. `*.svg` and
	 * `*.css` imports, for instance, are declared in `vite/client.d.ts` — the template
	 * only references it (`/// <reference types="vite/client" />` in vite-env.d.ts), so
	 * with no declarations loaded, importing an asset is an error.
	 */
	syncTypeLibs(files: ProjectFile[]): void;

	/** Show `path`, creating its model from `contents` on first open. */
	open(path: string, contents: string): void;
	close(path: string): void;
	/** Replace a model's text without marking it dirty (an external change). */
	setContents(path: string, contents: string): void;
	getContents(path: string): string | undefined;
	/** Called when the user edits, after a short idle — i.e. when it is written out. */
	onEdit(listener: (path: string, contents: string) => void): void;
	/**
	 * Called the moment a keystroke changes a file, before `onEdit`.
	 *
	 * The two are separate so a tab can show unsaved state: this marks it dirty
	 * immediately, `onEdit` clears it once the write-through has happened. One
	 * callback could not distinguish them.
	 */
	onDirty(listener: (path: string) => void): void;
	layout(): void;
	dispose(): void;
}

const SAVE_DEBOUNCE_MS = 300;

export function mountEditor(container: HTMLElement): EditorController {
	let editor = monaco.editor.create(container, {
		// "vs" rather than "vs-dark": the workspace around it is light, and the mock's
		// editor pane is styled after this theme's exact gutter and selection colours.
		theme: "vs",
		automaticLayout: true,
		fixedOverflowWidgets: true,
		minimap: { enabled: false },
		scrollBeyondLastLine: false,
		fontSize: 13,
		lineHeight: 20,
		fontFamily: 'Menlo, Monaco, Consolas, "Courier New", monospace',
		tabSize: 2,
	});

	// For the devtools console: reading diagnostics (`monaco.editor.getModelMarkers`)
	// is the only way to check from outside that the project's types actually resolved.
	// Dev-only, as with the `__monacoEditor` handle this file has always published.
	if (import.meta.env.DEV) {
		(window as any).__monaco = monaco;
		(window as any).__monacoEditor = editor;
	}

	let models = new Map<string, monaco.editor.ITextModel>();
	let timers = new Map<string, number>();
	/** Suppresses the change listener while we are the ones writing. */
	let applying = new Set<string>();
	let listeners: ((path: string, contents: string) => void)[] = [];
	let dirtyListeners: ((path: string) => void)[] = [];
	/** Extra libs currently registered, by path, so a resync can diff rather than reset. */
	let libs = new Map<string, { contents: string; dispose: () => void }>();
	let fallbackNodeTypesInstalled = false;
	let disposeFallbackNodeTypes = () => {};

	let flush = (path: string) => {
		timers.delete(path);
		let model = models.get(path);
		if (!model) return;
		let contents = model.getValue();
		for (let listener of listeners) listener(path, contents);
	};

	let modelFor = (path: string, contents: string) => {
		let existing = models.get(path);
		if (existing) return existing;

		// A URI per path so Monaco's TypeScript service sees the project as a set of
		// related files rather than one anonymous buffer, which is what makes
		// cross-file navigation and imports resolve.
		let model = monaco.editor.createModel(
			contents,
			languageFor(path),
			monaco.Uri.file(`/project/${path}`)
		);
		model.onDidChangeContent(() => {
			if (applying.has(path)) return;
			for (let listener of dirtyListeners) listener(path);
			let pending = timers.get(path);
			if (pending !== undefined) clearTimeout(pending);
			timers.set(path, setTimeout(() => flush(path), SAVE_DEBOUNCE_MS) as unknown as number);
		});
		models.set(path, model);
		return model;
	};

	/** Register one declaration file with both language services. */
	let addLib = (path: string, contents: string) => {
		let uri = `file:///project/${path}`;
		let a = monaco.typescript.typescriptDefaults.addExtraLib(contents, uri);
		let b = monaco.typescript.javascriptDefaults.addExtraLib(contents, uri);
		libs.set(path, {
			contents,
			dispose: () => {
				a.dispose();
				b.dispose();
			},
		});
	};

	let installFallbackNodeTypes = () => {
		if (fallbackNodeTypesInstalled) return;
		fallbackNodeTypesInstalled = true;
		let disposables: monaco.IDisposable[] = [];
		for (let [path, contents] of Object.entries(fallbackNodeTypes)) {
			let uri = "file://" + path;
			disposables.push(monaco.typescript.typescriptDefaults.addExtraLib(contents, uri));
			disposables.push(monaco.typescript.javascriptDefaults.addExtraLib(contents, uri));
		}
		disposeFallbackNodeTypes = () => {
			for (let d of disposables) d.dispose();
			disposeFallbackNodeTypes = () => {};
			fallbackNodeTypesInstalled = false;
		};
	};

	return {
		syncSources(files) {
			let wanted = new Set(files.map((f) => f.path));
			for (let file of files) {
				let existing = models.get(file.path);
				if (!existing) {
					modelFor(file.path, file.contents);
					continue;
				}
				if (existing.getValue() === file.contents) continue;
				applying.add(file.path);
				try {
					existing.pushEditOperations(
						[],
						[{ range: existing.getFullModelRange(), text: file.contents }],
						() => null
					);
				} finally {
					applying.delete(file.path);
				}
			}
			for (let [path, model] of [...models]) {
				if (wanted.has(path)) continue;
				// The file is gone from the project. Detach it first if it is on screen,
				// or the editor is left holding a disposed model.
				if (editor.getModel() === model) editor.setModel(null);
				models.delete(path);
				model.dispose();
			}
		},

		syncTypeLibs(files) {
			// The project's own @types/node wins over the build-time fallback; having
			// both would declare every node global twice.
			let projectHasNodeTypes = files.some((f) =>
				f.path.startsWith("node_modules/@types/node/")
			);
			if (projectHasNodeTypes) disposeFallbackNodeTypes();
			else installFallbackNodeTypes();

			let wanted = new Set(files.map((f) => f.path));
			for (let file of files) {
				let existing = libs.get(file.path);
				if (existing?.contents === file.contents) continue;
				existing?.dispose();
				addLib(file.path, file.contents);
			}
			for (let [path, lib] of [...libs]) {
				if (wanted.has(path)) continue;
				lib.dispose();
				libs.delete(path);
			}
		},

		open(path, contents) {
			editor.setModel(modelFor(path, contents));
		},

		close(path) {
			let pending = timers.get(path);
			if (pending !== undefined) {
				// Don't drop an edit just because the tab closed.
				clearTimeout(pending);
				flush(path);
			}
			let model = models.get(path);
			models.delete(path);
			if (model && editor.getModel() === model) editor.setModel(null);
			model?.dispose();
		},

		setContents(path, contents) {
			let model = models.get(path);
			if (!model || model.getValue() === contents) return;
			applying.add(path);
			try {
				// pushEditOperations rather than setValue: it keeps the undo stack and the
				// cursor, so a background refresh does not feel like the file reloaded.
				model.pushEditOperations(
					[],
					[{ range: model.getFullModelRange(), text: contents }],
					() => null
				);
			} finally {
				applying.delete(path);
			}
		},

		getContents(path) {
			return models.get(path)?.getValue();
		},

		onEdit(listener) {
			listeners.push(listener);
		},

		onDirty(listener) {
			dirtyListeners.push(listener);
		},

		layout() {
			editor.layout();
		},

		dispose() {
			for (let timer of timers.values()) clearTimeout(timer);
			timers.clear();
			for (let model of models.values()) model.dispose();
			models.clear();
			for (let lib of libs.values()) lib.dispose();
			libs.clear();
			disposeFallbackNodeTypes();
			editor.dispose();
		},
	};
}
