/**
 * End-to-end check against a running local dev server.
 *
 *   npm run dev            # in another terminal
 *   npm run e2e            # optionally E2E_BIG=1 for the multi-part case
 *
 * This plays both ends of the protocol: a browser that has no account and a Mac
 * that authenticates with a P-256 key. It covers the acceptance items from
 * PRD 18 that can be checked without a real Mac or a real phone.
 */
import { readFileSync } from "node:fs";
import {
	CHUNK_SIZE,
	chunkCountFor,
	cipherSizeFor,
	decryptChunk,
	decryptName,
	deriveKek,
	encryptChunk,
	encryptName,
	fileIdBytes,
	fromBase64Url,
	importContentKey,
	newContentKey,
	sealContentKey,
	toBase64Url,
	toHex,
} from "../src/shared/envelope.ts";

const BASE = process.env.E2E_BASE ?? "http://localhost:5173";
const PART_SIZE = 64 * 1024 * 1024;

/** Names are globally unique and one per device, so each run takes its own. */
const NAME = `e2e-${Math.random().toString(36).slice(2, 10)}`;

/**
 * An inbox lives on its own subdomain, so the send side is addressed by host
 * rather than by path. The Mac's own calls stay on the apex, which is also the
 * point: the API is host-agnostic everywhere except `resolve`.
 */
const { protocol: SCHEME, host: HOST } = new URL(BASE);
const on = (name: string, path = "") => `${SCHEME}//${name}.${HOST}${path}`;

let passed = 0;
const failures: string[] = [];

function check(name: string, condition: unknown, detail = ""): void {
	if (condition) {
		passed += 1;
		console.log(`  ok   ${name}`);
	} else {
		failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
		console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
	}
}

function section(title: string): void {
	console.log(`\n${title}`);
}

async function api(
	path: string,
	options: RequestInit & { token?: string } = {},
): Promise<{ status: number; body: any }> {
	const headers = new Headers(options.headers);
	if (options.token) headers.set("authorization", `Bearer ${options.token}`);
	if (options.body && typeof options.body === "string") {
		headers.set("content-type", "application/json");
	}
	const response = await fetch(path.startsWith("http") ? path : `${BASE}${path}`, {
		...options,
		headers,
	});
	const text = await response.text();
	let body: unknown;
	try {
		body = text ? JSON.parse(text) : null;
	} catch {
		body = text;
	}
	return { status: response.status, body };
}

// ---------------------------------------------------------------------------
// A stand-in for the Mac's Secure Enclave identity.
// ---------------------------------------------------------------------------

async function makeDevice() {
	const sig = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
		"sign",
		"verify",
	]);
	const kex = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
		"deriveBits",
	]);
	return {
		sig,
		kex,
		pubkey_sig: toBase64Url(new Uint8Array(await crypto.subtle.exportKey("raw", sig.publicKey))),
		pubkey_kex: toBase64Url(new Uint8Array(await crypto.subtle.exportKey("raw", kex.publicKey))),
	};
}

/** The Mac side of the envelope: ECDH, HKDF, unwrap. */
async function unwrapContentKey(
	kexPrivate: CryptoKey,
	ephPub: string,
	keyIv: string,
	wrapped: string,
): Promise<CryptoKey> {
	const ephemeral = await crypto.subtle.importKey(
		"raw",
		fromBase64Url(ephPub),
		{ name: "ECDH", namedCurve: "P-256" },
		false,
		[],
	);
	const shared = await crypto.subtle.deriveBits(
		{ name: "ECDH", public: ephemeral },
		kexPrivate,
		256,
	);
	const kek = await deriveKek(new Uint8Array(shared));
	const raw = await crypto.subtle.decrypt(
		{ name: "AES-GCM", iv: fromBase64Url(keyIv) },
		kek,
		fromBase64Url(wrapped),
	);
	return importContentKey(new Uint8Array(raw));
}

/** The browser side: encrypt the whole file into one ciphertext buffer. */
async function encryptFile(
	contentKey: CryptoKey,
	noncePrefix: Uint8Array,
	fileId: string,
	plaintext: Uint8Array,
): Promise<Uint8Array> {
	const total = chunkCountFor(plaintext.length);
	const out = new Uint8Array(cipherSizeFor(plaintext.length));
	let offset = 0;
	for (let index = 0; index < total; index++) {
		const ct = await encryptChunk(contentKey, {
			noncePrefix,
			fileIdBytes: fileIdBytes(fileId),
			index,
			total,
			plaintext: plaintext.subarray(index * CHUNK_SIZE, (index + 1) * CHUNK_SIZE),
		});
		out.set(ct, offset);
		offset += ct.length;
	}
	return out;
}

