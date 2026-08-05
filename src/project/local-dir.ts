// A project in a directory the user picked, rather than one the workspace unpacked.
//
// Same handle, same mount, same store (`./handle-store`) — what is different is everything
// *around* the handle, and that is what this module is:
//
//   - **It has to be asked for.** `showDirectoryPicker()` needs a user gesture, so it can only be
//     called from a click handler. Not "should be": the call throws otherwise.
//   - **It has to be remembered somewhere a handle can live.** A `FileSystemDirectoryHandle` is
//     structured-cloneable but has no JSON form, so localStorage — where the rest of this app's
//     persisted state lives — cannot hold one. IndexedDB can, and is the only thing that can.
//   - **Its permission does not survive a reload.** A remembered handle comes back in the
//     `"prompt"` state, and re-granting is another gesture. So a reload asks for one click; see
//     `requestLocalDirAccess` and the splash panel that calls it.
//   - **It is somebody's real work.** The runtime mounted here can create, rewrite and delete
//     files in it for real. Which is the point — but it is why the store this hands back refuses
//     to empty the directory, and why hydration has limits at all.

import { ensureDirectoryHandleAccess } from "node-worker";

import { createHandleStore, hasContents, type HandleStore } from "./handle-store";

/**
 * Directories a picked folder is read into the mirror *without*.
 *
 * The mirror is the UI's read model and holds every byte it is handed for the life of the page.
 * That is fine for a template and hopeless against a `.git`, which in any project with history is
 * mostly packfiles — megabytes of content-addressed binary that no tree, editor or shell in this
 * workspace has any use for.
 *
 * The runtime is unaffected: it mounts the handle directly, so `readdirSync(".")` inside a program
 * still lists `.git` and can read it. The visible consequence is that the file tree and the
 * workspace shell's `ls -a` (which read the mirror, via `src/shell/workspace-fs.ts`) do not.
 */
const SKIP_DIRS: ReadonlySet<string> = new Set([".git"]);

/**
 * Hydration limits, past which a folder is refused rather than opened badly.
 *
 * Someone will point this at their home directory. Reading it would not fail — it would fill the
 * tab's memory over several minutes and then die, having said nothing useful. Refusing takes a
 * second and names what was too big.
 */
const MAX_BYTES = 600 * 1024 * 1024;
const MAX_ENTRIES = 60_000;

const DB_NAME = "node-worker-handles";
const DB_VERSION = 1;
const STORE = "handles";
/** One project at a time, so one key. */
const KEY = "project";

/** Whether this browser can pick a directory at all. Chromium can; Firefox and Safari cannot. */
export function localDirSupported(): boolean {
	return typeof (globalThis as any).showDirectoryPicker === "function";
}

/**
 * Say what went wrong in terms of what the user did, not in terms of DOM exception names.
 *
 * `SecurityError` in particular is worth translating: the overwhelmingly likely cause is that this
 * page is running inside another site's frame — which is exactly how Puter launches it — and no
 * amount of clicking will fix that.
 */
function readable(err: unknown): Error {
	const name = (err as DOMException)?.name;
	if (name === "SecurityError") {
		return new Error(
			"this browser will not open a folder picker on this page — it is running inside another site's frame"
		);
	}
	if (name === "NotAllowedError") {
		return new Error("the folder picker needs a click to open, and this was not one");
	}
	return err instanceof Error ? err : new Error(String(err));
}

function isAbort(err: unknown): boolean {
	return (err as DOMException)?.name === "AbortError";
}

/**
 * Ask for a directory. **Must be called from a click handler.**
 *
 * Resolves `undefined` when the picker was dismissed, which is an ordinary outcome rather than a
 * failure — someone opened it to look and changed their mind.
 */
export async function pickLocalDir(): Promise<FileSystemDirectoryHandle | undefined> {
	const picker = (globalThis as any).showDirectoryPicker as
		| ((opts?: Record<string, unknown>) => Promise<FileSystemDirectoryHandle>)
		| undefined;
	if (typeof picker !== "function") {
		throw new Error("this browser cannot open a folder picker");
	}
	try {
		// `readwrite` up front so the grant covers what the runtime will actually do, rather than
		// prompting a second time the first time a program writes. `id` makes the picker reopen
		// wherever it was last used for this app specifically.
		return await picker({ id: "node-worker-project", mode: "readwrite", startIn: "documents" });
	} catch (err) {
		if (isAbort(err)) return undefined;
		throw readable(err);
	}
}

