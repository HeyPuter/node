// Where the project comes from.
//
// Two answers, and the workspace is written against the resolved result rather than either of
// them:
//
//   **template** — a baked tar.gz, downloaded once and unpacked into OPFS (`./opfs-store`). The
//   default, and the only thing a first visit can do.
//   **local** — a directory the user picked (`./local-dir`), remembered between visits.
//
// Both end as a `HandleStore` over a `FileSystemDirectoryHandle`, which is the whole reason this
// is a source rather than a mode: the runtime mounts one the same as the other, and everything
// downstream — the mirror, the pool, the shell, Export — is unchanged.
//
// Falling back is deliberate and always toward the template. A remembered folder can fail in
// several ordinary ways — permission declined, folder deleted, browser without a picker, folder
// too large to read — and every one of them leaves a `notice` for the terminal rather than a dead
// splash. The one thing this never does is fall back *silently*.
//
// This module reports progress through a narrow `SourceReporter` rather than taking the splash:
// `src/project` has no business importing `src/ui`, and the two methods it needs are the two
// methods it declares.

import type { MountEntry } from "./mirror";
import type { HandleStore } from "./handle-store";
import { openProjectStore, pruneProjectStores } from "./opfs-store";
import {
	loadLocalDir,
	localDirGranted,
	localDirSupported,
	openLocalStore,
	requestLocalDirAccess,
} from "./local-dir";
import { loadTemplate, type TemplateInfo, type TemplateManifest } from "./template";

export type SourceKind = "template" | "local";

/** What the splash needs to show, and nothing else. */
export interface SourceReporter {
	phase(key: string, fraction?: number, detail?: string): void;
	log(text: string): void;
}

/** Asks for the click that re-grants a remembered folder. Resolved by the splash. */
export type FolderRequest = (req: {
	name: string;
	grant: () => Promise<boolean>;
}) => Promise<"opened" | "template">;

export interface ResolveSourceArgs {
	manifest: TemplateManifest;
	/** `store.source` — "local", or anything else for a template. */
	source: string;
	/** `store.template` — the template id last used. */
	template: string;
	report: SourceReporter;
	requestFolder: FolderRequest;
	/** Confirm unpacking a template into an empty folder the user just opened. */
	confirmScaffold: (folderName: string, info: TemplateInfo) => Promise<boolean>;
	/**
	 * The source actually resolved, when it is not the one asked for.
	 *
	 * Persisted by the caller, so a folder that cannot be opened does not make every reload
	 * re-attempt it — and so the select comes up showing what is really loaded.
	 */
	onSourceChanged: (kind: SourceKind) => void;
}

export interface ResolvedProject {
	kind: SourceKind;
	store: HandleStore;
	/** The whole tree, for `mirror.seed`. */
	entries: MountEntry[];
	/** The active option in the source select. */
	label: string;
	/** One line for the terminal at boot, saying where the project came from. */
	summary: string;
	/** What the Run button issues. Undefined when a folder has no obvious start command. */
	start?: string;
	/** The active template, or — with a folder open — the one a switch would land on. */
	template: TemplateInfo;
	/** Set when this is not the source that was asked for, and why. */
	notice?: string;
}

export function parseSourceKind(value: string): SourceKind {
	return value === "local" ? "local" : "template";
}

/** Which template a given id means, falling back the way the manifest says to. */
export function templateFor(manifest: TemplateManifest, id: string): TemplateInfo {
	return (
		manifest.templates.find((t) => t.id === id) ??
		manifest.templates.find((t) => t.id === manifest.default) ??
		manifest.templates[0]
	);
}

export async function resolveProject(args: ResolveSourceArgs): Promise<ResolvedProject> {
	const info = templateFor(args.manifest, args.template);

	if (parseSourceKind(args.source) === "local") {
		const local = await resolveLocal(args, info);
		if (!("fallback" in local)) return local;
		// Make sure the next reload does not walk into the same failure, and carry the reason
		// through to the template that replaced it.
		args.onSourceChanged("template");
		return { ...(await resolveTemplate(args, info)), notice: local.fallback };
	}

	return resolveTemplate(args, info);
}

