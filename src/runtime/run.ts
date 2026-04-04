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
}

export interface RunResult {
	exitCode: number;
	/** Set when the run failed for a reason other than a non-zero exit. */
	error?: Error;
}

export interface Runner {
	run(request: RunRequest): Promise<RunResult>;
}
