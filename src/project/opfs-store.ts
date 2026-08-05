// A project in the origin private filesystem, which is where an unpacked template lives.
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
//
// Everything about *reading and writing* a directory handle is in `./handle-store`, because a
// picked directory (`./local-dir`) is the same object and wants the same code. What is left here
// is only what is true of OPFS in particular: it needs no permission, it can be asked to persist,
// and the workspace is free to delete the parts of it that it created.

import { createHandleStore, hasContents, type HandleStore } from "./handle-store";

/** Everything lives under one directory, so several projects can coexist later. */
const PROJECTS_DIR = "projects";

export type { HandleStore };

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
 *
 * Only called when a template is the active source. With a picked folder open there is no
 * `keep` to name, and pruning on its behalf would delete the template the user is one click
 * away from switching back to.
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

export async function openProjectStore(id: string): Promise<HandleStore> {
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

	// No limits and no skips: this directory holds exactly what the workspace put in it, so
	// there is nothing here it would rather not read — and `clear()` stays available, since
	// recovering from a bad extract means emptying it.
	return createHandleStore(handle, await hasContents(handle));
}
