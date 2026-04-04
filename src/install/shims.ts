// Runtime shims dropped into installed packages.
//
// Takes the shim *source* as an argument rather than importing it, so this module
// stays importable from plain Node: the browser build gets it through Vite's `?raw`,
// and `scripts/build-template.mjs` reads the same file off disk.

import type { PackageFile } from "./download.ts";
import type { ResolvedPackage } from "./resolve.ts";

/**
 * Where the esbuild shim goes, relative to the esbuild-wasm install dir.
 *
 * It has to live *inside* that package: node-worker redirects `esbuild/lib/main.js`
 * here, and the shim's own `require("./browser.js")` plus its `__dirname`-relative
 * `esbuild.wasm` read then resolve with no help from the runtime — which is what
 * keeps the runtime's share of this down to one redirect rule.
 */
export const ESBUILD_SHIM_SUBPATH = "lib/node-worker-shim.cjs";

/**
 * The shim files a resolved tree needs, or an empty list if it needs none.
 *
 * Returned separately from the packages' own files rather than folded into them,
 * because an incremental install skips any package already at the resolved version —
 * a shim shipped that way would go stale the moment it is edited here and never be
 * rewritten. Writing a few KB unconditionally on every install keeps editing the shim
 * a matter of re-running the install, and is idempotent.
 */
export function runtimeShimFiles(
	resolved: ResolvedPackage[],
	esbuildShimSource: string
): PackageFile[] {
	let esbuildWasm = resolved.find((p) => p.name === "esbuild-wasm");
	if (!esbuildWasm) return [];
	return [
		{
			path: `${esbuildWasm.installDir}/${ESBUILD_SHIM_SUBPATH}`,
			data: new TextEncoder().encode(esbuildShimSource),
		},
	];
}
