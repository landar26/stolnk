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
import { createServer } from "node:http";
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
// A stand-in for Creem (PRD 16.5).
//
// The licensing routes are worth testing against something, and the something
// cannot be Creem itself: a test suite that needs an account, a network and a
// live payment provider is a test suite nobody runs. This stub speaks the three
// calls the Worker makes and enforces the one rule that matters, the activation
// limit, so the whole path — key in the app, seat claimed, tier changed, walls
// gone — is exercised end to end locally.
//
// `.dev.vars` points CREEM_API_BASE here. With this not running, activation
// returns 503 and every device is Free, which is the other state worth being
// able to develop in.
// ---------------------------------------------------------------------------

const CREEM_PORT = 5199;

/** Keys the stub understands, chosen so each maps to one branch of the route. */
const GOOD_KEY = "STOLNK-TEST-GOOD-KEY";
const FULL_KEY = "STOLNK-TEST-FULL-KEY";
const BAD_KEY = "STOLNK-TEST-NO-SUCH-KEY";

const creemInstances = new Map<string, string>();
let creemActivations = 0;

const creem = createServer((request, response) => {
	let raw = "";
	request.on("data", (chunk) => (raw += chunk));
	request.on("end", () => {
		const body = raw ? (JSON.parse(raw) as { key?: string; instance_id?: string }) : {};
		const reply = (status: number, payload: unknown) => {
			response.writeHead(status, { "content-type": "application/json" });
			response.end(JSON.stringify(payload));
		};
		const license = (extra: Record<string, unknown> = {}) => ({
			id: "lic_test",
			status: "active",
			activation: creemActivations,
			activation_limit: 3,
			...extra,
		});

		if (request.url === "/v1/licenses/activate") {
			if (body.key === FULL_KEY) return reply(409, { error: "activation limit reached" });
			if (body.key !== GOOD_KEY) return reply(404, { error: "not found" });
			const instanceId = `inst_${creemActivations++}`;
			creemInstances.set(instanceId, body.key);
			return reply(200, license({ instance: { id: instanceId } }));
		}
		if (request.url === "/v1/licenses/deactivate") {
			if (!body.instance_id || !creemInstances.has(body.instance_id)) {
				return reply(404, { error: "no such instance" });
			}
			creemInstances.delete(body.instance_id);
			creemActivations -= 1;
			return reply(200, license());
		}
		reply(404, { error: "unhandled" });
	});
});
await new Promise<void>((resolve) => creem.listen(CREEM_PORT, "127.0.0.1", resolve));

/**
 * The webhook secret the running dev server is using. Read rather than fixed:
 * `npm run secrets:init` generates one, and a test that assumed a constant
 * would pass against the wrong server.
 */
function devWebhookSecret(): string {
	try {
		const line = readFileSync(new URL("../.dev.vars", import.meta.url), "utf8")
			.split("\n")
			.find((row) => row.startsWith("CREEM_WEBHOOK_SECRET="));
		return line ? line.slice(line.indexOf("=") + 1).trim().replace(/^"|"$/g, "") : "";
	} catch {
		return "";
	}
}