/** Either the folder opened, or the reason a template has to stand in for it. */
type LocalOutcome = ResolvedProject | { fallback: string };

async function resolveLocal(
	args: ResolveSourceArgs,
	info: TemplateInfo
): Promise<LocalOutcome> {
	const { report } = args;

	const give = (notice: string): LocalOutcome => {
		report.log(`folder: ${notice}`);
		return { fallback: notice };
	};

	if (!localDirSupported()) {
		return give("this browser cannot open a local folder, so a template was loaded instead");
	}

	const handle = await loadLocalDir();
	if (!handle) {
		return give("no folder is remembered any more, so a template was loaded instead");
	}

	// A grant does not survive a reload, so this is the normal path on every visit: one click,
	// in a handler the splash owns, because `requestPermission` needs a gesture.
	if (!(await localDirGranted(handle))) {
		report.log(`folder: “${handle.name}” needs permission again`);
		const outcome = await args.requestFolder({
			name: handle.name,
			grant: () => requestLocalDirAccess(handle),
		});
		if (outcome === "template") {
			// Not forgotten, only set aside: it stays in the source select so one click brings
			// it back.
			return give(`“${handle.name}” was left closed — loaded the ${info.id} template instead`);
		}
	}

	report.phase("download", 1, `Using “${handle.name}” on this device`);

	let store: HandleStore;
	try {
		store = await openLocalStore(handle);
	} catch (err) {
		return give(`could not open “${handle.name}” — ${message(err)}`);
	}

	let entries: MountEntry[];
	let summary: string;

	if (store.existing) {
		report.phase("extract", 0, `Reading “${handle.name}”…`);
		try {
			entries = await store.hydrate((count) => {
				report.phase("extract", 0, `Reading ${count} files…`);
			});
		} catch (err) {
			// Overwhelmingly the hydration limits in `local-dir`, whose message names the
			// directories that blew them. Worth surfacing rather than swallowing: the fix is
			// to point at a different folder, and that is only obvious if we say so.
			return give(`could not read “${handle.name}” — ${message(err)}`);
		}
		summary = `“${handle.name}” opened from this device (${fileCount(entries)} files)`;
	} else if (await args.confirmScaffold(handle.name, info)) {
		// An empty folder is the "start a new project here" case, and this is the template
		// path verbatim — download, then write it out, this time into the picked directory.
		entries = await loadTemplate(info, (p) => {
			report.phase(p.phase, p.fraction ?? 0, `${phaseVerb(p.phase)} ${p.detail}`);
		});
		await saveProject(store, entries, report);
		summary = `${info.id} template unpacked into “${handle.name}” (${info.packages} packages)`;
	} else {
		entries = [];
		summary = `“${handle.name}” opened from this device — it is empty`;
	}

	report.log(`project: ${entries.length} entries from “${handle.name}”`);

	return {
		kind: "local",
		store,
		entries,
		label: `📁 ${handle.name}`,
		summary,
		start: startCommandFor(entries),
		template: info,
	};
}

