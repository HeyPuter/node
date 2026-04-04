"use strict";
// esbuild for node-worker, backed by the WASM build.
//
// The node-worker resolver redirects `esbuild/lib/main.js` here (see
// `moduleRedirects` in node-worker's src/worker/module/resolve.ts). This file is
// installed *into* esbuild-wasm's own `lib/` directory by the npm-install step in
// src/npm-install.ts, which is what lets the runtime side be nothing but a
// redirect: `__dirname` is inside the package, so `require("./browser.js")` and
// the `esbuild.wasm` lookup below need no resolution tricks, and the glue, the
// wasm and this shim can never be version-skewed against each other.
//
// Why not redirect straight at esbuild-wasm the way rollup redirects at
// @rollup/wasm-node: that package is a drop-in (same exports, wasm instantiated
// at module scope, no init). esbuild-wasm is not. Its `lib/main.js` is the *node*
// API, which only knows how to `child_process.spawn` a subprocess to talk to over
// a pipe — unsupported here, and the reason the unshimmed error is
// `Unsupported platform: browser wasm LE`. `lib/browser.js` is the usable half,
// but it has a different contract, and this file is that adapter:
//
//   - it needs an explicit `initialize()` that callers like vite never make, so
//     every async export below awaits a lazily-started one
//   - `initialize({ worker: false })` runs the Go program on *this* thread rather
//     than in a nested Worker. That matters for more than overhead: the Go
//     runtime picks up `globalThis.fs`/`globalThis.process` from the scope it
//     runs in, which is how it gets a real filesystem (see installGoFsBridge).
//     In a nested Worker it would only ever see the ENOSYS stubs, which caps you
//     at `transform` and vite's dep *scan* — never the dep optimizer, which has
//     esbuild read dependency sources and write the bundle itself.
//   - the sync APIs can't be supported at all: they bridge async→sync through
//     worker_threads + Atomics, and node-worker has no `worker` binding.

const fs = require("fs");
const path = require("path");

const esbuild = require("./browser.js");

// Set this to serve esbuild.wasm over HTTP (e.g. from the harness's own origin)
// instead of reading 12 MB out of the vfs on first use.
const WASM_URL_ENV = "NODE_WORKER_ESBUILD_WASM_URL";

function enosys() {
	const err = new Error("not implemented");
	err.code = "ENOSYS";
	return err;
}

// Go's wasm_exec glue takes its filesystem from `globalThis.fs` when one is
// present, and only falls back to its all-ENOSYS stub when there isn't — the same
// hook esbuild-wasm's own `wasm_exec_node.js` uses (`globalThis.fs =
// require("fs")`). Handing it node-worker's fs is therefore all it takes to give
// the Go side real files, except for one wrinkle: esbuild's glue *mutates* the
// object it's given, replacing `read` and `writeSync` with the two halves of its
// stdio protocol, and its `read` throws "Bad read" for any fd but stdin. Passing
// the real module would both break every other consumer of node-worker's fs for
// the rest of the session and leave Go unable to read files anyway.
//
// So: a proxy that forwards to the real fs, traps those two assignments instead
// of storing them, and dispatches by fd — stdio to esbuild's handlers, everything
// else to the real thing. Dispatching on the fd number is safe because neither
// node-worker's fd table (which starts at 10) nor node itself ever hands out
// 0/1/2 for a file.
//
// `write` needs the same treatment even though esbuild never overrides it: Go
// reaches stdout through `fs.write`, not `fs.writeSync`, and the stub esbuild
// would otherwise be talking to implements `write` by delegating to its own
// `writeSync`. Forward it to the real fs and esbuild's stdout protocol packets go
// to the actual file descriptor 1 instead of into its message handler, which
// leaves every API call hanging forever (and prints protocol frames to the
// terminal).
function installGoFsBridge() {
	if (globalThis.fs) return;

	let protocolRead = null;
	let protocolWriteSync = null;
	const assigned = Object.create(null);

	const isProtocolWrite = (fd) => (fd === 1 || fd === 2) && protocolWriteSync;

	const read = (fd, ...args) => {
		if (fd === 0 && protocolRead) return protocolRead(fd, ...args);
		return fs.read(fd, ...args);
	};
	const writeSync = (fd, ...args) => {
		if (isProtocolWrite(fd)) return protocolWriteSync(fd, ...args);
		return fs.writeSync(fd, ...args);
	};
	// Same contract as the stub's: only whole-buffer writes at the current
	// position can go to the protocol, anything else is a caller error.
	const write = (fd, buf, offset, length, position, callback) => {
		if (!isProtocolWrite(fd)) {
			return fs.write(fd, buf, offset, length, position, callback);
		}
		if (offset !== 0 || length !== buf.length || position !== null) {
			callback(enosys());
			return;
		}
		let written;
		try {
			written = protocolWriteSync(fd, buf);
		} catch (err) {
			callback(err);
			return;
		}
		callback(null, written);
	};

	globalThis.fs = new Proxy(assigned, {
		get(_target, prop) {
			if (prop === "read") return read;
			if (prop === "write") return write;
			if (prop === "writeSync") return writeSync;
			if (prop in assigned) return assigned[prop];
			return fs[prop];
		},
		set(_target, prop, value) {
			if (prop === "read") protocolRead = value;
			else if (prop === "writeSync") protocolWriteSync = value;
			else assigned[prop] = value;
			return true;
		},
		has(_target, prop) {
			return prop in assigned || prop in fs;
		},
	});
}

