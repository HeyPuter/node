// Running commands against a real Puter Drive directory.
//
// The workspace's counterpart to this keeps the project in memory and has to re-populate a
// fresh worker every run. Here the filesystem outlives the worker by definition, so a
// replacement worker sees the same files and nothing has to be carried across — which is
// what lets `npm run build` work in the terminal too, even though every step of
// `tsc && vite build` exits.

import { NodeWorker, WorkerExitError, type Console as NodeWorkerConsole } from "node-worker";
import workerURL from "node-worker/worker?url";

import { createDriveTarget } from "../install/drive-target";
import type { CommandTarget } from "./command";
import type { RunRequest, RunResult } from "./run";

export interface DriveCommandOptions {
	puter: any;
	token: string;
	/** Absolute Drive directory, no trailing slash. */
	cwd: string;
	/** Wires a newly created worker's stdio up. Called for every worker. */
	attach: (console: NodeWorkerConsole) => void;
	/** Called before a worker is discarded, so its stdio can be detached. */
	detach?: () => void;
}

export interface DriveCommandTarget extends CommandTarget {
	/** Terminate the worker, if one is running. */
	dispose(): void;
}

export function createDriveCommandTarget(opts: DriveCommandOptions): DriveCommandTarget {
	let install = createDriveTarget(opts.puter, opts.cwd);
	let worker: NodeWorker | undefined;

	let acquire = async (): Promise<NodeWorker> => {
		if (worker) return worker;
		let next = new NodeWorker(workerURL, opts.token, opts.cwd, { keepalive: true });
		worker = next;
		opts.attach(next.console as NodeWorkerConsole);
		await next.ready;
		await next.console.setIsTTY(true);
		return next;
	};

	let discard = () => {
		if (!worker) return;
		opts.detach?.();
		worker.terminate();
		worker = undefined;
	};

	return {
		label: opts.cwd,
		install,

		absolute(path) {
			return path === "" ? opts.cwd : `${opts.cwd}/${path}`;
		},

		async hasFile(path) {
			try {
				let stat = await opts.puter.fs.stat(this.absolute(path));
				return !(stat?.is_dir ?? stat?.isDirectory ?? false);
			} catch {
				return false;
			}
		},

		async run(request: RunRequest): Promise<RunResult> {
			let target = this.absolute(request.path);
			let virtualPath = request.virtualModule
				? this.absolute(request.virtualModule.path)
				: undefined;

			let active: NodeWorker;
			try {
				active = await acquire();
			} catch (err) {
				discard();
				return { exitCode: 1, error: asError(err) };
			}

			try {
				if (request.virtualModule && virtualPath) {
					await active.registerVirtualModule(virtualPath, request.virtualModule.code);
				}
				let exitCode =
					request.module === "cjs"
						? await active.require(target, { argv: request.argv, env: request.env })
						: await active.import(target, { argv: request.argv, env: request.env });
				// Best-effort: a program that exited took the worker with it.
				if (virtualPath) await active.removeVirtualModule(virtualPath).catch(() => {});
				return { exitCode };
			} catch (err) {
				// `process.exit` is the program's status, not a failure — and it means this
				// worker is gone, so the next step of a chain gets a fresh one.
				if (err instanceof WorkerExitError) {
					discard();
					return { exitCode: err.code };
				}
				return { exitCode: 1, error: asError(err) };
			}
		},

		dispose: discard,
	};
}

function asError(err: unknown): Error {
	return err instanceof Error ? err : new Error(String(err));
}
