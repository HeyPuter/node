// Mount-layer / in-memory filesystem smoke test for node-worker.
//
// HOW TO RUN: paste this whole file into the Monaco editor in the testbed and
// click "Run eval module". Output streams to the console pane; the final line
// reports pass/fail counts (and the run throws if anything failed).
//
// What it exercises:
//   • the memory-backed /tmp mount — `os.tmpdir()` finally points somewhere usable
//   • mount grafting — /tmp showing up in a listing of /, and a recursive listing
//     not leaking the backing provider's view of a shadowed subtree
//   • path canonicalization — `.`, `..` and `//` collapsing before a path is
//     matched against a mount, and `realpath` answering canonically
//   • containment — `..` cannot walk out of a mount into another provider's
//     namespace by accident, only by resolving to a genuinely different path
//   • cross-mount operations — rename degrading to copy-then-delete for a file and
//     reporting EXDEV for a directory
//   • the errnos an in-memory tree owes callers (ENOENT / ENOTDIR / EEXIST /
//     ENOTEMPTY)
//   • millisecond mtimes, which puterfs cannot express — two writes inside one
//     second are distinguishable, which is what a watcher needs
//
// Everything in /tmp is in-memory and vanishes with the worker; the one file this
// writes to real storage is removed at the end.

import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Buffer } from "node:buffer";

let passed = 0;
let failed = 0;
let failures = [];

function ok(name, cond, detail) {
	let line = `  ${cond ? "✓" : "✗"} ${name}${detail !== undefined ? `  (${detail})` : ""}`;
	if (cond) {
		passed++;
		console.log(line);
	} else {
		failed++;
		failures.push(`${name}${detail !== undefined ? `  (${detail})` : ""}`);
		console.error(line);
	}
	return cond;
}

function section(title) {
	console.log(`\n${title}`);
}

function throws(name, fn, expectedCode) {
	try {
		fn();
		ok(name, false, "returned instead of throwing");
	} catch (err) {
		ok(name, err?.code === expectedCode, `${err?.code} — ${err?.message}`);
	}
}

let TMP = os.tmpdir();
let scratch = `${TMP}/mount-smoke-${Date.now()}`;
let outsideFile = path.resolve(`mount-smoke-crossed-${Date.now()}.txt`);

