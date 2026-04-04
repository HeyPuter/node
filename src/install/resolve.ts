// Dependency resolution against the npm registry.
//
// Deliberately free of `puter`, the DOM and Vite-only imports (`?raw`), because
// three very different callers need the *same* answer out of it:
//
//   - the in-page install writing into a memory mount,
//   - the in-page install uploading to Puter Drive,
//   - `scripts/build-template.mjs`, running under plain Node to bake a tarball.
//
// That last one is why this is a separate module rather than part of npm-install.ts.
// The layout it produces is not incidental: node-worker's module resolver has a
// redirect table keyed on where these packages land and which version they are (see
// `moduleRedirects` in node-worker/src/worker/module/resolve.ts), so a tarball built
// by a second, "equivalent" resolver would be subtly wrong in ways that only show up
// when a bundler tries to load its native binding.

import semver from "semver";

export const NPM_REGISTRY = "https://registry.npmjs.org";
const RESOLVE_CONCURRENCY = 16;

export type Packument = {
	versions: Record<string, PackageVersion>;
	"dist-tags"?: Record<string, string>;
};

export type PackageVersion = {
	name: string;
	version: string;
	dist: { tarball: string };
	dependencies?: Record<string, string>;
};

export type ResolvedPackage = {
	name: string;
	version: string;
	tarballUrl: string;
	/**
	 * Install path relative to the project root, no leading slash — e.g.
	 * "node_modules/foo" or "node_modules/parent/node_modules/foo".
	 */
	installDir: string;
};

/** Where progress goes. The page writes to a terminal; the build script to stdout. */
export type ResolveLog = (text: string) => void;

export async function resolveTree(
	rootDeps: Record<string, string>,
	log: ResolveLog
): Promise<ResolvedPackage[]> {
	type Hoisted = { version: string; installDir: string };
	let hoisted = new Map<string, Hoisted>();
	let resolved: ResolvedPackage[] = [];
	let packumentCache = new Map<string, Promise<Packument>>();

	type WorkItem = {
		name: string;
		range: string;
		/** installDir of the requesting parent, relative to the root. "" = root. */
		parentDir: string;
	};

	let getPackument = (name: string): Promise<Packument> => {
		let cached = packumentCache.get(name);
		if (cached) return cached;
		let url = `${NPM_REGISTRY}/${encodeURIComponent(name).replace("%40", "@")}`;
		let p = fetch(url).then(async (res) => {
			if (!res.ok) throw new Error(`registry ${name}: HTTP ${res.status}`);
			return (await res.json()) as Packument;
		});
		packumentCache.set(name, p);
		return p;
	};

	let pickVersion = (name: string, pack: Packument, range: string): string => {
		let resolvedRange = range;
		let tag = pack["dist-tags"]?.[range];
		if (tag) resolvedRange = tag;
		let versions = Object.keys(pack.versions);
		let max = semver.maxSatisfying(versions, resolvedRange, { includePrerelease: false });
		if (!max) {
			let coerced = semver.coerce(range);
			if (coerced && pack.versions[coerced.version]) return coerced.version;
			throw new Error(`no version of ${name} satisfies ${range}`);
		}
		return max;
	};

	let pending: WorkItem[] = Object.entries(rootDeps).map(([name, range]) => ({
		name,
		range,
		parentDir: "",
	}));

	// Two packages ship only native builds that don't exist for this runtime's
	// "browser"/"wasm" target, and for both the node-worker resolver transparently
	// redirects to a WASM equivalent that isn't a dependency of the original (and
	// wouldn't be installed anyway — we skip optionalDependencies). So pull them in
	// ourselves once the requested tree is resolved. One-shot, so the injected
	// subtrees can't retrigger injection.
	let injectedWasmFallbacks = false;

	while (pending.length > 0) {
		let batch = pending.splice(0, RESOLVE_CONCURRENCY);
		for (let item of batch) void getPackument(item.name);

		for (let item of batch) {
			let existing = hoisted.get(item.name);
			if (existing && rangeSatisfies(item.range, existing.version)) continue;

			let pack = await getPackument(item.name);
			let version = pickVersion(item.name, pack, item.range);
			let versionInfo = pack.versions[version];
			if (!versionInfo) throw new Error(`registry ${item.name}@${version} missing version info`);

			// Re-check after await — another item in this batch may have hoisted.
			existing = hoisted.get(item.name);
			if (existing && rangeSatisfies(item.range, existing.version)) continue;

			let installDir: string;
			if (!existing) {
				installDir = `node_modules/${item.name}`;
				hoisted.set(item.name, { version, installDir });
			} else if (existing.version === version) {
				continue;
			} else {
				installDir = `${item.parentDir}/node_modules/${item.name}`;
				if (installDir === existing.installDir) {
					log(
						`  warning: ${item.name}@${item.range} conflicts with hoisted ${existing.version}, keeping hoisted\n`
					);
					continue;
				}
			}

			let pkg: ResolvedPackage = {
				name: item.name,
				version,
				tarballUrl: versionInfo.dist.tarball,
				installDir,
			};
			resolved.push(pkg);
			log(`  ${item.name}@${item.range} -> ${version}\n`);

			for (let [childName, childRange] of Object.entries(versionInfo.dependencies ?? {})) {
				pending.push({ name: childName, range: childRange, parentDir: installDir });
			}
		}

		// Once the requested tree fully drains, inject each WASM counterpart pinned
		// to the exact resolved version of the package it stands in for. Both
		// publish in lockstep with their native twin, and both have to: rollup's
		// convert-ast decodes the AST buffer the WASM parser writes, and esbuild's
		// JS API and its wasm speak a versioned stdio protocol. Skipped when the
		// original isn't in the tree, or the user pinned the WASM build themselves.
		if (pending.length === 0 && !injectedWasmFallbacks) {
			injectedWasmFallbacks = true;
			let rollupHoist = hoisted.get("rollup");
			if (rollupHoist && !hoisted.has("@rollup/wasm-node")) {
				log(`  + @rollup/wasm-node@${rollupHoist.version} (WASM rollup for browser runtime)\n`);
				pending.push({
					name: "@rollup/wasm-node",
					range: rollupHoist.version,
					parentDir: "",
				});
			}
			// esbuild's JS API only drives a native subprocess, so it can't run here
			// at all; esbuild-wasm carries the same version's compiler as a wasm
			// module. The esbuild shim (./shims.ts) then adds the adapter that makes
			// it answer to esbuild's node API. (vite 8 lists esbuild as an optional
			// *peer* and uses rolldown instead, so on a vite 8 tree there's nothing
			// to inject.)
			let esbuildHoist = hoisted.get("esbuild");
			if (esbuildHoist && !hoisted.has("esbuild-wasm")) {
				log(`  + esbuild-wasm@${esbuildHoist.version} (WASM esbuild for browser runtime)\n`);
				pending.push({
					name: "esbuild-wasm",
					range: esbuildHoist.version,
					parentDir: "",
				});
			}
		}
	}

	return resolved;
}

