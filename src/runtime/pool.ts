// One worker per run.
//
// A run is a process, and the worker *is* that process: `process.exit` terminates it,
// and so do ctrl-C and a program wedged in a loop no message can interrupt. The
// alternative — a long-lived worker that reaps a finished run — cannot work, because
// closing sockets and timers does not undo a program that overwrote a global,
// monkeypatched a prototype or left a module-level singleton behind, and the module
// registries (SystemJS for ESM, the require cache for CJS) would still hold the last
// run's instances, so re-running the same path would not even re-execute it.
//
// So the worker is disposable and the project lives outside it — in the origin private
// filesystem, which the runtime now mounts directly rather than copying into each worker.
//
// That removed most of this file. There is no populate (nothing to copy), no `deltaSince`
// (nothing to bring up to date), and no post-run `harvest` (a program's writes are already in
// the store the moment it makes them, so there is no longer a window in which a wedged or
// exited worker loses them). A spare worker is still prewarmed, but only to hide the runtime's
// own boot — no longer to hide writing a `node_modules` across a message boundary.

import {
	NodeVfs,
	NodeWorker,
	WorkerExitError,
	createDirectoryHandleProvider,
	type NodeNetInit,
} from "node-worker";
import workerURL from "node-worker/worker?url";
import swURL from "node-worker/sw?url";

import {
	PROJECT_ROOT,
	type MirrorTarget,
	type MountEntry,
	type ProjectMirror,
	type ProjectStore,
} from "../project/mirror";
import type { RunRequest, RunResult, Runner } from "./run";

export type PoolStatus = "idle" | "starting" | "ready" | "running" | "error";

export interface PopulateProgress {
	written: number;
	total: number;
}

export interface PoolOptions {
	mirror: ProjectMirror;
	/** The project's files. Mounted at `PROJECT_ROOT`, shared by every worker. */
	projectHandle: FileSystemDirectoryHandle;
	/** Empty for an anonymous run, in which case `net` supplies what a token would have. */
	token: string;
	/** The relay URL and peer token an anonymous run uses instead of a puter token. */
	net?: NodeNetInit;
	/**
	 * Attach a worker's stdio to the terminal. Called once per worker, at the moment it
	 * becomes the live one — never at creation.
	 *
	 * The distinction is load-bearing. A terminal has one keyboard and one screen, so
	 * attaching a console necessarily detaches the previous one. A spare is built in the
	 * background *while the previous command is still running*, so attaching at creation
	 * would cut the running program's stdout off mid-stream and hand the keyboard to a
	 * worker that is doing nothing.
	 */
	attach: (worker: NodeWorker) => void;
	/** The terminal's dimensions, reported to each worker as stdout's columns/rows. */
	terminalSize: () => { columns: number; rows: number };
	/**
	 * The store the project lives in. Read from when reflecting a runtime write into the mirror,
	 * and written to directly only when there is no worker to write *through* — see
	 * `projectTarget`.
	 */
	store: ProjectStore;
	onStatus?: (status: PoolStatus, detail?: string) => void;
	onLog?: (text: string) => void;
}

function parentOf(path: string): string {
	let cut = path.lastIndexOf("/");
	return cut === -1 ? "" : path.slice(0, cut);
}

/** A worker, and the little that is still worth tracking about it. */
interface Member {
	worker: NodeWorker;
	/** Its filesystem, kept so an edit can be written through it and be seen as a change. */
	vfs: NodeVfs;
	/** The current run's injected module, which must not reach the mirror. */
	exclude?: string;
	/** Whether its stdio has been wired up; attaching twice would cancel its streams. */
	attached?: boolean;
}