async function sendFile(
	inboxId: string,
	kexPub: string,
	name: string,
	plaintext: Uint8Array,
	options: { password?: string; uploadTwice?: number } = {},
) {
	const contentKey = await newContentKey();
	const envelope = await sealContentKey(kexPub, contentKey);
	const encName = await encryptName(contentKey, name);

	const init = await api("/api/v1/transfers", {
		method: "POST",
		body: JSON.stringify({
			inbox_id: inboxId,
			password: options.password,
			files: [
				{
					enc_name: encName.enc_name,
					name_iv: encName.name_iv,
					size: plaintext.length,
					nonce_prefix: envelope.nonce_prefix,
					wrapped_key: envelope.wrapped_key,
					key_iv: envelope.key_iv,
					eph_pub: envelope.eph_pub,
				},
			],
		}),
	});
	if (init.status !== 201) return { init, contentKey };

	const fileId = init.body.files[0].file_id as string;
	const token = init.body.token as string;
	const ciphertext = await encryptFile(
		contentKey,
		fromBase64Url(envelope.nonce_prefix),
		fileId,
		plaintext,
	);

	const partCount = Math.max(1, Math.ceil(ciphertext.length / PART_SIZE));
	let skippedSecond = false;
	for (let part = 1; part <= partCount; part++) {
		const slice = ciphertext.subarray((part - 1) * PART_SIZE, part * PART_SIZE);
		const put = () =>
			api(`/api/v1/transfers/${init.body.transfer_id}/files/${fileId}/parts/${part}`, {
				method: "PUT",
				token,
				body: slice,
				headers: { "content-type": "application/octet-stream" },
			});
		const first = await put();
		if (first.status !== 200) return { init, upload: first, contentKey };
		if (options.uploadTwice === part) {
			const again = await put();
			skippedSecond = again.body?.skipped === true;
		}
	}

	const digest = toHex(await crypto.subtle.digest("SHA-256", plaintext));
	const complete = await api(
		`/api/v1/transfers/${init.body.transfer_id}/files/${fileId}/complete`,
		{ method: "POST", token, body: JSON.stringify({ plain_sha256: digest }) },
	);

	return {
		init,
		complete,
		contentKey,
		fileId,
		token,
		transferId: init.body.transfer_id as string,
		digest,
		skippedSecond,
	};
}

/** Reads the local R2 bucket directly, to prove objects really are deleted. */
async function r2ObjectExists(key: string): Promise<boolean> {
	const response = await fetch(
		`${BASE}/cdn-cgi/local/explorer/api/r2/buckets/stolnk-relay/objects?prefix=${encodeURIComponent(key)}`,
	);
	if (!response.ok) return false;
	const body: any = await response.json();
	const list = body?.objects ?? body?.result?.objects ?? body?.result ?? body;
	if (!Array.isArray(list)) return false;
	return list.some((entry: any) => (entry?.key ?? entry?.name) === key);
}

// ---------------------------------------------------------------------------

console.log(`Stolnk e2e against ${BASE}`);

section("Device onboarding (PRD 7.1 — one input: the name)");
const device = await makeDevice();
const register = (name: string, keys = device, slug = "inbox") =>
	api("/api/v1/devices", {
		method: "POST",
		body: JSON.stringify({
			name,
			slug,
			pubkey_sig: keys.pubkey_sig,
			pubkey_kex: keys.pubkey_kex,
		}),
	});

const registered = await register(NAME);
check("register returns 201", registered.status === 201, JSON.stringify(registered.body));
const deviceId = registered.body.device_id as string;
let token = registered.body.token as string;
check("first inbox created", !!registered.body.inbox?.inbox_id);
check("register returns the name", registered.body.name === NAME);
// The Mac sends no display name at registration: the first inbox is the device's
// own, so "Send files to ryan" is the honest default rather than "…to Inbox".
check(
	"the first inbox is named after the device name",
	registered.body.inbox?.display_name === NAME,
	String(registered.body.inbox?.display_name),
);
check(
	"the first inbox url is the name plus the path that was asked for",
	registered.body.inbox?.url === on(NAME, "/inbox"),
	String(registered.body.inbox?.url),
);

