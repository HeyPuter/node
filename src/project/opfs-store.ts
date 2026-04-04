// The project's files, in the origin private filesystem.
//
// This replaces "extract the template into memory on every load". The tarball is unpacked once,
// into OPFS, and every load after that finds it already there — so a reload costs a directory
// walk instead of a 10 MB download and 391 writes.
//
// The bigger change is who owns the files. The runtime's filesystem now lives on this side of the
// worker boundary, so `/project` is *mounted from this directory* rather than copied into each
// worker's memory. There is no replica, which means:
//
//   - no per-worker populate, and no `POPULATE_BATCH` to tune around a message that stalls the
//     page;
//   - no `deltaSince(rev)` to bring a new worker up to date, because there is nothing to bring
//     up to date;
//   - no post-run `harvest()` — and with it, no "the run's writes are lost" gap when a worker
//     wedges or exits before it can be read back. A program's writes are already in the store the
//     moment it makes them.
//
// The `ProjectMirror` stays, but its job narrows to what the UI actually needs: a synchronous
// read model for the tree and the editor, kept current from here and from the runtime's own watch
// events.

import type { MountEntry } from "./mirror";

/** Everything lives under one directory, so several projects can coexist later. */
const PROJECTS_DIR = "projects";

export interface OpfsStore {
	/** Mounted into the runtime at `PROJECT_ROOT`. */
	readonly handle: FileSystemDirectoryHandle;
	/** Whether this directory already had contents when it was opened. */
	readonly existing: boolean;
	/** Every file and directory, for hydrating the mirror. */
	hydrate(onProgress?: (count: number) => void): Promise<MountEntry[]>;
	writeMany(entries: Iterable<MountEntry>): Promise<void>;
	remove(paths: Iterable<string>): Promise<void>;
	/** Read one file back, for reflecting a runtime write into the mirror. */
	read(path: string): Promise<Uint8Array | undefined>;
	/** Throw away everything — switching template, or recovering from a bad extract. */
	clear(): Promise<void>;
}

/**
 * Delete every project directory but `keep`, and report which ids went.
 *
 * This is what makes switching template not cost a project's worth of storage every time.
 * A swap reloads the page — reconciling two unrelated trees in place is not worth the
 * complexity — and the outgoing tree is a real directory here, 40 MB or so of unpacked
 * `node_modules`, that nothing will ever open again.
 *
 * Deliberately done at boot rather than during the swap: the runtime *mounts* this
 * directory, so on the outgoing page its files can still be held open by a worker, and
 * OPFS refuses to remove a file with a live access handle. After the reload there is no
 * worker yet and nothing is held, so the removal either works or genuinely failed.
 */
export async function pruneProjectStores(keep: string): Promise<string[]> {
	if (!navigator.storage?.getDirectory) return [];
	const opfsRoot = await navigator.storage.getDirectory();
	let projects: FileSystemDirectoryHandle;
	try {
		projects = await opfsRoot.getDirectoryHandle(PROJECTS_DIR);
	} catch {
		// Nothing has been unpacked yet.
		return [];
	}

	const stale: string[] = [];
	for await (const name of (
		projects as unknown as { keys(): AsyncIterableIterator<string> }
	).keys()) {
		if (name !== keep) stale.push(name);
	}

	const removed: string[] = [];
	for (const name of stale) {
		// One directory failing is not a reason to leave the rest: each is independent, and
		// the caller only reports what actually went.
		try {
			await projects.removeEntry(name, { recursive: true });
			removed.push(name);
		} catch {
			// Still held open, or gone already. Next boot tries again.
		}
	}
	return removed;
}

function segments(path: string): string[] {
	return path.split("/").filter((s) => s.length > 0 && s !== ".");
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

export async function openProjectStore(id: string): Promise<OpfsStore> {
	if (!navigator.storage?.getDirectory) {
		throw new Error(
			"this browser has no origin private filesystem, which the workspace needs to hold your project"
		);
	}
	// Asking to persist is best-effort: without it the origin's storage is evictable under
	// pressure, and a project quietly disappearing between visits is much worse than a prompt.
	await navigator.storage.persist?.().catch(() => false);

	const opfsRoot = await navigator.storage.getDirectory();
	const projects = await opfsRoot.getDirectoryHandle(PROJECTS_DIR, { create: true });
	const handle = await projects.getDirectoryHandle(id, { create: true });

	let existing = false;
	for await (const _ of (
		handle as unknown as { keys(): AsyncIterableIterator<string> }
	).keys()) {
		existing = true;
		break;
	}

	const store: OpfsStore = {
		handle,
		existing,

		async hydrate(onProgress) {
			const out: MountEntry[] = [];
			const walk = async (dir: FileSystemDirectoryHandle, base: string) => {
				for await (const [name, child] of (
					dir as unknown as {
						entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
					}
				).entries()) {
					const path = base ? `${base}/${name}` : name;
					if (child.kind === "directory") {
						out.push({ path });
						await walk(child as FileSystemDirectoryHandle, path);
					} else {
						const file = await (child as FileSystemFileHandle).getFile();
						out.push({
							path,
							data: new Uint8Array(await file.arrayBuffer()),
							mtimeMs: file.lastModified,
						});
					}
					if (out.length % 50 === 0) onProgress?.(out.length);
				}
			};
			await walk(handle, "");
			onProgress?.(out.length);
			return out;
		},

		async writeMany(entries) {
			for (const entry of entries) {
				const parts = segments(entry.path);
				if (parts.length === 0) continue;
				if (entry.data === undefined) {
					await dirFor(handle, parts, true);
					continue;
				}
				const dir = await dirFor(handle, parts.slice(0, -1), true);
				if (!dir) continue;
				const file = await dir.getFileHandle(parts[parts.length - 1], {
					create: true,
				});
				const writable = await file.createWritable({ keepExistingData: false });
				try {
					await writable.write(entry.data as unknown as ArrayBufferView<ArrayBuffer>);
					await writable.close();
				} catch (err) {
					await writable.abort().catch(() => undefined);
					throw err;
				}
			}
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
			const names: string[] = [];
			for await (const name of (
				handle as unknown as { keys(): AsyncIterableIterator<string> }
			).keys()) {
				names.push(name);
			}
			for (const name of names) {
				await handle.removeEntry(name, { recursive: true }).catch(() => undefined);
			}
		},
	};

	return store;
}
