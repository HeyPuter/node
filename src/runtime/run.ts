// What it takes to execute one program, independent of who owns the worker.
//
// Two things implement this: the workspace's `WorkerPool`, which gets a fresh worker per run
// and mounts the project from this device's storage, and the Puter-terminal runner, which keeps
// one worker over a real Drive directory. The command layer is written against the
// interface so it does not know or care which it is talking to.

export interface RunRequest {
	/** Path of the module to run, relative to the target's root. */
	path: string;
	/** The complete `process.argv`, `argv[0]` included. */
	argv: string[];
	/** Replaces `process.env` for the run. */
	env: Record<string, string>;
	module?: "esm" | "cjs";
	/** Registered before the run and removed after — how `--eval` is delivered. */
	virtualModule?: { path: string; code: string };
	/**
	 * Absolute directory the program runs in, in the runtime's own namespace. Defaults to the
	 * target's root.
	 *
	 * Only a shell that has a working directory has anything to put here — a `cd src` has to
	 * reach `process.cwd()`, or a program run from `src` resolves its relative paths from
	 * somewhere the user did not ask for. Ignored by the Puter-terminal runner, whose cwd is
	 * fixed when its long-lived worker is created.
	 */
	cwd?: string;
}

export interface RunResult {
	exitCode: number;
	/** Set when the run failed for a reason other than a non-zero exit. */
	error?: Error;
	/**
	 * The host stopped this run on purpose — ctrl-C, or Stop.
	 *
	 * Terminating a worker rejects whatever it was running, so without this the ordinary outcome of
	 * pressing ctrl-C is indistinguishable from a crash, and gets reported as one: "Error: Worker
	 * terminated", with a stack trace through the pool.
	 */
	interrupted?: boolean;
}

export interface Runner {
	run(request: RunRequest): Promise<RunResult>;
}
