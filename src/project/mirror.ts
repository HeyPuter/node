// The project's files, as the UI reads them.
//
// This used to be the authoritative copy, with each worker holding a replica populated from it.
// It is neither now: the project lives in the origin private filesystem and the runtime *mounts*
// it, so there is one copy and the worker reads it directly.
//
// What survives is the reason this file exists at all — the tree and the editor need synchronous
// reads, and OPFS has none. So this is a read model: seeded from the store at boot, kept current
// from the runtime's own watch events, and written *through* to the filesystem on every edit.
//
// Everything that existed to keep a replica in step is gone with the replica: `populateEntries`,
// `deltaSince`, per-node revisions and tombstones. What replaced them is smaller and stronger —
// a program's writes are in the store the moment it makes them, so a worker that wedges or exits
// can no longer lose them.

/** Absolute path of the mount this mirrors. */
export const PROJECT_ROOT = "/project";

export type MirrorKind = "file" | "dir";

export interface MirrorListEntry {
	name: string;
	/** Project-relative, no leading slash. */
	path: string;
	kind: MirrorKind;
	/** 0 for directories. */
	size: number;
}

/** One file, or — with no data — one directory. */
export interface MountEntry {
	path: string;
	data?: Uint8Array;
	mtimeMs?: number;
}

/**
 * Normalize to the mirror's canonical form: project-relative, no leading or trailing
 * slash, no "." or ".." segments. A ".." that would climb out bottoms out at the root,
 * matching how the runtime's own `writeMemory` contains paths.
 */
export function normalizeProjectPath(path: string): string {
	let out: string[] = [];
	for (let seg of path.split("/")) {
		if (seg === "" || seg === ".") continue;
		if (seg === "..") {
			out.pop();
			continue;
		}
		out.push(seg);
	}
	return out.join("/");
}

function parentOf(path: string): string {
	let at = path.lastIndexOf("/");
	return at === -1 ? "" : path.slice(0, at);
}

function nameOf(path: string): string {
	let at = path.lastIndexOf("/");
	return at === -1 ? path : path.slice(at + 1);
}

interface FileNode {
	data: Uint8Array;
	mtimeMs: number;
}

/**
 * Where a mirror write is also persisted.
 *
 * The mirror used to be the authoritative copy, and the worker's mount a replica of it. That is
 * inverted now: the store is authoritative — the runtime mounts it directly — and the mirror is
 * the synchronous read model the tree and the editor need, since OPFS has no synchronous reads.
 * So every write here has to reach the store too, or an edit would be visible in the editor and
 * absent from the next run.
 */
export interface MirrorTarget {
	writeMany(entries: Iterable<MountEntry>, onProgress?: WriteProgress): Promise<void>;
	remove(paths: Iterable<string>): Promise<void>;
}

/**
 * How far a bulk write has got. Only the one caller that writes thousands of entries at once —
 * unpacking a template, in `./source` — passes this; an edit from the editor is one file and has
 * nothing to report.
 */
export type WriteProgress = (done: number, total: number) => void;

/** The store the project lives in: a mirror target that can also be read back. */
export interface ProjectStore extends MirrorTarget {
	read(path: string): Promise<Uint8Array | undefined>;
}

export class ProjectMirror {
	private files = new Map<string, FileNode>();
	/** Every known directory, explicit or implied by a file path. "" is the root. */
	private dirs = new Set<string>([""]);
	/** dir path -> child name -> kind. The tree renders straight out of this. */
	private children = new Map<string, Map<string, MirrorKind>>([["", new Map()]]);
	private listeners = new Set<() => void>();

	get fileCount(): number {
		return this.files.size;
	}

	/** Fires after any mutation, so the tree and status bar can refresh. */
	private target: MirrorTarget | undefined;

	/**
	 * Persist writes from here on.
	 *
	 * Set after `seed`, deliberately: seeding *comes from* the store (or has just been written to
	 * it), and writing it all back would double the boot cost for no effect.
	 */
	setTarget(target: MirrorTarget): void {
		this.target = target;
	}