async function resolveTemplate(
	args: ResolveSourceArgs,
	info: TemplateInfo
): Promise<ResolvedProject> {
	const { report } = args;
	report.log(`template: ${info.id} (create-vite ${info.createVite})`);

	// The other half of a template swap, done here because here is where nothing holds the
	// outgoing files open — see `pruneProjectStores`. Normally a no-op: there is one project
	// directory and it is the one being opened. Skipped entirely when a folder is the source,
	// which is why it lives on this branch.
	const pruned = await pruneProjectStores(info.id);
	if (pruned.length > 0) report.log(`cleaned up: ${pruned.join(", ")}`);

	// The project lives in the origin private filesystem, and the runtime mounts it from there —
	// so the template is unpacked once, on the first visit, and a reload finds it already present.
	// What used to be a 10 MB download and 391 writes on every load is now a directory walk.
	const store = await openProjectStore(info.id);
	let entries: MountEntry[];
	if (store.existing) {
		report.phase("extract", 0, "Opening your project…");
		entries = await store.hydrate((count) => {
			// Against the manifest's count, because it is this template that was written here —
			// a moving fraction rather than the flat 0 a reload used to sit on for the whole
			// read. An estimate, not a total: `hydrate` counts directories as well as files, so
			// it runs out of bar slightly early and waits there. Clamped for that reason.
			report.phase(
				"extract",
				info.files > 0 ? Math.min(1, count / info.files) : 0,
				`Reading ${count} files…`
			);
		});
		report.log(`project: ${entries.length} entries already on disk`);
	} else {
		entries = await loadTemplate(info, (p) => {
			report.phase(p.phase, p.fraction ?? 0, `${phaseVerb(p.phase)} ${p.detail}`);
		});
		report.log(`template: ${entries.length} entries, ${info.packages} packages`);
		await saveProject(store, entries, report);
	}

	return {
		kind: "template",
		store,
		entries,
		label: info.label,
		summary: store.existing
			? `${info.id} template restored from this device (${info.packages} packages)`
			: `${info.id} template unpacked (${info.packages} packages)`,
		start: info.start,
		template: info,
	};
}

// ------------------------------------------------------------------ helpers

/**
 * Write a freshly unpacked template out to the store, reporting as it goes.
 *
 * Its own splash phase rather than the tail end of "extract". This is the slowest thing a first
 * visit does — thousands of individual file creates, which no amount of batching turns into one
 * operation — and it used to be a single "Saving the project…" in front of a bar parked on one
 * number for the duration, which is indistinguishable from a hang.
 */
async function saveProject(
	store: HandleStore,
	entries: MountEntry[],
	report: SourceReporter
): Promise<void> {
	const count = entries.length.toLocaleString();
	report.phase("save", 0, `Saving ${count} files…`);
	await store.writeMany(entries, (done, total) => {
		report.phase(
			"save",
			total > 0 ? done / total : 1,
			`Saved ${done.toLocaleString()} of ${total.toLocaleString()} files…`
		);
	});
	report.log(`project: ${count} entries written`);
}

function phaseVerb(phase: string): string {
	return phase === "download" ? "Downloading" : "Unpacking";
}

function fileCount(entries: MountEntry[]): number {
	let n = 0;
	for (const entry of entries) if (entry.data !== undefined) n += 1;
	return n;
}

/**
 * What Run should issue for a project nobody baked.
 *
 * A template says so in the manifest. A folder has to be asked, and its `package.json` is the
 * only place that answer lives — so this is the same guess a person makes opening an unfamiliar
 * repo, in the same order. Undefined rather than a hopeful default: a Run button that reliably
 * fails is worse than one that says why it is disabled.
 */
export function startCommandFor(entries: MountEntry[]): string | undefined {
	const has = (path: string) =>
		entries.some((entry) => entry.path === path && entry.data !== undefined);

	const pkg = readJsonEntry(entries, "package.json");
	const scripts = pkg?.scripts;
	if (typeof scripts?.dev === "string") return "npm run dev";
	if (typeof scripts?.start === "string") return "npm start";

	const main = typeof pkg?.main === "string" ? pkg.main.replace(/^\.\//, "") : undefined;
	if (main && has(main)) return `node ${main}`;

	for (const candidate of ["index.js", "index.mjs", "index.cjs", "main.js", "server.js"]) {
		if (has(candidate)) return `node ${candidate}`;
	}
	return undefined;
}

function readJsonEntry(entries: MountEntry[], path: string): any | undefined {
	const found = entries.find((entry) => entry.path === path && entry.data !== undefined);
	if (!found?.data) return undefined;
	try {
		return JSON.parse(new TextDecoder().decode(found.data));
	} catch {
		return undefined;
	}
}

function message(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
