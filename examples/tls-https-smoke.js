// TLS + HTTPS smoke test for node-worker.
//
// HOW TO RUN: paste this whole file into the Monaco editor in the testbed and
// click "Run eval module". Output streams to the console pane; the final line
// reports pass/fail counts (and the run throws if anything failed).
//
// What it exercises:
//   • node:tls  — tls.connect(), the TLSSocket metadata surface
//     (getProtocol / getCipher / alpnProtocol / authorized / servername /
//      getPeerCertificate / getPeerX509Certificate), checkServerIdentity, and a
//      manual HTTP/1.1 GET over the encrypted socket.
//   • node:https — https.get() over the epoxy TLS transport, against an HTML
//     endpoint and a JSON API, verifying status/headers/body and that the
//     response socket is the encrypted TLSSocket.
//
// Tweak these if a host is unreachable from your network:
const TLS_HOST = "example.com";
const HTTPS_HTML = "https://example.com/";
const HTTPS_JSON = "https://jsonplaceholder.typicode.com/todos/1";
const NET_TIMEOUT_MS = 20_000;

import tls from "node:tls";
import https from "node:https";
import { Buffer } from "node:buffer";

let passed = 0;
let failed = 0;

function ok(name, cond, detail) {
	let line = `  ${cond ? "✓" : "✗"} ${name}${detail !== undefined ? `  (${detail})` : ""}`;
	if (cond) {
		passed++;
		console.log(line);
	} else {
		failed++;
		console.error(line);
	}
	return cond;
}

function section(title) {
	console.log("");
	console.log(`▶ ${title}`);
}