	/** Set while applying a change that came *from* the store. See `applyFromStore`. */
	private applying = false;

	/**
	 * Every persisted change, in the order it was made.
	 *
	 * Persistence is asynchronous and the read model is not, so two changes to the same path
	 * issued in one turn used to race: `echo x > f` followed by `rm f` are two independent
	 * promises, and nothing said the removal had to land second. A shell makes that ordinary
	 * — it is a single line — so writes go through one chain rather than one promise each.
	 */
	private tail: Promise<void> = Promise.resolve();

	/**
	 * Apply changes that came from the store, without writing them back.
	 *
	 * Not an optimization — without it the reflector loops forever. A program writes a file, the
	 * watch event brings it here, persisting it goes back through the filesystem, that emits
	 * another event, and around again. The bytes are already where they belong; only the read
	 * model is behind.
	 */
	applyFromStore(apply: () => void): void {
		let previous = this.applying;
		this.applying = true;
		try {
			apply();
		} finally {
			this.applying = previous;
		}
	}

	/**
	 * Failures are reported rather than thrown: a write reaches the read model synchronously and
	 * the store afterwards, so by the time one fails the editor has already moved on. Losing the
	 * report as well would make it invisible.
	 */
	private persist(fn: () => Promise<void>): void {
		if (!this.target || this.applying) return;
		this.tail = this.tail.then(fn).catch((err) => {
			console.error("[workspace] could not persist a change to the project store", err);
		});
	}

	/**
	 * Resolves once every change made so far has reached the store.
	 *
	 * A write reaches the read model synchronously and the store afterwards, and the runtime
	 * reads the project *through* the store — so without this, `echo hi > f && node -e
	 * "…readFileSync…"` is a race the shell loses about as often as it wins. Awaited before a
	 * run rather than after a write, because that is the one moment the two views have to agree.
	 */
	flush(): Promise<void> {
		return this.tail;
	}

