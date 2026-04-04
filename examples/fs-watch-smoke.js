// fs.watch / fs.watchFile smoke test for node-worker.
//
// HOW TO RUN: paste this whole file into the Monaco editor in the testbed and
// click "Run eval module". Output streams to the console pane; the final line
// reports pass/fail counts (and the run throws if anything failed).
//
// What it exercises:
//   • fs.watch on a directory — 'rename' for create/delete, 'change' for writes
//   • fs.watch({ recursive: true }) — relative filenames for nested entries
//   • fs.watch on a single file
//   • fs.watch({ encoding: 'buffer' }) — filename as a Buffer
//   • fs.promises.watch — the async-iterator form, including AbortSignal
//   • fs.watchFile / fs.unwatchFile — change(curr, prev) Stats
//   • that the puter socket.io feed is actually delivering: every local
//     mutation is reported immediately AND echoed back over the wire, so a
//     second event for the same path proves the socket half works.
//
// Everything happens inside a temp directory under cwd, removed at the end.

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

// A local (synthesized) event lands as soon as the api call resolves; the socket
// echo has to make a round trip through the backend.
const LOCAL_WAIT_MS = 3_000;
const ECHO_WAIT_MS = 8_000;

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Collects every ('change') emission so assertions can look for one that
// matches, rather than depending on ordering or on how many duplicates the
// api echo produces.
function collect(watcher) {
	let events = [];
	let waiters = [];
	watcher.on("change", (eventType, filename) => {
		events.push({ eventType, filename });
		for (let w of waiters.splice(0)) w();
	});
	return {
		events,
		async waitFor(predicate, timeoutMs) {
			let deadline = Date.now() + timeoutMs;
			while (true) {
				let hit = events.find(predicate);
				if (hit) return hit;
				let remaining = deadline - Date.now();
				if (remaining <= 0) return undefined;
				await Promise.race([
					new Promise((r) => waiters.push(r)),
					sleep(Math.min(remaining, 250)),
				]);
			}
		},
		async count(predicate, timeoutMs) {
			let deadline = Date.now() + timeoutMs;
			while (Date.now() < deadline) await sleep(250);
			return events.filter(predicate).length;
		},
	};
}

let root = path.resolve(`fs-watch-smoke-${Date.now()}`);

