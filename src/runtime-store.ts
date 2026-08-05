// Auth token, working directory and persisted UI state.
//
// Shared by all three modes (workspace, Puter terminal, legacy testbed) and therefore
// its own module: the alternative is one importing another for these, which makes a
// cycle out of what is really just configuration.

const params = new URLSearchParams(window.location.search);

export const urlToken = params.get("puter.auth.token")?.trim() ?? "";
export const urlUsername = params.get("puter.auth.username")?.trim() ?? "";

/** A token in the URL is how Puter launches an app, and the only reliable signal. */
export const isPuterApp = urlToken.length > 0;

export const devDefaults: { token: string; cwd: string } = import.meta.env.DEV
	? {
			token: (import.meta.env.VITE_DEV_TOKEN ?? "").trim(),
			cwd: (import.meta.env.VITE_DEV_CWD ?? "").trim(),
		}
	: { token: "", cwd: "" };

// --------------------------------------------------------------- anonymous mode
//
// Running with **no puter token at all**. The project already lives in this device's
// storage rather than in Drive, so the only thing a token was still buying the
// workspace is the network: the wisp relay credentials behind `fetch` and sockets,
// and the peer identity behind `listen()`. Both can be supplied directly — see
// `NodeNetInit` in node-worker — so this mode hands the runtime a relay URL and a
// peer token and never calls api.puter.com.
//
// What it gives up: puterfs under "/", and TURN relays, since `peer/generate-turn` is
// authenticated and anonymous ICE is STUN-only. Export still works — it asks puter.js for
// an account at the moment it needs one, rather than the page needing one up front.

/**
 * Force the anonymous path even when a token is available.
 *
 * Not the only way in: with no token from anywhere the workspace goes anonymous by
 * itself. This is for testing that path while a token is sitting in the store, and it is
 * strict — if the relay endpoint refuses this origin, it fails rather than falling back
 * to the token it was told to ignore.
 */
export const isAnonMode =
	params.get("anon") === "1" ||
	(import.meta.env.DEV && (import.meta.env.VITE_DEV_ANON ?? "").trim() === "1");

/**
 * Where a wisp relay URL comes from.
 *
 * `wisp/relay-token/create` is authenticated, so an anonymous page cannot mint its
 * own; this endpoint does it on the page's behalf and returns the finished wisp v1
 * URL (`wss://host/<relay-token>/`) as plain text. It is origin-gated, so it only
 * answers pages served from an origin it knows.
 */
const WISP_ENDPOINT = (
	import.meta.env.VITE_WISP_URL_ENDPOINT ??
	"https://sensible-ship-8305.puter.work/"
).trim();

/** A relay URL configured outright, which skips the endpoint entirely. */
const WISP_URL = (import.meta.env.VITE_WISP_URL ?? "").trim();

/** Fetch (or read) the relay URL, validated — a 200 with an error page in it is not one. */
export async function resolveWispUrl(): Promise<string> {
	if (WISP_URL) return WISP_URL;

	let res = await fetch(WISP_ENDPOINT);
	if (!res.ok) {
		throw new Error(`wisp relay endpoint failed: HTTP ${res.status} ${res.statusText}`);
	}
	let url = (await res.text()).trim();
	// The endpoint answers a refused origin with 200 and a sentence of prose, so the
	// scheme is the only thing that actually distinguishes a URL from a rejection.
	if (!/^wss?:\/\//.test(url)) {
		throw new Error(`wisp relay endpoint did not return a relay url: ${url}`);
	}
	return url;
}

export const STARTER_CODE = `import { readdirSync } from "node:fs";

console.log(readdirSync(".", "utf-8"));
`;

export function getPuter(): any {
	return (globalThis as any).puter;
}

export function defaultCwd(puter = getPuter()): string {
	void puter;
	return urlUsername ? `/${urlUsername}/` : "/";
}

export type RuntimeStore = {
	cwd: string;
	token: string;
	/**
	 * This page's peer identity in anonymous mode, sent to the signaller as `anonToken`.
	 *
	 * Persisted rather than generated per load so a peer keeps its identity across
	 * reloads. Empty until `anonNet` mints one; see `isAnonMode`.
	 */
	peerToken: string;
	code: string;
	/**
	 * Where the project comes from: "local" for a picked folder, anything else for a template.
	 *
	 * Separate from `template` rather than folded into it, so switching to a folder and back
	 * lands on the template that was left rather than on the default.
	 */
	source: string;
	/** Which baked template the workspace last used. */
	template: string;
	/**
	 * Resolve once every write made so far has landed.
	 *
	 * Assignment is fire-and-forget, which is right for everything that happens while the
	 * page stays up. It is wrong just before a reload: as a Puter app a write is a network
	 * round trip, and navigating cancels one in flight — so the template swap would persist
	 * nothing and the next load would come back to the template it started on.
	 */
	flush(): Promise<void>;
};