section("A name belongs to exactly one device (PRD 6.1)");
const rival = await makeDevice();
const stolen = await register(NAME, rival);
check("a taken name cannot be registered again", stolen.status === 409, JSON.stringify(stolen.body));
const stillTaken = await api(`/api/v1/names/${NAME}/available`);
check(
	"the failed registration created nothing",
	stillTaken.status === 200 && stillTaken.body.available === false,
	JSON.stringify(stillTaken.body),
);

for (const bad of ["-ryan", "ryan-", "xn--abc", "ab", "a".repeat(21), "ryan_smith"]) {
	const attempt = await register(bad, rival);
	check(`illegal name rejected: ${bad}`, attempt.status === 400, String(attempt.status));
}
for (const reserved of ["www", "api", "localhost"]) {
	const attempt = await register(reserved, rival);
	check(`reserved name rejected: ${reserved}`, attempt.status === 400, String(attempt.status));
}
const reservedAvailability = await api("/api/v1/names/www/available");
check(
	"availability answers reserved names instead of erroring",
	reservedAvailability.status === 200 &&
		reservedAvailability.body.available === false &&
		reservedAvailability.body.reason === "reserved",
	JSON.stringify(reservedAvailability.body),
);

section("Challenge-response auth (PRD 9.1)");
const challenge = await api(`/api/v1/devices/${deviceId}/challenge`);
check("challenge issued", challenge.status === 200 && !!challenge.body.nonce);
const signature = await crypto.subtle.sign(
	{ name: "ECDSA", hash: "SHA-256" },
	device.sig.privateKey,
	new TextEncoder().encode(challenge.body.nonce),
);
const authed = await api(`/api/v1/devices/${deviceId}/auth`, {
	method: "POST",
	body: JSON.stringify({
		nonce: challenge.body.nonce,
		signature: toBase64Url(new Uint8Array(signature)),
	}),
});
check("valid signature authenticates", authed.status === 200 && !!authed.body.token);
token = authed.body.token;

const replay = await api(`/api/v1/devices/${deviceId}/auth`, {
	method: "POST",
	body: JSON.stringify({
		nonce: challenge.body.nonce,
		signature: toBase64Url(new Uint8Array(signature)),
	}),
});
check("nonce cannot be replayed", replay.status === 401);

const badChallenge = await api(`/api/v1/devices/${deviceId}/challenge`);
const forged = await api(`/api/v1/devices/${deviceId}/auth`, {
	method: "POST",
	body: JSON.stringify({
		nonce: badChallenge.body.nonce,
		signature: toBase64Url(new Uint8Array(64)),
	}),
});
check("bad signature rejected", forged.status === 401);

// A device the server has never heard of is a different thing from an expired
// session, and says so: 404 with its own code. The Mac keys off that code to
// drop back into first-run instead of retrying an authentication that can never
// succeed — which is exactly what a reset dev database produces.
const ghost = await api("/api/v1/devices/definitely-not-a-device/challenge");
check(
	"an unknown device is 404 unknown_device, not 401",
	ghost.status === 404 && ghost.body?.error === "unknown_device",
	JSON.stringify(ghost.body),
);

section("Inbox model and routing (PRD 6)");
const second = await api("/api/v1/inboxes", {
	method: "POST",
	token,
	body: JSON.stringify({ slug: "client-a", display_name: "Client A" }),
});
check("second inbox created", second.status === 201, JSON.stringify(second.body));
check(
	"sub-inbox url is name + path",
	second.body.url === on(NAME, "/client-a"),
	String(second.body.url),
);

const resolved = await api(on(NAME, "/api/v1/resolve?slug=client-a"));
check("resolve returns inbox metadata", resolved.status === 200 && !!resolved.body.kex_pub);
check("resolve reports the address it was reached at", resolved.body.url === on(NAME, "/client-a"));
check("part size is 64 MiB (PRD 8.6 #2)", resolved.body.part_size === PART_SIZE);
check("Mac reported offline while no socket is open", resolved.body.online === false);
const inboxId = resolved.body.inbox_id as string;
const kexPub = resolved.body.kex_pub as string;