	onChange(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private notifyPending = false;

	/**
	 * Announce a change, at most once per turn.
	 *
	 * Each notification rebuilds the editor's program, re-renders the tree and refreshes every
	 * open tab, so it costs a pass over the project — fine per keystroke, ruinous per file when
	 * a shell loop writes a hundred of them. Only the announcement is deferred: the read model
	 * itself stays current synchronously, which is what read-after-write within one command
	 * line depends on.
	 */
	private touched() {
		if (this.notifyPending) return;
		this.notifyPending = true;
		setTimeout(() => {
			this.notifyPending = false;
			for (let listener of [...this.listeners]) listener();
		}, 0);
	}

	// ------------------------------------------------------------------ reads

	has(path: string): boolean {
		return this.files.has(normalizeProjectPath(path));
	}

	read(path: string): Uint8Array | undefined {
		return this.files.get(normalizeProjectPath(path))?.data;
	}

	readText(path: string): string | undefined {
		let data = this.read(path);
		return data === undefined ? undefined : new TextDecoder().decode(data);
	}

	/** When a file last changed, for anything that has to `stat` it. Undefined for a directory. */
	mtimeOf(path: string): number | undefined {
		return this.files.get(normalizeProjectPath(path))?.mtimeMs;
	}

	/** Parsed JSON, or undefined if the file is absent or does not parse. */
	readJson<T = any>(path: string): T | undefined {
		let text = this.readText(path);
		if (text === undefined) return undefined;
		try {
			return JSON.parse(text) as T;
		} catch {
			return undefined;
		}
	}

	isDir(path: string): boolean {
		return this.dirs.has(normalizeProjectPath(path));
	}

	/** Direct children of a directory, directories first then files, each A-Z. */
	list(dir: string): MirrorListEntry[] {
		let base = normalizeProjectPath(dir);
		let kids = this.children.get(base);
		if (!kids) return [];
		let out: MirrorListEntry[] = [];
		for (let [name, kind] of kids) {
			let path = base === "" ? name : `${base}/${name}`;
			out.push({
				name,
				path,
				kind,
				size: kind === "file" ? (this.files.get(path)?.data.byteLength ?? 0) : 0,
			});
		}
		out.sort((a, b) => {
			if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
			return a.name.localeCompare(b.name);
		});
		return out;
	}

	/** Every file, for Export. Directories are implicit in the paths. */
	*allFiles(): Iterable<{ path: string; data: Uint8Array }> {
		for (let [path, node] of this.files) yield { path, data: node.data };
	}

	/**
	 * Installed packages under `node_modules`, counted the way npm reports them:
	 * top-level dirs plus one level inside each `@scope`, ignoring dotfiles.
	 */
	packageCount(): number {
		let top = this.children.get("node_modules");
		if (!top) return 0;
		let count = 0;
		for (let [name, kind] of top) {
			if (kind !== "dir" || name.startsWith(".")) continue;
			if (name.startsWith("@")) {
				count += this.children.get(`node_modules/${name}`)?.size ?? 0;
			} else {
				count += 1;
			}
		}
		return count;
	}

	// ----------------------------------------------------------------- writes

	/** Replace the entire project. Used at boot and when switching template. */
	seed(entries: Iterable<MountEntry>): void {
		this.files.clear();
		this.dirs = new Set([""]);
		this.children = new Map([["", new Map()]]);
		for (let entry of entries) this.put(entry);
		this.touched();
	}

	write(path: string, data: Uint8Array | string): void {
		this.writeMany([{ path, data: asBytes(data) }]);
	}

	writeMany(entries: Iterable<MountEntry>): void {
		let changed = false;
		let all = [...entries];
		for (let entry of all) changed = this.put(entry) || changed;
		if (changed) {
			this.touched();
			this.persist(() => this.target!.writeMany(all));
		}
	}

	mkdir(path: string): void {
		this.writeMany([{ path }]);
	}

	/** Remove a file, or a directory and everything under it. */
	delete(path: string): void {
		let target = normalizeProjectPath(path);
		if (target === "") return;

		let removed: string[] = [];
		if (this.files.has(target)) {
			removed.push(target);
		} else if (this.dirs.has(target)) {
			// Prefix match on a segment boundary, so "src" never takes "srcfoo".
			let prefix = target + "/";
			for (let p of this.files.keys()) if (p.startsWith(prefix)) removed.push(p);
			for (let d of [...this.dirs]) {
				if (d === target || d.startsWith(prefix)) {
					this.dirs.delete(d);
					this.children.delete(d);
				}
			}
		} else {
			return;
		}

		for (let p of removed) this.files.delete(p);
		this.children.get(parentOf(target))?.delete(nameOf(target));
		this.touched();
		// One removal at the target, not one per file under it: the store deletes recursively,
		// and asking it to remove each descendant separately would be both slower and racy.
		this.persist(() => this.target!.remove([target]));
	}

	private put(entry: MountEntry): boolean {
		let path = normalizeProjectPath(entry.path);
		if (path === "") return false;
		this.ensureDirs(parentOf(path));

		if (entry.data === undefined) {
			// No data means "make a directory" — only needed for a deliberately empty
			// one, since files create their own parents.
			if (!this.dirs.has(path)) {
				this.dirs.add(path);
				this.children.set(path, new Map());
				this.children.get(parentOf(path))!.set(nameOf(path), "dir");
			}
			return true;
		}

		this.files.set(path, { data: entry.data, mtimeMs: entry.mtimeMs ?? Date.now() });
		this.children.get(parentOf(path))!.set(nameOf(path), "file");
		return true;
	}

	private ensureDirs(dir: string): void {
		if (dir === "" || this.dirs.has(dir)) return;
		let segments = dir.split("/");
		let path = "";
		for (let seg of segments) {
			let parent = path;
			path = path === "" ? seg : `${path}/${seg}`;
			if (this.dirs.has(path)) continue;
			this.dirs.add(path);
			this.children.set(path, new Map());
			this.children.get(parent)!.set(seg, "dir");
		}
	}
}

function asBytes(data: Uint8Array | string): Uint8Array {
	return typeof data === "string" ? new TextEncoder().encode(data) : data;
}