const PREFIX = "node-worker.";

/** The properties that persist; `flush` is behaviour, not state. */
type StoredKey = "cwd" | "token" | "peerToken" | "code" | "source" | "template";
const KEYS: StoredKey[] = ["cwd", "token", "peerToken", "code", "source", "template"];

function storageRead(key: string) {
	return globalThis.localStorage?.getItem?.(key) ?? undefined;
}

function storageWrite(key: string, value: string) {
	globalThis.localStorage?.setItem?.(key, value);
}

async function waitForPuterKV(timeoutMs = 5_000) {
	let puter = getPuter();
	if (puter?.kv) return puter;

	let deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 50));
		puter = getPuter();
		if (puter?.kv) return puter;
	}

	return puter;
}

/**
 * State that survives a reload, in puter.kv when running as a Puter app and
 * localStorage otherwise, written through on assignment.
 */
export async function createRuntimeStore(): Promise<RuntimeStore> {
	let inflight = new Set<Promise<void>>();

	let state: RuntimeStore = {
		cwd: devDefaults.cwd || defaultCwd(),
		token: urlToken || devDefaults.token,
		peerToken: "",
		code: STARTER_CODE,
		source: "",
		template: "",
		async flush() {
			// A loop rather than one `all`: a write queued while we were waiting still counts.
			while (inflight.size > 0) await Promise.all([...inflight]);
		},
	};

	let read = async (key: string) => {
		if (!isPuterApp) return storageRead(key);
		let puter = await waitForPuterKV();
		if (puter?.kv?.get) {
			let value = await puter.kv.get(key);
			return typeof value === "string" ? value : value == null ? undefined : String(value);
		}
		return storageRead(key);
	};

	let write = async (key: string, value: string) => {
		if (!isPuterApp) {
			storageWrite(key, value);
			return;
		}
		let puter = await waitForPuterKV();
		if (puter?.kv?.set) {
			await puter.kv.set(key, value);
			return;
		}
		storageWrite(key, value);
	};

	/** Write, and keep the promise around so `flush` can wait for it. */
	let queue = (key: string, value: string) => {
		// Swallowed here rather than left to reject: a storage that will not take a write is
		// not worth failing a swap over, and `flush` must not turn one into an exception.
		let pending = write(key, value).catch(() => undefined);
		inflight.add(pending);
		void pending.then(() => inflight.delete(pending));
	};

	for (let key of KEYS) {
		state[key] = (await read(PREFIX + key)) ?? state[key];
	}

	return new Proxy(state, {
		set(obj, prop, value) {
			if (!KEYS.includes(prop as StoredKey)) return false;
			obj[prop as StoredKey] = String(value);
			queue(PREFIX + String(prop), String(value));
			return true;
		},
	});
}

/**
 * Split a wisp v1 URL into the relay address and the relay token it carries.
 *
 * `generateWispV1URL()` builds that URL as `${server}/${token}/` from a
 * `wisp/relay-token/create` response, so the last path segment is the token and
 * everything before it is the server — and a relay whose address has a path prefix of
 * its own (`wss://host/wisp/<token>/`) survives the round trip.
 *
 * This lives here rather than in node-worker because it is a fact about what
 * `WISP_ENDPOINT` returns, not about wisp: node-worker dials `wispUrl` as given, and
 * splitting it there meant guessing that every URL had a token in its last segment.
 * The puter relays authenticate over the password extension, so undoing the
 * concatenation is what lets `relayToken` carry it.
 */
function splitWispV1Url(url: string): [server: string, token: string] {
	let parsed = new URL(url);
	let segments = parsed.pathname.split("/").filter((s) => s.length > 0);
	let token = segments.pop();
	if (!token) throw new Error(`wisp url carries no relay token: ${url}`);
	parsed.pathname = segments.length ? `/${segments.join("/")}` : "";
	// `origin` would drop a `wss:` scheme's port on some engines, and `href` would
	// re-add the trailing slash the pathname assignment just cleared.
	return [parsed.toString().replace(/\/$/, ""), token];
}

/**
 * The network for an anonymous run: a relay, and a peer token that outlives the tab.
 *
 * Awaits `flush` because the peer token is only useful if it survives the reload —
 * assignment is fire-and-forget, and the worker starting is not a reason for the write
 * to have landed.
 */
export async function anonNet(store: RuntimeStore): Promise<{
	wispUrl: string;
	relayToken: string;
	peerToken: string;
}> {
	let peerToken = store.peerToken.trim();
	if (!peerToken) {
		peerToken = crypto.randomUUID();
		store.peerToken = peerToken;
		await store.flush();
	}

	let [wispUrl, relayToken] = splitWispV1Url(await resolveWispUrl());
	return { wispUrl, relayToken, peerToken };
}

/** Where Export writes, and the default cwd for Drive mode. */
export function driveHome(): string {
	return urlUsername ? `/${urlUsername}` : "/";
}