export class WorkerPool implements Runner {
	private opts: PoolOptions;
	private live: Member | undefined;
	/** Built ahead of time so the next command does not wait for a populate. */
	private spare: Promise<Member> | undefined;
	private status: PoolStatus = "idle";
	private running = false;
	/** Paths the runtime changed, coalesced before being read back into the mirror. */
	private pendingReflect = new Set<string>();
	/**
	 * Paths written from this side, whose event needs no read-back.
	 *
	 * The mirror is already current for these — it is where the write came from — so reading each
	 * one back out of the store would mean an OPFS read per saved file, and a few hundred of them
	 * during an install. Entries are added only after a write lands (a failed one produces no
	 * event to match) and dropped on the first event that matches, so a later genuine change to
	 * the same path still reflects.
	 */
	private selfWrote = new Set<string>();
	private reflectTimer: ReturnType<typeof setTimeout> | undefined;

	constructor(opts: PoolOptions) {
		this.opts = opts;
	}

	get busy(): boolean {
		return this.running;
	}

	/** Bring up the first worker, reporting populate progress to the splash. */
	async start(onProgress?: (p: PopulateProgress) => void): Promise<void> {
		this.setStatus("starting");
		try {
			this.live = await this.create(onProgress);
			this.setStatus("ready");
		} catch (err) {
			this.setStatus("error", err instanceof Error ? err.message : String(err));
			throw err;
		}
	}

	/**
	 * Run one program to completion.
	 *
	 * The worker used is retired afterwards regardless of how the run ended: a run that
	 * returned normally can have left just as much global mess behind as one that
	 * exited, and there is no way to tell from out here.
	 */
	async run(request: RunRequest): Promise<RunResult> {
		if (this.running) throw new Error("a program is already running");
		this.running = true;
		this.setStatus("running");

		let member: Member;
		try {
			member = await this.acquire();
		} catch (err) {
			this.running = false;
			this.setStatus("error", err instanceof Error ? err.message : String(err));
			return { exitCode: 1, error: asError(err) };
		}

		let absolute = `${PROJECT_ROOT}/${request.path}`;
		let virtualPath = request.virtualModule
			? `${PROJECT_ROOT}/${request.virtualModule.path}`
			: undefined;
		// Recorded so the change-reflector never mirrors the injected module.
		member.exclude = request.virtualModule?.path;
		let result: RunResult;
		try {
			if (request.virtualModule && virtualPath) {
				await member.worker.registerVirtualModule(virtualPath, request.virtualModule.code);
			}
			let exitCode =
				request.module === "cjs"
					? await member.worker.require(absolute, { argv: request.argv, env: request.env })
					: await member.worker.import(absolute, { argv: request.argv, env: request.env });
			result = { exitCode };
		} catch (err) {
			// A program that called process.exit is reported by its status, not as a
			// failure: the worker being gone is the expected consequence, not a fault.
			result =
				err instanceof WorkerExitError
					? { exitCode: err.code }
					: { exitCode: 1, error: asError(err) };
		}

		// An injected module is a real file in the mount, so without this it would show up in
		// the project as a stray `[eval-…].mjs`. It now lives in the worker's *own* overlay
		// rather than in the shared project store, so this is tidiness rather than the
		// correctness fix it used to be — and `exclude` above covers it either way.
		if (virtualPath) {
			await member.worker.removeVirtualModule(virtualPath).catch(() => {});
		}

		// Nothing to read back: the run wrote straight into the store. Drain whatever the
		// reflector has queued so the tree is current before the worker goes away.
		await this.drainReflect();
		this.retire(member);

		this.running = false;
		this.setStatus("ready");
		return result;
	}

	/**
	 * Stop whatever is running.
	 *
	 * Nothing has to be rescued from the worker first — an interrupted program's writes are
	 * already in the store, which is the difference between terminating a worker now and
	 * terminating one that held the only copy of its own output. Queued mirror updates are
	 * drained so the tree reflects what the program managed to write.
	 */
	async stop(): Promise<void> {
		if (!this.running) return;
		let member = this.live;
		if (!member) return;
		await this.drainReflect();
		// `run` is still awaiting its `import`, which the terminate below rejects.
		this.retire(member);
	}

	/** Tell the running worker the terminal was resized. */
	async setTerminalSize(size: { columns: number; rows: number }): Promise<void> {
		try {
			await this.live?.worker.console.setSize(size);
		} catch {
			// No live worker, or it went away mid-resize. The next one is created with
			// the current size anyway.
		}
	}

