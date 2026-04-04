// `npm install`, as an orchestration of ./install/*.
//
// Resolution (./install/resolve.ts) and downloading (./install/download.ts) are the
// same wherever the files end up; only the destination differs, and that is an
// `InstallTarget`. The log lines are load-bearing in one narrow sense — they are the
// UI's only view of an install — so they stay stable, with the target supplying the
// verb for the step that genuinely differs.

import { fetchPackages } from "./install/download";
import { errMsg, mapWithConcurrency, resolveTree, type ResolvedPackage } from "./install/resolve";
import { runtimeShimFiles } from "./install/shims";
import type { InstallTarget } from "./install/target";

// Shipped as source rather than published to npm: the runtime side of the esbuild
// swap is a single redirect rule, and this is the file it redirects to. See
// ./install/shims.ts for where it lands and why.
import esbuildWasmShim from "./shims/esbuild-wasm.cjs?raw";

const CHECK_CONCURRENCY = 16;

export type NpmInstallRuntime = {
	target: InstallTarget;
	writeText: (text: string) => void;
	/** Where the log says it is reading package.json from. Cosmetic. */
	label: string;
};

export async function runNpmInstall(runtime: NpmInstallRuntime): Promise<number> {
	let started = Date.now();
	let { target, writeText } = runtime;

	writeText(`npm install: reading ${runtime.label}/package.json\n`);
	let pkg = await target.readPackageJson("");
	if (!pkg) {
		writeText(`npm install: no readable package.json at ${runtime.label}\n`);
		return 1;
	}
	let rootDeps: Record<string, string> = {
		...(pkg.dependencies ?? {}),
		...(pkg.devDependencies ?? {}),
	};

	let depCount = Object.keys(rootDeps).length;
	if (depCount === 0) {
		writeText(`npm install: package.json has no dependencies\n`);
		return 0;
	}
	writeText(`npm install: ${depCount} top-level deps, resolving...\n`);

	let resolved: ResolvedPackage[];
	try {
		resolved = await resolveTree(rootDeps, writeText);
	} catch (err) {
		writeText(`npm install: resolve failed: ${errMsg(err)}\n`);
		return 1;
	}
	writeText(`npm install: resolved ${resolved.length} packages\n`);

	// Prune packages present in node_modules but no longer in the resolved tree, so
	// removed dependencies don't linger. Top-level + one scope level only — that's
	// where the hoisting resolver places things, and deleting a stale top-level dir
	// takes its nested node_modules with it.
	try {
		let keep = new Set(resolved.map((p) => p.installDir));
		let installed = await target.listTopLevelPackages();
		let removed = installed.filter((dir) => !keep.has(dir));
		for (let dir of removed) await target.remove(dir);
		if (removed.length > 0) {
			writeText(`npm install: pruned ${removed.length} removed package(s)\n`);
		}
	} catch (err) {
		writeText(`npm install: prune warning: ${errMsg(err)}\n`);
	}

	// Skip packages already installed at the resolved version. This is what makes the
	// install incremental and resumable: a re-run only fetches and writes what's
	// missing, shrinking each run to something the destination can handle (and letting
	// a failed run be finished simply by running again).
	let pending: ResolvedPackage[];
	try {
		pending = await filterInstalled(target, resolved);
	} catch (err) {
		writeText(`npm install: state check failed: ${errMsg(err)}\n`);
		return 1;
	}
	let cached = resolved.length - pending.length;
	if (cached > 0) writeText(`npm install: ${cached} already up to date\n`);
	if (pending.length === 0) {
		await writeShims(runtime, resolved);
		let elapsed = ((Date.now() - started) / 1000).toFixed(1);
		writeText(`npm install: done, ${resolved.length} packages up to date in ${elapsed}s\n`);
		return 0;
	}
	writeText(`npm install: downloading ${pending.length} package(s)...\n`);

	let fetched;
	try {
		fetched = await fetchPackages(pending, writeText);
	} catch (err) {
		writeText(`npm install: download failed: ${errMsg(err)}\n`);
		return 1;
	}

	let totalFiles = fetched.reduce((n, p) => n + p.files.length, 0);
	writeText(
		`npm install: ${target.writeVerb} ${totalFiles} files across ${fetched.length} package(s)...\n`
	);

	try {
		// Group by install depth when the target needs a parent to exist before
		// anything nested under its node_modules is written. Within a layer no package
		// is an ancestor of another, so they can go concurrently.
		let layers = target.orderByDepth
			? [...groupByDepth(fetched).entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v)
			: [fetched];

		let written = 0;
		for (let layer of layers) {
			await mapWithConcurrency(layer, target.writeConcurrency, async (pkg) => {
				await target.writeFiles(pkg.files);
				written += 1;
				if (written % 10 === 0 || written === fetched.length) {
					writeText(`  ${target.writeVerb} ${written}/${fetched.length}\n`);
				}
			});
		}
	} catch (err) {
		writeText(`npm install: ${target.writeVerb} failed: ${errMsg(err)}\n`);
		writeText(`npm install: re-run to resume — installed packages are skipped\n`);
		return 1;
	}

	await writeShims(runtime, resolved);

	let elapsed = ((Date.now() - started) / 1000).toFixed(1);
	writeText(
		`npm install: done, ${fetched.length} installed (${cached} cached), ${totalFiles} files in ${elapsed}s\n`
	);
	return 0;
}

/**
 * Write the runtime shims, unconditionally. A failure here doesn't invalidate the
 * install (only esbuild breaks), so it warns rather than aborting.
 */
async function writeShims(
	runtime: NpmInstallRuntime,
	resolved: ResolvedPackage[]
): Promise<void> {
	let files = runtimeShimFiles(resolved, esbuildWasmShim);
	for (let file of files) {
		try {
			await runtime.target.writeFiles([file]);
			runtime.writeText(`npm install: + ${file.path} (esbuild WASM shim)\n`);
		} catch (err) {
			runtime.writeText(`npm install: shim warning: ${file.path}: ${errMsg(err)}\n`);
		}
	}
}

/** The subset of `resolved` not already installed at the resolved version. */
async function filterInstalled(
	target: InstallTarget,
	resolved: ResolvedPackage[]
): Promise<ResolvedPackage[]> {
	let pending: ResolvedPackage[] = [];
	await mapWithConcurrency(resolved, CHECK_CONCURRENCY, async (pkg) => {
		let installed = await target.readPackageJson(pkg.installDir);
		if (installed?.version !== pkg.version) pending.push(pkg);
	});
	return pending;
}

function groupByDepth<T extends { installDir: string }>(packages: T[]): Map<number, T[]> {
	let byDepth = new Map<number, T[]>();
	for (let pkg of packages) {
		let depth = pkg.installDir.split("/").length;
		let layer = byDepth.get(depth);
		if (layer) layer.push(pkg);
		else byDepth.set(depth, [pkg]);
	}
	return byDepth;
}