// ------------------------------------------------------------------ remembering it

function openDb(): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const idb = globalThis.indexedDB;
		// Absent in some private-browsing modes, where a folder simply cannot be remembered.
		if (!idb) {
			reject(new Error("this browser has no IndexedDB, so a folder cannot be remembered"));
			return;
		}
		const req = idb.open(DB_NAME, DB_VERSION);
		req.onupgradeneeded = () => {
			if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
		};
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error ?? new Error("could not open IndexedDB"));
		// Another tab holding an older version open. Reporting beats hanging forever.
		req.onblocked = () => reject(new Error("another tab is holding this database open"));
	});
}

/** One transaction, closed on the way out so a swap's reload is not blocked by it. */
async function withStore<T>(
	mode: IDBTransactionMode,
	fn: (store: IDBObjectStore) => IDBRequest
): Promise<T> {
	const db = await openDb();
	try {
		return await new Promise<T>((resolve, reject) => {
			const tx = db.transaction(STORE, mode);
			const req = fn(tx.objectStore(STORE));
			req.onsuccess = () => resolve(req.result as T);
			req.onerror = () => reject(req.error ?? new Error("IndexedDB request failed"));
			tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
		});
	} finally {
		db.close();
	}
}

/** Errors propagate: a folder that could not be saved would come back as a template. */
export function saveLocalDir(handle: FileSystemDirectoryHandle): Promise<void> {
	return withStore<void>("readwrite", (store) => store.put(handle, KEY));
}

/**
 * The remembered folder, if there is one — with no permission attached to it yet.
 *
 * Swallows its failures: no remembered folder and a database that would not open lead to the same
 * place, which is the template path.
 */
export async function loadLocalDir(): Promise<FileSystemDirectoryHandle | undefined> {
	try {
		const found = await withStore<unknown>("readonly", (store) => store.get(KEY));
		// A directory handle and nothing else — an older or corrupt value is not worth trusting.
		return found && (found as FileSystemHandle).kind === "directory"
			? (found as FileSystemDirectoryHandle)
			: undefined;
	} catch {
		return undefined;
	}
}

export async function forgetLocalDir(): Promise<void> {
	try {
		await withStore<void>("readwrite", (store) => store.delete(KEY));
	} catch {
		// Nothing to forget, or nowhere to forget it from.
	}
}

// ------------------------------------------------------------------ permission

/**
 * Whether this handle can be used right now, without asking.
 *
 * `queryPermission` never prompts, which is what makes this safe at boot — where there is no
 * gesture to spend. A remembered handle normally answers `"prompt"` here, because a grant does not
 * survive a reload unless the user made it permanent in the browser's own prompt.
 */
export async function localDirGranted(handle: FileSystemDirectoryHandle): Promise<boolean> {
	const query = (handle as unknown as {
		queryPermission?: (d: { mode: string }) => Promise<PermissionState>;
	}).queryPermission;
	if (typeof query !== "function") return true;
	try {
		return (await query.call(handle, { mode: "readwrite" })) === "granted";
	} catch {
		return false;
	}
}

/**
 * Ask for permission on a remembered handle. **Must be called from a click handler.**
 *
 * node-worker's own helper, because it is the same question the vfs asks — mounting a handle
 * without a grant fails per-operation with EACCES instead of once, up front.
 */
export function requestLocalDirAccess(handle: FileSystemDirectoryHandle): Promise<boolean> {
	return ensureDirectoryHandleAccess(handle, "readwrite");
}

// ------------------------------------------------------------------ the store

/**
 * The picked directory as a project store. Permission must already have been granted — listing it
 * is the first thing this does.
 */
export async function openLocalStore(
	handle: FileSystemDirectoryHandle
): Promise<HandleStore> {
	return createHandleStore(handle, await hasContents(handle), {
		skipDirs: SKIP_DIRS,
		maxBytes: MAX_BYTES,
		maxEntries: MAX_ENTRIES,
		noClear:
			"the workspace will not empty a folder you picked — switch to a template instead, or clear it yourself",
	});
}
