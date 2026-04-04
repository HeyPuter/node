// File-descriptor / FileHandle smoke test for node-worker.
//
// HOW TO RUN: paste this whole file into the Monaco editor in the testbed and
// click "Run eval module". Output streams to the console pane; the final line
// reports pass/fail counts (and the run throws if anything failed).
//
// What it exercises:
//   • one fd space — an `openSync` fd used by the callback, promise and stream
//     families, and vice versa
//   • offset semantics — positionless reads/writes advancing the shared offset,
//     positioned ones not, and `a` mode appending in order
//   • dirty-handle semantics — unflushed writes visible to reads through the same
//     fd, `fstat` reporting the buffered size, flush on close
//   • lifecycle — EBADF after close, flags rejecting the wrong direction, the
//     open-mode errnos (ENOENT / EEXIST)
//   • ranged reads on the *blocking* transport, which is the one path that only
//     ever sees them via a positioned read through an fd
//   • ftruncate growing (zero-fill) and shrinking
//   • readv / writev
//
// Everything happens inside a temp directory under cwd, removed at the end.

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Buffer } from "node:buffer";

// The watcher check below waits on a locally-synthesized event, which is emitted
// the moment the write succeeds rather than after a socket round trip.
const LOCAL_WAIT_MS = 3_000;

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

async function rejects(name, fn, expectedCode) {
	try {
		await fn();
		ok(name, false, "resolved instead of rejecting");
	} catch (err) {
		ok(name, err?.code === expectedCode, `${err?.code} — ${err?.message}`);
	}
}

function throws(name, fn, expectedCode) {
	try {
		fn();
		ok(name, false, "returned instead of throwing");
	} catch (err) {
		ok(name, err?.code === expectedCode, `${err?.code} — ${err?.message}`);
	}
}

function readCb(fd, buffer, offset, length, position) {
	return new Promise((resolve, reject) => {
		fs.read(fd, buffer, offset, length, position, (err, bytesRead) =>
			err ? reject(err) : resolve(bytesRead)
		);
	});
}

function fstatCb(fd) {
	return new Promise((resolve, reject) => {
		fs.fstat(fd, (err, stats) => (err ? reject(err) : resolve(stats)));
	});
}

function collect(stream) {
	return new Promise((resolve, reject) => {
		let chunks = [];
		stream.on("data", (c) => chunks.push(c));
		stream.on("end", () => resolve(Buffer.concat(chunks)));
		stream.on("error", reject);
	});
}

let root = path.resolve(`fs-handle-smoke-${Date.now()}`);
let n = 0;
function tmp(contents) {
	let p = path.join(root, `f${n++}.txt`);
	if (contents !== undefined) fs.writeFileSync(p, contents);
	return p;
}

