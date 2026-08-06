// The project's files, over a `FileSystemDirectoryHandle`.
//
// Two things in the browser hand one of those out, and everything below treats them
// identically:
//
//   navigator.storage.getDirectory()  → OPFS, where an unpacked template lives (./opfs-store)
//   showDirectoryPicker()             → a directory on the user's machine (./local-dir)
//
// That they are the same object is what makes "open a folder I already have" a source rather
// than a subsystem: the runtime mounts this handle either way (see `createDirectoryHandleProvider`
// in node-worker, whose own header covers both), so nothing downstream of here knows or cares
// which kind it got. The differences that do exist are the options below — a picked directory is
// somebody's real work, so what may be read into memory and what may be deleted are things its
// caller gets to decide.
//
// `createWritable` rather than `createSyncAccessHandle`: the latter is OPFS-only and worker-only,
// and this all runs on the page. See the note in node-worker's `vfs/dispatch.ts` about moving the
// vfs host into a worker, which is what would make the sync variant reachable.

import type { MountEntry, ProjectStore } from "./mirror";
import { fmtBytes } from "./template";

/**
 * A project's files, and the little the workspace needs to know about them beyond reading and
 * writing: the handle to mount, whether there was anything there to begin with, and a way to
 * pull the whole tree into the mirror.
 */
export interface HandleStore extends ProjectStore {
	/** Mounted into the runtime at `PROJECT_ROOT`. */
	readonly handle: FileSystemDirectoryHandle;
	/** Whether this directory already had contents when it was opened. */
	readonly existing: boolean;
	/** Every file and directory, for hydrating the mirror. */
	hydrate(onProgress?: (count: number) => void): Promise<MountEntry[]>;
	/** Throw away everything — switching template, or recovering from a bad extract. */
	clear(): Promise<void>;
}

export interface HandleStoreOptions {
	/**
	 * Directory names, at any depth, never read into the mirror.
	 *
	 * Only the mirror — the runtime mounts this handle directly, so a program still sees these
	 * perfectly well. The mirror is the UI's read model and holds every byte it is given for the
	 * lifetime of the page, which is fine for a template and ruinous for a `.git` full of
	 * packfiles.
	 */
	skipDirs?: ReadonlySet<string>;
	/** Refuse to hydrate past this, rather than filling the tab's memory. */
	maxBytes?: number;
	/** Refuse to hydrate past this many entries. */
	maxEntries?: number;
	/** Make `clear()` throw with this message instead of deleting anything. */
	noClear?: string;
}

/** How many of the biggest directories an over-limit folder names. */
const BLAME_COUNT = 3;

/**
 * How many files `writeMany` has in flight at once.
 *
 * Writing one is four round-trips to the browser's filesystem thread — resolve its directory, open
 * the file, open a writable, close it — and the react-ts template is 4,927 files, most of them
 * small and several directories deep inside `node_modules`. Done strictly one at a time that is
 * some twenty thousand sequential round-trips: it measured 10s on a fast desktop, and it is the
 * kind of cost that scales with somebody else's disk.
 *
 * Almost all of it is latency rather than disk or CPU, so overlapping is nearly pure win: the same
 * template writes in 2.6-3.0s this way. 16 rather than more because a sweep over a tree this shape
 * stopped improving there and was slower by 32 — the filesystem backend is saturated by then, and
 * the only thing further concurrency buys is more buffers held in flight.
 */
const WRITE_CONCURRENCY = 16;

/** How often a bulk write reports, in entries. Matches `hydrate`, for the same reason. */
const PROGRESS_EVERY = 50;

function segments(path: string): string[] {
	return path.split("/").filter((s) => s.length > 0 && s !== ".");
}

/**
 * The async iterators `FileSystemDirectoryHandle` actually has, which lib.dom does not declare.
 *
 * One cast in one place, rather than the same `as unknown as` at all five call sites that walk a
 * directory.
 */
function keysOf(dir: FileSystemDirectoryHandle): AsyncIterableIterator<string> {
	return (dir as unknown as { keys(): AsyncIterableIterator<string> }).keys();
}

function entriesOf(
	dir: FileSystemDirectoryHandle
): AsyncIterableIterator<[string, FileSystemHandle]> {
	return (
		dir as unknown as {
			entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
		}
	).entries();
}

