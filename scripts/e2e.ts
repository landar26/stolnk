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
import { execFileSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
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
// No worker types here, only numbers — so the budget the test walks into is the
// same constant the Worker enforces, rather than a copy that drifts from it.
import { RATE_MAX_SHARE_LOOKUPS } from "../src/worker/limits.ts";

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

async function makeShare(
	deviceToken: string,
	plaintext: Uint8Array,
	options: { filename?: string; ttl_hours?: number; max_downloads?: number; password?: string; password_salt?: string; code?: string } = {},
) {
	const init = await api("/api/v1/shares", {
		method: "POST",
		token: deviceToken,
		body: JSON.stringify({
			filename: options.filename ?? "shared.txt",
			size: plaintext.length,
			ttl_hours: options.ttl_hours ?? 24,
			max_downloads: options.max_downloads,
			password: options.password,
			password_salt: options.password_salt,
			code: options.code,
		}),
	});
	if (init.status !== 201) return { init };
	let skipped = false;
	for (let part = 1; part <= init.body.part_count; part++) {
		const bytes = plaintext.subarray((part - 1) * init.body.part_size, part * init.body.part_size);
		const path = `/api/v1/shares/${init.body.share_id}/parts/${part}`;
		const upload = await api(path, {
			method: "PUT", token: init.body.token, body: bytes,
			headers: { "content-type": "application/octet-stream" },
		});
		if (upload.status !== 200) return { init, upload };
		if (part === 1) {
			const again = await api(path, {
				method: "PUT", token: init.body.token, body: bytes,
				headers: { "content-type": "application/octet-stream" },
			});
			skipped = again.body?.skipped === true;
		}
	}
	const sha256 = toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", plaintext)));
	const complete = await api(`/api/v1/shares/${init.body.share_id}/complete`, {
		method: "POST", token: init.body.token, body: JSON.stringify({ sha256 }),
	});
	return { init, complete, skipped };
}

async function restoreShare(deviceToken: string, shareId: string, plaintext: Uint8Array, claimSha?: string) {
	const init = await api(`/api/v1/shares/${shareId}/restore`, { method: "POST", token: deviceToken });
	if (init.status !== 200) return { init };
	for (let part = 1; part <= init.body.part_count; part++) {
		const bytes = plaintext.subarray((part - 1) * init.body.part_size, part * init.body.part_size);
		const upload = await api(`/api/v1/shares/${shareId}/parts/${part}`, {
			method: "PUT", token: init.body.token, body: bytes,
			headers: { "content-type": "application/octet-stream" },
		});
		if (upload.status !== 200) return { init, upload };
	}
	const sha256 = claimSha ?? toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", plaintext)));
	const complete = await api(`/api/v1/shares/${shareId}/complete`, {
		method: "POST", token: init.body.token, body: JSON.stringify({ sha256 }),
	});
	return { init, complete };
}

async function shareVerifier(password: string, salt: string, iterations = 210_000): Promise<string> {
	const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
	const bits = await crypto.subtle.deriveBits(
		{ name: "PBKDF2", hash: "SHA-256", salt: fromBase64Url(salt), iterations }, key, 256,
	);
	return toHex(new Uint8Array(bits));
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

section("Outbound shares — a local file becomes a public link");
const shareBytes = new TextEncoder().encode("outbound share bytes, exactly");
const unlimited = await makeShare(token, shareBytes, { filename: "report 你好.txt" });
check("share creation returns 201", unlimited.init.status === 201, JSON.stringify(unlimited.init.body));
check("share code has 80 bits of slug entropy", /^[a-z0-9]{16}$/.test(unlimited.init.body.code));
check("share URL uses the reserved tilde namespace", unlimited.init.body.url === on(NAME, `/~${unlimited.init.body.code}`));
check("a retried share part is skipped", unlimited.skipped === true);
check("completing a share makes it ready", unlimited.complete?.status === 200 && unlimited.complete.body.state === "ready");

const sharePath = on(NAME, `/~${unlimited.init.body.code}/${encodeURIComponent("report 你好.txt")}`);
const shared = await fetch(sharePath);
check("public download returns the original bytes", shared.status === 200 && new Uint8Array(await shared.arrayBuffer()).every((b, i) => b === shareBytes[i]));
check("public bytes are always an octet-stream attachment", shared.headers.get("content-type") === "application/octet-stream" && /attachment/.test(shared.headers.get("content-disposition") ?? ""));
const shareLanding = await fetch(unlimited.init.body.url, { redirect: "manual" });
check("an unlimited unprotected landing redirects to the byte URL", shareLanding.status === 302);
const shareCapabilities = await api(`${unlimited.init.body.url}?format=json`);
check("share capabilities disclose plaintext", shareCapabilities.body.plaintext === true && /not end-to-end encrypted/i.test(shareCapabilities.body.note));
const masquerade = await api(`/api/v1/resolve?slug=~${unlimited.init.body.code}`);
check("a share code cannot resolve as an inbox", masquerade.status === 404);

const shareHead = await fetch(sharePath, { method: "HEAD" });
const shareEtag = shareHead.headers.get("etag") ?? "";
const shareRange = await fetch(sharePath, { headers: { range: "bytes=0-7" } });
check("unlimited shares support byte ranges", shareRange.status === 206 && (await shareRange.arrayBuffer()).byteLength === 8);
const shareSuffix = await fetch(sharePath, { headers: { range: "bytes=-7" } });
check("unlimited shares support suffix ranges", shareSuffix.status === 206 && (await shareSuffix.arrayBuffer()).byteLength === 7);
const sharePast = await fetch(sharePath, { headers: { range: "bytes=999999999-" } });
check("an unsatisfiable share range is 416", sharePast.status === 416 && sharePast.headers.get("content-range") === `bytes */${shareBytes.length}`);
const share304 = await fetch(sharePath, { headers: { "if-none-match": shareEtag } });
check("unlimited shares support conditional GET", !!shareEtag && share304.status === 304);

const limited = await makeShare(token, shareBytes, { filename: "limited.bin", max_downloads: 2 });
const limitedPath = on(NAME, `/~${limited.init.body.code}/limited.bin`);
for (let i = 0; i < 3; i++) await fetch(limitedPath, { method: "HEAD" });
const rangedLimited = await fetch(limitedPath, { headers: { range: "bytes=0-3" } });
check("limited shares ignore Range and return the whole file", rangedLimited.status === 200 && (await rangedLimited.arrayBuffer()).byteLength === shareBytes.length);
check("limited shares disable caches, ranges and etags", limitedPath && rangedLimited.headers.get("accept-ranges") === "none" && /no-store/.test(rangedLimited.headers.get("cache-control") ?? "") && !rangedLimited.headers.has("etag"));
const secondLimited = await fetch(limitedPath);
await secondLimited.arrayBuffer();
const spentLimited = await fetch(limitedPath);
check("HEAD does not count and the third GET is gone", secondLimited.status === 200 && spentLimited.status === 410);

const saltReply = await api("/api/v1/shares/salt", { token });
const sharePasswordVerifier = await shareVerifier("open sesame", saltReply.body.salt, saltReply.body.iterations);
const protectedShare = await makeShare(token, shareBytes, {
	filename: "secret.txt", max_downloads: 5, password: sharePasswordVerifier, password_salt: saltReply.body.salt,
});
const lookup = await api(on(NAME, `/api/v1/share-link/lookup?code=${protectedShare.init.body.code}`));
check("locked lookup hides filename and size", lookup.status === 200 && lookup.body.password.required && !("filename" in lookup.body) && !("size" in lookup.body));
const wrongUnlock = await api(on(NAME, "/api/v1/share-link/unlock"), { method: "POST", body: JSON.stringify({ code: protectedShare.init.body.code, verifier: "wrong" }) });
check("a wrong share verifier is rejected", wrongUnlock.status === 401);
const unlock = await api(on(NAME, "/api/v1/share-link/unlock"), { method: "POST", body: JSON.stringify({ code: protectedShare.init.body.code, verifier: sharePasswordVerifier }) });
const protectedPath = on(NAME, `/~${protectedShare.init.body.code}/secret.txt?t=${encodeURIComponent(unlock.body.token)}`);
const protectedGet = await fetch(protectedPath);
check("a short-lived access token downloads the protected file", unlock.status === 200 && protectedGet.status === 200);
const curlPassword = await fetch(on(NAME, `/~${protectedShare.init.body.code}/secret.txt`), { headers: { "x-stolnk-password": "open sesame" } });
check("curl can use the explicit plaintext password header", curlPassword.status === 200);

const burn = await makeShare(token, shareBytes, { filename: "once.bin", max_downloads: 1 });
const burnPath = on(NAME, `/~${burn.init.body.code}/once.bin`);
const race = await Promise.all([fetch(burnPath), fetch(burnPath)]);
const raceStatuses = race.map((response) => response.status).sort();
await Promise.all(race.map((response) => response.arrayBuffer()));
check("burn-after-read admits exactly one concurrent download", raceStatuses[0] === 200 && raceStatuses[1] === 410, raceStatuses.join(","));

const revokedShare = await makeShare(token, shareBytes, { filename: "revoke.bin" });
const revoked = await api(`/api/v1/shares/${revokedShare.init.body.share_id}/revoke`, { method: "POST", token });
const afterRevoke = await fetch(on(NAME, `/~${revokedShare.init.body.code}/revoke.bin`));
check("revocation immediately deletes access", revoked.status === 200 && afterRevoke.status === 404);
const badPost = await api(on(NAME, `/~${unlimited.init.body.code}`), { method: "POST", body: new Uint8Array([1]) });
check("a share POST cannot masquerade as an inbox upload", badPost.status === 404 && !/inbox does not exist/i.test(String(badPost.body?.message)));

section("A share link can carry a path its owner chose");
const chosen = await makeShare(token, shareBytes, { filename: "invoice.pdf", code: "invoice-2026" });
check("a chosen path is used verbatim", chosen.init.status === 201 && chosen.init.body.code === "invoice-2026", JSON.stringify(chosen.init.body));
check("a chosen path builds the public URL", chosen.init.body.url === on(NAME, "/~invoice-2026"));
// Also the regression test for the router's own charset: `index.ts` used to
// match `~[a-z0-9]{1,32}`, so a hyphen 404'd before any handler was reached.
const chosenBytes = await fetch(on(NAME, "/~invoice-2026/invoice.pdf"));
check("a hyphenated path reaches the bytes", chosenBytes.status === 200 && (await chosenBytes.arrayBuffer()).byteLength === shareBytes.length);

const usedBeforeClash = (await api("/api/v1/licenses/status", { token })).body.relay_used as number;
const clash = await api("/api/v1/shares", {
	method: "POST", token,
	body: JSON.stringify({ filename: "other.pdf", size: shareBytes.length, ttl_hours: 24, code: "invoice-2026" }),
});
check("a path already in use is a 409, not a 500", clash.status === 409 && clash.body.error === "code_taken", JSON.stringify(clash.body));
const usedAfterClash = (await api("/api/v1/licenses/status", { token })).body.relay_used as number;
// The row and the booking share one batch, so a rejected create leaves neither.
check("a refused path books no relay bytes", usedAfterClash === usedBeforeClash, `${usedBeforeClash} → ${usedAfterClash}`);
const clashList = (await api("/api/v1/shares", { token })).body.shares as any[];
check("a refused path leaves no orphan row", clashList.filter((share) => share.code === "invoice-2026").length === 1);

const uppercase = await makeShare(token, shareBytes, { filename: "case.pdf", code: "  Invoice-2027  " });
check("a chosen path is trimmed and lower-cased", uppercase.init.body.code === "invoice-2027", JSON.stringify(uppercase.init.body));

for (const [label, code] of [["too short", "ab"], ["two segments", "a/b"], ["an underscore", "a_b"], ["too long", "a".repeat(33)]] as const) {
	const rejected = await api("/api/v1/shares", {
		method: "POST", token,
		body: JSON.stringify({ filename: "bad.pdf", size: 1, ttl_hours: 24, code }),
	});
	check(`a path with ${label} is a 400`, rejected.status === 400, `${rejected.status} ${JSON.stringify(rejected.body)}`);
}

const freeProbe = await api("/api/v1/shares/code-available/never-used-here", { token });
check("an unused path probes as available", freeProbe.status === 200 && freeProbe.body.available === true && freeProbe.body.reason === null, JSON.stringify(freeProbe.body));
const takenProbe = await api("/api/v1/shares/code-available/invoice-2026", { token });
check("a used path probes as taken", takenProbe.status === 200 && takenProbe.body.available === false && takenProbe.body.reason === "taken");
// The edit screen asks about a path while the share it belongs to already
// holds it. Without a share to except, the probe answers "taken" about the
// share doing the asking, and the field calls a successful save a collision.
const ownProbe = await api(`/api/v1/shares/${chosen.init.body.share_id}/code-available/invoice-2026`, { token });
check("a share's own path is available to itself", ownProbe.status === 200 && ownProbe.body.available === true, JSON.stringify(ownProbe.body));
const ownProbeClash = await api(`/api/v1/shares/${chosen.init.body.share_id}/code-available/invoice-2027`, { token });
check("another link's path is still taken", ownProbeClash.status === 200 && ownProbeClash.body.available === false && ownProbeClash.body.reason === "taken", JSON.stringify(ownProbeClash.body));
const invalidProbe = await api("/api/v1/shares/code-available/ab", { token });
// 200, not 400: a field being typed into asked a question and got an answer.
check("an invalid path probes as invalid, with a 200", invalidProbe.status === 200 && invalidProbe.body.available === false && invalidProbe.body.reason === "invalid", `${invalidProbe.status}`);

const repathed = await api(`/api/v1/shares/${chosen.init.body.share_id}`, {
	method: "PATCH", token, body: JSON.stringify({ code: "invoice-2026-final" }),
});
check("repathing returns the new URL", repathed.status === 200 && repathed.body.url === on(NAME, "/~invoice-2026-final"), JSON.stringify(repathed.body));
const atNewSharePath = await fetch(on(NAME, "/~invoice-2026-final/invoice.pdf"));
const atOldSharePath = await fetch(on(NAME, "/~invoice-2026/invoice.pdf"));
await atNewSharePath.arrayBuffer();
check("the new path serves the file", atNewSharePath.status === 200);
check("the old path stops working immediately", atOldSharePath.status === 404);
const repathClash = await api(`/api/v1/shares/${chosen.init.body.share_id}`, {
	method: "PATCH", token, body: JSON.stringify({ code: "invoice-2027" }),
});
check("repathing onto another live link is a 409", repathClash.status === 409 && repathClash.body.error === "code_taken");
const repathRevoked = await api(`/api/v1/shares/${revokedShare.init.body.share_id}`, {
	method: "PATCH", token, body: JSON.stringify({ code: "raised-from-the-dead" }),
});
check("a revoked link cannot be repathed", repathRevoked.status === 400, `${repathRevoked.status}`);
// Guessable paths made enumeration worth attempting, so the two endpoints that
// answer questions about a path without serving it grew a budget.
//
// From its own address, for two reasons: `clientIp` falls back to 0.0.0.0 when
// nothing sets the header, so every other request in this file shares one
// bucket and exhausting it here would 429 whatever ran next — and asserting
// that a different address still gets through is the part worth proving.
const enumerator = { "cf-connecting-ip": "203.0.113.7" };
let lookupLimited = 0;
for (let attempt = 0; attempt < RATE_MAX_SHARE_LOOKUPS + 5; attempt++) {
	const probe = await api(on(NAME, `/api/v1/share-link/lookup?code=guess-${attempt}`), { headers: enumerator });
	if (probe.status === 429) lookupLimited += 1;
}
check("share metadata lookups are rate limited", lookupLimited > 0, `${lookupLimited} of ${RATE_MAX_SHARE_LOOKUPS + 5} refused`);
const otherViewer = await api(on(NAME, "/api/v1/share-link/lookup?code=guess-0"), {
	headers: { "cf-connecting-ip": "198.51.100.4" },
});
check("the budget is per address, not global", otherViewer.status !== 429, `${otherViewer.status}`);
// The landing page shares that bucket and must be reachable from elsewhere too.
const otherLanding = await fetch(on(NAME, "/~invoice-2026-final"), {
	headers: { "cf-connecting-ip": "198.51.100.4" }, redirect: "manual",
});
check("a landing page is unaffected by another address's enumeration", otherLanding.status === 302, `${otherLanding.status}`);

// The seven-day rule: a terminal row keeps its path so that nobody holding the
// old link is ever handed a different file at the same address. Revoked first
// so the attempt below is refused for its path and not for a quota — the code
// check is the last one `openShare` runs, after every wall.
await api(`/api/v1/shares/${chosen.init.body.share_id}/revoke`, { method: "POST", token });
await api(`/api/v1/shares/${uppercase.init.body.share_id}/revoke`, { method: "POST", token });
const reclaim = await api("/api/v1/shares", {
	method: "POST", token,
	body: JSON.stringify({ filename: "squat.pdf", size: 1, ttl_hours: 24, code: "invoice-2027" }),
});
check("a revoked link does not release its path", reclaim.status === 409 && reclaim.body.error === "code_taken", `${reclaim.status} ${JSON.stringify(reclaim.body)}`);

const chosenMasquerade = await api("/api/v1/resolve?slug=~invoice-2026-final");
check("a chosen share path cannot resolve as an inbox", chosenMasquerade.status === 404);

section("Pausing a share is the stop you can undo");
const pausable = await makeShare(token, shareBytes, { filename: "pausable.pdf", code: "pause-me" });
const pauseBytes = on(NAME, "/~pause-me/pausable.pdf");
check("it serves before pausing", (await fetch(pauseBytes)).status === 200);
const paused = await api(`/api/v1/shares/${pausable.init.body.share_id}`, {
	method: "PATCH", token, body: JSON.stringify({ paused: true }),
});
check("pausing reports the share as paused", paused.status === 200 && paused.body.paused === true, JSON.stringify(paused.body));
const whilePausedShare = await fetch(pauseBytes);
await whilePausedShare.arrayBuffer();
// 423, not 404: the link is real and its holder should try again, which is the
// whole difference between this and every other way a link stops working.
check("a paused link says temporarily unavailable, not gone", whilePausedShare.status === 423, `${whilePausedShare.status}`);
const pausedLookup = await api(on(NAME, "/api/v1/share-link/lookup?code=pause-me"));
check("a paused link discloses nothing through lookup", pausedLookup.status === 404);
check("its bytes are still there", await r2ObjectExists(`share/${pausable.init.body.share_id}`));
const pausedClash = await api("/api/v1/shares", {
	method: "POST", token,
	body: JSON.stringify({ filename: "squat.pdf", size: 1, ttl_hours: 24, code: "pause-me" }),
});
check("and it still holds its path", pausedClash.status === 409 && pausedClash.body.error === "code_taken");
// The point of the feature: a paused link is stopped, not finished, so the
// controls that could get it out of a pause must still work.
const pausedRepath = await api(`/api/v1/shares/${pausable.init.body.share_id}`, {
	method: "PATCH", token, body: JSON.stringify({ code: "pause-me-renamed" }),
});
check("a paused link can still be repathed", pausedRepath.status === 200 && pausedRepath.body.code === "pause-me-renamed", JSON.stringify(pausedRepath.body));
const resumed = await api(`/api/v1/shares/${pausable.init.body.share_id}`, {
	method: "PATCH", token, body: JSON.stringify({ paused: false }),
});
check("resuming reports it live again", resumed.status === 200 && resumed.body.paused === false);
const afterResume = await fetch(on(NAME, "/~pause-me-renamed/pausable.pdf"));
check("and the bytes come back", afterResume.status === 200 && (await afterResume.arrayBuffer()).byteLength === shareBytes.length);
const badPause = await api(`/api/v1/shares/${pausable.init.body.share_id}`, {
	method: "PATCH", token, body: JSON.stringify({ paused: "yes" }),
});
check('"paused" must be a boolean', badPause.status === 400);
// Nothing to turn back on: revoking deleted the object.
const resumeRevoked = await api(`/api/v1/shares/${revokedShare.init.body.share_id}`, {
	method: "PATCH", token, body: JSON.stringify({ paused: false }),
});
check("a revoked link cannot be resumed", resumeRevoked.status === 400, `${resumeRevoked.status}`);
// Hands back the active-share slot. Free allows three, and a section that keeps
// one alive spends part of the next section's budget rather than its own.
await api(`/api/v1/shares/${pausable.init.body.share_id}`, { method: "DELETE", token });

section("A link that ended can be restored, with the same file");
const restorable = await makeShare(token, shareBytes, { filename: "restore-me.pdf", code: "restore-me" });
const restorePath = on(NAME, "/~restore-me/restore-me.pdf");
await api(`/api/v1/shares/${restorable.init.body.share_id}/revoke`, { method: "POST", token });
check("it is gone after revoking", (await fetch(restorePath)).status === 404);
check("and its bytes are gone with it", !(await r2ObjectExists(`share/${restorable.init.body.share_id}`)));

// The gate the whole feature rests on: the URL comes back unchanged, so the
// bytes behind it have to be the ones it was created with.
//
// A file of a different length never gets that far — the row's size is fixed,
// so the part upload refuses it before a byte is stored. Same length, different
// content is the case only the hash can catch, and it is the one below.
const shorterFile = await restoreShare(token, restorable.init.body.share_id, new TextEncoder().encode("short"));
check("a file of the wrong size is refused before it is stored", shorterFile.upload?.status === 400, JSON.stringify(shorterFile.upload?.body));
await api(`/api/v1/shares/${restorable.init.body.share_id}/abort`, { method: "POST", token: shorterFile.init.body.token });
const wrongBytes = new TextEncoder().encode("outbound share bytes, EXACTLY");
const wrongFile = await restoreShare(token, restorable.init.body.share_id, wrongBytes);
check("restoring hands back an upload slot", wrongFile.init.status === 200 && typeof wrongFile.init.body.token === "string", JSON.stringify(wrongFile.init.body));
check("a different file is refused at completion", wrongFile.complete?.status === 400 && /same file/i.test(String(wrongFile.complete.body?.message)), JSON.stringify(wrongFile.complete?.body));
const afterWrong = await api(`/api/v1/shares/${restorable.init.body.share_id}`, { token });
check("the refused restore leaves the record terminal, not half-open", afterWrong.status === 200 && afterWrong.body.state !== "uploading", JSON.stringify(afterWrong.body));
check("and the link is still not serving", (await fetch(restorePath)).status === 404);
// A lied-about hash is the same refusal: the check is on what the row carries.
const liar = await restoreShare(token, restorable.init.body.share_id, wrongBytes, "0".repeat(64));
check("a claimed hash that is not the record's is refused too", liar.complete?.status === 400, JSON.stringify(liar.complete?.body));

const restored = await restoreShare(token, restorable.init.body.share_id, shareBytes);
check("the right file completes", restored.complete?.status === 200 && restored.complete.body.state === "ready", JSON.stringify(restored.complete?.body));
const servedAgain = await fetch(restorePath);
check("and the original URL serves the original bytes", servedAgain.status === 200 && new Uint8Array(await servedAgain.arrayBuffer()).every((b, i) => b === shareBytes[i]));
check("the restored link kept its path", restored.init.body.code === "restore-me" && restored.init.body.url === on(NAME, "/~restore-me"));
// This row has now been restored four times. Its window must still be the
// 24 hours it was made with: renewing `expires_at` without `created_at` would
// have grown the span each time until it failed Free's own 24-hour wall.
const restoredRow = ((await api("/api/v1/shares", { token })).body.shares as any[])
	.find((share) => share.share_id === restorable.init.body.share_id);
const restoredSpan = (restoredRow.expires_at - restoredRow.created_at) / 3_600_000;
check("restoring does not stretch the link's lifetime", Math.abs(restoredSpan - 24) < 0.01, `${restoredSpan}h`);

// Restoring a spent burn-after-read has to re-arm it, or it is spent on arrival.
const burned = await makeShare(token, shareBytes, { filename: "burned.pdf", code: "burn-restore", max_downloads: 1 });
const burnedPath = on(NAME, "/~burn-restore/burned.pdf");
await (await fetch(burnedPath)).arrayBuffer();
check("the burn link is spent after one download", (await fetch(burnedPath)).status === 410);
const reburn = await restoreShare(token, burned.init.body.share_id, shareBytes);
check("a spent link restores", reburn.complete?.status === 200, JSON.stringify(reburn.complete?.body));
const reburned = await fetch(burnedPath);
await reburned.arrayBuffer();
check("and its download count was re-armed, not resumed", reburned.status === 200, `${reburned.status}`);
check("still burning after one", (await fetch(burnedPath)).status === 410);

const liveRestore = await api(`/api/v1/shares/${unlimited.init.body.share_id}/restore`, { method: "POST", token });
check("a link that has not ended cannot be restored", liveRestore.status === 400, `${liveRestore.status}`);

await api(`/api/v1/shares/${restorable.init.body.share_id}`, { method: "DELETE", token });
await api(`/api/v1/shares/${burned.init.body.share_id}`, { method: "DELETE", token });

section("Deleting a share frees its path (the other half of revoke)");
// Revoked a moment ago and still holding "invoice-2027" — the assertion above
// is what makes this section mean something.
const deleted = await api(`/api/v1/shares/${uppercase.init.body.share_id}`, { method: "DELETE", token });
check("deleting a share reports a deletion, not a revocation", deleted.status === 200 && deleted.body.deleted === true, JSON.stringify(deleted.body));
const afterDelete = await api(`/api/v1/shares/${uppercase.init.body.share_id}`, { token });
check("the record is gone, not merely terminal", afterDelete.status === 404);
const listAfterDelete = (await api("/api/v1/shares", { token })).body.shares as any[];
check("and it leaves the owner's list", !listAfterDelete.some((share) => share.share_id === uppercase.init.body.share_id));
const reused = await makeShare(token, shareBytes, { filename: "reused.pdf", code: "invoice-2027" });
check("the freed path can be taken by a new link", reused.init.status === 201 && reused.init.body.code === "invoice-2027", JSON.stringify(reused.init.body));
const reusedBytes = await fetch(on(NAME, "/~invoice-2027/reused.pdf"));
await reusedBytes.arrayBuffer();
check("and the new link serves its own file", reusedBytes.status === 200);

// Deleting a *live* share has to end the object too: once the row is gone
// nothing left in the system knows there is plaintext at that key.
const liveDelete = await makeShare(token, shareBytes, { filename: "still-live.pdf", code: "delete-me-live" });
check("a share to delete while live was created", liveDelete.init.status === 201, JSON.stringify(liveDelete.init.body));
const liveKey = `share/${liveDelete.init.body.share_id}`;
check("the live share's object exists before deletion", await r2ObjectExists(liveKey), liveKey);
const liveDeleted = await api(`/api/v1/shares/${liveDelete.init.body.share_id}`, { method: "DELETE", token });
check("a live share can be deleted in one step", liveDeleted.status === 200 && liveDeleted.body.deleted === true);
const afterLiveDelete = await fetch(on(NAME, "/~delete-me-live/still-live.pdf"));
check("its link stops working", afterLiveDelete.status === 404);
let liveObjectGone = false;
for (let attempt = 0; attempt < 20 && !liveObjectGone; attempt++) {
	liveObjectGone = !(await r2ObjectExists(liveKey));
}
check("and its bytes are released, not orphaned", liveObjectGone);

const foreign = await api(`/api/v1/shares/${uppercase.init.body.share_id}`, { method: "DELETE", token });
check("deleting an already-deleted share is a 404, not a 500", foreign.status === 404, `${foreign.status}`);

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

/*
 * PRD 8.2 / M4 — LAN direct.
 *
 * None of this drives a real DataChannel: Node has no WebRTC, and the parts of
 * the LAN path that can be got wrong on a server are not the SDP exchange, they
 * are the money and the authorisation. So what is checked here is exactly the
 * server's half — who may open a signalling socket, what it may push through
 * it, that a LAN transfer books nothing and cannot touch the relay, and that
 * abandoning one does not mint free allowance. The browser-to-Mac leg needs
 * real hardware and is listed in the README as such.
 */
section("LAN direct signalling (PRD 8.2)");
{
	const wsBase = BASE.replace("http", "ws");
	const open = (url: string) =>
		new Promise<WebSocket | null>((resolve) => {
			const socket = new WebSocket(url);
			socket.addEventListener("open", () => resolve(socket));
			socket.addEventListener("error", () => resolve(null));
			setTimeout(() => resolve(socket.readyState === WebSocket.OPEN ? socket : null), 5000);
		});
	const next = (socket: WebSocket, predicate: (value: any) => boolean, ms = 3000) =>
		new Promise<any>((resolve) => {
			const onMessage = (event: MessageEvent) => {
				if (typeof event.data !== "string" || event.data === "pong") return;
				let parsed: any;
				try {
					parsed = JSON.parse(event.data);
				} catch {
					return;
				}
				if (!predicate(parsed)) return;
				socket.removeEventListener("message", onMessage);
				resolve(parsed);
			};
			socket.addEventListener("message", onMessage);
			setTimeout(() => resolve(null), ms);
		});

	const offlineResolve = await api(on(NAME, "/api/v1/resolve?slug=inbox"));
	check(
		"no signal token while the Mac is asleep — nothing to negotiate with, and it wakes the DO",
		offlineResolve.body.signal_token === undefined,
		String(offlineResolve.body.signal_token),
	);

	const mac = await open(`${wsBase}/api/v1/ws/device?token=${token}`);
	check("Mac socket connects", mac !== null);
	await new Promise((r) => setTimeout(r, 300));

	const onlineResolve = await api(on(NAME, "/api/v1/resolve?slug=inbox"));
	const signalToken = onlineResolve.body.signal_token as string | undefined;
	check("a signal token is issued once the Mac is awake", typeof signalToken === "string");

	// No upgrade header: the route answers 401 before the Durable Object is ever
	// reached, which is the property being checked. (undici refuses to send one.)
	const forged = await fetch(`${BASE}/api/v1/ws/lan?token=not.a.token`);
	check("a forged signal token is refused", forged.status === 401, String(forged.status));
	const asUpload = await fetch(`${BASE}/api/v1/ws/lan?token=${booked.body.token}`);
	check(
		"an upload token cannot be spent as a signal token — the type is part of the signature",
		asUpload.status === 401,
		String(asUpload.status),
	);

	const sender = signalToken ? await open(`${wsBase}/api/v1/ws/lan?token=${signalToken}`) : null;
	check("send page opens a signalling socket", sender !== null);

	if (mac && sender) {
		// Browser -> Mac. The session id is stamped by the DO from the socket's own
		// attachment, so the sender never chooses it and cannot address another's.
		const offered = next(mac, (event) => event.type === "signal");
		sender.send(JSON.stringify({ type: "signal", payload: { kind: "offer", sdp: "v=0" } }));
		const relayedOffer = await offered;
		check(
			"an offer reaches the Mac",
			relayedOffer?.payload?.sdp === "v=0",
			JSON.stringify(relayedOffer),
		);
		check(
			"and carries a session id the sender never chose",
			typeof relayedOffer?.session === "string" && relayedOffer.session.length > 0,
		);

		// Mac -> browser, addressed by that session id.
		const answered = next(sender, (event) => event.type === "signal");
		mac.send(
			JSON.stringify({
				type: "signal",
				session: relayedOffer.session,
				payload: { kind: "answer", sdp: "v=0-answer" },
			}),
		);
		const relayedAnswer = await answered;
		check(
			"the answer comes back to the send page that offered",
			relayedAnswer?.payload?.sdp === "v=0-answer",
			JSON.stringify(relayedAnswer),
		);

		// A session id the Mac invents reaches nobody: the tag lookup is what makes
		// echoing the id back safe.
		const stray = next(sender, (event) => event.type === "signal", 600);
		mac.send(
			JSON.stringify({ type: "signal", session: "made-up", payload: { kind: "answer" } }),
		);
		check("a made-up session id addresses nobody", (await stray) === null);

		// Cost fence (PRD 8.6 #1): every signalling message wakes the DO, and this
		// socket is reachable by anyone holding the link.
		const oversized = next(mac, (event) => event.type === "signal", 600);
		sender.send(JSON.stringify({ type: "signal", payload: { pad: "x".repeat(9000) } }));
		check("an oversized signalling message is dropped", (await oversized) === null);

		for (let i = 0; i < 70; i++) {
			sender.send(JSON.stringify({ type: "signal", payload: { kind: "ice", i } }));
		}
		await new Promise((r) => setTimeout(r, 400));
		const flooded = next(mac, (event) => event.type === "signal", 600);
		sender.send(JSON.stringify({ type: "signal", payload: { kind: "ice", last: true } }));
		check("a send page past its signalling budget is cut off", (await flooded) === null);

		/*
		 * And the Mac is not charged for it. Its socket is one per device and
		 * lives for as long as the app does, answering every negotiation it is
		 * ever offered — so a budget shared across unrelated transfers would make
		 * LAN work for the first few and then quietly stop. On a fallback path
		 * that failure is invisible: everything keeps working, just slowly.
		 */
		// Past the page's ceiling, deliberately: the number only means something
		// if the Mac has sent more than a send page is allowed to.
		for (let i = 0; i < 70; i++) {
			mac.send(
				JSON.stringify({
					type: "signal",
					session: relayedOffer.session,
					payload: { kind: "ice", i },
				}),
			);
		}
		await new Promise((r) => setTimeout(r, 400));
		const stillAnswering = next(sender, (event) => event.payload?.sdp === "v=0-still-here");
		mac.send(
			JSON.stringify({
				type: "signal",
				session: relayedOffer.session,
				payload: { kind: "answer", sdp: "v=0-still-here" },
			}),
		);
		const late = await stillAnswering;
		check(
			"the Mac's own socket is never rate-limited — it answers for every session",
			late?.payload?.sdp === "v=0-still-here",
			JSON.stringify(late),
		);

		sender.close();
	}
	if (mac) mac.close();
	await new Promise((r) => setTimeout(r, 300));
}

section("A LAN transfer never touches the relay (PRD 8.2, 16.2)");
const lanInboxId = registered.body.inbox.inbox_id as string;
const lanUsedBefore = (await api("/api/v1/licenses/status", { token })).body.relay_used as number;
const lanTransfer = await api("/api/v1/transfers", {
	method: "POST",
	body: JSON.stringify({
		inbox_id: lanInboxId,
		transport: "lan",
		files: [
			{
				enc_name: "x",
				name_iv: "x",
				size: 50 * 1024 * 1024,
				nonce_prefix: "x",
				wrapped_key: "x",
				key_iv: "x",
				eph_pub: "x",
			},
		],
	}),
});
check("a LAN transfer is accepted", lanTransfer.status === 201, JSON.stringify(lanTransfer.body));
const lanUsedAfter = (await api("/api/v1/licenses/status", { token })).body.relay_used as number;
check(
	"and books nothing against the month — PRD 16.2 promises the local path is free",
	lanUsedAfter === lanUsedBefore,
	`${lanUsedBefore} -> ${lanUsedAfter}`,
);
check(
	"it is handed no parts to upload",
	lanTransfer.body.files?.[0]?.part_count === 0,
	String(lanTransfer.body.files?.[0]?.part_count),
);

const lanFileId = lanTransfer.body.files[0].file_id as string;
const lanToken = lanTransfer.body.token as string;
/*
 * The claim `transport: "lan"` is taken from the client, which is only safe
 * because of these two refusals: no multipart upload was created, so a sender
 * who lied to skip the monthly allowance is holding a transfer it cannot put a
 * byte into. This is the check that stands in for trusting the client.
 */
const lanPart = await fetch(
	`${BASE}/api/v1/transfers/${lanTransfer.body.transfer_id}/files/${lanFileId}/parts/1`,
	{
		method: "PUT",
		headers: { authorization: `Bearer ${lanToken}`, "content-length": "16" },
		body: new Uint8Array(16),
	},
);
check(
	"claiming LAN buys no free relay bytes: parts are refused",
	lanPart.status === 400,
	String(lanPart.status),
);
const lanComplete = await api(
	`/api/v1/transfers/${lanTransfer.body.transfer_id}/files/${lanFileId}/complete`,
	{
		method: "POST",
		token: lanToken,
		body: JSON.stringify({ plain_sha256: "0".repeat(64) }),
	},
);
check("and so is completing it over the relay", lanComplete.status === 400, String(lanComplete.status));

// PRD 16.2 — the local path stays open when the paid one has run out. This is
// the whole reason the transport claim skips the allowance check rather than
// merely skipping the booking.
// One byte above the per-file ceiling. Exactly 20 GiB is valid on Pro.
const overBudget = 20 * 1024 * 1024 * 1024 + 1;
const relayOverBudget = await api("/api/v1/transfers", {
	method: "POST",
	body: JSON.stringify({
		inbox_id: lanInboxId,
		files: [
			{
				enc_name: "x",
				name_iv: "x",
				size: overBudget,
				nonce_prefix: "x",
				wrapped_key: "x",
				key_iv: "x",
				eph_pub: "x",
			},
		],
	}),
});
check(
	"a transfer past the file ceiling is still refused over the relay",
	relayOverBudget.status === 400 || relayOverBudget.status === 402 || relayOverBudget.status === 413,
	String(relayOverBudget.status),
);

const lanMeta = await api(`/api/v1/files/${lanFileId}/meta`, { token });
check("the Mac can read a LAN file's envelope before any byte arrives", lanMeta.status === 200);
check(
	"and the inbox it lands in comes from the server, not from the peer",
	lanMeta.body?.file?.inbox_id === lanInboxId,
	JSON.stringify(lanMeta.body),
);
const relayMeta = await api(`/api/v1/files/${booked.body.files?.[0]?.file_id}/meta`, { token });
check(
	"a relay file is not readable through the LAN metadata route",
	relayMeta.status === 404,
	String(relayMeta.status),
);
const unauthenticatedMeta = await api(`/api/v1/files/${lanFileId}/meta`);
check("and the route is device-authenticated", unauthenticatedMeta.status === 401);

// The Mac reports the digest it verified against the bytes it actually landed,
// because on this path nobody else is in a position to.
const lanAck = await api(`/api/v1/files/${lanFileId}/ack`, {
	method: "POST",
	token,
	body: JSON.stringify({ plain_sha256: "a".repeat(64) }),
});
check("acking a LAN file delivers it", lanAck.status === 200 && lanAck.body.delivered === true);
const lanUsedAfterAck = (await api("/api/v1/licenses/status", { token })).body.relay_used as number;
check(
	"delivering it still books nothing",
	lanUsedAfterAck === lanUsedBefore,
	`${lanUsedBefore} -> ${lanUsedAfterAck}`,
);

/*
 * The failure this guards is silent and expensive: `refundRelayBytes` clamps at
 * zero, so refunding a LAN transfer does not produce a negative counter — it
 * quietly spends allowance that a *different* transfer booked in the same
 * month. Booking a relay transfer first is what makes the theft visible.
 */
const guardBooked = await api("/api/v1/transfers", {
	method: "POST",
	body: JSON.stringify({
		inbox_id: lanInboxId,
		files: [
			{
				enc_name: "x",
				name_iv: "x",
				size: 30 * 1024 * 1024,
				nonce_prefix: "x",
				wrapped_key: "x",
				key_iv: "x",
				eph_pub: "x",
			},
		],
	}),
});
const guardUsed = (await api("/api/v1/licenses/status", { token })).body.relay_used as number;
const lanToAbandon = await api("/api/v1/transfers", {
	method: "POST",
	body: JSON.stringify({
		inbox_id: lanInboxId,
		transport: "lan",
		files: [
			{
				enc_name: "x",
				name_iv: "x",
				size: 25 * 1024 * 1024,
				nonce_prefix: "x",
				wrapped_key: "x",
				key_iv: "x",
				eph_pub: "x",
			},
		],
	}),
});
await api(`/api/v1/transfers/${lanToAbandon.body.transfer_id}/abort`, {
	method: "POST",
	token: lanToAbandon.body.token,
});
const guardAfter = (await api("/api/v1/licenses/status", { token })).body.relay_used as number;
check(
	"abandoning a LAN transfer refunds nothing — it never booked anything",
	guardAfter === guardUsed,
	`${guardUsed} -> ${guardAfter}`,
);
await api(`/api/v1/transfers/${guardBooked.body.transfer_id}/abort`, {
	method: "POST",
	token: guardBooked.body.token,
});

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

section("Retention (a record can be forgotten without giving up the address)");
// The state here is exactly the one that matters: one transfer just delivered,
// nothing pending, and an inbox whose address the owner wants to keep.
//
// Add something still in flight, to prove the clear leaves it alone. Declared
// and never uploaded, so it sits in 'uploading' with an object parked for it.
const inFlight = await api("/api/v1/transfers", {
	method: "POST",
	body: JSON.stringify({
		inbox_id: inboxId,
		files: [
			{
				enc_name: "x",
				name_iv: "x",
				size: 1024,
				nonce_prefix: "x",
				wrapped_key: "x",
				key_iv: "x",
				eph_pub: "x",
			},
		],
	}),
});
check("a second transfer is in flight", inFlight.status === 201, JSON.stringify(inFlight.body));

// Read after the booking above, not before it: accepting that transfer books
// its bytes, so a reading taken earlier would show the clear "adding" the
// 1024 bytes the booking added.
const usedBeforeClear = (await api("/api/v1/licenses/status", { token })).body
	.relay_used as number;

const cleared = await api(`/api/v1/inboxes/${inboxId}/transfers`, { method: "DELETE", token });
check(
	"clearing reports what it forgot",
	cleared.status === 200 && cleared.body.cleared >= 1,
	JSON.stringify(cleared.body),
);

const clearedAgain = await api(`/api/v1/inboxes/${inboxId}/transfers`, { method: "DELETE", token });
check(
	"a second clear finds nothing left — the delivered record is really gone",
	clearedAgain.status === 200 && clearedAgain.body.cleared === 0,
	JSON.stringify(clearedAgain.body),
);

const stillThere = await api(`/api/v1/transfers/${inFlight.body.transfer_id}`, {
	token: inFlight.body.token,
});
check(
	"the in-flight transfer survives — its ciphertext is still parked",
	stillThere.status === 200 && stillThere.body.state === "uploading",
	`${stillThere.status} ${JSON.stringify(stillThere.body)}`,
);

const usedAfterClear = (await api("/api/v1/licenses/status", { token })).body
	.relay_used as number;
check(
	"clearing records does not hand back relay bytes",
	usedAfterClear === usedBeforeClear,
	`${usedBeforeClear} -> ${usedAfterClear}`,
);

const stillResolves = await api(on(NAME, "/api/v1/resolve?slug=client-a"));
check(
	"the inbox and its address are untouched — this is the whole difference from delete",
	stillResolves.status === 200 && stillResolves.body.inbox_id === inboxId,
	JSON.stringify(stillResolves.body),
);

const outsider = await register(`${NAME}-x`.slice(0, 20), await makeDevice());
const notYours = await api(`/api/v1/inboxes/${inboxId}/transfers`, {
	method: "DELETE",
	token: outsider.body.token as string,
});
check("another device cannot clear this inbox's records", notYours.status === 404, `${notYours.status}`);

// Put it back the way the rest of the suite expects it: nothing parked, nothing
// booked against the month.
await api(`/api/v1/transfers/${inFlight.body.transfer_id}/abort`, {
	method: "POST",
	token: inFlight.body.token,
});

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

section("The inbox address as an API (curl and agents)");
/*
 * The same URL a person opens, used by a machine. Two things are worth
 * asserting beyond "did it 202": that the file the Mac ends up holding is
 * byte-identical to what curl sent — the Worker is doing the encrypting on this
 * path, so a framing mistake here is a corrupted file rather than a failed
 * request — and that every refusal leaves nothing booked and nothing parked.
 */
const curlAddress = on(NAME, "/client-a");

const capabilities = await api(`${curlAddress}?format=json`);
check("?format=json describes the address", capabilities.status === 200, `${capabilities.status}`);
check("it names the field curl must use", capabilities.body?.upload?.fileField === "file");
check("it carries a command that can be run as-is", /^curl --fail-with-body /.test(capabilities.body?.curl ?? ""));
check(
	"it states the per-file ceiling",
	capabilities.body?.upload?.maxBytesPerRequest === 95 * 1024 * 1024,
	String(capabilities.body?.upload?.maxBytesPerRequest),
);
check("it says one file per request", capabilities.body?.upload?.maxFilesPerRequest === 1);
check(
	"it does not pretend this path is browser-encrypted",
	/not in your browser/.test(capabilities.body?.encryption ?? ""),
);
check(
	"no wildcard CORS — an inbox address must not be probeable cross-origin",
	(await fetch(`${curlAddress}?format=json`)).headers.get("access-control-allow-origin") === null,
);
const viaAccept = await fetch(curlAddress, { headers: { accept: "application/json" } });
check("Accept: application/json works too", viaAccept.status === 200);
const asPage = await fetch(curlAddress);
check(
	"a browser still gets the page",
	asPage.status === 200 && (asPage.headers.get("content-type") ?? "").includes("text/html"),
	asPage.headers.get("content-type") ?? "",
);
const unknownAddress = await api(`${on(NAME, "/no-such-path")}?format=json`);
check("an address that does not exist 404s", unknownAddress.status === 404);
/*
 * `OPTIONS` returns the same document in production and is not asserted here:
 * the Vite dev server answers preflights itself, so the request never reaches
 * the Worker locally. Run the suite against a deployed origin to see it.
 */

/** POSTs a multipart body the way curl does, without shelling out. */
async function curlUpload(
	address: string,
	name: string,
	data: Uint8Array,
	options: { fields?: Array<[string, string]>; trailingField?: boolean; headers?: Record<string, string> } = {},
) {
	const form = new FormData();
	for (const [key, value] of options.fields ?? []) form.append(key, value);
	form.append("file", new Blob([data]), name);
	if (options.trailingField) form.append("note", "after the file");
	const response = await fetch(address, { method: "POST", body: form, headers: options.headers });
	const text = await response.text();
	let body: any = null;
	try {
		body = text ? JSON.parse(text) : null;
	} catch {
		body = text;
	}
	return { status: response.status, body };
}

/** Everything the Mac does with a pending file, ending in an ACK. */
async function collectOne(expected: { name: string; bytes: Uint8Array }) {
	const list = await api("/api/v1/pending", { token });
	const file = list.body.files?.[0];
	if (!file) return { ok: false, reason: "nothing pending" };

	const key = await unwrapContentKey(device.kex.privateKey, file.eph_pub, file.key_iv, file.wrapped_key);
	const name = await decryptName(key, file.enc_name, file.name_iv);
	const response = await fetch(`${BASE}/api/v1/files/${file.file_id}/content`, {
		headers: { authorization: `Bearer ${token}` },
	});
	const ciphertext = new Uint8Array(await response.arrayBuffer());

	const total = chunkCountFor(expected.bytes.length);
	const plain = new Uint8Array(expected.bytes.length);
	let read = 0;
	let written = 0;
	for (let index = 0; index < total; index++) {
		const length = Math.min(CHUNK_SIZE, expected.bytes.length - index * CHUNK_SIZE) + 16;
		const chunk = await decryptChunk(key, {
			noncePrefix: fromBase64Url(file.nonce_prefix),
			fileIdBytes: fileIdBytes(file.file_id),
			index,
			total,
			ciphertext: ciphertext.subarray(read, read + length),
		});
		plain.set(chunk, written);
		read += length;
		written += chunk.length;
	}

	const digest = toHex(await crypto.subtle.digest("SHA-256", plain));
	await api(`/api/v1/files/${file.file_id}/ack`, { method: "POST", token });
	return {
		ok: true,
		name,
		framingOk: ciphertext.length === cipherSizeFor(expected.bytes.length),
		identical: digest === toHex(await crypto.subtle.digest("SHA-256", expected.bytes)),
		hashMatches: digest === file.plain_sha256,
		nameOk: name === expected.name,
	};
}

/** `getRandomValues` refuses more than 64 KiB in one call. */
function randomBytes(length: number): Uint8Array {
	const out = new Uint8Array(length);
	for (let at = 0; at < length; at += 65536) {
		crypto.getRandomValues(out.subarray(at, Math.min(length, at + 65536)));
	}
	return out;
}

// Two chunks and a partial third, so the chunk count bound into every AAD is
// something the Worker had to get right rather than a constant 1.
const curlBytes = randomBytes(2 * CHUNK_SIZE + 4096);
const curlSent = await curlUpload(curlAddress, "季度报告 ✅.bin", curlBytes);
check("a multipart POST to the address is accepted", curlSent.status === 202, JSON.stringify(curlSent.body).slice(0, 200));
check("it answers with what it took", curlSent.body?.file?.size === curlBytes.length, String(curlSent.body?.file?.size));
check(
	"the reply says accepted rather than delivered",
	/^Accepted\./.test(curlSent.body?.message ?? ""),
	String(curlSent.body?.message),
);

const collected = await collectOne({ name: "季度报告 ✅.bin", bytes: curlBytes });
check("the Mac finds it waiting", collected.ok, collected.reason ?? "");
check("the filename the Worker encrypted decrypts on the Mac", collected.nameOk, String(collected.name));
check("the ciphertext matches the wire format's framing", collected.framingOk);
check("what the Mac decrypts is byte-identical to what was posted", collected.identical);
check("the plaintext digest the Worker recorded is the real one", collected.hashMatches);

// A genuine curl, not an approximation of one. The whole point of this path is
// that the client is a program nobody here wrote, so at least one check has to
// go through the real thing.
const realCurlFile = `${tmpdir()}/stolnk-e2e-${Math.random().toString(36).slice(2)}.bin`;
const realCurlBytes = randomBytes(48_000);
writeFileSync(realCurlFile, realCurlBytes);
let realCurlStatus = "";
try {
	realCurlStatus = execFileSync(
		"curl",
		["-s", "-o", "/dev/null", "-w", "%{http_code}", "-F", `file=@${realCurlFile}`, curlAddress],
		{ encoding: "utf8" },
	).trim();
} catch (error) {
	realCurlStatus = String(error);
} finally {
	rmSync(realCurlFile, { force: true });
}
check("real curl -F uploads to the address", realCurlStatus === "202", realCurlStatus);
const realCollected = await collectOne({
	name: realCurlFile.split("/").pop() as string,
	bytes: realCurlBytes,
});
check("and what real curl sent arrives intact", realCollected.identical && realCollected.nameOk);

// Everything above has been collected and acknowledged, so the ledger is back
// where it started and each refusal below has to leave it there.
const usedBeforeCurl = (await api("/api/v1/licenses/status", { token })).body.relay_used as number;

const refusals: Array<[string, () => Promise<number>]> = [
	[
		"a body that is not multipart",
		async () =>
			(await fetch(curlAddress, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }))
				.status,
	],
	[
		"a multipart body with no file in it",
		async () => {
			const form = new FormData();
			form.append("note", "hello");
			return (await fetch(curlAddress, { method: "POST", body: form })).status;
		},
	],
	[
		"a body with no Content-Length at all",
		async () =>
			(
				await fetch(curlAddress, {
					method: "POST",
					headers: { "content-type": "multipart/form-data; boundary=zzz" },
					body: new ReadableStream({
						start(controller) {
							controller.enqueue(new TextEncoder().encode("--zzz--\r\n"));
							controller.close();
						},
					}),
					// @ts-expect-error — Node needs this to stream a request body.
					duplex: "half",
				})
			).status,
	],
];
for (const [name, run] of refusals) {
	const status = await run();
	check(`${name} is refused`, status === 400, String(status));
}

// The size is derived from Content-Length on the assumption that the file is
// the last part; a field after it breaks that, and the check that catches it is
// the one standing between a wrong chunk count and a file that lands short.
const trailing = await curlUpload(curlAddress, "late.bin", new Uint8Array(4096), { trailingField: true });
check("a field after the file is refused, not truncated", trailing.status === 400, JSON.stringify(trailing.body));

/*
 * The ceiling is read off `Content-Length` before the body is touched, so in
 * production a 96 MiB upload is refused without 96 MiB crossing the wire. That
 * half cannot be shown here: the dev server buffers the whole request before
 * the Worker sees it, so claiming a length and not sending it just hangs. What
 * is checked is the part that matters either way — that a body over the ceiling
 * is refused at all — and it needs a real 96 MiB body, so it is behind the same
 * flag as the other big-file case.
 */
if (process.env.E2E_BIG === "1") {
	const hugeFile = `${tmpdir()}/stolnk-e2e-huge-${Math.random().toString(36).slice(2)}.bin`;
	writeFileSync(hugeFile, Buffer.alloc(96 * 1024 * 1024));
	let ceilingStatus = "";
	try {
		ceilingStatus = execFileSync(
			"curl",
			["-s", "-o", "/dev/null", "-w", "%{http_code}", "-F", `file=@${hugeFile}`, curlAddress],
			{ encoding: "utf8" },
		).trim();
	} catch (error) {
		ceilingStatus = String(error);
	} finally {
		rmSync(hugeFile, { force: true });
	}
	check("a body over the ceiling is refused", ceilingStatus === "413", ceilingStatus);
}

const nothingPending = await api("/api/v1/pending", { token });
check("no refusal left anything parked", nothingPending.body.files.length === 0, JSON.stringify(nothingPending.body.files));
const usedAfterRefusals = (await api("/api/v1/licenses/status", { token })).body.relay_used as number;
check(
	"and none of them booked relay bytes that were never delivered",
	usedAfterRefusals === usedBeforeCurl,
	`${usedBeforeCurl} -> ${usedAfterRefusals}`,
);

// A password, which curl cannot derive a verifier for — so the server does it,
// and it accepts the raw password either as a field before the file or as a
// header, the latter because field order is a bad thing to make someone
// discover after transferring a whole file.
const curlSalt = (await api(`/api/v1/inboxes/${inboxId}/password-salt`, { method: "POST", token })).body
	.salt as string;
async function curlVerifier(password: string): Promise<string> {
	const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, [
		"deriveBits",
	]);
	const bits = await crypto.subtle.deriveBits(
		{ name: "PBKDF2", hash: "SHA-256", salt: fromBase64Url(curlSalt), iterations: 210_000 },
		key,
		256,
	);
	return toHex(new Uint8Array(bits));
}
await api(`/api/v1/inboxes/${inboxId}`, {
	method: "PATCH",
	token,
	body: JSON.stringify({ password: await curlVerifier("hunter2"), password_salt: curlSalt }),
});