const missing = await api(on("nobody-here", "/api/v1/resolve"));
check("unknown name 404s", missing.status === 404);
const apexResolve = await api("/api/v1/resolve");
check("the apex is not an inbox", apexResolve.status === 404);
const nested = await api(`${SCHEME}//a.b.${HOST}/api/v1/resolve`);
check("a nested subdomain 404s (no certificate could cover it)", nested.status === 404);
const wrongSlug = await api(on(NAME, "/api/v1/resolve?slug=NOT/a/valid/slug"));
check("a malformed slug is a miss, not a 400", wrongSlug.status === 404);

section("Offline send and delivery (PRD 8.3, 11.2 — the core difference)");
const payload = new TextEncoder().encode("客户素材 ✅ ".repeat(500));
const sent = await sendFile(inboxId, kexPub, "客户素材 final ✅.mov", payload, { uploadTwice: 1 });
check("upload accepted while the Mac is asleep", sent.init.status === 201);
check("re-uploading a part is a no-op (resume)", sent.skippedSecond === true);
check("complete succeeded", sent.complete?.status === 200, JSON.stringify(sent.complete?.body));

const pending = await api("/api/v1/pending", { token });
check("file is waiting for the Mac", pending.status === 200 && pending.body.files.length === 1);
const waiting = pending.body.files[0];
check("first transfer of a session needs confirmation (PRD 13.2)", waiting.needs_confirmation === true);

const macKey = await unwrapContentKey(
	device.kex.privateKey,
	waiting.eph_pub,
	waiting.key_iv,
	waiting.wrapped_key,
);
const recoveredName = await decryptName(macKey, waiting.enc_name, waiting.name_iv);
check("filename decrypts on the Mac", recoveredName === "客户素材 final ✅.mov", recoveredName);

const content = await fetch(`${BASE}/api/v1/files/${waiting.file_id}/content`, {
	headers: { authorization: `Bearer ${token}` },
});
const ciphertext = new Uint8Array(await content.arrayBuffer());
check("ciphertext length matches the framing", ciphertext.length === cipherSizeFor(payload.length));

const total = chunkCountFor(payload.length);
const plainParts: Uint8Array[] = [];
let cursor = 0;
for (let index = 0; index < total; index++) {
	const length = Math.min(CHUNK_SIZE, payload.length - index * CHUNK_SIZE) + 16;
	plainParts.push(
		await decryptChunk(macKey, {
			noncePrefix: fromBase64Url(waiting.nonce_prefix),
			fileIdBytes: fileIdBytes(waiting.file_id),
			index,
			total,
			ciphertext: ciphertext.subarray(cursor, cursor + length),
		}),
	);
	cursor += length;
}
const reassembled = new Uint8Array(payload.length);
let writeAt = 0;
for (const part of plainParts) {
	reassembled.set(part, writeAt);
	writeAt += part.length;
}
const roundTripDigest = toHex(await crypto.subtle.digest("SHA-256", reassembled));
check("round trip is byte-identical", roundTripDigest === waiting.plain_sha256);

section("Range requests (interrupted pull resumes)");
const ranged = await fetch(`${BASE}/api/v1/files/${waiting.file_id}/content`, {
	headers: { authorization: `Bearer ${token}`, range: "bytes=10-19" },
});
const rangedBytes = new Uint8Array(await ranged.arrayBuffer());
check("206 with the right slice", ranged.status === 206 && rangedBytes.length === 10);
check(
	"range content matches",
	toHex(rangedBytes) === toHex(ciphertext.subarray(10, 20)),
);

section("ACK deletes the stored object (PRD 8.5, 18)");
const r2Key = `relay/${sent.transferId}/${waiting.file_id}`;
check("object exists before ACK", await r2ObjectExists(r2Key));
const acked = await api(`/api/v1/files/${waiting.file_id}/ack`, { method: "POST", token });
check("ack accepted", acked.status === 200);
check("object gone immediately after ACK", !(await r2ObjectExists(r2Key)));
const afterAck = await api("/api/v1/pending", { token });
check("nothing left pending", afterAck.body.files.length === 0);

