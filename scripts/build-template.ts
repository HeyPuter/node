// Bakes a create-vite template, with node_modules already installed, into a
// gzipped tar the page loads at boot.
//
// Run with plain `node` — Node strips the types, and the shared modules under
// src/install are written to be importable from here (no `puter`, no DOM, no Vite-only
// imports, explicit .ts extensions on their relative imports).
//
//   node ./scripts/build-template.ts [--template vanilla-ts] [--template react-ts]
//
// The reason this reuses src/install rather than resolving dependencies itself: the
// layout is not incidental. node-worker's module resolver has a redirect table keyed
// on where @rollup/wasm-node and esbuild-wasm land and on their being the *exact*
// version of the native package they stand in for (see `moduleRedirects` in
// node-worker/src/worker/module/resolve.ts). A second implementation that merely
// looked equivalent would produce a tree that only fails once a bundler reaches for
// its native binding.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import semver from "semver";
import { createGzipDecoder, createGzipEncoder, packTar, unpackTar } from "modern-tar";

import { fetchPackages } from "../src/install/download.ts";
import { NPM_REGISTRY, resolveTree, stripPackagePrefix } from "../src/install/resolve.ts";
import { runtimeShimFiles } from "../src/install/shims.ts";

/**
 * The create-vite major this bakes from. Pinned rather than `latest` so a rebuild is
 * reproducible and so the vite major — which decides whether the esbuild and rollup
 * WASM substitutions apply at all — cannot change underneath the runtime.
 */
const CREATE_VITE_RANGE = "^7.0.0";

/** Baked by default, first one wins the manifest's `default`. */
const DEFAULT_TEMPLATES = ["react-ts", "vanilla-ts"];

/** USTAR caps an entry name at 255 bytes even with the prefix field. */
const MAX_TAR_NAME = 255;

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(here, "..");

const log = (text: string) => process.stdout.write(text);

type ManifestEntry = {
	id: string;
	label: string;
	/** The command the workspace's Run button issues. */
	start: string;
	packages: number;
	files: number;
	bytes: number;
	createVite: string;
};

async function main() {
	let { templates, outDir } = parseArgs(process.argv.slice(2));

	log(`create-vite: resolving ${CREATE_VITE_RANGE}\n`);
	let createVite = await fetchCreateVite();
	log(`create-vite: ${createVite.version}\n`);

	await mkdir(outDir, { recursive: true });

	let esbuildShim = await readFile(
		join(projectRoot, "src/shims/esbuild-wasm.cjs"),
		"utf8"
	);

	let manifest: ManifestEntry[] = [];
	for (let id of templates) {
		manifest.push(
			await buildTemplate({ id, outDir, createVite, esbuildShim })
		);
	}

	let indexPath = join(outDir, "index.json");
	await writeFile(
		indexPath,
		JSON.stringify(
			{ default: templates[0], templates: manifest },
			null,
			2
		) + "\n"
	);
	log(`\nwrote ${indexPath}\n`);
}

// --------------------------------------------------------------- create-vite

type CreateVite = { version: string; files: Map<string, Uint8Array> };

async function fetchCreateVite(): Promise<CreateVite> {
	let res = await fetch(`${NPM_REGISTRY}/create-vite`);
	if (!res.ok) throw new Error(`registry create-vite: HTTP ${res.status}`);
	let packument = (await res.json()) as {
		versions: Record<string, { version: string; dist: { tarball: string } }>;
	};

	let version = semver.maxSatisfying(Object.keys(packument.versions), CREATE_VITE_RANGE, {
		includePrerelease: false,
	});
	if (!version) throw new Error(`no create-vite version satisfies ${CREATE_VITE_RANGE}`);

	let tarball = packument.versions[version].dist.tarball;
	let tar = await fetch(tarball);
	if (!tar.ok || !tar.body) throw new Error(`download create-vite: HTTP ${tar.status}`);

	let entries = await unpackTar(tar.body.pipeThrough(createGzipDecoder()));
	let files = new Map<string, Uint8Array>();
	for (let entry of entries) {
		if (!entry.data) continue;
		let path = stripPackagePrefix(entry.header.name);
		if (!path) continue;
		files.set(path, entry.data);
	}
	return { version, files };
}

/**
 * The template's own files, with create-vite's `_`-prefixed names restored.
 *
 * create-vite ships `.gitignore` as `_gitignore` (and friends) because npm refuses to
 * publish a `.gitignore` inside a package, and renames them back when it scaffolds. A
 * tree that skipped that step would hand the project a stray `_gitignore` and no
 * `.gitignore`.
 */
