// Fetching and unpacking a baked project template.
//
// Produced by scripts/build-template.ts; see its header for what is in one and why the
// layout matters.

import { createTarDecoder, createGzipDecoder } from "modern-tar";

import { appUrl } from "../base";
import type { MountEntry } from "./mirror";

// Through `appUrl` because the templates are served from the deployment root, wherever that is —
// see src/base.ts. The cache is keyed on the resolved URL, so two deployments on one origin keep
// their own entries rather than one serving the other's template.
const MANIFEST_URL = appUrl("templates/index.json");
const CACHE_NAME = "node-worker-template";

export interface TemplateInfo {
	id: string;
	label: string;
	/** The command the workspace's Run button issues. */
	start: string;
	packages: number;
	files: number;
	bytes: number;
	createVite: string;
}

export interface TemplateManifest {
	default: string;
	templates: TemplateInfo[];
}

export type LoadPhase = "download" | "extract";

export interface LoadProgress {
	phase: LoadPhase;
	/** 0..1, or undefined when the total is unknown (no Content-Length). */
	fraction?: number;
	/** Human-readable detail for the splash's status line. */
	detail: string;
}

export type ProgressReporter = (progress: LoadProgress) => void;

export async function fetchManifest(): Promise<TemplateManifest> {
	let res = await fetch(MANIFEST_URL);
	if (!res.ok) {
		throw new Error(
			`no template manifest at ${MANIFEST_URL} (HTTP ${res.status}) — run \`pnpm template\``
		);
	}
	let manifest = (await res.json()) as TemplateManifest;
	if (!manifest.templates?.length) throw new Error("template manifest is empty");
	return manifest;
}

/**
 * The template's bytes, from the Cache API when possible.
 *
 * Worth caching because it is the single largest thing the page loads — around 10 MB
 * gzipped for a vite tree — and it never changes for a given build. A miss is a
 * one-time cost; a hit turns the splash's first phase into a no-op.
 */
async function fetchArchive(
	info: TemplateInfo,
	report: ProgressReporter
): Promise<Uint8Array> {
	let url = appUrl(`templates/${info.id}.tar.gz`);
	let cache = await openCache();

	let cached = await cache?.match(url);
	if (cached) {
		report({ phase: "download", fraction: 1, detail: "cache hit" });
		return new Uint8Array(await cached.arrayBuffer());
	}

	let res = await fetch(url);
	if (!res.ok || !res.body) {
		throw new Error(`download ${url}: HTTP ${res.status} — run \`pnpm template\``);
	}

	// The manifest's byte count is a better total than Content-Length: it is right
	// even when the response is served with transfer encoding that omits a length.
	let total = Number(res.headers.get("content-length")) || info.bytes || 0;
	let chunks: Uint8Array[] = [];
	let received = 0;
	let reader = res.body.getReader();
	while (true) {
		let { value, done } = await reader.read();
		if (done) break;
		if (!value) continue;
		chunks.push(value);
		received += value.byteLength;
		// A host that decompresses for us still reports the *compressed* length, so
		// what arrives can exceed it several times over. Once it does, the total is
		// known to be meaningless and showing it would just look broken.
		let known = total > 0 && received <= total;
		report({
			phase: "download",
			fraction: known ? received / total : undefined,
			detail: known ? `${fmtBytes(received)} of ${fmtBytes(total)}` : fmtBytes(received),
		});
	}

	let archive = concat(chunks, received);
	// Cache the assembled bytes rather than re-fetching: `res` is already consumed,
	// and a second request just to populate the cache would double the transfer.
	await cache
		?.put(url, new Response(archive as BlobPart, { headers: { "content-type": "application/gzip" } }))
		.catch(() => {
			// A full or unavailable cache costs a download next time, nothing more.
		});
	return archive;
}

/**
 * Load a template and return its entries, ready for the mirror.
 *
 * Decoded entry-at-a-time rather than with `unpackTar` so the splash can show real
 * progress through the ~400 files, and so each entry's bytes are copied into a buffer
 * of their own — the mirror holds these for the lifetime of the page and hands them to
 * every worker it populates, so none of them may be a view onto a shared archive
 * buffer.
 */
export async function loadTemplate(
	info: TemplateInfo,
	report: ProgressReporter
): Promise<MountEntry[]> {
	let archive = await fetchArchive(info, report);

	let entries: MountEntry[] = [];
	let bytes = new Blob([archive as BlobPart]).stream();
	// Only gunzip if it is actually gzipped.
	//
	// Static hosts commonly serve a `.tar.gz` with `Content-Encoding: gzip` — Vite's
	// dev server does — and a browser always accepts that encoding, so `fetch` hands
	// back tar that has already been decompressed for us. Other hosts send it as an
	// opaque body and it arrives compressed. Sniffing the magic number is what makes
	// the same code work on both, instead of depending on how the archive is served.
	let stream = (isGzip(archive) ? bytes.pipeThrough(createGzipDecoder()) : bytes).pipeThrough(
		createTarDecoder()
	);

	// An explicit reader rather than `for await`: ReadableStream async iteration is
	// still not everywhere (Safari has no `[Symbol.asyncIterator]` on it), and this
	// loop is the one thing standing between the user and the workspace.
	let reader = stream.getReader();
	try {
		while (true) {
			let { value: entry, done } = await reader.read();
			if (done) break;
			if (!entry) continue;

			if (entry.header.type === "file") {
				entries.push({
					path: entry.header.name,
					data: await readAll(entry.body, entry.header.size),
					mtimeMs: entry.header.mtime?.getTime(),
				});
			} else {
				// Every non-file entry: a directory becomes a mkdir, and links are
				// dropped (the baker emits none, and the memory mount has no concept of
				// them). Draining is mandatory either way — an unread body stalls the
				// decoder on the next read.
				await entry.body.cancel();
				if (entry.header.type === "directory") entries.push({ path: entry.header.name });
			}

			report({
				phase: "extract",
				fraction: info.files > 0 ? Math.min(1, entries.length / info.files) : undefined,
				detail: `${entries.length} of ${info.files} files`,
			});
		}
	} finally {
		reader.releaseLock();
	}

	return entries;
}

async function readAll(stream: ReadableStream<Uint8Array>, size: number): Promise<Uint8Array> {
	let out = new Uint8Array(size);
	let at = 0;
	let reader = stream.getReader();
	while (true) {
		let { value, done } = await reader.read();
		if (done) break;
		if (!value) continue;
		// A header that understates its body would otherwise write past the end.
		if (at + value.byteLength > out.byteLength) {
			throw new Error(`tar entry longer than its declared ${size} bytes`);
		}
		out.set(value, at);
		at += value.byteLength;
	}
	return at === out.byteLength ? out : out.subarray(0, at);
}

/** The gzip magic number, 0x1f 0x8b. */
function isGzip(data: Uint8Array): boolean {
	return data.byteLength >= 2 && data[0] === 0x1f && data[1] === 0x8b;
}

async function openCache(): Promise<Cache | undefined> {
	// Absent on insecure origins and in some private-browsing modes.
	if (typeof caches === "undefined") return undefined;
	try {
		return await caches.open(CACHE_NAME);
	} catch {
		return undefined;
	}
}

function concat(chunks: Uint8Array[], total: number): Uint8Array {
	let out = new Uint8Array(total);
	let at = 0;
	for (let chunk of chunks) {
		out.set(chunk, at);
		at += chunk.byteLength;
	}
	return out;
}

export function fmtBytes(n: number): string {
	return n < 1024 * 1024
		? `${(n / 1024).toFixed(0)} KB`
		: `${(n / 1024 / 1024).toFixed(1)} MB`;
}
