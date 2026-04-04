// Resolving a command name to the script that implements it.
//
// npm creates `node_modules/.bin` at install time, as symlinks or shell shims. A tarball
// carries neither, and the runtime has no symlinks or shell to run them with, so the
// mapping is rebuilt from the one place it is actually recorded: each package's own `bin`
// field.
//
// This is what makes `npm run dev` work, since a script body of "vite" is a request for
// whatever `vite`'s package says its `vite` binary is.
//
// Written against the two `InstallTarget` methods that inspect `node_modules` rather than
// against a filesystem, because that interface already abstracts exactly this over both
// the in-memory project and real Puter Drive — so one implementation serves the workspace
// and the terminal.

/** Command name -> path of the script that implements it, relative to the project root. */
export type BinIndex = Map<string, string>;

export interface PackageSource {
	/** Installed package directories, e.g. "node_modules/vite", "node_modules/@a/b". */
	listTopLevelPackages(): Promise<string[]>;
	/** The `package.json` in a package directory, or undefined if unreadable. */
	readPackageJson(dir: string): Promise<any | undefined>;
}

export async function buildBinIndex(source: PackageSource): Promise<BinIndex> {
	let index: BinIndex = new Map();
	let dirs = await source.listTopLevelPackages();

	let entries = await Promise.all(
		dirs.map(async (dir) => ({ dir, pkg: await source.readPackageJson(dir) }))
	);

	for (let { dir, pkg } of entries) {
		let bin = pkg?.bin;
		if (!bin) continue;

		if (typeof bin === "string") {
			// A string `bin` is named after the package — and for a scoped package it is
			// the bare name, not the scope: `@foo/bar` installs `bar`.
			let name = typeof pkg.name === "string" ? pkg.name.split("/").pop() : undefined;
			if (name) index.set(name, join(dir, bin));
			continue;
		}
		if (typeof bin !== "object") continue;
		for (let [name, target] of Object.entries(bin)) {
			if (typeof target === "string") index.set(name, join(dir, target));
		}
	}

	return index;
}

function join(dir: string, rel: string): string {
	let parts: string[] = [];
	for (let seg of `${dir}/${rel}`.split("/")) {
		if (seg === "" || seg === ".") continue;
		if (seg === "..") {
			parts.pop();
			continue;
		}
		parts.push(seg);
	}
	return parts.join("/");
}