	/**
	 * Where the mirror persists an edit: *through* the runtime's filesystem, not into the store
	 * underneath it.
	 *
	 * The bytes land in the same place either way — the provider is mounted on that store. What
	 * only this route produces is the **event**. A write that goes around the filesystem is
	 * invisible to it, so nothing inside the runtime learns the file changed, `fs.watch` never
	 * fires and a running dev server never rebuilds. Saving a file has to look like a filesystem
	 * change, because that is what it is.
	 *
	 * This replaces the old `syncLive()`, which pushed the mirror's latest into the running
	 * worker's private replica. There is no replica now, so nothing to push — but "the running
	 * worker has to hear about it" survived the change, and this is where it lives.
	 *
	 * Falls back to the store when there is no worker to write through, during boot or after a
	 * failure: persisting the edit still matters more than announcing it, and with nothing running
	 * there is nobody to announce it to.
	 */
	get projectTarget(): MirrorTarget {
		let absolute = (path: string) => `${PROJECT_ROOT}/${path}`;
		return {
			writeMany: async (entries) => {
				let vfs = this.live?.vfs;
				if (!vfs) return this.opts.store.writeMany(entries);
				let all = [...entries];
				// Parents first, deduplicated: `writeFile` does not create directories, and an
				// install writes hundreds of files into a handful of them.
				let dirs = new Set<string>();
				for (let entry of all) {
					let path = entry.data === undefined ? entry.path : parentOf(entry.path);
					if (path) dirs.add(path);
				}
				for (let dir of [...dirs].sort()) {
					await vfs.mkdir(absolute(dir), { recursive: true });
				}
				for (let entry of all) {
					if (entry.data === undefined) continue;
					await vfs.writeFile(absolute(entry.path), entry.data);
					this.selfWrote.add(entry.path);
				}
			},
			remove: async (paths) => {
				let vfs = this.live?.vfs;
				if (!vfs) return this.opts.store.remove(paths);
				for (let path of paths) {
					await vfs.rm(absolute(path), { recursive: true, force: true });
				}
			},
		};
	}

	/** Discard the current worker and any spare, then build a fresh one. */
	async restart(onProgress?: (p: PopulateProgress) => void): Promise<void> {
		let old = this.live;
		this.live = undefined;
		old?.worker.terminate();
		void this.discardSpare();
		this.running = false;
		await this.start(onProgress);
	}

	dispose(): void {
		this.live?.worker.terminate();
		this.live = undefined;
		void this.discardSpare();
	}

	// ------------------------------------------------------------- internals

	/** A worker, from the spare when one is ready. */
	private async acquire(): Promise<Member> {
		if (!this.live) {
			let pending = this.spare;
			this.spare = undefined;
			this.live = pending ? await pending : await this.create();
		}
		// Now that it is the live worker, and not before, give it the terminal.
		this.attachOnce(this.live);
		// No sync step. A spare cannot be stale, because it was never a copy — it is mounted on
		// the same store every edit goes to.
		return this.live;
	}

	/**
	 * Wire a worker's stdio up, exactly once.
	 *
	 * Re-attaching the same console would cancel the readers it already has, and a
	 * cancelled stream never yields again — so the worker would fall silent for the rest
	 * of its life rather than merely repeating itself.
	 */
	private attachOnce(member: Member): void {
		if (member.attached) return;
		member.attached = true;
		this.opts.attach(member.worker);
	}

