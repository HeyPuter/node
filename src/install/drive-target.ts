// Installing into real Puter Drive.
//
// Every constant here is a concession to the backend rather than a preference, and
// the comments say which, because they are the kind of thing that looks arbitrary
// later and gets "cleaned up".

import type { PackageFile } from "./download";
import type { InstallTarget } from "./target";
import { errMsg } from "./resolve";

// Kept deliberately low: the backend 500s on /fs/completeBatchWrite when too many
// large batch writes land at once (then the SDK's per-file completeWrite fallback
// 409s). Fewer concurrent uploads + retry keeps it within what the server can absorb.
const UPLOAD_CONCURRENCY = 4;
const MAX_UPLOAD_ATTEMPTS = 5;

export function createDriveTarget(puter: any, cwd: string): InstallTarget {
	let isDir = (e: any): boolean => e?.is_dir ?? e?.isDirectory ?? false;

	let readdir = async (path: string): Promise<any[]> => {
		try {
			return (await puter.fs.readdir(path)) ?? [];
		} catch {
			return [];
		}
	};

	return {
		orderByDepth: true,
		writeConcurrency: UPLOAD_CONCURRENCY,
		writeVerb: "uploading",

		async readPackageJson(dir) {
			// `dir` is "" for the project root; joining it blindly would ask the api
			// for `<cwd>//package.json`.
			let base = dir === "" ? cwd : `${cwd}/${dir}`;
			try {
				let f = await puter.fs.read(`${base}/package.json`);
				return JSON.parse(await f.text());
			} catch {
				return undefined;
			}
		},

		async listTopLevelPackages() {
			let out: string[] = [];
			for (let e of await readdir(`${cwd}/node_modules`)) {
				let name: string | undefined = e?.name;
				if (!name || name.startsWith(".") || !isDir(e)) continue;
				if (name.startsWith("@")) {
					for (let s of await readdir(`${cwd}/node_modules/${name}`)) {
						let sub: string | undefined = s?.name;
						if (!sub || sub.startsWith(".")) continue;
						out.push(`node_modules/${name}/${sub}`);
					}
				} else {
					out.push(`node_modules/${name}`);
				}
			}
			return out;
		},

		async remove(dir) {
			try {
				await puter.fs.delete(`${cwd}/${dir}`);
			} catch {
				// A package we wanted gone being already gone is the desired state.
			}
		},

		// One fs.upload() per package rather than all files at once: one giant batch
		// overwhelms the backend (500s on completeBatchWrite, then a 409 cascade on the
		// per-file completeWrite fallback), and the SDK also does an O(dirs × files)
		// nesting pass that stalls the worker.
		//
		// Retries with backoff to ride out transient 500/409s instead of aborting the
		// whole install.
		async writeFiles(files: PackageFile[]) {
			if (files.length === 0) return;
			let uploads = files.map((f) => new File([f.data as BlobPart], f.path));
			let lastErr: unknown;
			for (let attempt = 1; attempt <= MAX_UPLOAD_ATTEMPTS; attempt++) {
				try {
					await puter.fs.upload(uploads, cwd, {
						createMissingParents: true,
						overwrite: true,
					});
					return;
				} catch (err) {
					lastErr = err;
					if (attempt < MAX_UPLOAD_ATTEMPTS) {
						await sleep(Math.min(4000, 300 * 2 ** (attempt - 1)));
					}
				}
			}
			throw new Error(
				`upload failed after ${MAX_UPLOAD_ATTEMPTS} attempts: ${errMsg(lastErr)}`
			);
		},
	};
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