function rangeSatisfies(range: string, version: string): boolean {
	try {
		return semver.satisfies(version, range, { includePrerelease: true });
	} catch {
		return false;
	}
}

/**
 * Strip a tarball entry's leading directory ("package/") and normalize the rest.
 *
 * Tarballs sometimes encode the same file twice with different spellings (e.g.
 * "package/dist/x.js" and "package/./dist/x.js"). Anything that dedupes by target
 * path has to normalize before keying, or the two look distinct here and identical
 * to whatever consumes them. Also guards against ".." traversal escaping the
 * package directory. Returns null for entries with nothing left (directories,
 * PAX/long-name headers).
 *
 * Not replaceable by modern-tar's `strip: 1`, which does neither of those things.
 */
export function stripPackagePrefix(p: string): string | null {
	if (!p) return null;
	let slash = p.indexOf("/");
	if (slash < 0) return null;
	let rest = p.slice(slash + 1);
	if (!rest || rest.endsWith("/")) return null;
	let out: string[] = [];
	for (let seg of rest.split("/")) {
		if (seg === "" || seg === ".") continue;
		if (seg === "..") {
			if (out.length === 0) return null;
			out.pop();
			continue;
		}
		out.push(seg);
	}
	if (out.length === 0) return null;
	return out.join("/");
}

export async function mapWithConcurrency<T>(
	items: T[],
	concurrency: number,
	fn: (item: T) => Promise<void>
): Promise<void> {
	let i = 0;
	let workers: Promise<void>[] = [];
	for (let w = 0; w < Math.min(concurrency, items.length); w++) {
		workers.push(
			(async () => {
				while (true) {
					let idx = i++;
					if (idx >= items.length) return;
					await fn(items[idx]);
				}
			})()
		);
	}
	await Promise.all(workers);
}

export function errMsg(e: unknown): string {
	if (e instanceof Error) return e.message;
	return String(e);
}