/** Whether a directory has anything in it, without listing all of it. */
export async function hasContents(dir: FileSystemDirectoryHandle): Promise<boolean> {
	for await (const _ of keysOf(dir)) return true;
	return false;
}

async function dirFor(
	root: FileSystemDirectoryHandle,
	parts: string[],
	create: boolean
): Promise<FileSystemDirectoryHandle | undefined> {
	let dir = root;
	for (const part of parts) {
		try {
			dir = await dir.getDirectoryHandle(part, { create });
		} catch {
			return undefined;
		}
	}
	return dir;
}

/**
 * Run `each` over every item, at most `limit` at a time.
 *
 * Stops at the first failure and rethrows it once the runners already in flight have finished,
 * which is what the serial loop this replaced did — and the reason not to lean on `Promise.all`
 * alone, whose rejection would surface with a dozen writes still running behind it.
 */
async function inParallel<T>(
	items: readonly T[],
	limit: number,
	each: (item: T) => Promise<void>
): Promise<void> {
	let next = 0;
	let failure: unknown;
	let runner = async () => {
		while (next < items.length && failure === undefined) {
			try {
				await each(items[next++]);
			} catch (err) {
				failure = err;
			}
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runner));
	if (failure !== undefined) throw failure;
}

export function createHandleStore(
	handle: FileSystemDirectoryHandle,
	existing: boolean,
	opts: HandleStoreOptions = {}
): HandleStore {
	const skipDirs = opts.skipDirs;

	return {
		handle,
		existing,

		async hydrate(onProgress) {
			const out: MountEntry[] = [];
			let bytes = 0;
			/** Bytes per top-level entry, so a folder over the byte cap can say what filled it. */
			const weight = new Map<string, number>();

			/**
			 * Refuse, naming what is responsible.
			 *
			 * `blame` is where the walk had got to. It carries the whole message for the entry
			 * cap, because a walk that stops the moment it trips has not counted enough of
			 * anything to rank — but it is *inside* the directory at fault, which is the one
			 * thing worth saying. The byte cap can rank, since every file seen so far was
			 * weighed on the way past.
			 */
			const refuse = (what: string, by: "bytes" | "count", blame: string): never => {
				let detail: string;
				if (by === "count") {
					detail = blame ? `while reading ${blame}` : "";
				} else {
					detail = [...weight.entries()]
						.sort((a, b) => b[1] - a[1])
						.slice(0, BLAME_COUNT)
						// Anything that rounds to nothing is noise in a list of culprits.
						.filter(([, n]) => n >= 1024)
						.map(([name, n]) => `${name} ${fmtBytes(n)}`)
						.join(", ");
				}
				// Named rather than merely refused: "too large" on its own leaves someone
				// guessing, and the answer is almost always one directory they would happily
				// have excluded.
				throw new Error(
					`this folder is too large to open here — ${what}` +
						(detail ? ` (${detail})` : "")
				);
			};

			const walk = async (dir: FileSystemDirectoryHandle, base: string, top: string) => {
				for await (const [name, child] of entriesOf(dir)) {
					const path = base ? `${base}/${name}` : name;
					// What to blame for the bytes: the top-level entry this one is under, which
					// for something at the root is itself — a 200 MB lockfile is worth naming too.
					const blame = base === "" ? name : top;

					if (child.kind === "directory") {
						if (skipDirs?.has(name)) continue;
						out.push({ path });
						await walk(child as FileSystemDirectoryHandle, path, blame);
					} else {
						const file = await (child as FileSystemFileHandle).getFile();
						// Counted from `size` before the read, not after: a single file bigger
						// than the whole budget would otherwise exhaust the tab on the way to
						// being refused.
						bytes += file.size;
						weight.set(blame, (weight.get(blame) ?? 0) + file.size);
						if (opts.maxBytes !== undefined && bytes > opts.maxBytes) {
							refuse(`over ${fmtBytes(opts.maxBytes)} of files`, "bytes", blame);
						}
						out.push({
							path,
							data: new Uint8Array(await file.arrayBuffer()),
							mtimeMs: file.lastModified,
						});
					}

					if (opts.maxEntries !== undefined && out.length > opts.maxEntries) {
						refuse(
							`over ${opts.maxEntries.toLocaleString()} files and directories`,
							"count",
							// The path, not the top-level name: a `node_modules` that trips this
							// is worth pointing at exactly.
							base || name
						);
					}
					if (out.length % 50 === 0) onProgress?.(out.length);
				}
			};

			await walk(handle, "", "");
			onProgress?.(out.length);
			return out;
		},

		async writeMany(entries, onProgress) {
			const all = [...entries];

			/**
			 * Directory handles by path, so a directory is opened once however many files go
			 * into it.
			 *
			 * The win is twofold. Resolving `node_modules/@babel/parser/lib` used to cost four
			 * round-trips *per file written into it* — a template's 5,000 files sit in a few
			 * hundred directories, so nearly all of that was re-answering the same question.
			 * And the entries are cached as **promises**: the sixteen writes that arrive at a
			 * brand-new directory together then share one `create: true` rather than racing to
			 * make it.
			 *
			 * Per call, not for the store's lifetime. A directory can go away underneath us —
			 * `remove`, a program the runtime is running, or the user in their own file manager
			 * — and a handle cached across calls would keep failing every write into it.
			 */
			const dirs = new Map<string, Promise<FileSystemDirectoryHandle | undefined>>();

			const dirOnce = (parts: string[]): Promise<FileSystemDirectoryHandle | undefined> => {
				if (parts.length === 0) return Promise.resolve(handle);
				const path = parts.join("/");
				let found = dirs.get(path);
				if (!found) {
					// Resolved from its own parent rather than walked from the root, so a new
					// directory costs one round-trip instead of one per segment above it.
					const name = parts[parts.length - 1];
					found = dirOnce(parts.slice(0, -1)).then((parent) =>
						parent
							?.getDirectoryHandle(name, { create: true })
							.catch(() => undefined)
					);
					dirs.set(path, found);
				}
				return found;
			};

			const writeOne = async (entry: MountEntry) => {
				const parts = segments(entry.path);
				if (parts.length === 0) return;
				if (entry.data === undefined) {
					await dirOnce(parts);
					return;
				}
				const dir = await dirOnce(parts.slice(0, -1));
				if (!dir) return;
				const file = await dir.getFileHandle(parts[parts.length - 1], { create: true });
				const writable = await file.createWritable({ keepExistingData: false });
				try {
					await writable.write(entry.data as unknown as ArrayBufferView<ArrayBuffer>);
					await writable.close();
				} catch (err) {
					await writable.abort().catch(() => undefined);
					throw err;
				}
			};

			let done = 0;
			await inParallel(all, WRITE_CONCURRENCY, async (entry) => {
				await writeOne(entry);
				// Counted even when the entry was skipped, so the total the caller is shown
				// against is the one it handed over.
				done += 1;
				if (done % PROGRESS_EVERY === 0 || done === all.length) {
					onProgress?.(done, all.length);
				}
			});
		},

		async remove(paths) {
			for (const path of paths) {
				const parts = segments(path);
				if (parts.length === 0) continue;
				const dir = await dirFor(handle, parts.slice(0, -1), false);
				if (!dir) continue;
				await dir
					.removeEntry(parts[parts.length - 1], { recursive: true })
					.catch(() => undefined);
			}
		},

		async read(path) {
			const parts = segments(path);
			if (parts.length === 0) return undefined;
			const dir = await dirFor(handle, parts.slice(0, -1), false);
			if (!dir) return undefined;
			try {
				const file = await dir.getFileHandle(parts[parts.length - 1]);
				return new Uint8Array(await (await file.getFile()).arrayBuffer());
			} catch {
				return undefined;
			}
		},

		async clear() {
			// A picked directory passes `noClear`, because emptying one is not this app's to do:
			// the workspace only ever calls this to reset storage it created itself.
			if (opts.noClear !== undefined) throw new Error(opts.noClear);
			const names: string[] = [];
			for await (const name of keysOf(handle)) names.push(name);
			for (const name of names) {
				await handle.removeEntry(name, { recursive: true }).catch(() => undefined);
			}
		},
	};
}
