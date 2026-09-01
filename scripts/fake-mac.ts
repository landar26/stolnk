/**
 * A headless stand-in for the Mac app, for driving the browser send page during
 * development.
 *
 *   node --experimental-strip-types scripts/fake-mac.ts <destination-folder>
 *
 * It registers a device, prints the inbox URL, then does what the real receiver
 * does: pull, decrypt, verify, write. It exists so the browser upload path can
 * be exercised end to end without building and launching the app.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
	CHUNK_SIZE,
	chunkCountFor,
	decryptChunk,
	decryptName,
	deriveKek,
	fileIdBytes,
	fromBase64Url,
	importContentKey,
	toBase64Url,
	toHex,
} from "../src/shared/envelope.ts";

const BASE = process.env.E2E_BASE ?? "http://localhost:5173";
const DESTINATION = resolve(process.argv[2] ?? "./received");
mkdirSync(DESTINATION, { recursive: true });

// Identity is persisted so restarting the process is "the Mac woke up" rather
// than "a different Mac appeared" — which is what makes the offline delivery
// path testable.
const STATE_FILE = resolve(DESTINATION, ".fake-mac.json");

async function generateIdentity() {
	const sig = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
		"sign",
		"verify",
	]);
	const kex = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
		"deriveBits",
	]);
	return { sig, kex };
}

async function importIdentity(saved: any) {
	const sigPrivate = await crypto.subtle.importKey(
		"jwk", saved.sig, { name: "ECDSA", namedCurve: "P-256" }, true, ["sign"]);
	const kexPrivate = await crypto.subtle.importKey(
		"jwk", saved.kex, { name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
	const publicOf = async (jwk: any, algorithm: any, usages: KeyUsage[]) =>
		crypto.subtle.importKey(
			"jwk", { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, ext: true }, algorithm, true, usages);
	return {
		sig: {
			privateKey: sigPrivate,
			publicKey: await publicOf(saved.sig, { name: "ECDSA", namedCurve: "P-256" }, ["verify"]),
		},
		kex: {
			privateKey: kexPrivate,
			publicKey: await publicOf(saved.kex, { name: "ECDH", namedCurve: "P-256" }, []),
		},
	};
}

const persisted = existsSync(STATE_FILE)
	? JSON.parse(readFileSync(STATE_FILE, "utf8"))
	: null;
const { sig, kex } = persisted ? await importIdentity(persisted) : await generateIdentity();

async function api(path: string, options: RequestInit & { token?: string } = {}) {
	const headers = new Headers(options.headers);
	if (options.token) headers.set("authorization", `Bearer ${options.token}`);
	if (typeof options.body === "string") headers.set("content-type", "application/json");
	const response = await fetch(`${BASE}${path}`, { ...options, headers });
	const text = await response.text();
	return { status: response.status, body: text ? JSON.parse(text) : null };
}

let deviceId: string;
let token: string;
let deviceName: string;

if (persisted) {
	deviceId = persisted.device_id;
	deviceName = persisted.name;
	const challenge = await api(`/api/v1/devices/${deviceId}/challenge`);
	const signature = await crypto.subtle.sign(
		{ name: "ECDSA", hash: "SHA-256" },
		sig.privateKey,
		new TextEncoder().encode(challenge.body.nonce),
	);
	const authed = await api(`/api/v1/devices/${deviceId}/auth`, {
		method: "POST",
		body: JSON.stringify({
			nonce: challenge.body.nonce,
			signature: toBase64Url(new Uint8Array(signature)),
		}),
	});
	token = authed.body.token;
	console.log("woke up as an existing Mac");
} else {
	deviceName = `dev-${Math.random().toString(36).slice(2, 8)}`;
	const registered = await api("/api/v1/devices", {
		method: "POST",
		body: JSON.stringify({
			name: deviceName,
			slug: "inbox",
			pubkey_sig: toBase64Url(new Uint8Array(await crypto.subtle.exportKey("raw", sig.publicKey))),
			pubkey_kex: toBase64Url(new Uint8Array(await crypto.subtle.exportKey("raw", kex.publicKey))),
			display_name: "Ryan's Mac",
		}),
	});
	deviceId = registered.body.device_id;
	token = registered.body.token;

	writeFileSync(
		STATE_FILE,
		JSON.stringify(
			{
				device_id: deviceId,
				name: deviceName,
				sig: await crypto.subtle.exportKey("jwk", sig.privateKey),
				kex: await crypto.subtle.exportKey("jwk", kex.privateKey),
			},
			null,
			"\t",
		),
	);
}

const { protocol, host } = new URL(BASE);
console.log(`inbox   ${protocol}//${deviceName}.${host}/inbox`);
console.log(`folder  ${DESTINATION}`);
console.log("waiting for files… (ctrl-c to stop)");

// Presence: with this socket open the send page shows "Online"; kill the
// process and it shows "Mac is asleep" while still accepting uploads.
const socket = new WebSocket(`${BASE.replace("http", "ws")}/api/v1/ws/device?token=${token}`);
socket.addEventListener("message", (event) => {
	if (typeof event.data === "string" && event.data.includes("file.ready")) void collect();
});

async function collect(): Promise<void> {
	const pending = await api("/api/v1/pending", { token });
	if (pending.status === 401) {
		const challenge = await api(`/api/v1/devices/${deviceId}/challenge`);
		const signature = await crypto.subtle.sign(
			{ name: "ECDSA", hash: "SHA-256" },
			sig.privateKey,
			new TextEncoder().encode(challenge.body.nonce),
		);
		const authed = await api(`/api/v1/devices/${deviceId}/auth`, {
			method: "POST",
			body: JSON.stringify({
				nonce: challenge.body.nonce,
				signature: toBase64Url(new Uint8Array(signature)),
			}),
		});
		token = authed.body.token;
		return collect();
	}

	for (const file of pending.body?.files ?? []) {
		if (file.needs_confirmation) {
			await api(`/api/v1/files/${file.file_id}/accept`, {
				method: "POST",
				token,
				body: JSON.stringify({ always: true }),
			});
		}

		const ephemeral = await crypto.subtle.importKey(
			"raw",
			fromBase64Url(file.eph_pub),
			{ name: "ECDH", namedCurve: "P-256" },
			false,
			[],
		);
		const shared = await crypto.subtle.deriveBits(
			{ name: "ECDH", public: ephemeral },
			kex.privateKey,
			256,
		);
		const kek = await deriveKek(new Uint8Array(shared));
		const rawKey = await crypto.subtle.decrypt(
			{ name: "AES-GCM", iv: fromBase64Url(file.key_iv) },
			kek,
			fromBase64Url(file.wrapped_key),
		);
		const contentKey = await importContentKey(new Uint8Array(rawKey));
		const name = await decryptName(contentKey, file.enc_name, file.name_iv);

		const response = await fetch(`${BASE}/api/v1/files/${file.file_id}/content`, {
			headers: { authorization: `Bearer ${token}` },
		});
		const ciphertext = new Uint8Array(await response.arrayBuffer());

		const total = chunkCountFor(file.size);
		const plaintext = new Uint8Array(file.size);
		let readAt = 0;
		let writeAt = 0;
		for (let index = 0; index < total; index++) {
			const length = Math.min(CHUNK_SIZE, file.size - index * CHUNK_SIZE) + 16;
			const chunk = await decryptChunk(contentKey, {
				noncePrefix: fromBase64Url(file.nonce_prefix),
				fileIdBytes: fileIdBytes(file.file_id),
				index,
				total,
				ciphertext: ciphertext.subarray(readAt, readAt + length),
			});
			plaintext.set(chunk, writeAt);
			readAt += length;
			writeAt += chunk.length;
		}

		const digest = toHex(await crypto.subtle.digest("SHA-256", plaintext));
		if (digest !== file.plain_sha256) {
			console.error(`✕ ${name}: digest mismatch, discarded`);
			continue;
		}

		// Real receiver sanitises the name; this stand-in only strips separators.
		writeFileSync(resolve(DESTINATION, name.replace(/[/\\:]/g, "")), plaintext);
		await api(`/api/v1/files/${file.file_id}/ack`, { method: "POST", token });
		console.log(`✓ ${name} · ${plaintext.length} bytes · sha256 ok`);
	}
}

setInterval(() => void collect(), 3000);
