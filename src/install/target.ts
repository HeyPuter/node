// Where an install puts its files.
//
// The resolver and the downloader are the same everywhere; only the destination
// differs, and the two destinations differ a lot. Puter Drive is a remote store with
// a rate-sensitive batch API, ordering constraints and transient failures worth
// retrying. A memory mirror is a Map. Pretending those are the same thing is how the
// Drive-specific tuning ends up applied pointlessly to memory, or lost.

import type { PackageFile } from "./download";

export interface InstallTarget {
	/**
	 * The installed `package.json` in `dir`, or undefined if absent/unreadable.
	 * `dir` is project-root-relative with no leading or trailing slash; `""` is the
	 * project root itself.
	 *
	 * Drives the "already at the resolved version?" check that makes an install
	 * incremental and resumable.
	 */
	readPackageJson(dir: string): Promise<any | undefined>;

	/**
	 * Installed package directories under `node_modules`, relative to the project
	 * root — e.g. "node_modules/foo", "node_modules/@scope/bar". Descends one level
	 * into `@scope` dirs; ignores dotfiles like `.bin`. Empty if there is no
	 * `node_modules` yet.
	 */
	listTopLevelPackages(): Promise<string[]>;

	/** Remove an installed package directory, recursively. */
	remove(dir: string): Promise<void>;

	/**
	 * Write one package's files. Paths are project-root-relative; parent directories
	 * are the target's problem.
	 *
	 * Called once per package rather than once per install, so a target that needs to
	 * order or throttle writes has the granularity to.
	 */
	writeFiles(files: PackageFile[]): Promise<void>;

	/**
	 * Whether `writeFiles` must see shallower packages before deeper ones. True for
	 * Drive, where a parent directory has to exist before anything nested under its
	 * `node_modules` can be written; false where parents are implicit.
	 */
	readonly orderByDepth: boolean;

	/** Concurrent `writeFiles` calls the target can absorb. */
	readonly writeConcurrency: number;

	/** The word for what `writeFiles` does, for the install's own log lines. */
	readonly writeVerb: string;
}