async function main() {
	console.log(`fs.watch smoke test in ${root}`);
	await fsp.mkdir(root, { recursive: true });

	// ---------------------------------------------------------------- directory
	section("fs.watch(dir)");
	{
		let watcher = fs.watch(root);
		let seen = collect(watcher);
		let file = path.join(root, "a.txt");

		await fsp.writeFile(file, "one");
		let created = await seen.waitFor((e) => e.filename === "a.txt", LOCAL_WAIT_MS);
		ok("reports a created child by basename", !!created, created?.eventType);
		ok(
			"eventType is rename or change",
			created?.eventType === "rename" || created?.eventType === "change",
			created?.eventType
		);

		seen.events.length = 0;
		await fsp.rm(file);
		let removed = await seen.waitFor((e) => e.filename === "a.txt", LOCAL_WAIT_MS);
		ok("reports a removed child", !!removed, removed?.eventType);
		ok("removal is a rename", removed?.eventType === "rename", removed?.eventType);

		// Nothing outside the watched directory should reach this watcher.
		//
		// Scoped to the outsider's own basename rather than asserting the buffer is
		// empty. Every mutation is reported twice — once locally the instant it
		// succeeds, once when the api echoes it back over the socket — and the echo
		// can arrive seconds later, which is why ECHO_WAIT_MS is 8s. Clearing the
		// buffer and demanding nothing at all arrive within 1.5s therefore raced the
		// echo of the *removal* just above, and failed whenever the socket was slow.
		// A late event about `a.txt` is not this assertion being violated: `a.txt` is
		// inside the watched directory. What must never show up is the outsider.
		seen.events.length = 0;
		let outsideName = `fs-watch-outsider-${Date.now()}.txt`;
		let outside = path.resolve(outsideName);
		await fsp.writeFile(outside, "x");
		await sleep(1_500);
		let leaked = seen.events.filter((e) => String(e.filename) === outsideName);
		ok(
			"ignores paths outside the watched dir",
			leaked.length === 0,
			`${leaked.length} leaked of ${seen.events.length} seen`
		);
		await fsp.rm(outside, { force: true });

		watcher.close();
		await sleep(100);
		seen.events.length = 0;
		await fsp.writeFile(path.join(root, "after-close.txt"), "x");
		await sleep(1_000);
		ok("stops emitting after close()", seen.events.length === 0, `${seen.events.length} events`);
	}

	// ---------------------------------------------------------------- recursive
	section("fs.watch(dir, { recursive: true })");
	{
		let watcher = fs.watch(root, { recursive: true });
		let seen = collect(watcher);
		let sub = path.join(root, "nested", "deep");

		await fsp.mkdir(sub, { recursive: true });
		let dirEvent = await seen.waitFor(
			(e) => e.filename === path.join("nested", "deep"),
			LOCAL_WAIT_MS
		);
		ok("reports a nested directory by relative path", !!dirEvent, dirEvent?.filename);

		seen.events.length = 0;
		let deepFile = path.join(sub, "b.txt");
		await fsp.writeFile(deepFile, "two");
		let fileEvent = await seen.waitFor(
			(e) => e.filename === path.join("nested", "deep", "b.txt"),
			LOCAL_WAIT_MS
		);
		ok("reports a nested file by relative path", !!fileEvent, fileEvent?.filename);

		watcher.close();
	}

	// A non-recursive watcher must NOT see grandchildren.
	section("fs.watch(dir) depth");
	{
		let watcher = fs.watch(root);
		let seen = collect(watcher);
		await fsp.writeFile(path.join(root, "nested", "deep", "c.txt"), "three");
		await sleep(1_500);
		ok(
			"non-recursive watcher ignores grandchildren",
			!seen.events.some((e) => String(e.filename).includes("c.txt")),
			JSON.stringify(seen.events.map((e) => e.filename))
		);
		watcher.close();
	}

	// --------------------------------------------------------------- single file
	section("fs.watch(file)");
	{
		let file = path.join(root, "watched.txt");
		await fsp.writeFile(file, "initial");
		let watcher = fs.watch(file);
		let seen = collect(watcher);

		await fsp.writeFile(file, "updated");
		let changed = await seen.waitFor(() => true, LOCAL_WAIT_MS);
		ok("reports a write to the watched file", !!changed, `${changed?.eventType} ${changed?.filename}`);
		ok("filename is the file's basename", changed?.filename === "watched.txt", changed?.filename);
		watcher.close();
	}

	// -------------------------------------------------------------- encoding
	section("fs.watch(dir, { encoding: 'buffer' })");
	{
		let watcher = fs.watch(root, { encoding: "buffer" });
		let seen = collect(watcher);
		await fsp.writeFile(path.join(root, "buf.txt"), "x");
		let event = await seen.waitFor((e) => Buffer.isBuffer(e.filename), LOCAL_WAIT_MS);
		ok("filename is a Buffer", !!event, event && event.filename.toString("utf8"));
		ok(
			"Buffer decodes to the basename",
			event?.filename?.toString("utf8") === "buf.txt",
			event?.filename?.toString("utf8")
		);
		watcher.close();
	}

	// ------------------------------------------------------------------ rename
	section("fs.rename reports both ends");
	{
		let watcher = fs.watch(root, { recursive: true });
		let seen = collect(watcher);
		let from = path.join(root, "before.txt");
		let to = path.join(root, "after.txt");
		await fsp.writeFile(from, "x");
		seen.events.length = 0;
		await fsp.rename(from, to);

		let source = await seen.waitFor((e) => e.filename === "before.txt", LOCAL_WAIT_MS);
		let dest = await seen.waitFor((e) => e.filename === "after.txt", LOCAL_WAIT_MS);
		ok("reports the source path", !!source, source?.eventType);
		ok("reports the destination path", !!dest, dest?.eventType);
		watcher.close();
	}

	// ---------------------------------------------------------- promises.watch
	section("fs.promises.watch");
	{
		let controller = new AbortController();
		let iterator = fsp.watch(root, { signal: controller.signal });
		let received = [];
		let done = (async () => {
			try {
				for await (let event of iterator) {
					received.push(event);
					if (received.length >= 1) break;
				}
				return "completed";
			} catch (err) {
				return err?.name === "AbortError" ? "aborted" : `threw ${err?.message}`;
			}
		})();

		await sleep(200);
		await fsp.writeFile(path.join(root, "iter.txt"), "x");
		let outcome = await Promise.race([done, sleep(LOCAL_WAIT_MS).then(() => "timeout")]);
		ok("async iterator yields an event", outcome === "completed", outcome);
		ok(
			"yielded shape is { eventType, filename }",
			typeof received[0]?.eventType === "string" && typeof received[0]?.filename === "string",
			JSON.stringify(received[0])
		);
		controller.abort();
	}

	section("fs.promises.watch aborts");
	{
		let controller = new AbortController();
		let iterator = fsp.watch(root, { signal: controller.signal });
		let done = (async () => {
			try {
				for await (let _ of iterator) {
					// keep going until aborted
				}
				return "completed";
			} catch (err) {
				return err?.name === "AbortError" ? "aborted" : `threw ${err?.name}`;
			}
		})();
		await sleep(300);
		controller.abort();
		let outcome = await Promise.race([done, sleep(3_000).then(() => "timeout")]);
		ok("abort rejects with AbortError", outcome === "aborted", outcome);
	}

	// -------------------------------------------------------------- watchFile
	section("fs.watchFile / fs.unwatchFile");
	{
		let file = path.join(root, "polled.txt");
		await fsp.writeFile(file, "v1");
		await sleep(500);

		let changes = [];
		let waiters = [];
		let listener = (curr, prev) => {
			changes.push({ curr, prev });
			for (let w of waiters.splice(0)) w();
		};
		let watcher = fs.watchFile(file, listener);
		ok("watchFile returns a StatWatcher", typeof watcher?.ref === "function", typeof watcher);

		// Give the initial stat time to seed `prev` — the first emission must
		// reflect a real change, not the initial observation.
		await sleep(1_000);
		ok("does not emit on the initial stat", changes.length === 0, `${changes.length} emissions`);

		await fsp.writeFile(file, "v2 is longer");
		let deadline = Date.now() + ECHO_WAIT_MS;
		while (changes.length === 0 && Date.now() < deadline) {
			await Promise.race([new Promise((r) => waiters.push(r)), sleep(250)]);
		}
		let first = changes[0];
		ok("emits change(curr, prev)", !!first, `${changes.length} emissions`);
		ok("curr is a Stats", typeof first?.curr?.isFile === "function", typeof first?.curr);
		ok(
			"curr.size reflects the new contents",
			first?.curr?.size === Buffer.byteLength("v2 is longer"),
			`${first?.curr?.size} vs ${Buffer.byteLength("v2 is longer")}`
		);
		ok(
			"prev.size reflects the old contents",
			first?.prev?.size === Buffer.byteLength("v1"),
			`${first?.prev?.size} vs ${Buffer.byteLength("v1")}`
		);

		fs.unwatchFile(file, listener);
		changes.length = 0;
		await fsp.writeFile(file, "v3");
		await sleep(1_500);
		ok("unwatchFile detaches the listener", changes.length === 0, `${changes.length} emissions`);
	}

	section("fs.watchFile on a missing file");
	{
		let missing = path.join(root, "never-existed.txt");
		let changes = [];
		fs.watchFile(missing, (curr, prev) => changes.push({ curr, prev }));
		await sleep(1_000);

		await fsp.writeFile(missing, "now it exists");
		let deadline = Date.now() + ECHO_WAIT_MS;
		while (changes.length === 0 && Date.now() < deadline) await sleep(250);

		let first = changes[0];
		ok("emits when a missing file appears", !!first, `${changes.length} emissions`);
		ok("prev is the all-zero Stats", first?.prev?.mtimeMs === 0, String(first?.prev?.mtimeMs));
		ok("prev.mode is 0 for a missing file", first?.prev?.mode === 0, String(first?.prev?.mode));
		ok("prev.isFile() is false", first?.prev?.isFile() === false, String(first?.prev?.isFile()));
		fs.unwatchFile(missing);
	}

	// ------------------------------------------------------- socket round trip
	// The local synth fires immediately; the api echo arrives a round trip later.
	// Two events for one mutation is therefore the signal that the socket.io feed
	// is genuinely connected, not just that local synthesis works.
	section("puter socket.io feed");
	{
		let watcher = fs.watch(root);
		let seen = collect(watcher);
		let file = path.join(root, "echo.txt");
		await fsp.writeFile(file, "echo");
		let total = await seen.count((e) => e.filename === "echo.txt", ECHO_WAIT_MS);
		ok(
			"a local mutation is also echoed over the socket",
			total >= 2,
			`${total} event(s) — 1 means the socket never delivered`
		);
		watcher.close();
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
if (failed > 0) throw new Error(`${failed} fs.watch check(s) failed`);