section("Tamper detection (PRD 9.3 — no half files)");
const vectors = JSON.parse(
	readFileSync(new URL("../../testdata/vectors.json", import.meta.url), "utf8"),
);
const vectorKey = await unwrapContentKey(
	await crypto.subtle.importKey(
		"jwk",
		{
			kty: "EC",
			crv: "P-256",
			d: vectors.recipient.private_raw,
			x: toBase64Url(fromBase64Url(vectors.recipient.public_raw).subarray(1, 33)),
			y: toBase64Url(fromBase64Url(vectors.recipient.public_raw).subarray(33, 65)),
			ext: true,
		},
		{ name: "ECDH", namedCurve: "P-256" },
		false,
		["deriveBits"],
	),
	vectors.envelope.eph_pub,
	vectors.envelope.key_iv,
	vectors.envelope.wrapped_key,
);
const vectorKeyRaw = toBase64Url(new Uint8Array(await crypto.subtle.exportKey("raw", vectorKey)));
check(
	"vectors unwrap to the expected content key",
	vectorKeyRaw === vectors.envelope.expected_content_key,
);

let tamperRejected = false;
try {
	await decryptChunk(vectorKey, {
		noncePrefix: fromBase64Url(vectors.envelope.nonce_prefix),
		fileIdBytes: fileIdBytes(vectors.tampered.file_id),
		index: 0,
		total: 1,
		ciphertext: fromBase64Url(vectors.tampered.ciphertext),
	});
} catch {
	tamperRejected = true;
}
check("a flipped bit fails the GCM tag", tamperRejected);

let reorderRejected = false;
try {
	const first = vectors.vectors.find((v: any) => v.label === "multi-chunk");
	const ct = fromBase64Url(first.ciphertext);
	// Feed chunk 0 while claiming it is chunk 1: the AAD must refuse it.
	await decryptChunk(vectorKey, {
		noncePrefix: fromBase64Url(vectors.envelope.nonce_prefix),
		fileIdBytes: fileIdBytes(first.file_id),
		index: 1,
		total: first.chunk_count,
		ciphertext: ct.subarray(0, CHUNK_SIZE + 16),
	});
} catch {
	reorderRejected = true;
}
check("a reordered chunk is rejected", reorderRejected);

section("Password protection (PRD 18 — never in the clear)");
const saltResponse = await api(`/api/v1/inboxes/${inboxId}/password-salt`, {
	method: "POST",
	token,
});
const salt = saltResponse.body.salt as string;
async function deriveVerifier(password: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(password),
		"PBKDF2",
		false,
		["deriveBits"],
	);
	const bits = await crypto.subtle.deriveBits(
		{ name: "PBKDF2", hash: "SHA-256", salt: fromBase64Url(salt), iterations: 210_000 },
		key,
		256,
	);
	return toHex(new Uint8Array(bits));
}
const verifier = await deriveVerifier("hunter2");
const setPassword = await api(`/api/v1/inboxes/${inboxId}`, {
	method: "PATCH",
	token,
	body: JSON.stringify({ password: verifier, password_salt: salt }),
});
check("password set", setPassword.status === 200 && setPassword.body.has_password === true);

const gated = await api(on(NAME, "/api/v1/resolve?slug=client-a"));
check("send page is told a password is needed", gated.body.password?.required === true);
const wrong = await sendFile(inboxId, kexPub, "x.txt", new Uint8Array([1]), {
	password: await deriveVerifier("wrong"),
});
check("wrong password rejected", wrong.init.status === 401);
const right = await sendFile(inboxId, kexPub, "x.txt", new Uint8Array([1]), {
	password: verifier,
});
check("correct password accepted", right.init.status === 201);
await api(`/api/v1/transfers/${right.transferId}/abort`, { method: "POST", token: right.token });
await api(`/api/v1/inboxes/${inboxId}`, {
	method: "PATCH",
	token,
	body: JSON.stringify({ password: null }),
});

section("Pause and limits (PRD 13.4, 8.6 #3)");
await api(`/api/v1/inboxes/${inboxId}`, {
	method: "PATCH",
	token,
	body: JSON.stringify({ paused: true }),
});
const whilePaused = await sendFile(inboxId, kexPub, "y.txt", new Uint8Array([1]));
check("paused inbox refuses files", whilePaused.init.status === 423);
await api(`/api/v1/inboxes/${inboxId}`, {
	method: "PATCH",
	token,
	body: JSON.stringify({ paused: false }),
});

