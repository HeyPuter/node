// Fetching and unpacking package tarballs.
//
// Split from both the resolver and the install targets because it is the one step
// that is identical everywhere: the registry serves the same gzipped tar to the page
// and to a build script, and the entries that come out are the same files either way.
// Only where they are *written* differs, which is what `InstallTarget` is for.

import { createGzipDecoder, unpackTar } from "modern-tar";

// Explicit .ts extensions on the relative imports in this module and its siblings:
// scripts/build-template.ts imports them under plain Node, whose type stripping does
// no extensionless resolution. Vite is happy either way.
import { mapWithConcurrency, stripPackagePrefix, type ResolvedPackage } from "./resolve.ts";

export const DOWNLOAD_CONCURRENCY = 8;

export type PackageFile = { path: string; data: Uint8Array };

/** A resolved package plus its unpacked contents, keyed by install-relative path. */
export type FetchedPackage = ResolvedPackage & { files: PackageFile[] };

/**
 * Download and unpack one package.
 *
 * Entries are keyed by target path before being returned: a tarball can carry the
 * same path more than once (npm pack quirks, PAX/long-name header entries) and tar
 * semantics are last-wins, so collapsing here means no consumer has to care. The
 * Drive target additionally *requires* it — its batch upload rejects duplicate
 * target paths.
 */
export async function fetchPackage(pkg: ResolvedPackage): Promise<PackageFile[]> {
	let res = await fetch(pkg.tarballUrl);
	if (!res.ok || !res.body) {
		throw new Error(`download ${pkg.name}@${pkg.version}: HTTP ${res.status}`);
	}
	let entries = await unpackTar(res.body.pipeThrough(createGzipDecoder()));
	let byPath = new Map<string, PackageFile>();
	for (let entry of entries) {
		if (!entry.data) continue;
		let stripped = stripPackagePrefix(entry.header.name);
		if (!stripped) continue;
		// A copy: `entry.data` may be a view into one buffer shared by every entry in
		// the archive, and these outlive the archive.
		let bytes = new Uint8Array(entry.data.byteLength);
		bytes.set(entry.data);
		byPath.set(`${pkg.installDir}/${stripped}`, {
			path: `${pkg.installDir}/${stripped}`,
			data: bytes,
		});
	}
	return [...byPath.values()];
}

/**
 * Download every package, reporting progress as each lands.
 *
 * Returns them in no particular order; callers that care about install depth (the
 * Drive target does, so parents exist before nested `node_modules`) sort for
 * themselves.
 */
export async function fetchPackages(
	packages: ResolvedPackage[],
	log: (text: string) => void
): Promise<FetchedPackage[]> {
	let out: FetchedPackage[] = [];
	let done = 0;
	await mapWithConcurrency(packages, DOWNLOAD_CONCURRENCY, async (pkg) => {
		let files = await fetchPackage(pkg);
		out.push({ ...pkg, files });
		done += 1;
		if (done % 10 === 0 || done === packages.length) {
			log(`  downloaded ${done}/${packages.length}\n`);
		}
	});
	return out;
}
