// Turning a listening port into something clickable.
//
// A server in the runtime listens through puter.peer: `net.Server.listen` registers a
// peer server with the signaller under a credential and its port number (see
// node-worker/src/lib/peer.ts). browser.puter.com is the browser UI that knows how to
// reach those — give it a localhost URL and it resolves the port against the peer servers
// registered under that credential, tunnelling the rest over WISP.
//
// So nothing has to be plumbed for a preview to work; the port just has to be noticed —
// except the *which peer* part, which differs by how the workspace is authenticated:
//
//   - signed in: the credential is the user's auth token, which browser.puter.com already
//     has from being signed in as the same user. Nothing to pass.
//   - anonymous: the credential is this page's peer token, which browser.puter.com cannot
//     know, so it travels in the link as `peerToken` and browser.puter.com presents it to
//     the signaller as its own `anonToken` — the signaller then matches the two by
//     `(token, port)`.

const PUTER_BROWSER = "https://browser.puter.com/";

/** Matches the `http://localhost:5173/` a dev server prints when it starts. */
const LOCALHOST = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::(\d+))?(\/\S*)?/g;

/**
 * CSI/OSC escape sequences, stripped before matching.
 *
 * Not optional: vite prints its address with the port in bold, so the raw bytes are
 * `http://localhost:` ESC `[1m` `5173` ESC `[22m` `/`. Scanning that for a port finds
 * nothing, and the preview chip never appears even though the server is up.
 */
const ANSI = /\x1b(?:\[[0-9;?]*[ -\/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g;

/**
 * The browser.puter.com link for a port, `peerToken` set when the workspace is anonymous.
 *
 * `openUrl` is the parameter browser.puter.com reads; `peerToken` is the only difference
 * between the two cases, and it is what lets it find a peer server that no user owns.
 */
export function previewUrlFor(port: number, path = "/", peerToken?: string): string {
	let target = `http://localhost:${port}${path}`;
	let anon = peerToken ? `&peerToken=${encodeURIComponent(peerToken)}` : "";
	return `${PUTER_BROWSER}?openUrl=${target}${anon}`;
}

/** Rewrite a localhost URL for browser.puter.com, or return undefined if it isn't one. */
export function rewriteLocalhost(uri: string, peerToken?: string): string | undefined {
	let match = /^https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::(\d+))?(\/.*)?$/.exec(uri);
	if (!match) return undefined;
	let port = match[1] ? Number(match[1]) : 80;
	return previewUrlFor(port, match[2] || "/", peerToken);
}

/**
 * Watches program output for a server announcing itself.
 *
 * Scanning stdout is how this is known at all: the runtime keeps the peer invite code
 * on the server object and never reports it, and `Server.address()` returns a
 * placeholder, so there is no API to ask. A dev server printing its own URL is the
 * signal available.
 */
export class PortWatcher {
	private buffer = "";
	private found = new Set<number>();
	private onPort: (port: number) => void;

	// A declared field rather than a parameter property: the project sets
	// `erasableSyntaxOnly`, so that shorthand would not survive type stripping.
	constructor(onPort: (port: number) => void) {
		this.onPort = onPort;
	}

	/** Feed program output through. Safe to call with partial chunks. */
	observe(text: string): void {
		// Keep a tail across chunks: a URL can be split across two writes, and the port
		// is at the end of it.
		this.buffer = (this.buffer + text.replace(ANSI, "")).slice(-512);
		for (let match of this.buffer.matchAll(LOCALHOST)) {
			if (!match[1]) continue;
			let port = Number(match[1]);
			if (!Number.isFinite(port) || this.found.has(port)) continue;
			this.found.add(port);
			this.onPort(port);
		}
	}

	/** Forget what was seen — a new run has no servers until it says so. */
	reset(): void {
		this.buffer = "";
		this.found.clear();
	}
}
