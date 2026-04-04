// Installing into the page's project mirror.
//
// Almost nothing to it, which is the point of the `InstallTarget` seam: no depth
// ordering (parents are implied by a path), no retry (there is no server to fail), no
// concurrency ceiling (it is a Map). Propagating to the live worker is the mirror's
// job, not this module's.

import type { ProjectMirror } from "../project/mirror";
import type { PackageFile } from "./download";
import type { InstallTarget } from "./target";

export function createMirrorTarget(mirror: ProjectMirror): InstallTarget {
	return {
		orderByDepth: false,
		// Synchronous underneath, so the "concurrency" only decides how many packages
		// are grouped per await. 1 keeps the log's progress counter monotonic.
		writeConcurrency: 1,
		writeVerb: "writing",

		async readPackageJson(dir) {
			return mirror.readJson(dir === "" ? "package.json" : `${dir}/package.json`);
		},

		async listTopLevelPackages() {
			let out: string[] = [];
			for (let entry of mirror.list("node_modules")) {
				if (entry.kind !== "dir" || entry.name.startsWith(".")) continue;
				if (entry.name.startsWith("@")) {
					for (let scoped of mirror.list(entry.path)) {
						if (scoped.name.startsWith(".")) continue;
						out.push(scoped.path);
					}
				} else {
					out.push(entry.path);
				}
			}
			return out;
		},

		async remove(dir) {
			mirror.delete(dir);
		},

		async writeFiles(files: PackageFile[]) {
			mirror.writeMany(files);
		},
	};
}
