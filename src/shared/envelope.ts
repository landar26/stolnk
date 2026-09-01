/**
 * The v1 envelope, implemented once for the browser sender and the Node test
 * harness. See docs/wire-format.md — that document, not this file, is the
 * contract the Swift receiver is written against.
 *
 * Only WebCrypto is used, so this runs unchanged in browsers, Workers and Node.
 */

export const CHUNK_SIZE = 1024 * 1024;
export const TAG_SIZE = 16;
export const KEK_INFO = "stolnk/v1/kek";

export function toBase64Url(bytes: Uint8Array | ArrayBuffer): string {
	const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
	let binary = "";
	for (let i = 0; i < view.length; i += 0x8000) {
		binary += String.fromCharCode(...view.subarray(i, i + 0x8000));
	}
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64Url(text: string): Uint8Array {
	const padded = text.replace(/-/g, "+").replace(/_/g, "/");
	const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
	const out = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
	return out;
}

export function toHex(bytes: Uint8Array | ArrayBuffer): string {
	const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
	return Array.from(view, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function cipherSizeFor(plainSize: number): number {
	return plainSize + chunkCountFor(plainSize) * TAG_SIZE;
}

export function chunkCountFor(plainSize: number): number {
	return Math.max(1, Math.ceil(plainSize / CHUNK_SIZE));
}

/** 12-byte nonce: 4-byte per-file prefix then the big-endian chunk index. */
export function chunkNonce(prefix: Uint8Array, index: number): Uint8Array {
	const nonce = new Uint8Array(12);
	nonce.set(prefix.subarray(0, 4), 0);
	new DataView(nonce.buffer).setBigUint64(4, BigInt(index), false);
	return nonce;
}

/**
 * AAD binds each chunk to its position and to the total count, so neither
 * reordering nor truncation can go unnoticed (PRD 9.2).
 */
export function chunkAad(fileIdBytes: Uint8Array, index: number, total: number): Uint8Array {
	const aad = new Uint8Array(fileIdBytes.length + 8);
	aad.set(fileIdBytes, 0);
	const view = new DataView(aad.buffer, fileIdBytes.length);
	view.setUint32(0, index, false);
	view.setUint32(4, total, false);
	return aad;
}

export interface FileEnvelope {
	wrapped_key: string;
	key_iv: string;
	eph_pub: string;
	nonce_prefix: string;
}

/**
 * Wraps a fresh content key to the Mac's ECDH public key. The ephemeral
 * keypair means the sender never needs an identity of its own — PRD principle
 * #1, the sender has no account and installs nothing.
 */
export async function sealContentKey(
	kexPubRaw: string,
	contentKey: CryptoKey,
): Promise<FileEnvelope> {
	const recipient = await crypto.subtle.importKey(
		"raw",
		fromBase64Url(kexPubRaw) as BufferSource,
		{ name: "ECDH", namedCurve: "P-256" },
		false,
		[],
	);
	const ephemeral = await crypto.subtle.generateKey(
		{ name: "ECDH", namedCurve: "P-256" },
		true,
		["deriveBits"],
	);

	const shared = await crypto.subtle.deriveBits(
		{ name: "ECDH", public: recipient },
		ephemeral.privateKey,
		256,
	);
	const kek = await deriveKek(new Uint8Array(shared));

	const keyIv = crypto.getRandomValues(new Uint8Array(12));
	const rawContentKey = await crypto.subtle.exportKey("raw", contentKey);
	const wrapped = await crypto.subtle.encrypt(
		{ name: "AES-GCM", iv: keyIv as BufferSource },
		kek,
		rawContentKey,
	);

	return {
		wrapped_key: toBase64Url(new Uint8Array(wrapped)),
		key_iv: toBase64Url(keyIv),
		eph_pub: toBase64Url(
			new Uint8Array(await crypto.subtle.exportKey("raw", ephemeral.publicKey)),
		),
		nonce_prefix: toBase64Url(crypto.getRandomValues(new Uint8Array(4))),
	};
}

export async function deriveKek(sharedSecret: Uint8Array): Promise<CryptoKey> {
	const ikm = await crypto.subtle.importKey("raw", sharedSecret as BufferSource, "HKDF", false, [
		"deriveKey",
	]);
	return crypto.subtle.deriveKey(
		{
			name: "HKDF",
			hash: "SHA-256",
			salt: new Uint8Array(0) as BufferSource,
			info: new TextEncoder().encode(KEK_INFO) as BufferSource,
		},
		ikm,
		{ name: "AES-GCM", length: 256 },
		false,
		["encrypt", "decrypt"],
	);
}

export async function newContentKey(): Promise<CryptoKey> {
	return crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, [
		"encrypt",
		"decrypt",
	]);
}

export async function importContentKey(raw: Uint8Array): Promise<CryptoKey> {
	return crypto.subtle.importKey("raw", raw as BufferSource, { name: "AES-GCM" }, true, [
		"encrypt",
		"decrypt",
	]);
}

export async function encryptName(
	contentKey: CryptoKey,
	name: string,
): Promise<{ enc_name: string; name_iv: string }> {
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const ct = await crypto.subtle.encrypt(
		{ name: "AES-GCM", iv: iv as BufferSource },
		contentKey,
		new TextEncoder().encode(name) as BufferSource,
	);
	return { enc_name: toBase64Url(new Uint8Array(ct)), name_iv: toBase64Url(iv) };
}

export async function decryptName(
	contentKey: CryptoKey,
	encName: string,
	nameIv: string,
): Promise<string> {
	const plain = await crypto.subtle.decrypt(
		{ name: "AES-GCM", iv: fromBase64Url(nameIv) as BufferSource },
		contentKey,
		fromBase64Url(encName) as BufferSource,
	);
	return new TextDecoder().decode(plain);
}

export async function encryptChunk(
	contentKey: CryptoKey,
	options: {
		noncePrefix: Uint8Array;
		fileIdBytes: Uint8Array;
		index: number;
		total: number;
		plaintext: Uint8Array;
	},
): Promise<Uint8Array> {
	const ct = await crypto.subtle.encrypt(
		{
			name: "AES-GCM",
			iv: chunkNonce(options.noncePrefix, options.index) as BufferSource,
			additionalData: chunkAad(options.fileIdBytes, options.index, options.total) as BufferSource,
			tagLength: 128,
		},
		contentKey,
		options.plaintext as BufferSource,
	);
	return new Uint8Array(ct);
}

export async function decryptChunk(
	contentKey: CryptoKey,
	options: {
		noncePrefix: Uint8Array;
		fileIdBytes: Uint8Array;
		index: number;
		total: number;
		ciphertext: Uint8Array;
	},
): Promise<Uint8Array> {
	const plain = await crypto.subtle.decrypt(
		{
			name: "AES-GCM",
			iv: chunkNonce(options.noncePrefix, options.index) as BufferSource,
			additionalData: chunkAad(options.fileIdBytes, options.index, options.total) as BufferSource,
			tagLength: 128,
		},
		contentKey,
		options.ciphertext as BufferSource,
	);
	return new Uint8Array(plain);
}

/**
 * A file id is 16 random bytes rendered as base64url; the AAD binds the raw
 * bytes rather than the text, so both ends must agree on this decoding.
 */
export function fileIdBytes(fileId: string): Uint8Array {
	const bytes = fromBase64Url(fileId);
	if (bytes.length === 16) return bytes;
	const out = new Uint8Array(16);
	out.set(bytes.subarray(0, 16));
	return out;
}