	private async create(onProgress?: (p: PopulateProgress) => void): Promise<Member> {
		// A filesystem per worker, so `/tmp`, the overlay and injected modules stay private to
		// each run — but the *project provider* is shared, so every worker sees one set of files.
		// Mount tables are per session; providers are not.
		// No token, no puterfs: an anonymous run gets a memory root under the project mount,
		// which is all the project itself ever needed — it lives in this device's storage.
		let vfs = new NodeVfs(
			this.opts.token ? { puter: { token: this.opts.token } } : {}
		);
		// `overlay` because a run's entry point is injected *into* the project — it has to live
		// there to resolve the project's own `node_modules` — and writing it to the store would
		// leave a stray `[command].mjs` behind after every run.
		vfs.mount(
			PROJECT_ROOT,
			(mount) => createDirectoryHandleProvider(this.opts.projectHandle, mount),
			{ overlay: true }
		);

		// A program's writes land in the store directly, so the mirror — which is only the UI's
		// read model now — is kept current from the runtime's own watch events instead of being
		// read back after the fact.
		vfs.onFsEvent((event) => this.reflect(event));

		let worker = await NodeWorker.create(workerURL, this.opts.token, PROJECT_ROOT, {
			keepalive: true,
			swURL,
			vfs,
			net: this.opts.net,
		});
		// The output really is a terminal, and a CLI that lays out progress needs its
		// width: vite's build truncates to `process.stdout.columns`, so a wrong or
		// missing value shows up as mangled output rather than as an error.
		await worker.console.setIsTTY(true, this.opts.terminalSize());

		let member: Member = { worker, vfs };
		// Nothing to populate, so the only progress there is to report is "done". Kept so the
		// splash keeps its shape rather than special-casing a phase that now takes no time.
		onProgress?.({ written: 1, total: 1 });
		return member;
	}

	/**
	 * Reflect a change the runtime made into the mirror, so the tree and the editor see it.
	 *
	 * Replaces the old read-back-after-the-run entirely, and is strictly better: it is live
	 * rather than post-hoc, and it cannot lose anything to a worker that wedged or exited, since
	 * the bytes are already in the store by the time the event arrives.
	 */
	private reflect(event: { kind: string; path: string; isDir: boolean }): void {
		if (!event.path.startsWith(PROJECT_ROOT)) return;
		let path = event.path.slice(PROJECT_ROOT.length).replace(/^\/+/, "");
		if (!path || path === this.live?.exclude) return;

		if (event.kind === "removed") {
			this.opts.mirror.applyFromStore(() => this.opts.mirror.delete(path));
			return;
		}
		if (event.isDir) {
			this.opts.mirror.applyFromStore(() => this.opts.mirror.mkdir(path));
			return;
		}
		if (this.selfWrote.delete(path)) return;
		// Coalesced: a build writes the same handful of files repeatedly, and reading each one
		// back per event would mean a read per write rather than a read per settle.
		this.pendingReflect.add(path);
		if (this.reflectTimer !== undefined) return;
		this.reflectTimer = setTimeout(() => {
			this.reflectTimer = undefined;
			void this.drainReflect();
		}, 40);
	}

	private async drainReflect(): Promise<void> {
		let paths = [...this.pendingReflect];
		this.pendingReflect.clear();
		let writes: MountEntry[] = [];
		for (let path of paths) {
			let data = await this.opts.store.read(path);
			if (data) writes.push({ path, data });
		}
		if (writes.length > 0) {
			this.opts.mirror.applyFromStore(() => this.opts.mirror.writeMany(writes));
		}
	}

	/** Terminate a used worker and start filling its replacement. */
	private retire(member: Member): void {
		if (this.live === member) this.live = undefined;
		member.worker.terminate();
		this.prewarm();
	}

	private prewarm(): void {
		if (this.spare) return;
		this.spare = this.create().catch((err) => {
			// Don't strand the failure on an unobserved promise: clear it so `acquire`
			// builds one synchronously (and surfaces the error) rather than awaiting a
			// spare that will never arrive.
			this.spare = undefined;
			throw err;
		});
		// The rejection above is re-thrown for `acquire`; nothing else observes it.
		this.spare.catch(() => {});
	}

	private async discardSpare(): Promise<void> {
		let pending = this.spare;
		this.spare = undefined;
		if (!pending) return;
		try {
			(await pending).worker.terminate();
		} catch {
			// It never came up; there is nothing to terminate.
		}
	}

	private setStatus(status: PoolStatus, detail?: string) {
		this.status = status;
		this.opts.onStatus?.(status, detail);
	}

	get currentStatus(): PoolStatus {
		return this.status;
	}
}

function asError(err: unknown): Error {
	return err instanceof Error ? err : new Error(String(err));
}
