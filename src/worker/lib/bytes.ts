/** Byte and encoding helpers shared by every worker module. */

export function toBase64Url(bytes: ArrayBuffer | Uint8Array): string {
	const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
	let binary = "";
	for (let i = 0; i < view.length; i++) binary += String.fromCharCode(view[i]);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64Url(text: string): Uint8Array {
	const padded = text.replace(/-/g, "+").replace(/_/g, "/");
	const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
	const out = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
	return out;
}

export function toHex(bytes: ArrayBuffer | Uint8Array): string {
	const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
	return Array.from(view, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function randomBytes(length: number): Uint8Array {
	const out = new Uint8Array(length);
	crypto.getRandomValues(out);
	return out;
}

/**
 * Random identifier with at least 128 bits of entropy.
 * PRD 13.1 treats the URL itself as a capability, so unguessability is the
 * whole security property here.
 */
export function randomId(bytes = 16): string {
	return toBase64Url(randomBytes(bytes));
}

/**
 * A random inbox path, ~130 bits over an alphabet that satisfies `SLUG_RE`.
 *
 * `randomId` is base64url — it contains uppercase letters and `_`, neither of
 * which is a legal slug. Reset used to write one anyway and got away with it
 * only because nothing normalised the address on the way back in. Hostnames are
 * case-insensitive, so slugs are canonically lowercase, and a reset link has to
 * survive that.
 */
const SLUG_ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789";

export function randomSlug(length = 26): string {
	const bytes = randomBytes(length);
	let out = "";
	for (let i = 0; i < length; i++) out += SLUG_ALPHABET[bytes[i] % SLUG_ALPHABET.length];
	return out;
}

/** Comparison whose duration does not depend on where the mismatch is. */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
	return diff === 0;
}

export async function sha256Hex(input: Uint8Array | string): Promise<string> {
	const data = typeof input === "string" ? new TextEncoder().encode(input) : input;
	return toHex(await crypto.subtle.digest("SHA-256", data as BufferSource));
}