const lockedCapabilities = await api(`${curlAddress}?format=json`);
check("the capability document names the password field", lockedCapabilities.body?.upload?.passwordField === "password");
check(
	"and its curl command includes one",
	/-F "password=/.test(lockedCapabilities.body?.curl ?? ""),
	String(lockedCapabilities.body?.curl),
);
check(
	"no password is refused",
	(await curlUpload(curlAddress, "a.bin", new Uint8Array([1]))).status === 401,
);
check(
	"the wrong password is refused",
	(await curlUpload(curlAddress, "a.bin", new Uint8Array([1]), { fields: [["password", "nope"]] })).status === 401,
);
const withField = await curlUpload(curlAddress, "field.bin", new Uint8Array([1, 2, 3]), {
	fields: [["password", "hunter2"]],
});
check("a password field before the file is accepted", withField.status === 202, JSON.stringify(withField.body));
await api(`/api/v1/files/${(await api("/api/v1/pending", { token })).body.files[0].file_id}/ack`, {
	method: "POST",
	token,
});
const withHeader = await curlUpload(curlAddress, "header.bin", new Uint8Array([1, 2, 3]), {
	headers: { "x-stolnk-password": "hunter2" },
});
check("and so is an X-Stolnk-Password header", withHeader.status === 202, JSON.stringify(withHeader.body));
await api(`/api/v1/files/${(await api("/api/v1/pending", { token })).body.files[0].file_id}/ack`, {
	method: "POST",
	token,
});
await api(`/api/v1/inboxes/${inboxId}`, { method: "PATCH", token, body: JSON.stringify({ password: null }) });

await api(`/api/v1/inboxes/${inboxId}`, { method: "PATCH", token, body: JSON.stringify({ paused: true }) });
check(
	"a paused inbox refuses this door too",
	(await curlUpload(curlAddress, "p.bin", new Uint8Array([1]))).status === 423,
);
await api(`/api/v1/inboxes/${inboxId}`, { method: "PATCH", token, body: JSON.stringify({ paused: false }) });

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