// Same story for `process`: because node-worker installs one as a global, Go uses
// it instead of the stub it would otherwise define, and Go's js/wasm syscall layer
// calls straight through to these. Fill in only what's missing, with the values
// Go's own stub uses.
function installGoProcessShims() {
	const proc = globalThis.process;
	if (!proc) return;

	const ids = { getuid: -1, getgid: -1, geteuid: -1, getegid: -1 };
	for (const name of Object.keys(ids)) {
		if (typeof proc[name] !== "function") proc[name] = () => ids[name];
	}
	for (const name of ["getgroups", "umask"]) {
		if (typeof proc[name] !== "function") {
			proc[name] = () => {
				throw enosys();
			};
		}
	}
}

async function compileWasmModule() {
	const url = process.env[WASM_URL_ENV];
	if (url) {
		const res = await fetch(url);
		if (!res.ok) {
			throw new Error(
				`${WASM_URL_ENV}=${url} responded ${res.status} ${res.statusText}`
			);
		}
		return WebAssembly.compile(await res.arrayBuffer());
	}

	// Sibling of this file's package root. Reading it synchronously is one large
	// blocking vfs request; set WASM_URL_ENV to avoid it.
	const wasmPath = path.join(__dirname, "..", "esbuild.wasm");
	return WebAssembly.compile(fs.readFileSync(wasmPath));
}

let initPromise;

// `initialize` rejects if called twice, so this is the only caller, and a failed
// attempt clears the promise so the next API call can retry rather than
// permanently poisoning the module.
function ensureInitialized() {
	if (initPromise) return initPromise;
	initPromise = (async () => {
		installGoFsBridge();
		installGoProcessShims();
		const wasmModule = await compileWasmModule();
		await esbuild.initialize({ wasmModule, worker: false });
	})();
	initPromise.catch(() => {
		initPromise = undefined;
	});
	return initPromise;
}

function lazy(name) {
	return async (...args) => {
		await ensureInitialized();
		return esbuild[name](...args);
	};
}

// The browser build hardcodes `hasFS: false`, which does two things to the `write`
// option: it flips the default from true to false, and it makes an explicit
// `write: true` throw "The write option is unavailable in this environment". Note
// that this is entirely separate from whether the Go side can reach a filesystem —
// with the bridge above it reads dependency sources from the real fs just fine —
// it's a JS-side gate on the option itself.
//
// The failure mode matters more than the error would: vite's dep optimizer never
// passes `write`, so it silently gets `write: false`, esbuild hands back
// outputFiles nobody looks at, and vite then reads an output directory that was
// never created. So: force `write: false`, and write the output ourselves, exactly
// where esbuild would have.
function withEmulatedWrite(options) {
	const opts = { ...(options ?? {}) };
	if (opts.write === false) return { options: opts, emit: (result) => result };

	opts.write = false;
	return {
		options: opts,
		emit: async (result) => {
			for (const file of result.outputFiles ?? []) {
				await fs.promises.mkdir(path.dirname(file.path), { recursive: true });
				await fs.promises.writeFile(file.path, file.contents);
			}
			// Node's esbuild omits outputFiles when it did the writing itself.
			const written = { ...result };
			delete written.outputFiles;
			return written;
		},
	};
}

async function build(options) {
	await ensureInitialized();
	const { options: opts, emit } = withEmulatedWrite(options);
	return emit(await esbuild.build(opts));
}

async function context(options) {
	await ensureInitialized();
	const { options: opts, emit } = withEmulatedWrite(options);
	const ctx = await esbuild.context(opts);
	// Delegate rather than copy: `cancel`/`dispose`/`watch`/`serve` are closures
	// with no `this` dependency, so inheriting them keeps this correct if esbuild
	// grows another method. (`watch` and `serve` throw under hasFS: false — vite
	// dev uses neither, it has its own watcher.)
	const wrapped = Object.create(ctx);
	wrapped.rebuild = async () => emit(await ctx.rebuild());
	return wrapped;
}

function unsupportedSync(name) {
	return () => {
		throw new Error(
			`esbuild.${name}() is not supported in this runtime: the WASM build bridges ` +
				`it through worker_threads + Atomics, which node-worker has no binding ` +
				`for. Use the async esbuild.${name.replace(/Sync$/, "")}() instead.`
		);
	};
}

const api = {
	// `version` has to be a real value, not a getter behind init — vite imports it
	// as a binding (`import { version as esbuildVersion } from "esbuild"`).
	version: esbuild.version,

	transform: lazy("transform"),
	formatMessages: lazy("formatMessages"),
	analyzeMetafile: lazy("analyzeMetafile"),
	build,
	context,

	transformSync: unsupportedSync("transformSync"),
	buildSync: unsupportedSync("buildSync"),
	formatMessagesSync: unsupportedSync("formatMessagesSync"),
	analyzeMetafileSync: unsupportedSync("analyzeMetafileSync"),

	// Options are ignored: this shim owns the one permitted initialize() call.
	// Kept callable so code that politely initializes first still works.
	initialize: () => ensureInitialized(),
	stop: () => esbuild.stop(),
};

api.default = api;
module.exports = api;