const oversize = await api("/api/v1/transfers", {
	method: "POST",
	body: JSON.stringify({
		inbox_id: inboxId,
		files: [
			{
				enc_name: "x",
				name_iv: "x",
				size: 21 * 1024 ** 3,
				nonce_prefix: "x",
				wrapped_key: "x",
				key_iv: "x",
				eph_pub: "x",
			},
		],
	}),
});
check("oversized file refused, not billed", oversize.status === 400 || oversize.status === 413);

section("Reset revokes the URL (PRD 6.3, 18)");
const beforeReset = await api(on(NAME, "/api/v1/resolve?slug=client-a"));
check("URL works before reset", beforeReset.status === 200);
const reset = await api(`/api/v1/inboxes/${inboxId}/reset`, { method: "POST", token });
check("reset issued a new path", reset.status === 200 && reset.body.slug !== "client-a");
const resetSlug = String(reset.body.slug);
check(
	"the reset path is a legal slug",
	/^[a-z0-9-]{1,32}$/.test(resetSlug),
	resetSlug,
);
check("the name survives a reset", reset.body.url === on(NAME, `/${resetSlug}`), String(reset.body.url));
const atResetSlug = await api(on(NAME, `/api/v1/resolve?slug=${resetSlug}`));
check("the new URL resolves", atResetSlug.status === 200);
const afterReset = await api(on(NAME, "/api/v1/resolve?slug=client-a"));
check("old URL 404s immediately", afterReset.status === 404);

section("Presence (PRD 11.1 vs 11.2)");
const socket = new WebSocket(`${BASE.replace("http", "ws")}/api/v1/ws/device?token=${token}`);
await new Promise<void>((resolve, reject) => {
	socket.addEventListener("open", () => resolve());
	socket.addEventListener("error", () => reject(new Error("socket failed")));
	setTimeout(() => reject(new Error("socket timeout")), 5000);
}).catch((error) => check("device socket connects", false, String(error)));
if (socket.readyState === WebSocket.OPEN) {
	check("device socket connects", true);
	await new Promise((r) => setTimeout(r, 300));
	const online = await api(on(NAME, "/api/v1/resolve?slug=inbox"));
	check("Mac now reports online", online.body.online === true);
	socket.close();
	await new Promise((r) => setTimeout(r, 300));
	const offline = await api(on(NAME, "/api/v1/resolve?slug=inbox"));
	check("Mac reports offline again after disconnect", offline.body.online === false);
}

if (process.env.E2E_BIG === "1") {
	section("Multi-part upload (65 MiB, exercises 64 MiB part boundaries)");
	const big = new Uint8Array(65 * 1024 * 1024);
	crypto.getRandomValues(big.subarray(0, 65536));
	for (let i = 65536; i < big.length; i += 65536) big.copyWithin(i, 0, 65536);
	const root = await api(on(NAME, "/api/v1/resolve?slug=inbox"));
	const bigSend = await sendFile(root.body.inbox_id, kexPub, "shoot.mov", big);
	check("multi-part upload completed", bigSend.complete?.status === 200);
	const bigPending = await api("/api/v1/pending", { token });
	const bigFile = bigPending.body.files.find((f: any) => f.file_id === bigSend.fileId);
	check("multi-part file is pending", !!bigFile);
	if (bigFile) {
		check(
			"cipher size accounts for every chunk tag",
			bigFile.cipher_size === cipherSizeFor(big.length),
		);
		await api(`/api/v1/files/${bigFile.file_id}/ack`, { method: "POST", token });
	}
}

section("Path is editable (PRD 6.2 — a link is name + path)");
// Reset picks a random path; this is the owner choosing one. Same uniqueness
// rule as creating an inbox, minus the row's own current path.
const moved = await api(`/api/v1/inboxes/${inboxId}`, {
	method: "PATCH",
	token,
	body: JSON.stringify({ slug: "client-b" }),
});
check(
	"path can be changed to a chosen value",
	moved.status === 200 && moved.body.slug === "client-b",
	JSON.stringify(moved.body),
);
const atNewPath = await api(on(NAME, "/api/v1/resolve?slug=client-b"));
check("new path resolves", atNewPath.status === 200);

