// Populating a whole project into an in-memory mount, from the host.
//
// HOW TO RUN: this one is driven from the *page*, not from inside the runtime, so
// it does not go in the Monaco editor. Open devtools on the testbed with the worker
// ready and paste it into the console. It uses `window.__nodeWorker`, which the
// testbed exposes in dev builds for exactly this.
//
// What it demonstrates: a project that exists nowhere but memory — no uploads, no
// puterfs writes — being resolved and executed by the runtime as ordinary files.
// Nested ESM sources, a bare specifier served from a memory-resident node_modules,
// a CJS dependency required from ESM, a binary asset read byte-exact, and a
// package.json the resolver finds the usual way.
//
// The same shape is what an archive-backed node_modules will use: build the tree
// once, hand it over, run out of it.

(async () => {
	const w = window.__nodeWorker;
	if (!w) throw new Error("no __nodeWorker — is the worker ready, and is this a dev build?");
	await w.ready;

	const log = (...a) => console.log("[host-memory-project]", ...a);

	// A real PNG header, so the binary check is not just "some bytes survived".
	const logo = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2, 253, 254, 255]);

	const files = [
		{
			path: "package.json",
			data: JSON.stringify(
				{ name: "memproj", version: "1.0.0", type: "module", main: "src/index.js" },
				null,
				2
			),
		},
		{
			path: "src/index.js",
			data: [
				'import { greet } from "./greet.js";',
				'import dep from "memdep";',
				'import fs from "node:fs";',
				'import path from "node:path";',
				"",
				"export function run() {",
				'  const here = path.dirname(new URL(import.meta.url).pathname);',
				'  const logo = fs.readFileSync(path.join(here, "..", "assets", "logo.png"));',
				'  const pkg = JSON.parse(fs.readFileSync(path.join(here, "..", "package.json"), "utf8"));',
				"  return {",
				'    greeting: greet("world"),',
				"    dep: dep(),",
				"    logoBytes: logo.length,",
				"    logoIsPng: logo[0] === 0x89 && logo[1] === 0x50,",
				"    pkgName: pkg.name,",
				"  };",
				"}",
				"",
			].join("\n"),
		},
		{ path: "src/greet.js", data: "export const greet = (who) => `hello, ${who}`;\n" },

		// A dependency that only exists in memory. The module resolver walks up from
		// /proj/src looking for node_modules the ordinary way and finds this — which
		// is the precondition for serving a real dependency tree out of an archive.
		{
			path: "node_modules/memdep/package.json",
			data: JSON.stringify({ name: "memdep", version: "0.0.1", main: "index.js" }),
		},
		{
			path: "node_modules/memdep/index.js",
			data: 'module.exports = () => "from a memory-resident dependency";\n',
		},

		{ path: "assets/logo.png", data: logo },
		// No `data` means "make a directory" — only needed for an empty one, since
		// files create their own parents.
		{ path: "assets/empty" },
	];

	// `replace: true` so re-running this in the console just re-populates.
	await w.mountMemory("/proj", { replace: true });
	const written = await w.writeMemory("/proj", files);
	log("populated", written);

	// Everything below runs *inside* the runtime, against the memory mount.
	const probe = [
		'import fs from "node:fs";',
		'const show = (n, f) => { try { console.log(n + " = " + JSON.stringify(f())); } catch (e) { console.log(n + " THREW " + e.code); } };',
		'show("/ lists the mount", () => fs.readdirSync("/"));',
		'show("project tree", () => fs.readdirSync("/proj", { recursive: true }).sort());',
		'show("binary asset", () => { const b = fs.readFileSync("/proj/assets/logo.png"); return { len: b.length, png: b[0] === 0x89 && b[1] === 0x50 }; });',
		'show("empty dir", () => fs.statSync("/proj/assets/empty").isDirectory());',
		'const mod = await import("/proj/src/index.js");',
		'console.log("RESULT " + JSON.stringify(mod.run()));',
	].join("\n");

	await w.registerVirtualModule("/proj/[probe].js", probe);
	try {
		await w.setCwd("/proj");
		await w.import("/proj/[probe].js");
	} finally {
		await w.removeVirtualModule("/proj/[probe].js");
	}

	log("done — see the terminal pane for the runtime's output");
})();
