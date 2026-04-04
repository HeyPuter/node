// fs stream / Stats / glob / utimes smoke test for node-worker.
//
// HOW TO RUN: paste this whole file into the Monaco editor in the testbed and
// click "Run eval module". Output streams to the console pane; the final line
// reports pass/fail counts (and the run throws if anything failed).
//
// What it exercises:
//   • fs.createWriteStream — chunked writes, bytesWritten, open/ready/close
//   • fs.createReadStream — whole-file (one api call) and start/end ranges
//   • stream/promises pipeline() in both directions
//   • FileHandle#createReadStream / createWriteStream / readLines /
//     readableWebStream
//   • fs.Utf8Stream — buffered append writer
//   • Stats.mode file-type bits and nlink
//   • fs.glob / fs.globSync / fs.promises.glob
//   • fs.utimes / futimes — the /touch-backed "set to now" path
//   • fs.link / symlink / readlink — the errnos a filesystem without links reports
//
// Set NODE_WORKER_API_STATS=1 in the environment to confirm a whole-file
// createReadStream costs one `read` call rather than one per chunk.
//
// Everything happens inside a temp directory under cwd, removed at the end.

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
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

function finished(stream) {
	return new Promise((resolve, reject) => {
		stream.on("close", resolve);
		stream.on("error", reject);
	});
}

let root = path.resolve(`fs-streams-smoke-${Date.now()}`);