function templateFiles(createVite: CreateVite, id: string): Map<string, Uint8Array> {
	let prefix = `template-${id}/`;
	let out = new Map<string, Uint8Array>();
	for (let [path, data] of createVite.files) {
		if (!path.startsWith(prefix)) continue;
		let rest = path.slice(prefix.length);
		let at = rest.lastIndexOf("/");
		let dir = at === -1 ? "" : rest.slice(0, at + 1);
		let name = at === -1 ? rest : rest.slice(at + 1);
		if (name.startsWith("_")) name = "." + name.slice(1);
		out.set(dir + name, data);
	}
	if (out.size === 0) {
		let available = [...createVite.files.keys()]
			.map((p) => /^template-([^/]+)\//.exec(p)?.[1])
			.filter((v, i, a): v is string => !!v && a.indexOf(v) === i)
			.sort();
		throw new Error(
			`create-vite ${createVite.version} has no template-${id}; available: ${available.join(", ")}`
		);
	}
	return out;
}

// ------------------------------------------------------------------ building

async function buildTemplate(opts: {
	id: string;
	outDir: string;
	createVite: CreateVite;
	esbuildShim: string;
}): Promise<ManifestEntry> {
	let { id, outDir, createVite, esbuildShim } = opts;
	log(`\n=== ${id} ===\n`);

	let files = templateFiles(createVite, id);
	log(`template: ${files.size} project files\n`);

	let pkgJson = files.get("package.json");
	if (!pkgJson) throw new Error(`template-${id} has no package.json`);
	let pkg = JSON.parse(new TextDecoder().decode(pkgJson));

	let rootDeps: Record<string, string> = {
		...(pkg.dependencies ?? {}),
		...(pkg.devDependencies ?? {}),
	};
	log(`resolving ${Object.keys(rootDeps).length} top-level deps...\n`);
	let resolved = await resolveTree(rootDeps, log);
	log(`resolved ${resolved.length} packages\n`);

	log(`downloading ${resolved.length} package(s)...\n`);
	let fetched = await fetchPackages(resolved, log);

	for (let pkgFiles of fetched) {
		for (let file of pkgFiles.files) files.set(file.path, file.data);
	}

	// After the packages, so it lands inside the esbuild-wasm directory that now
	// exists rather than being overwritten by it.
	for (let shim of runtimeShimFiles(resolved, esbuildShim)) {
		files.set(shim.path, shim.data);
		log(`+ ${shim.path} (esbuild WASM shim)\n`);
	}

	let tooLong = [...files.keys()].filter((p) => p.length > MAX_TAR_NAME);
	if (tooLong.length > 0) {
		throw new Error(
			`${tooLong.length} path(s) exceed the ${MAX_TAR_NAME}-byte tar name limit, ` +
				`starting with ${tooLong[0]}`
		);
	}

	// Sorted so a rebuild of an unchanged tree produces an identical archive.
	let names = [...files.keys()].sort();
	let tar = await packTar(
		names.map((name) => {
			let data = files.get(name)!;
			return { header: { name, size: data.byteLength, type: "file" as const }, body: data };
		})
	);

	let gz = await gzip(tar);
	let outPath = join(outDir, `${id}.tar.gz`);
	await writeFile(outPath, gz);
	log(
		`wrote ${outPath} — ${files.size} files, ${resolved.length} packages, ` +
			`${fmtBytes(tar.byteLength)} tar, ${fmtBytes(gz.byteLength)} gzipped\n`
	);

	return {
		id,
		label: id,
		start: startCommand(pkg),
		packages: resolved.length,
		files: files.size,
		bytes: gz.byteLength,
		createVite: createVite.version,
	};
}

/** What the workspace's Run button should issue for this template. */
function startCommand(pkg: any): string {
	let scripts = pkg?.scripts ?? {};
	if (scripts.dev) return "npm run dev";
	if (scripts.start) return "npm start";
	return "node .";
}

async function gzip(data: Uint8Array): Promise<Uint8Array> {
	let stream = new Blob([data as BlobPart]).stream().pipeThrough(createGzipEncoder());
	return new Uint8Array(await new Response(stream).arrayBuffer());
}

// --------------------------------------------------------------------- misc

function parseArgs(argv: string[]): { templates: string[]; outDir: string } {
	let templates: string[] = [];
	let outDir = join(projectRoot, "public/templates");
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--template" && argv[i + 1]) templates.push(argv[++i]);
		else if (argv[i] === "--out" && argv[i + 1]) outDir = argv[++i];
		else throw new Error(`unexpected argument: ${argv[i]}`);
	}
	return { templates: templates.length > 0 ? templates : DEFAULT_TEMPLATES, outDir };
}

function fmtBytes(n: number): string {
	return n < 1024 * 1024
		? `${(n / 1024).toFixed(0)} KB`
		: `${(n / 1024 / 1024).toFixed(1)} MB`;
}

await main();