async function signWebhook(payload: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(devWebhookSecret()),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
	return [...new Uint8Array(mac)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
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

section("Free tier walls (PRD 16.1 — every one of these was unreachable in V1)");
const firstInbox = registered.body.inbox.inbox_id as string;

const freePlan = await api("/api/v1/licenses/status", { token });
check(
	"a new device is Free",
	freePlan.status === 200 && freePlan.body.tier === "free",
	JSON.stringify(freePlan.body),
);
check(
	"Free is told its relay allowance, and has spent none of it",
	freePlan.body.relay_limit === 3 * 1024 ** 3 && freePlan.body.relay_used === 0,
	JSON.stringify(freePlan.body),
);

const walledSecond = await api("/api/v1/inboxes", {
	method: "POST",
	token,
	body: JSON.stringify({ slug: "client-a", display_name: "Client A" }),
});
check(
	"Free is refused a second inbox (H2's signal, PRD 15.4)",
	walledSecond.status === 402 && walledSecond.body.error === "upgrade_required",
	JSON.stringify(walledSecond.body),
);

const walledPassword = await api(`/api/v1/inboxes/${firstInbox}`, {
	method: "PATCH",
	token,
	body: JSON.stringify({ password: "verifier", password_salt: "salt" }),
});
check(
	"Free is refused password protection",
	walledPassword.status === 402 && walledPassword.body.error === "upgrade_required",
	JSON.stringify(walledPassword.body),
);
const clearOnFree = await api(`/api/v1/inboxes/${firstInbox}`, {
	method: "PATCH",
	token,
	body: JSON.stringify({ password: null }),
});
check(
	"Free may still clear a password — downgrading must not lock anyone out",
	clearOnFree.status === 200,
	JSON.stringify(clearOnFree.body),
);

const freeResolve = await api(on(NAME, "/api/v1/resolve?slug=inbox"));
check(
	"Free's per-file ceiling is 2 GB, and the send page is told so",
	freeResolve.body.max_file_size === 2 * 1024 ** 3,
	String(freeResolve.body.max_file_size),
);

// An over-size file is over quota, not malformed. This distinction was dead
// code for the whole of V1 — with every device on Pro the two ceilings were
// always equal, so the 400 always fired first and the message a real Free user
// would see ("size is out of range") had never been looked at.
const tooBig = await api("/api/v1/transfers", {
	method: "POST",
	body: JSON.stringify({
		inbox_id: freeResolve.body.inbox_id,
		files: [
			{
				enc_name: "x",
				name_iv: "x",
				size: 5 * 1024 ** 3,
				nonce_prefix: "x",
				wrapped_key: "x",
				key_iv: "x",
				eph_pub: "x",
			},
		],
	}),
});
check(
	"a file over Free's ceiling is refused as quota, not as a bad request",
	tooBig.status === 413 && tooBig.body.error === "quota_exceeded",
	`${tooBig.status} ${JSON.stringify(tooBig.body)}`,
);
check(
	"and the refusal names the ceiling that applies",
	/2 GB/.test(String(tooBig.body.message)),
	String(tooBig.body.message),
);

// The monthly allowance is checked before any bytes move, so this costs nothing
// to test: two 1.6 GB files declared is 3.2 GB against a 3 GB month.
const overMonth = await api("/api/v1/transfers", {
	method: "POST",
	body: JSON.stringify({
		inbox_id: freeResolve.body.inbox_id,
		files: [1, 2].map(() => ({
			enc_name: "x",
			name_iv: "x",
			size: Math.floor(1.6 * 1024 ** 3),
			nonce_prefix: "x",
			wrapped_key: "x",
			key_iv: "x",
			eph_pub: "x",
		})),
	}),
});
check(
	"the monthly relay allowance refuses an over-budget transfer",
	overMonth.status === 413 && /this month/.test(String(overMonth.body.message)),
	`${overMonth.status} ${JSON.stringify(overMonth.body)}`,
);
check(
	"and says so without naming the owner's tier, usage or bill (PRD 13.1)",
	!/free|pro|quota|gb|\d/i.test(String(overMonth.body.message)),
	String(overMonth.body.message),
);

section("Licensing (PRD 16.5 — Creem is the authority, D1 is the cache)");
const badKey = await api("/api/v1/licenses/activate", {
	method: "POST",
	token,
	body: JSON.stringify({ key: BAD_KEY }),
});
check(
	"an unrecognised key is rejected as itself, not as a generic error",
	badKey.status === 404 && badKey.body.error === "license_not_found",
	JSON.stringify(badKey.body),
);

const fullKey = await api("/api/v1/licenses/activate", {
	method: "POST",
	token,
	body: JSON.stringify({ key: FULL_KEY }),
});
check(
	"a licence with no seats left says so, and says what to do",
	fullKey.status === 409 && fullKey.body.error === "seats_full",
	JSON.stringify(fullKey.body),
);

const activated = await api("/api/v1/licenses/activate", {
	method: "POST",
	token,
	body: JSON.stringify({ key: GOOD_KEY }),
});
check(
	"activating a good key makes the device Pro",
	activated.status === 200 && activated.body.tier === "pro",
	JSON.stringify(activated.body),
);
const seatsAfterActivation = activated.body.license?.seats_used as number;
check(
	"and reports the seat it took",
	activated.body.license?.seats === 3 && seatsAfterActivation >= 1,
	JSON.stringify(activated.body.license),
);
check(
	"Pro's allowance is 300 GB",
	activated.body.relay_limit === 300 * 1024 ** 3,
	String(activated.body.relay_limit),
);

const reactivated = await api("/api/v1/licenses/activate", {
	method: "POST",
	token,
	body: JSON.stringify({ key: GOOD_KEY }),
});
check(
	"re-entering the same key is idempotent, not a second seat",
	reactivated.status === 200 && reactivated.body.license?.seats_used === seatsAfterActivation,
	JSON.stringify(reactivated.body.license),
);

const upgradedResolve = await api(on(NAME, "/api/v1/resolve?slug=inbox"));
check(
	"the inbox created before the purchase gets the Pro ceiling",
	upgradedResolve.body.max_file_size === 20 * 1024 ** 3,
	String(upgradedResolve.body.max_file_size),
);
check(
	"and the Pro retention window (PRD 16.1)",
	upgradedResolve.body.ttl_hours === 24 * 7,
	String(upgradedResolve.body.ttl_hours),
);

section("Relay accounting (PRD 16.1 — booked on accept, returned if undelivered)");
const usedBefore = (await api("/api/v1/licenses/status", { token })).body.relay_used as number;
const bookSize = 100 * 1024 * 1024;
// Declared, never uploaded: booking happens when the transfer is accepted, so
// this measures the ledger without moving 100 MB.
const booked = await api("/api/v1/transfers", {
	method: "POST",
	body: JSON.stringify({
		inbox_id: registered.body.inbox.inbox_id,
		files: [
			{
				enc_name: "x",
				name_iv: "x",
				size: bookSize,
				nonce_prefix: "x",
				wrapped_key: "x",
				key_iv: "x",
				eph_pub: "x",
			},
		],
	}),
});
check("a transfer is accepted", booked.status === 201, JSON.stringify(booked.body));
const usedAfterBooking = (await api("/api/v1/licenses/status", { token })).body
	.relay_used as number;
check(
	"accepting a transfer books its bytes against the month",
	usedAfterBooking === usedBefore + bookSize,
	`${usedBefore} -> ${usedAfterBooking}`,
);

await api(`/api/v1/transfers/${booked.body.transfer_id}/abort`, {
	method: "POST",
	token: booked.body.token,
});
const usedAfterAbort = (await api("/api/v1/licenses/status", { token })).body.relay_used as number;
check(
	"withdrawing it gives the bytes back — parking is not delivery",
	usedAfterAbort === usedBefore,
	`${usedAfterBooking} -> ${usedAfterAbort}`,
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

/*
 * PRD 10.5 — the push is the whole point of the design: without it a file
 * waits out the Mac's polling interval, which looks exactly like "nothing
 * happened". Presence passing is not evidence that notifications arrive; the
 * socket can be connected and the frame still never sent.
 */
section("A ready file is pushed to a connected Mac (PRD 10.5)");
{
	const pushSocket = new WebSocket(`${BASE.replace("http", "ws")}/api/v1/ws/device?token=${token}`);
	const opened = await new Promise<boolean>((resolve) => {
		pushSocket.addEventListener("open", () => resolve(true));
		pushSocket.addEventListener("error", () => resolve(false));
		setTimeout(() => resolve(false), 5000);
	});
	check("device socket open for push", opened);

	if (opened) {
		const pushed = new Promise<any>((resolve) => {
			pushSocket.addEventListener("message", (event) => {
				try {
					const frame = JSON.parse(String(event.data));
					if (frame.type === "file.ready") resolve(frame);
				} catch {
					// Not our JSON.
				}
			});
			setTimeout(() => resolve(null), 5000);
		});

		const root = await api(on(NAME, "/api/v1/resolve?slug=inbox"));
		const push = await sendFile(root.body.inbox_id, kexPub, "pushed.txt", new Uint8Array([7]));
		const frame = await pushed;

		check("file.ready reached the Mac", !!frame, frame ? "" : "no frame within 5s");
		if (frame) {
			check("the push names the file that just completed", frame.file_id === push.fileId);
			check("the push carries its transfer", frame.transfer_id === push.transferId);
		}
		await api(`/api/v1/files/${push.fileId}/ack`, { method: "POST", token });
	}
	pushSocket.close();
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

section("Releasing a seat (PRD 7.2 — a dead Mac must not hold one forever)");
const wrongOwner = await api("/api/v1/licenses/deactivate", {
	method: "POST",
	body: JSON.stringify({ key: BAD_KEY, device_id: deviceId }),
});
check(
	"releasing with the wrong key says only 'no such activation'",
	wrongOwner.status === 404 && !/pro|free|seat/i.test(String(wrongOwner.body.message)),
	JSON.stringify(wrongOwner.body),
);

// No device session on this call, deliberately: the key is the credential.
// A Mac that is lost or dead can never sign anything again, so requiring its
// own signature to free its seat would strand the seat permanently.
const released = await api("/api/v1/licenses/deactivate", {
	method: "POST",
	body: JSON.stringify({ key: GOOD_KEY, device_id: deviceId }),
});
check(
	"the seat is released by whoever holds the key, with no session",
	released.status === 200 && released.body.released === true,
	JSON.stringify(released.body),
);
const afterRelease = await api("/api/v1/licenses/status", { token });
check(
	"and the device is Free again",
	afterRelease.status === 200 && afterRelease.body.tier === "free",
	JSON.stringify(afterRelease.body),
);

section("Checkout webhook (Creem's current license_keys payload)");
// Shaped as Creem actually sends it: the payload object *is* the checkout, so
// its own `id` is the checkout id, and the order and customer hang off it. The
// order id in particular is the only thing the refund below will have to go on.
const ORDER_ID = `ord_e2e_${Math.random().toString(36).slice(2, 8)}`;
const CHECKOUT_ID = `ch_e2e_${Math.random().toString(36).slice(2, 8)}`;
const checkoutBody = JSON.stringify({
	id: "evt_e2e_checkout",
	eventType: "checkout.completed",
	object: {
		id: CHECKOUT_ID,
		object: "checkout",
		status: "completed",
		order: { id: ORDER_ID, object: "order", amount: 2900, currency: "USD" },
		customer: { id: "cus_e2e", object: "customer", email: "e2e@example.com" },
		license_keys: [{ id: "lic_e2e", key: GOOD_KEY, status: "active", activation_limit: 3 }],
	},
});
const completedCheckout = await api("/api/v1/webhooks/creem", {
	method: "POST",
	headers: { "creem-signature": await signWebhook(checkoutBody) },
	body: checkoutBody,
});
check(
	"a signed checkout stores the nested Creem licence instead of ignoring it",
	completedCheckout.status === 200 && completedCheckout.body.ok === true && !completedCheckout.body.ignored,
	JSON.stringify(completedCheckout.body),
);

section("Refund webhook (PRD 16.5 — revocation is push, and never destructive)");
/**
 * A refund exactly as Creem sends one, which is the point of this whole
 * section: the payload carries a refund, an order, a checkout and a customer,
 * and **no licence key**. An earlier version of these tests put the key in
 * `object.key`, a shape Creem does not produce, and so passed while revocation
 * was in fact dead code. The row is found through the order id recorded at
 * checkout (migration 0003), or it is not found at all.
 */
const refundFor = (order: string, checkout: string) =>
	JSON.stringify({
		id: "evt_e2e_refund",
		eventType: "refund.created",
		object: {
			id: "ref_e2e",
			object: "refund",
			status: "succeeded",
			refund_amount: 2900,
			refund_currency: "USD",
			order: { id: order, object: "order" },
			checkout: { id: checkout, object: "checkout" },
			customer: { id: "cus_e2e", object: "customer" },
		},
	});

const unsigned = await api("/api/v1/webhooks/creem", {
	method: "POST",
	body: refundFor(ORDER_ID, CHECKOUT_ID),
});
check(
	"an unsigned webhook is refused",
	unsigned.status === 401 && unsigned.body.error === "bad_signature",
	JSON.stringify(unsigned.body),
);
const forgedHook = await api("/api/v1/webhooks/creem", {
	method: "POST",
	headers: { "creem-signature": "0".repeat(64) },
	body: refundFor(ORDER_ID, CHECKOUT_ID),
});
check("a forged signature is refused", forgedHook.status === 401, JSON.stringify(forgedHook.body));

// A device of its own, so the refund below cannot affect anything above it.
const refundee = await makeDevice();
const refundName = `e2e-rf-${Math.random().toString(36).slice(2, 8)}`;
const refundReg = await register(refundName, refundee);
const refundToken = refundReg.body.token as string;
await api("/api/v1/licenses/activate", {
	method: "POST",
	token: refundToken,
	body: JSON.stringify({ key: GOOD_KEY }),
});
const extra = await api("/api/v1/inboxes", {
	method: "POST",
	token: refundToken,
	body: JSON.stringify({ slug: "client-b", display_name: "Client B" }),
});
check("Pro created a second inbox before the refund", extra.status === 201);

// A refund for an order nobody bought. It must be accepted (a non-2xx makes
// Creem retry it forever) and must revoke nothing — a lookup that matched too
// broadly would take Pro away from a paying stranger.
const strayBody = refundFor("ord_e2e_nobody", "ch_e2e_nobody");
const stray = await api("/api/v1/webhooks/creem", {
	method: "POST",
	headers: { "creem-signature": await signWebhook(strayBody) },
	body: strayBody,
});
check(
	"a refund for an unknown order is accepted and ignored",
	stray.status === 200 && stray.body.ignored === "refund.created",
	JSON.stringify(stray.body),
);
const stillPro = await api("/api/v1/licenses/status", { token: refundToken });
check(
	"and it revoked nothing",
	stillPro.body.tier === "pro",
	JSON.stringify(stillPro.body),
);

const refundBody = refundFor(ORDER_ID, CHECKOUT_ID);
const refunded = await api("/api/v1/webhooks/creem", {
	method: "POST",
	headers: { "creem-signature": await signWebhook(refundBody) },
	body: refundBody,
});
check("a correctly signed refund is accepted", refunded.status === 200, JSON.stringify(refunded.body));

const afterRefund = await api("/api/v1/licenses/status", { token: refundToken });
check(
	"the refunded device is Free again",
	afterRefund.body.tier === "free",
	JSON.stringify(afterRefund.body),
);
const survived = await api("/api/v1/inboxes", { token: refundToken });
check(
	"both inboxes still exist — a refund pauses, it never deletes",
	survived.body.inboxes.length === 2,
	JSON.stringify(survived.body.inboxes.map((i: any) => [i.slug, i.paused])),
);
check(
	"the inbox beyond the free allowance is paused, the oldest still live",
	survived.body.inboxes.find((i: any) => i.slug === "client-b")?.paused === true &&
		survived.body.inboxes.find((i: any) => i.slug === "inbox")?.paused === false,
	JSON.stringify(survived.body.inboxes.map((i: any) => [i.slug, i.paused])),
);

creem.close();

/**
 * PRD 10.1 — the installer is served from R2 through the Worker, so the site is
 * the whole distribution channel and these are the checks that it works.
 *
 * Skipped wholesale when nothing has been published, which is the state of a
 * fresh clone. `npm run release:mac -- --local --fake` seeds it and turns this
 * section on.
 */
section("Installer download (PRD 10.1 — Developer ID, direct from the site)");
const manifestResponse = await fetch(`${BASE}/api/v1/release/mac`);
if (manifestResponse.status === 404) {
	check("no macOS build published — download checks skipped", true);
} else {
	const manifest = (await manifestResponse.json()) as any;
	check("the manifest is served", manifestResponse.status === 200);
	check(
		"it names a versioned universal dmg",
		/^Stolnk-[0-9A-Za-z.+-]{1,32}-universal\.dmg$/.test(manifest.filename),
		manifest.filename,
	);
	check("the hash is a SHA-256", /^[0-9a-f]{64}$/.test(manifest.sha256), manifest.sha256);
	check("the size is real", manifest.size > 0, String(manifest.size));
	check("it states the deployment target", manifest.min_macos === "13.0", manifest.min_macos);
	check(
		"the url is derived from the filename, not echoed",
		manifest.url === `/download/mac/${manifest.filename}`,
		manifest.url,
	);

	// Navigation headers, not a bare fetch. The static-asset layer runs ahead of
	// the Worker and answers navigations that match no asset with index.html, so
	// a plain fetch here passes while a real click on the button is served the
	// SPA instead of the installer. `run_worker_first` in wrangler.json is what
	// prevents that, and this is the check that notices if it is ever removed.
	const asNavigation = {
		accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
		"sec-fetch-mode": "navigate",
		"sec-fetch-dest": "document",
	};
	const alias = await fetch(`${BASE}/download/mac`, {
		redirect: "manual",
		headers: asNavigation,
	});
	check(
		"the stable alias redirects to the versioned file",
		alias.status === 302 && alias.headers.get("location") === manifest.url,
		`${alias.status} ${alias.headers.get("location")}`,
	);
	const navigated = await fetch(`${BASE}${manifest.url}`, { headers: asNavigation });
	check(
		"a browser navigation to the dmg gets the dmg, not the SPA",
		navigated.status === 200 &&
			navigated.headers.get("content-type") === "application/x-apple-diskimage",
		`${navigated.status} ${navigated.headers.get("content-type")}`,
	);
	await navigated.arrayBuffer();
	check(
		"the alias is cached briefly, so a release is never stuck",
		/max-age=300/.test(alias.headers.get("cache-control") ?? ""),
		alias.headers.get("cache-control") ?? "",
	);

	const head = await fetch(`${BASE}${manifest.url}`, { method: "HEAD" });
	const etag = head.headers.get("etag") ?? "";
	check("the dmg is served", head.status === 200);
	check(
		"content-length matches the manifest",
		Number(head.headers.get("content-length")) === manifest.size,
		head.headers.get("content-length") ?? "",
	);
	check(
		"it is typed as a disk image and marked as an attachment",
		head.headers.get("content-type") === "application/x-apple-diskimage" &&
			(head.headers.get("content-disposition") ?? "").includes(manifest.filename),
	);
	check(
		"the versioned object is immutable",
		/immutable/.test(head.headers.get("cache-control") ?? ""),
		head.headers.get("cache-control") ?? "",
	);
	check("it advertises ranges and an etag", head.headers.get("accept-ranges") === "bytes" && !!etag);

	// A plain GET must not come back 206: R2 populates `range` regardless of what
	// the request asked for, and a 206 with no Range is how download managers get
	// confused about whether they have the whole file.
	const whole = await fetch(`${BASE}${manifest.url}`);
	const wholeBytes = new Uint8Array(await whole.arrayBuffer());
	check("an unconditional GET is 200, not 206", whole.status === 200, String(whole.status));

	const first = await fetch(`${BASE}${manifest.url}`, { headers: { range: "bytes=0-15" } });
	check(
		"a range request is a 206 slice",
		first.status === 206 &&
			first.headers.get("content-range") === `bytes 0-15/${manifest.size}` &&
			(await first.arrayBuffer()).byteLength === 16,
	);
	const suffix = await fetch(`${BASE}${manifest.url}`, { headers: { range: "bytes=-16" } });
	check(
		"the suffix form resumers send is honoured",
		suffix.status === 206 &&
			suffix.headers.get("content-range") === `bytes ${manifest.size - 16}-${manifest.size - 1}/${manifest.size}`,
		suffix.headers.get("content-range") ?? String(suffix.status),
	);
	const past = await fetch(`${BASE}${manifest.url}`, { headers: { range: "bytes=99999999999-" } });
	check(
		"a range past the end is 416, not the whole file",
		past.status === 416 && past.headers.get("content-range") === `bytes */${manifest.size}`,
		`${past.status} ${past.headers.get("content-range")}`,
	);
	const conditional = await fetch(`${BASE}${manifest.url}`, { headers: { "if-none-match": etag } });
	check("a matching etag is 304", conditional.status === 304, String(conditional.status));

	// The check that actually protects the published-hash claim on the download
	// page. Skipped for a real build, which is too big to be worth hashing here.
	if (manifest.size <= 64 * 1024 * 1024) {
		check(
			"the bytes served hash to what the manifest promises",
			toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", wholeBytes))) ===
				manifest.sha256,
		);
	} else {
		check("build too large to hash in-suite — skipped", true);
	}

	for (const probe of ["latest.json", "evil.dmg", `${manifest.filename}.bak`]) {
		const response = await fetch(`${BASE}/download/mac/${probe}`);
		check(`/download/mac/${probe} is not reachable`, response.status === 404, String(response.status));
	}

	// The apex owns the marketing site; on an inbox subdomain these paths are not
	// addresses, and the SPA answers instead.
	const offApex = await fetch(on(NAME, "/api/v1/release/mac"));
	check(
		"the manifest is apex-only",
		offApex.status === 404,
		String(offApex.status),
	);
}

section("Static site routing (the asset layer must never shadow the Worker)");
/**
 * The failure this section exists for is invisible to every other test in this
 * file, because every other test uses a plain fetch.
 *
 * With static assets in front of the Worker, `not_found_handling:
 * "single-page-application"` answers any *navigation* that matches no asset with
 * `index.html` — so `/api/v1/checkout` returns a clean 302 to curl while a real
 * click on "Buy Stolnk Pro" is served the SPA's 404 page. That is exactly what
 * shipped: the button never worked, and a curl check said it did.
 *
 * `run_worker_first: true` is what stops it, and these are the checks that
 * notice if it is ever weakened — including to the array form, which reads like
 * an addition and is in fact an exclusive allow-list.
 */
const asNavigationRequest = {
	accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
	"sec-fetch-mode": "navigate",
	"sec-fetch-dest": "document",
};

const navHealth = await fetch(`${BASE}/api/v1/health`, { headers: asNavigationRequest });
check(
	"a navigation to an API path reaches the Worker, not the SPA",
	(navHealth.headers.get("content-type") ?? "").includes("application/json"),
	`${navHealth.status} ${navHealth.headers.get("content-type")}`,
);

const navCheckout = await fetch(`${BASE}/api/v1/checkout`, {
	redirect: "manual",
	headers: asNavigationRequest,
});
check(
	"clicking Buy Stolnk Pro redirects to Creem",
	navCheckout.status === 302 && /creem\.io/.test(navCheckout.headers.get("location") ?? ""),
	`${navCheckout.status} ${navCheckout.headers.get("location")}`,
);

/*
 * The other half of `run_worker_first: true`: the Worker now sees requests for
 * real files, and a notFound that answers them with index.html serves the
 * script as HTML and takes the site down. The tag is read out of the page
 * rather than hard-coded, because the built name carries a content hash and the
 * dev server serves the unbundled entry instead.
 */
const page = await fetch(`${BASE}/pricing`, { headers: asNavigationRequest });
const html = await page.text();

const entry = /<script[^>]+src="([^"]+\.(?:js|tsx))"/.exec(html)?.[1];
check("the page references a script entry", !!entry, html.slice(0, 200));
if (entry) {
	const asset = await fetch(`${BASE}${entry}`);
	const type = asset.headers.get("content-type") ?? "";
	check(
		"the script entry is served as JavaScript, not index.html",
		asset.status === 200 && /javascript|ecmascript/.test(type),
		`${asset.status} ${type}`,
	);
}

// The security headers are skipped on localhost, where Vite needs inline
// scripts (index.ts says so), so this one can only be asserted against a
// deployed origin: E2E_BASE=https://stolnk.com npm run e2e.
if (!/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|$)/.test(BASE)) {
	check(
		"the pricing page carries the CSP that PRD 9.4 rests on",
		(page.headers.get("content-security-policy") ?? "").includes("default-src 'self'"),
		page.headers.get("content-security-policy") ?? "(none)",
	);
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
	for (const failure of failures) console.log(`  - ${failure}`);
	process.exit(1);
}