// What senders see is editable after the fact — the Mac's Links pane relies on
// this, and it is the only reason the New Inbox sheet can stop asking for it.
const renamedDisplay = await api(`/api/v1/inboxes/${inboxId}`, {
	method: "PATCH",
	token,
	body: JSON.stringify({ display_name: "Client A, renamed" }),
});
check("display name can be changed", renamedDisplay.status === 200);
const seenBySender = await api(on(NAME, "/api/v1/resolve?slug=client-b"));
check(
	"the send page sees the new display name",
	seenBySender.body.display_name === "Client A, renamed",
	String(seenBySender.body.display_name),
);
const atResetPath = await api(on(NAME, `/api/v1/resolve?slug=${resetSlug}`));
check("the path it moved off 404s", atResetPath.status === 404);

const taken = await api("/api/v1/inboxes", {
	method: "POST",
	token,
	body: JSON.stringify({ slug: "occupied", display_name: "Occupied" }),
});
const occupiedId = taken.body.inbox_id as string;
const collision = await api(`/api/v1/inboxes/${occupiedId}`, {
	method: "PATCH",
	token,
	body: JSON.stringify({ slug: "client-b" }),
});
check("moving onto a path in use is refused", collision.status === 400);

const emptySlug = await api(`/api/v1/inboxes/${occupiedId}`, {
	method: "PATCH",
	token,
	body: JSON.stringify({ slug: "" }),
});
check("an inbox cannot be moved to an empty path", emptySlug.status === 400);
await api(`/api/v1/inboxes/${occupiedId}`, { method: "DELETE", token });

section("Every link carries a path (PRD 6.2)");
// There is no bare-subdomain address, so none of the three ways to get an inbox
// will accept an empty path, and the bare host resolves to nothing.
const bare = await api(on(NAME, "/api/v1/resolve"));
check("the bare subdomain is not an address", bare.status === 404);

const noSlugCreate = await api("/api/v1/inboxes", {
	method: "POST",
	token,
	body: JSON.stringify({ display_name: "Pathless" }),
});
check("an inbox cannot be created without a path", noSlugCreate.status === 400);

const blankSlugCreate = await api("/api/v1/inboxes", {
	method: "POST",
	token,
	body: JSON.stringify({ slug: "   ", display_name: "Pathless" }),
});
check("whitespace is not a path either", blankSlugCreate.status === 400);

const noSlugRegister = await api("/api/v1/devices", {
	method: "POST",
	body: JSON.stringify({
		name: `e2e-${Math.random().toString(36).slice(2, 10)}`,
		pubkey_sig: device.pubkey_sig,
		pubkey_kex: device.pubkey_kex,
	}),
});
check("registration without a path is refused", noSlugRegister.status === 400);

section("Deleting a link frees its path (PRD 6.2)");
const firstBefore = await api(on(NAME, "/api/v1/resolve?slug=inbox"));
check("the first inbox resolves before deletion", firstBefore.status === 200);
const firstInboxId = firstBefore.body.inbox_id as string;

const deletedFirst = await api(`/api/v1/inboxes/${firstInboxId}`, { method: "DELETE", token });
check(
	"the inbox registration created can be deleted like any other",
	deletedFirst.status === 200 && deletedFirst.body.deleted === true,
	JSON.stringify(deletedFirst.body),
);
const firstAfter = await api(on(NAME, "/api/v1/resolve?slug=inbox"));
check("its URL 404s immediately", firstAfter.status === 404);

const reclaimed = await api("/api/v1/inboxes", {
	method: "POST",
	token,
	body: JSON.stringify({ slug: "inbox", display_name: "Inbox again" }),
});
check(
	"the freed path can be taken again",
	reclaimed.status === 201 && reclaimed.body.slug === "inbox",
	JSON.stringify(reclaimed.body),
);

const duplicate = await api("/api/v1/inboxes", {
	method: "POST",
	token,
	body: JSON.stringify({ slug: "inbox", display_name: "Inbox twice" }),
});
check("a second inbox on the same path is refused", duplicate.status === 400);

const remaining = await api("/api/v1/inboxes", { token });
for (const inbox of remaining.body.inboxes) {
	await api(`/api/v1/inboxes/${inbox.inbox_id}`, { method: "DELETE", token });
}
const emptied = await api("/api/v1/devices/me", { token });
check(
	"a device can be left with no inboxes at all",
	emptied.status === 200 && emptied.body.inboxes.length === 0,
	JSON.stringify(emptied.body),
);

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
	for (const failure of failures) console.log(`  - ${failure}`);
	process.exit(1);
}