function withTimeout(promise, ms, label) {
	let timer;
	let timeout = new Promise((_, reject) => {
		timer = setTimeout(() => reject(new Error(`${label}: timed out after ${ms}ms`)), ms);
	});
	return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Open a TLS connection, capture the negotiated metadata, then speak a raw
// HTTP/1.1 GET over it and collect the full response text.
function rawTlsGet(host, path) {
	return new Promise((resolve, reject) => {
		let meta;
		let socket = tls.connect(
			{ host, port: 443, servername: host, ALPNProtocols: ["http/1.1"] },
			() => {
				meta = {
					protocol: socket.getProtocol(),
					alpn: socket.alpnProtocol,
					cipher: socket.getCipher(),
					authorized: socket.authorized,
					servername: socket.servername,
					cert: socket.getPeerCertificate(),
					x509: socket.getPeerX509Certificate(),
				};
				socket.write(
					`GET ${path} HTTP/1.1\r\n` +
						`Host: ${host}\r\n` +
						`Connection: close\r\n` +
						`User-Agent: node-worker-smoke\r\n` +
						`Accept: */*\r\n\r\n`
				);
			}
		);
		let chunks = [];
		socket.on("data", (d) => chunks.push(d));
		socket.on("end", () =>
			resolve({ meta, body: Buffer.concat(chunks).toString("utf8") })
		);
		socket.on("error", reject);
	});
}

function httpsGet(url) {
	return new Promise((resolve, reject) => {
		let req = https.get(url, (res) => {
			// Capture socket state now, while the response is live — with
			// `Connection: close` the http client detaches res.socket by 'end'.
			let socket = res.socket;
			let socketInfo = {
				encrypted: !!socket && socket.encrypted === true,
				protocol: socket && socket.getProtocol ? socket.getProtocol() : null,
			};
			let chunks = [];
			res.on("data", (d) => chunks.push(d));
			res.on("end", () =>
				resolve({
					statusCode: res.statusCode,
					headers: res.headers,
					body: Buffer.concat(chunks).toString("utf8"),
					socketInfo,
				})
			);
			res.on("error", reject);
		});
		req.on("error", reject);
	});
}

// ---------------------------------------------------------------------------
section("node:tls module surface (synchronous)");
ok("connect is a function", typeof tls.connect === "function");
ok("TLSSocket is a class", typeof tls.TLSSocket === "function");
ok("checkServerIdentity is a function", typeof tls.checkServerIdentity === "function");
let ciphers = tls.getCiphers();
ok(
	"getCiphers() returns a non-empty list",
	Array.isArray(ciphers) && ciphers.length > 0,
	ciphers.slice(0, 3).join(", ") + ", ..."
);
let serverThrew = false;
try {
	tls.createServer();
} catch {
	serverThrew = true;
}
ok("createServer() throws (no TCP server transport)", serverThrew);

// ---------------------------------------------------------------------------
section(`tls.connect → ${TLS_HOST}:443 (manual HTTP/1.1 GET)`);
try {
	let { meta, body } = await withTimeout(rawTlsGet(TLS_HOST, "/"), NET_TIMEOUT_MS, "tls.connect");

	ok("handshake completed (secureConnect fired)", !!meta);
	ok("getProtocol() is TLS 1.2/1.3", /^TLSv1\.[23]$/.test(meta.protocol || ""), meta.protocol);
	ok("ALPN negotiated http/1.1", meta.alpn === "http/1.1", String(meta.alpn));
	ok(
		"getCipher() populated",
		!!meta.cipher.name && !!meta.cipher.standardName && !!meta.cipher.version,
		`${meta.cipher.name} / ${meta.cipher.standardName} / ${meta.cipher.version}`
	);
	ok("authorized against bundled roots", meta.authorized === true);
	ok("servername (SNI) set to host", meta.servername === TLS_HOST, meta.servername);

	ok(
		"peer cert has a subject",
		meta.cert.subject && Object.keys(meta.cert.subject).length > 0,
		JSON.stringify(meta.cert.subject)
	);
	ok(
		"peer cert SAN covers host",
		(meta.cert.subjectaltname || "").toLowerCase().includes(TLS_HOST),
		meta.cert.subjectaltname
	);
	ok(
		"peer cert issuer present",
		!!(meta.cert.issuer && (meta.cert.issuer.O || meta.cert.issuer.CN)),
		meta.cert.issuer && (meta.cert.issuer.O || meta.cert.issuer.CN)
	);
	ok(
		"peer cert validity window",
		!!meta.cert.valid_from && !!meta.cert.valid_to,
		`${meta.cert.valid_from} → ${meta.cert.valid_to}`
	);
	ok(
		"peer cert sha-256 fingerprint",
		/^[0-9A-F:]+$/.test(meta.cert.fingerprint256 || ""),
		meta.cert.fingerprint256
	);
	ok(
		"peer cert raw is a Buffer",
		Buffer.isBuffer(meta.cert.raw),
		`${meta.cert.raw ? meta.cert.raw.length : 0} bytes`
	);
	ok(
		"getPeerX509Certificate() returns an X509Certificate",
		!!meta.x509 && typeof meta.x509.subject === "string"
	);
	ok(
		"checkServerIdentity() accepts the cert",
		tls.checkServerIdentity(TLS_HOST, meta.cert) === undefined
	);

	let statusLine = body.split("\r\n")[0];
	ok("HTTP/1.1 200 over the TLS socket", body.startsWith("HTTP/1.1 200"), statusLine);
	ok("response body is example.com", body.includes("Example Domain"));
} catch (err) {
	ok("tls.connect smoke", false, err && err.message ? err.message : String(err));
}

// ---------------------------------------------------------------------------
section(`https.get → ${HTTPS_HTML}`);
try {
	let res = await withTimeout(httpsGet(HTTPS_HTML), NET_TIMEOUT_MS, "https.get(html)");
	ok("status code 200", res.statusCode === 200, String(res.statusCode));
	ok("content-type header present", !!res.headers["content-type"], res.headers["content-type"]);
	ok("body is example.com", res.body.includes("Example Domain"));
	ok("response socket is an encrypted TLSSocket", res.socketInfo.encrypted);
	ok(
		"response socket getProtocol() is TLS 1.2/1.3",
		/^TLSv1\.[23]$/.test(res.socketInfo.protocol || ""),
		res.socketInfo.protocol
	);
} catch (err) {
	ok("https.get(html) smoke", false, err && err.message ? err.message : String(err));
}

// ---------------------------------------------------------------------------
section(`https.get → ${HTTPS_JSON}`);
try {
	let res = await withTimeout(httpsGet(HTTPS_JSON), NET_TIMEOUT_MS, "https.get(json)");
	ok("status code 200", res.statusCode === 200, String(res.statusCode));
	let json;
	try {
		json = JSON.parse(res.body);
	} catch {
		/* leaves json undefined */
	}
	ok("body parses as JSON", !!json);
	ok("JSON payload has id === 1", json && json.id === 1, JSON.stringify(json));
} catch (err) {
	ok("https.get(json) smoke", false, err && err.message ? err.message : String(err));
}

// ---------------------------------------------------------------------------
console.log("");
console.log(
	`──── ${failed === 0 ? "ALL PASS" : "FAILURES"}: ${passed} passed, ${failed} failed ────`
);
if (failed > 0) {
	throw new Error(`${failed} smoke check(s) failed`);
}