async function main() {
	console.log(`fs mount smoke test in ${scratch}`);

	// ------------------------------------------------------------ the mount
	section("the memory-backed tmpdir");
	ok("os.tmpdir() is /tmp", TMP === "/tmp", TMP);
	ok("/tmp exists", fs.existsSync(TMP));
	ok("/tmp is a directory", fs.statSync(TMP).isDirectory());
	ok(
		"/tmp appears in a listing of /",
		fs.readdirSync("/").includes("tmp"),
		JSON.stringify(fs.readdirSync("/"))
	);
	ok(
		"/tmp appears as a directory Dirent",
		fs
			.readdirSync("/", { withFileTypes: true })
			.some((d) => d.name === "tmp" && d.isDirectory())
	);

	// ------------------------------------------------------- basic file ops
	section("in-memory file operations");
	fs.mkdirSync(scratch, { recursive: true });
	let file = `${scratch}/a.txt`;
	fs.writeFileSync(file, "memory!");
	ok("write then read", fs.readFileSync(file, "utf8") === "memory!");
	ok("stat reports the size", fs.statSync(file).size === 7, fs.statSync(file).size);
	ok("stat says it is a file", fs.statSync(file).isFile());
	ok(
		"readdir lists it",
		fs.readdirSync(scratch).includes("a.txt"),
		JSON.stringify(fs.readdirSync(scratch))
	);

	fs.mkdirSync(`${scratch}/deep/nested`, { recursive: true });
	fs.writeFileSync(`${scratch}/deep/nested/b.txt`, "nested");
	ok(
		"recursive readdir yields paths relative to the root read",
		JSON.stringify(fs.readdirSync(scratch, { recursive: true }).sort()) ===
			JSON.stringify(["a.txt", "deep", "deep/nested", "deep/nested/b.txt"]),
		JSON.stringify(fs.readdirSync(scratch, { recursive: true }).sort())
	);

	fs.copyFileSync(file, `${scratch}/copy.txt`);
	ok("copyFile within the mount", fs.readFileSync(`${scratch}/copy.txt`, "utf8") === "memory!");
	fs.renameSync(`${scratch}/copy.txt`, `${scratch}/moved.txt`);
	ok(
		"rename within the mount",
		fs.existsSync(`${scratch}/moved.txt`) && !fs.existsSync(`${scratch}/copy.txt`)
	);
	fs.rmSync(`${scratch}/moved.txt`);
	ok("unlink", !fs.existsSync(`${scratch}/moved.txt`));

	// ------------------------------------------------------- canonicalization
	section("paths are canonicalized before they reach a provider");
	ok(
		"`..` collapses",
		fs.readFileSync(`${scratch}/deep/../a.txt`, "utf8") === "memory!"
	);
	ok("`//` collapses", fs.readFileSync(`${scratch}//a.txt`, "utf8") === "memory!");
	ok("`.` collapses", fs.readFileSync(`${scratch}/./a.txt`, "utf8") === "memory!");
	ok(
		"realpath answers canonically",
		fs.realpathSync(`${scratch}/./deep/../a.txt`) === file,
		fs.realpathSync(`${scratch}/./deep/../a.txt`)
	);
	ok(
		"a trailing slash on a directory is fine",
		fs.statSync(`${scratch}/`).isDirectory()
	);

	section("`..` cannot smuggle a path into the wrong provider");
	// Resolving out of the mount is legitimate — it just has to actually *leave*,
	// landing on whatever provider owns the destination rather than handing the
	// memory tree a path with ".." still in it.
	ok(
		"/tmp/.. is the real root, served by puterfs",
		fs.readdirSync("/tmp/..").includes("tmp"),
		JSON.stringify(fs.readdirSync("/tmp/.."))
	);

	// ------------------------------------------------------------- mkdtemp
	section("mkdtemp in the tmpdir");
	// This is the case that motivated mounting anything at /tmp: puterfs has no such
	// directory and cannot grow one, so before the mount every mkdtemp-style caller
	// was pointed at a path that could not be created.
	let temp = fs.mkdtempSync(`${TMP}/probe-`);
	ok("mkdtemp creates a directory", fs.statSync(temp).isDirectory(), temp);
	ok("mkdtemp is inside the tmpdir", temp.startsWith(`${TMP}/probe-`));
	fs.rmSync(temp, { recursive: true });

	// --------------------------------------------------------------- mtimes
	section("timestamps");
	let t1 = fs.statSync(file).mtimeMs;
	fs.writeFileSync(file, "again");
	let t2 = fs.statSync(file).mtimeMs;
	// puterfs stores unix *seconds*, so two writes inside one second are
	// indistinguishable there. An in-memory file has no such limit, and a watcher
	// that compares mtimes depends on the difference.
	ok(
		"two writes in the same second are distinguishable",
		t2 !== t1 && t2 - t1 < 1000,
		`${t1} -> ${t2}`
	);

	let when = new Date("2020-01-02T03:04:05.678Z");
	fs.utimesSync(file, when, when);
	ok(
		"utimes sets an arbitrary time exactly",
		fs.statSync(file).mtimeMs === when.getTime(),
		`${fs.statSync(file).mtimeMs} vs ${when.getTime()}`
	);

	// ----------------------------------------------------------- the errnos
	section("errnos from the in-memory tree");
	throws("read of a missing file is ENOENT", () => fs.readFileSync(`${scratch}/nope`), "ENOENT");
	throws("readdir of a file is ENOTDIR", () => fs.readdirSync(file), "ENOTDIR");
	throws(
		"write into a missing directory is ENOENT",
		() => fs.writeFileSync(`${scratch}/absent/f.txt`, "x"),
		"ENOENT"
	);
	throws(
		"mkdir of an existing path is EEXIST",
		() => fs.mkdirSync(`${scratch}/deep`),
		"EEXIST"
	);
	throws(
		"rm of a non-empty directory is ENOTEMPTY",
		() => fs.rmSync(`${scratch}/deep`),
		"ENOTEMPTY"
	);
	ok("rm -r of a non-empty directory works", (() => {
		fs.rmSync(`${scratch}/deep`, { recursive: true });
		return !fs.existsSync(`${scratch}/deep`);
	})());
	ok("rm with force on a missing path is a no-op", (() => {
		fs.rmSync(`${scratch}/never-existed`, { force: true });
		return true;
	})());

	// ------------------------------------------------------- cross-mount ops
	section("operations that span two mounts");
	fs.writeFileSync(`${scratch}/crossing.txt`, "crossed");
	// No backend can move bytes into another one, so this degrades to
	// copy-then-delete rather than reporting EXDEV — vite and npm both rename a temp
	// file into place, and those paths will straddle a mount boundary routinely.
	fs.renameSync(`${scratch}/crossing.txt`, outsideFile);
	ok(
		"renaming a file across mounts moves the bytes",
		fs.readFileSync(outsideFile, "utf8") === "crossed",
		fs.readFileSync(outsideFile, "utf8")
	);
	ok(
		"...and removes the source",
		!fs.existsSync(`${scratch}/crossing.txt`)
	);

	fs.mkdirSync(`${scratch}/adir`, { recursive: true });
	throws(
		"renaming a directory across mounts is EXDEV",
		() => fs.renameSync(`${scratch}/adir`, path.resolve(`mount-smoke-dir-${Date.now()}`)),
		"EXDEV"
	);

	fs.copyFileSync(outsideFile, `${scratch}/back.txt`);
	ok(
		"copyFile across mounts",
		fs.readFileSync(`${scratch}/back.txt`, "utf8") === "crossed"
	);

	// ---------------------------------------------------------- binary content
	section("binary content is byte-exact and unshared");
	{
		let bin = Buffer.alloc(256);
		for (let i = 0; i < 256; i++) bin[i] = i;
		let binFile = `${scratch}/every-byte.bin`;
		fs.writeFileSync(binFile, bin);

		ok(
			"round trips every byte value",
			Buffer.compare(bin, fs.readFileSync(binFile)) === 0
		);
		ok("size is right", fs.statSync(binFile).size === 256, fs.statSync(binFile).size);

		// A memory-backed file is the one case where a read could hand back the
		// stored bytes themselves. It must not: node promises a fresh buffer, callers
		// mutate what they get, and aliasing would let a *read* silently rewrite the
		// file. A network backend can't have this bug — every read builds a new buffer
		// from the response — so nothing else would catch it.
		bin[0] = 99;
		ok("the stored copy does not alias the caller's buffer", fs.readFileSync(binFile)[0] === 0);

		let first = fs.readFileSync(binFile);
		first[1] = 200;
		ok(
			"a returned buffer does not alias the stored bytes",
			fs.readFileSync(binFile)[1] === 1,
			`byte1=${fs.readFileSync(binFile)[1]}`
		);

		let fd = fs.openSync(binFile, "r");
		let mid = Buffer.alloc(4);
		fs.readSync(fd, mid, 0, 4, 128);
		ok("a ranged read is byte-exact", mid[0] === 128 && mid[3] === 131, JSON.stringify([...mid]));
		mid[0] = 7;
		let mid2 = Buffer.alloc(4);
		fs.readSync(fd, mid2, 0, 4, 128);
		// `subarray` is a view, so the ranged path needs the same copy as the
		// whole-file one.
		ok("a ranged read does not alias either", mid2[0] === 128, JSON.stringify([...mid2]));
		fs.closeSync(fd);
		fs.rmSync(binFile);
	}

	// ------------------------------------------------- the injected-file overlay
	section("an injected module is an ordinary file");
	{
		// This very file was handed to the runtime as a string, never written to
		// storage. It used to live in a map inside the module resolver that nothing
		// else could see — `fs` reported ENOENT for it. It now lives in the sparse
		// in-memory layer over "/", which makes it a file like any other.
		let self = new URL(import.meta.url).pathname;
		ok("the running module has a path", self.length > 0, self);
		ok("...which stats as a file", fs.statSync(self).isFile());
		ok("...with a real size", fs.statSync(self).size > 0, fs.statSync(self).size);
		ok(
			"...whose contents are its own source",
			fs.readFileSync(self, "utf8").includes("INJECTED_OVERLAY_MARKER")
		);

		let selfDir = path.dirname(self);
		let listed = fs.readdirSync(selfDir);
		ok(
			"...and appears in a listing of its directory",
			listed.includes(path.basename(self))
		);
		// The listing is a union: the overlay contributes this file, the backing
		// store contributes everything that is really there.
		ok(
			"...merged with the real entries of that directory",
			listed.length > 1,
			`${listed.length} entries`
		);

		// Writing to an ordinary path must still reach ordinary storage — the overlay
		// shadows only what it actually holds. If every write went to memory instead,
		// nothing would persist and the mistake would be invisible until a restart.
		let passthrough = path.join(selfDir, `overlay-passthrough-${Date.now()}.txt`);
		fs.writeFileSync(passthrough, "persisted");
		ok(
			"a write to an ordinary path is not captured by the overlay",
			fs.readFileSync(passthrough, "utf8") === "persisted"
		);
		fs.rmSync(passthrough);
		ok("...and is removable", !fs.existsSync(passthrough));
	}

	// ------------------------------------------------------------------ cleanup
	section("cleanup");
	await fsp.rm(outsideFile, { force: true });
	fs.rmSync(scratch, { recursive: true, force: true });
	ok("scratch removed", !fs.existsSync(scratch));
	ok("the file written to real storage is gone", !fs.existsSync(outsideFile));
}

try {
	await main();
} catch (err) {
	failed++;
	console.error("  ✗ unhandled: " + (err?.stack ?? err));
	await fsp.rm(outsideFile, { force: true }).catch(() => {});
	try {
		fs.rmSync(scratch, { recursive: true, force: true });
	} catch {}
}

console.log(`\n${passed} passed, ${failed} failed`);
// Repeated at the end so the summary survives a scrolled-off terminal.
for (let f of failures) console.error(`  FAILED: ${f}`);
if (failed > 0) throw new Error(`${failed} fs mount check(s) failed`);
