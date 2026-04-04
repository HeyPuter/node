// Copying the project out to Puter Drive.
//
// Reads the mirror, not the worker, so it works while a program is running and does not
// care whether a worker happens to be alive. Writing reuses the Drive install target,
// which already knows how to batch and retry against the api's limits.

import { createDriveTarget } from "../install/drive-target";
import type { PackageFile } from "../install/download";
import type { ProjectMirror } from "../project/mirror";

/** Files per fs.upload() call. The Drive target's own comments explain the ceiling. */
const BATCH = 64;

export interface ExportOptions {
	puter: any;
	mirror: ProjectMirror;
	/** Absolute Drive directory to write into. Created if missing. */
	destination: string;
	write: (text: string) => void;
}

export async function exportToDrive(opts: ExportOptions): Promise<number> {
	let { puter, mirror, destination, write } = opts;
	let started = Date.now();

	let files: PackageFile[] = [...mirror.allFiles()];
	if (files.length === 0) {
		write("export: nothing to export\n");
		return 1;
	}

	write(`export: copying /project to ${destination} (including node_modules)...\n`);

	try {
		await puter.fs.mkdir(destination, { createMissingParents: true, dedupeName: false });
	} catch {
		// Already there, which is the state we want.
	}

	let target = createDriveTarget(puter, destination);
	let done = 0;
	try {
		// Batched by file count rather than uploaded per-package: an export has no
		// package structure to group by, and one call per file would be thousands of
		// round trips.
		for (let at = 0; at < files.length; at += BATCH) {
			await target.writeFiles(files.slice(at, at + BATCH));
			done = Math.min(at + BATCH, files.length);
			write(`  ${done}/${files.length} files\n`);
		}
	} catch (err) {
		write(`export: failed after ${done}/${files.length} files: ${message(err)}\n`);
		return 1;
	}

	let elapsed = ((Date.now() - started) / 1000).toFixed(1);
	write(`export: done — ${files.length} files to ${destination} in ${elapsed}s\n`);
	return 0;
}

function message(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