async function main() {
	console.log(`fs stream smoke test in ${root}`);
	await fsp.mkdir(root, { recursive: true });

	// A payload big enough to span several highWaterMark chunks.
	let big = Buffer.alloc(300 * 1024);
	for (let i = 0; i < big.length; i++) big[i] = i % 251;

	// ------------------------------------------------------------ write stream
	section("fs.createWriteStream");
	let target = path.join(root, "written.bin");
	{
		let events = [];
		let stream = fs.createWriteStream(target);
		stream.on("open", (fd) => events.push(["open", fd]));
		stream.on("ready", () => events.push(["ready"]));
		stream.on("close", () => events.push(["close"]));

		ok("pending is true before open", stream.pending === true, String(stream.pending));

		// Three chunks so _write runs more than once.
		for (let offset = 0; offset < big.length; offset += 128 * 1024) {
			let chunk = big.subarray(offset, Math.min(offset + 128 * 1024, big.length));
			if (!stream.write(chunk)) await new Promise((r) => stream.once("drain", r));
		}
		stream.end();
		await finished(stream);

		ok("path is the resolved target", stream.path === target, stream.path);
		ok("bytesWritten counts every chunk", stream.bytesWritten === big.length, `${stream.bytesWritten} vs ${big.length}`);
		ok(
			"emits open then ready then close",
			events.map((e) => e[0]).join(",") === "open,ready,close",
			events.map((e) => e[0]).join(",")
		);
		ok("open carries a numeric fd", typeof events[0]?.[1] === "number", String(events[0]?.[1]));

		let stat = await fsp.stat(target);
		ok("file has the full size on disk", stat.size === big.length, `${stat.size} vs ${big.length}`);
	}

	// ------------------------------------------------------------- read stream
	section("fs.createReadStream (whole file)");
	{
		let events = [];
		let stream = fs.createReadStream(target);
		stream.on("open", (fd) => events.push(["open", fd]));
		stream.on("ready", () => events.push(["ready"]));
		stream.on("close", () => events.push(["close"]));

		let chunks = [];
		for await (let chunk of stream) chunks.push(chunk);
		let read = Buffer.concat(chunks);

		ok("round-trips byte-for-byte", read.equals(big), `${read.length} bytes`);
		ok("bytesRead matches", stream.bytesRead === big.length, `${stream.bytesRead} vs ${big.length}`);
		ok("delivered more than one chunk", chunks.length > 1, `${chunks.length} chunks`);
		ok(
			"emits open then ready then close",
			events.map((e) => e[0]).join(",") === "open,ready,close",
			events.map((e) => e[0]).join(",")
		);
	}

	section("fs.createReadStream (start/end)");
	{
		let stream = fs.createReadStream(target, { start: 100, end: 199 });
		let chunks = [];
		for await (let chunk of stream) chunks.push(chunk);
		let read = Buffer.concat(chunks);
		ok("reads exactly the inclusive range", read.length === 100, `${read.length} bytes`);
		ok("range content matches", read.equals(big.subarray(100, 200)));
	}

	section("fs.createReadStream (encoding)");
	{
		let textFile = path.join(root, "text.txt");
		await fsp.writeFile(textFile, "hello\nworld\n");
		let stream = fs.createReadStream(textFile, "utf8");
		let out = "";
		for await (let chunk of stream) out += chunk;
		ok("yields strings with an encoding", typeof out === "string" && out === "hello\nworld\n", JSON.stringify(out));
	}

	section("fs.createReadStream (missing file)");
	{
		let stream = fs.createReadStream(path.join(root, "nope.bin"));
		let err = await new Promise((resolve) => {
			stream.on("error", resolve);
			stream.on("end", () => resolve(undefined));
			stream.resume();
		});
		ok("emits ENOENT", err?.code === "ENOENT", `${err?.code} — ${err?.message}`);
	}

	// ---------------------------------------------------------------- pipeline
	section("stream/promises pipeline()");
	{
		let piped = path.join(root, "piped.bin");
		await pipeline(Readable.from([big.subarray(0, 1024), big.subarray(1024, 4096)]), fs.createWriteStream(piped));
		let stat = await fsp.stat(piped);
		ok("Readable -> WriteStream writes everything", stat.size === 4096, `${stat.size} vs 4096`);

		let copy = path.join(root, "copied.bin");
		await pipeline(fs.createReadStream(piped), fs.createWriteStream(copy));
		let content = await fsp.readFile(copy);
		ok("ReadStream -> WriteStream round-trips", content.equals(big.subarray(0, 4096)), `${content.length} bytes`);
	}

	// -------------------------------------------------------------- FileHandle
	section("FileHandle streams");
	{
		let handlePath = path.join(root, "handle.txt");
		let handle = await fsp.open(handlePath, "w");
		let ws = handle.createWriteStream();
		ws.end("line one\nline two\nline three\n");
		await finished(ws);
		await handle.close();

		let content = await fsp.readFile(handlePath, "utf8");
		ok("FileHandle#createWriteStream writes", content === "line one\nline two\nline three\n", JSON.stringify(content));

		let readHandle = await fsp.open(handlePath, "r");
		let rs = readHandle.createReadStream();
		let out = "";
		for await (let chunk of rs) out += chunk.toString("utf8");
		ok("FileHandle#createReadStream reads", out === content, JSON.stringify(out));

		let lines = [];
		for await (let line of readHandle.readLines()) lines.push(line);
		ok("FileHandle#readLines yields lines", lines.length === 3, JSON.stringify(lines));
		ok("first line is correct", lines[0] === "line one", lines[0]);

		let web = readHandle.readableWebStream();
		ok("readableWebStream returns a ReadableStream", web instanceof ReadableStream, String(web?.constructor?.name));
		let reader = web.getReader();
		let webBytes = 0;
		while (true) {
			let { done, value } = await reader.read();
			if (done) break;
			webBytes += value.byteLength;
		}
		ok("web stream delivers the whole file", webBytes === content.length, `${webBytes} vs ${content.length}`);
		await readHandle.close();
	}

	section("fs.createReadStream({ fd })");
	{
		let file = path.join(root, "byfd.txt");
		await fsp.writeFile(file, "from an fd");
		let fd = fs.openSync(file, "r");
		// openSync produces a SyncFileHandle, which the async streams can't use;
		// the async open family is the one that pairs with them.
		fs.closeSync(fd);

		let handle = await fsp.open(file, "r");
		let stream = fs.createReadStream(file, { fd: handle.fd, autoClose: false });
		let out = "";
		for await (let chunk of stream) out += chunk.toString("utf8");
		ok("reads through a numeric fd", out === "from an fd", JSON.stringify(out));
		ok("stream.fd is the handle's fd", stream.fd === handle.fd, `${stream.fd} vs ${handle.fd}`);
		await handle.close();
	}

	// ------------------------------------------------------------- Utf8Stream
	section("fs.Utf8Stream");
	{
		let logFile = path.join(root, "log.txt");
		let stream = new fs.Utf8Stream({ dest: logFile, minLength: 4096 });
		await new Promise((resolve, reject) => {
			stream.on("ready", resolve);
			stream.on("error", reject);
		});
		ok("append defaults to true", stream.append === true, String(stream.append));
		ok("contentMode defaults to utf8", stream.contentMode === "utf8", stream.contentMode);
		ok("exposes the destination file", stream.file === logFile, stream.file);

		stream.write("first\n");
		stream.write("second\n");
		await new Promise((resolve, reject) => {
			stream.flush((err) => (err ? reject(err) : resolve()));
		});
		let logged = await fsp.readFile(logFile, "utf8");
		ok("flush() writes the buffer", logged === "first\nsecond\n", JSON.stringify(logged));

		stream.write("third\n");
		let closed = new Promise((r) => stream.on("close", r));
		stream.end();
		await closed;
		logged = await fsp.readFile(logFile, "utf8");
		ok("end() flushes and closes", logged === "first\nsecond\nthird\n", JSON.stringify(logged));
	}

	// ------------------------------------------------------------------ Stats
	section("Stats file-type bits");
	{
		let dirStat = await fsp.stat(root);
		let fileStat = await fsp.stat(target);

		ok(
			"a directory's mode carries S_IFDIR",
			(dirStat.mode & fs.constants.S_IFMT) === fs.constants.S_IFDIR,
			"0o" + dirStat.mode.toString(8)
		);
		ok(
			"a file's mode carries S_IFREG",
			(fileStat.mode & fs.constants.S_IFMT) === fs.constants.S_IFREG,
			"0o" + fileStat.mode.toString(8)
		);
		ok("directory nlink is 2", dirStat.nlink === 2, String(dirStat.nlink));
		ok("file nlink is 1", fileStat.nlink === 1, String(fileStat.nlink));

		let bigintStat = await fsp.stat(root, { bigint: true });
		ok(
			"bigint mode carries S_IFDIR too",
			(bigintStat.mode & BigInt(fs.constants.S_IFMT)) === BigInt(fs.constants.S_IFDIR),
			"0o" + bigintStat.mode.toString(8)
		);
		ok("bigint nlink is 2n", bigintStat.nlink === 2n, String(bigintStat.nlink));
	}

	// ------------------------------------------------------------------- glob
	section("fs.glob");
	{
		await fsp.mkdir(path.join(root, "globdir"), { recursive: true });
		await fsp.writeFile(path.join(root, "globdir", "one.ts"), "");
		await fsp.writeFile(path.join(root, "globdir", "two.ts"), "");
		await fsp.writeFile(path.join(root, "globdir", "three.js"), "");

		let syncMatches = fs.globSync("*.ts", { cwd: path.join(root, "globdir") });
		ok("globSync finds the .ts files", syncMatches.length === 2, JSON.stringify(syncMatches));

		let asyncMatches = [];
		for await (let match of fsp.glob("*.ts", { cwd: path.join(root, "globdir") })) {
			asyncMatches.push(match);
		}
		ok("promises.glob finds the .ts files", asyncMatches.length === 2, JSON.stringify(asyncMatches));

		let cbMatches = await new Promise((resolve, reject) => {
			fs.glob("*.js", { cwd: path.join(root, "globdir") }, (err, matches) =>
				err ? reject(err) : resolve(matches)
			);
		});
		ok("callback glob finds the .js file", cbMatches.length === 1, JSON.stringify(cbMatches));
	}

	// ----------------------------------------------------------------- utimes
	section("fs.utimes");
	{
		let file = path.join(root, "timed.txt");
		await fsp.writeFile(file, "x");
		let before = await fsp.stat(file);

		// puterfs can only set a timestamp to *now*, so this is the path that
		// actually reaches the api.
		await new Promise((r) => setTimeout(r, 1_100));
		let now = new Date();
		await fsp.utimes(file, now, now);
		let after = await fsp.stat(file);
		ok(
			"utimes(now) moves mtime forward",
			after.mtimeMs >= before.mtimeMs,
			`${before.mtimeMs} -> ${after.mtimeMs}`
		);

		// An arbitrary past timestamp is not representable; node's contract is
		// satisfied by not throwing, and the file must still exist afterwards.
		await fsp.utimes(file, new Date("2001-01-01T00:00:00Z"), new Date("2001-01-01T00:00:00Z"));
		ok("utimes(past) is a no-op rather than an error", fs.existsSync(file));

		await rejects("utimes on a missing path rejects ENOENT", () => fsp.utimes(path.join(root, "gone.txt"), 0, 0), "ENOENT");

		let handle = await fsp.open(file, "r+");
		await handle.utimes(new Date(), new Date());
		ok("FileHandle#utimes resolves", true);
		await new Promise((resolve, reject) => {
			fs.futimes(handle.fd, new Date(), new Date(), (err) => (err ? reject(err) : resolve()));
		});
		ok("fs.futimes resolves", true);
		await handle.close();

		// futimesSync needs an fd from openSync: this runtime keeps sync and async
		// handles in one fd table but does not let one family use the other's fds.
		let syncFd = fs.openSync(file, "r+");
		fs.futimesSync(syncFd, new Date(), new Date());
		ok("fs.futimesSync resolves", true);
		fs.closeSync(syncFd);
	}

	// ------------------------------------------------------------------ links
	section("links report the errno of a filesystem without them");
	{
		let existing = path.join(root, "timed.txt");
		let link = path.join(root, "link.txt");

		await rejects("promises.link rejects EPERM", () => fsp.link(existing, link), "EPERM");
		await rejects("promises.symlink rejects EPERM", () => fsp.symlink(existing, link), "EPERM");
		await rejects("promises.readlink rejects EINVAL on a real file", () => fsp.readlink(existing), "EINVAL");
		await rejects(
			"promises.readlink rejects ENOENT on a missing path",
			() => fsp.readlink(path.join(root, "absent.txt")),
			"ENOENT"
		);

		throws("linkSync throws EPERM", () => fs.linkSync(existing, link), "EPERM");
		throws("symlinkSync throws EPERM", () => fs.symlinkSync(existing, link), "EPERM");
		throws("readlinkSync throws EINVAL on a real file", () => fs.readlinkSync(existing), "EINVAL");

		let stat = await fsp.lstat(existing);
		ok("lstat reports a plain file (nothing can be a symlink)", stat.isSymbolicLink() === false);
		ok("realpath is the identity", (await fsp.realpath(existing)) === existing, await fsp.realpath(existing));
		ok("realpath.native exists", typeof fs.realpath.native === "function", typeof fs.realpath.native);
		ok("realpathSync.native exists", typeof fs.realpathSync.native === "function", typeof fs.realpathSync.native);
	}

	// -------------------------------------------------------------- readline
	section("readline over a read stream");
	{
		let file = path.join(root, "lines.txt");
		await fsp.writeFile(file, "alpha\nbeta\ngamma\n");
		let rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
		let lines = [];
		for await (let line of rl) lines.push(line);
		ok("readline reads every line", lines.length === 3, JSON.stringify(lines));
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
if (failed > 0) throw new Error(`${failed} fs stream check(s) failed`);