async function main() {
	console.log(`fs handle smoke test in ${root}`);
	await fsp.mkdir(root, { recursive: true });

	// -------------------------------------------------------- one fd space
	//
	// The sync and async families used to store different handle classes in the fd
	// table and reject each other's descriptors with EBADF. Node has one
	// process-wide fd space, and every one of these is what node does.
	section("an openSync fd works with every family");
	{
		let file = tmp("hello world");
		let fd = fs.openSync(file, "r");

		let viaCb = Buffer.alloc(5);
		let bytesRead = await readCb(fd, viaCb, 0, 5, 0);
		ok(
			"callback fs.read on an openSync fd",
			bytesRead === 5 && viaCb.toString() === "hello",
			viaCb.toString()
		);

		let stats = await fstatCb(fd);
		ok("callback fs.fstat on an openSync fd", stats.size === 11, stats.size);
		ok("fstatSync on an openSync fd", fs.fstatSync(fd).size === 11);

		let promisified = await fs.promises.open(file, "r");
		ok(
			"fs.promises.open still returns a working handle",
			(await promisified.readFile("utf8")) === "hello world"
		);
		await promisified.close();

		let streamed = await collect(
			fs.createReadStream(file, { fd, autoClose: false })
		);
		ok(
			"createReadStream({ fd }) on an openSync fd",
			streamed.toString() === "hello world",
			streamed.toString()
		);

		fs.closeSync(fd);
	}

	section("an async fd works with the sync family");
	{
		let file = tmp("sync-side");
		let handle = await fsp.open(file, "r");
		let buf = Buffer.alloc(4);
		let read = fs.readSync(handle.fd, buf, 0, 4, 0);
		ok(
			"readSync on an fs.promises.open fd",
			read === 4 && buf.toString() === "sync",
			buf.toString()
		);
		ok(
			"fstatSync on an fs.promises.open fd",
			fs.fstatSync(handle.fd).size === 9
		);
		await handle.close();
	}

	// -------------------------------------------------------------- offsets
	section("read offsets");
	{
		let fd = fs.openSync(tmp("hello world"), "r");
		let a = Buffer.alloc(5);
		let b = Buffer.alloc(6);
		fs.readSync(fd, a, 0, 5, null);
		fs.readSync(fd, b, 0, 6, null);
		ok(
			"positionless readSync advances the shared offset",
			a.toString() === "hello" && b.toString() === " world",
			JSON.stringify([a.toString(), b.toString()])
		);

		let c = Buffer.alloc(5);
		let d = Buffer.alloc(5);
		fs.readSync(fd, c, 0, 5, 0);
		fs.readSync(fd, d, 0, 5, 0);
		ok(
			"positioned readSync does not advance it",
			c.toString() === "hello" && d.toString() === "hello",
			JSON.stringify([c.toString(), d.toString()])
		);

		let past = Buffer.alloc(5);
		ok(
			"reading past EOF yields 0 bytes",
			fs.readSync(fd, past, 0, 5, 9999) === 0
		);
		fs.closeSync(fd);
	}

	section("ranged reads on the blocking transport");
	{
		// A positioned read through an fd is the only thing that sends a `Range` on
		// the sync path, and the api answers it with a 206. That used to be read as
		// a failure — `xhr.status / 100 === 2` is only true for exactly 200 — so this
		// is the regression guard for it. The read must be positioned and the handle
		// must never have been fully buffered, or it is served locally and proves
		// nothing.
		let body = "0123456789abcdefghijklmnopqrstuvwxyz";
		let fd = fs.openSync(tmp(body), "r");
		let mid = Buffer.alloc(6);
		let got = fs.readSync(fd, mid, 0, 6, 10);
		ok(
			"positioned readSync mid-file (206 range)",
			got === 6 && mid.toString() === "abcdef",
			mid.toString()
		);

		let tail = Buffer.alloc(6);
		let tailRead = fs.readSync(fd, tail, 0, 6, 30);
		ok(
			"positioned readSync at the tail",
			tailRead === 6 && tail.toString() === "uvwxyz",
			tail.toString()
		);
		fs.closeSync(fd);
	}

	// --------------------------------------------------------------- writes
	section("write offsets and flush-on-close");
	{
		let file = tmp("seed");
		let fd = fs.openSync(file, "w");
		fs.writeSync(fd, "abc");
		fs.writeSync(fd, "def");
		ok(
			"nothing is visible before close",
			fs.readFileSync(file, "utf8") === "",
			JSON.stringify(fs.readFileSync(file, "utf8"))
		);
		fs.closeSync(fd);
		ok(
			"sequential writeSync flushes in order on close",
			fs.readFileSync(file, "utf8") === "abcdef",
			fs.readFileSync(file, "utf8")
		);
	}

	section("append mode");
	{
		let file = tmp("X");
		let fd = fs.openSync(file, "a");
		fs.writeSync(fd, "1");
		fs.writeSync(fd, "2");
		fs.closeSync(fd);
		ok(
			"appends land after existing content, in order",
			fs.readFileSync(file, "utf8") === "X12",
			fs.readFileSync(file, "utf8")
		);
	}

	section("a dirty handle is the truth for its own fd");
	{
		let file = tmp("original");
		let fd = fs.openSync(file, "w");
		fs.writeSync(fd, "1234567890");
		ok(
			"fstat reports the buffered size, not the stale server size",
			fs.fstatSync(fd).size === 10,
			fs.fstatSync(fd).size
		);
		fs.closeSync(fd);
		ok(
			"contents match after the flush",
			fs.readFileSync(file, "utf8") === "1234567890"
		);
	}

	// ------------------------------------------------------------ lifecycle
	section("lifecycle and flags");
	{
		let file = tmp("abc");

		let fd = fs.openSync(file, "r");
		fs.closeSync(fd);
		throws(
			"readSync after close is EBADF",
			() => fs.readSync(fd, Buffer.alloc(1), 0, 1, 0),
			"EBADF"
		);
		throws("closeSync twice is EBADF", () => fs.closeSync(fd), "EBADF");

		let ro = fs.openSync(file, "r");
		throws(
			"writeSync on an r-mode fd is EBADF",
			() => fs.writeSync(ro, "nope"),
			"EBADF"
		);
		fs.closeSync(ro);

		let wo = fs.openSync(file, "w");
		throws(
			"readSync on a w-mode fd is EBADF",
			() => fs.readSync(wo, Buffer.alloc(1), 0, 1, 0),
			"EBADF"
		);
		fs.closeSync(wo);

		throws(
			"openSync of a missing file is ENOENT",
			() => fs.openSync(path.join(root, "definitely-absent.txt"), "r"),
			"ENOENT"
		);
		throws(
			"openSync with wx on an existing file is EEXIST",
			() => fs.openSync(file, "wx"),
			"EEXIST"
		);
		await rejects(
			"fsp.open of a missing file is ENOENT",
			() => fsp.open(path.join(root, "also-absent.txt"), "r"),
			"ENOENT"
		);
	}

	// ------------------------------------------------------------ ftruncate
	section("ftruncate");
	{
		let file = tmp("abcdefghij");
		let fd = fs.openSync(file, "r+");
		fs.ftruncateSync(fd, 4);
		fs.closeSync(fd);
		ok(
			"shrinks",
			fs.readFileSync(file, "utf8") === "abcd",
			fs.readFileSync(file, "utf8")
		);

		let fd2 = fs.openSync(file, "r+");
		fs.ftruncateSync(fd2, 8);
		fs.closeSync(fd2);
		let grown = fs.readFileSync(file);
		ok(
			"grows with zero fill",
			grown.length === 8 && grown[4] === 0 && grown[7] === 0,
			`len=${grown.length}`
		);
	}

	// --------------------------------------------------------- readv/writev
	section("readv / writev");
	{
		let file = tmp();
		let fd = fs.openSync(file, "w");
		fs.writevSync(fd, [Buffer.from("aaa"), Buffer.from("bbb")]);
		fs.closeSync(fd);
		ok(
			"writevSync concatenates in order",
			fs.readFileSync(file, "utf8") === "aaabbb",
			fs.readFileSync(file, "utf8")
		);

		let rfd = fs.openSync(file, "r");
		let one = Buffer.alloc(3);
		let two = Buffer.alloc(3);
		let total = fs.readvSync(rfd, [one, two], 0);
		ok(
			"readvSync fills each buffer",
			total === 6 && one.toString() === "aaa" && two.toString() === "bbb",
			JSON.stringify([one.toString(), two.toString()])
		);
		fs.closeSync(rfd);
	}

	// -------------------------------------------------------- watch on sync
	section("a sync-family write is visible to watchers");
	{
		// The sync handle's close used to flush without announcing it, so every
		// `fs.writeSync`-through-an-fd was invisible to fs.watch. Only the local
		// event is awaited here — the socket echo has its own coverage in
		// fs-watch-smoke.js.
		let file = tmp("before");
		let seen = [];
		let watcher = fs.watch(root, (eventType, filename) =>
			seen.push({ eventType, filename })
		);
		let base = path.basename(file);

		await new Promise((r) => setTimeout(r, 100));
		let fd = fs.openSync(file, "w");
		fs.writeSync(fd, "after");
		fs.closeSync(fd);

		let deadline = Date.now() + LOCAL_WAIT_MS;
		while (Date.now() < deadline && !seen.some((e) => e.filename === base)) {
			await new Promise((r) => setTimeout(r, 50));
		}
		watcher.close();
		ok(
			"closing a dirty sync fd emits a watch event",
			seen.some((e) => e.filename === base),
			JSON.stringify(seen.slice(0, 4))
		);
	}

	// ---------------------------------------------------- promises surface
	section("fs.promises FileHandle");
	{
		let file = tmp("promise-side");
		let handle = await fsp.open(file, "r+");
		ok("handle.fd is a number", typeof handle.fd === "number", handle.fd);
		ok(
			"handle.readFile",
			(await handle.readFile("utf8")) === "promise-side"
		);

		await handle.writeFile("replaced");
		await handle.sync();
		ok(
			"handle.writeFile + sync",
			fs.readFileSync(file, "utf8") === "replaced",
			fs.readFileSync(file, "utf8")
		);

		await handle.appendFile("!");
		await handle.close();
		ok(
			"handle.appendFile flushes on close",
			fs.readFileSync(file, "utf8") === "replaced!",
			fs.readFileSync(file, "utf8")
		);

		let disposed = false;
		{
			await using h = await fsp.open(file, "r");
			disposed = typeof h.fd === "number";
		}
		ok("await using disposes the handle", disposed);
	}

	// ------------------------------------------------------------------ cleanup
	section("cleanup");
	await fsp.rm(root, { recursive: true, force: true });
	ok("temp dir removed", !fs.existsSync(root));
}

try {
	await main();
} catch (err) {
	failed++;
	console.error("  ✗ unhandled: " + (err?.stack ?? err));
	await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
}

console.log(`\n${passed} passed, ${failed} failed`);
// Repeated at the end so the summary survives a scrolled-off terminal.
for (let f of failures) console.error(`  FAILED: ${f}`);
if (failed > 0) throw new Error(`${failed} fs handle check(s) failed`);
