import { fromBase64Url, randomId, timingSafeEqual } from "./bytes";

/**
 * PRD 18 requires that the inbox password never reaches the server in the
 * clear. The browser derives a verifier with PBKDF2 over a public per-inbox
 * salt and sends only that; the server stores SHA-256(verifier).
 *
 * So a database leak yields neither the password nor anything directly
 * replayable, and the server never sees the password itself. This is not a PAKE
 * — an attacker who records a request can replay that verifier — which is why
 * verifiers are scoped to a short-lived upload session rather than reused.
 */

export const PBKDF2_ITERATIONS = 210_000;

export function newSalt(): string {
	return randomId(16);
}

export async function hashVerifier(verifier: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(verifier) as BufferSource,
	);
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function verifierMatches(verifier: string, storedHash: string): Promise<boolean> {
	const encoder = new TextEncoder();
	const computed = await hashVerifier(verifier);
	return timingSafeEqual(encoder.encode(computed), encoder.encode(storedHash));
}

/** Server-side mirror of the browser's derivation, used by the e2e tests. */
export async function deriveVerifier(password: string, salt: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(password) as BufferSource,
		"PBKDF2",
		false,
		["deriveBits"],
	);
	const bits = await crypto.subtle.deriveBits(
		{
			name: "PBKDF2",
			hash: "SHA-256",
			salt: fromBase64Url(salt) as BufferSource,
			iterations: PBKDF2_ITERATIONS,
		},
		key,
		256,
	);
	return [...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
