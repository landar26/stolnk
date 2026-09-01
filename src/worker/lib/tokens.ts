import { fromBase64Url, timingSafeEqual, toBase64Url } from "./bytes";

/**
 * Compact HMAC-signed tokens: base64url(payload) "." base64url(mac).
 *
 * A JWT library would buy nothing here — there is exactly one issuer, one
 * verifier, and one algorithm, and keeping the dependency list short is part of
 * the auditability promise in PRD 9.4.
 */

export interface DeviceToken {
	t: "device";
	sub: string;
	exp: number;
}

/** Authorises a browser to push parts into one specific transfer. */
export interface UploadToken {
	t: "upload";
	transfer: string;
	inbox: string;
	session: string;
	exp: number;
}

export type TokenPayload = DeviceToken | UploadToken;

const encoder = new TextEncoder();
const keyCache = new Map<string, Promise<CryptoKey>>();

function hmacKey(secret: string): Promise<CryptoKey> {
	let cached = keyCache.get(secret);
	if (!cached) {
		cached = crypto.subtle.importKey(
			"raw",
			encoder.encode(secret),
			{ name: "HMAC", hash: "SHA-256" },
			false,
			["sign", "verify"],
		);
		keyCache.set(secret, cached);
	}
	return cached;
}

export async function signToken(secret: string, payload: TokenPayload): Promise<string> {
	const body = toBase64Url(encoder.encode(JSON.stringify(payload)));
	const mac = await crypto.subtle.sign("HMAC", await hmacKey(secret), encoder.encode(body));
	return `${body}.${toBase64Url(mac)}`;
}

export async function verifyToken<T extends TokenPayload>(
	secret: string,
	token: string | undefined | null,
	type: T["t"],
): Promise<T | null> {
	if (!token) return null;
	const dot = token.indexOf(".");
	if (dot < 1) return null;
	const body = token.slice(0, dot);
	const mac = token.slice(dot + 1);

	let expected: ArrayBuffer;
	try {
		expected = await crypto.subtle.sign("HMAC", await hmacKey(secret), encoder.encode(body));
	} catch {
		return null;
	}
	let provided: Uint8Array;
	try {
		provided = fromBase64Url(mac);
	} catch {
		return null;
	}
	if (!timingSafeEqual(new Uint8Array(expected), provided)) return null;

	let payload: TokenPayload;
	try {
		payload = JSON.parse(new TextDecoder().decode(fromBase64Url(body)));
	} catch {
		return null;
	}
	if (payload.t !== type) return null;
	if (typeof payload.exp !== "number" || payload.exp < Date.now()) return null;
	return payload as T;
}

/** Reads a bearer token out of the Authorization header. */
export function bearer(request: Request): string | null {
	const header = request.headers.get("authorization");
	if (!header?.toLowerCase().startsWith("bearer ")) return null;
	return header.slice(7).trim() || null;
}
