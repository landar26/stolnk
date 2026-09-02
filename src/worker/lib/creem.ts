import { fail } from "./http";

/**
 * The Creem side of PRD 16.5.
 *
 * Creem is the merchant of record — it takes the money and files the VAT in
 * several dozen jurisdictions, which is the part a solo developer genuinely
 * cannot do — and it also issues and counts the licence keys, so the seat limit
 * in PRD 16.1 is enforced by the same system that sold the seat.
 *
 * Everything in this file runs on the Mac's own request or on a webhook. It is
 * never reached from the send path: see lib/entitlement.ts for why entitlement
 * is a local read.
 *
 * The API key is a Worker secret. It is deliberately not shipped to the Mac
 * app, which is why activation is Mac -> Worker -> Creem rather than the app
 * talking to Creem directly: a key inside a downloadable binary is a public key.
 */

const DEFAULT_BASE = "https://api.creem.io";

export interface CreemLicense {
	id: string;
	status: string;
	activation: number;
	activation_limit: number | null;
	instance?: { id: string } | null;
}

async function call<T>(env: Env, path: string, body: unknown): Promise<T> {
	if (!env.CREEM_API_KEY) {
		fail(503, "not_configured", "Purchases are not set up on this server.");
	}
	const base = env.CREEM_API_BASE || DEFAULT_BASE;
	let response: Response;
	try {
		response = await fetch(`${base}${path}`, {
			method: "POST",
			headers: { "content-type": "application/json", "x-api-key": env.CREEM_API_KEY },
			body: JSON.stringify(body),
		});
	} catch {
		// Creem unreachable. 503 and not 4xx: the licence may be perfectly good,
		// and telling someone their key is invalid because of a network blip is
		// the one failure mode that generates support mail (PRD 19 risk 10).
		fail(503, "upstream_unavailable", "Could not reach the licence server. Try again shortly.");
	}
	if (!response.ok) {
		const detail = await response.text().catch(() => "");
		throw new CreemError(response.status, detail);
	}
	return (await response.json()) as T;
}

export class CreemError extends Error {
	constructor(
		readonly status: number,
		readonly detail: string,
	) {
		super(`creem ${status}: ${detail}`);
	}
}

/** Claims a seat. `instanceName` is what the customer portal will show. */
export function activate(env: Env, key: string, instanceName: string): Promise<CreemLicense> {
	return call<CreemLicense>(env, "/v1/licenses/activate", {
		key,
		instance_name: instanceName,
	});
}

/** Releases a seat, so a replaced Mac does not hold one forever (PRD 7.2). */
export function deactivate(env: Env, key: string, instanceId: string): Promise<CreemLicense> {
	return call<CreemLicense>(env, "/v1/licenses/deactivate", { key, instance_id: instanceId });
}

/*
 * Creem also offers /v1/licenses/validate, and it is deliberately not wrapped
 * here: it takes the licence *key*, and this server stores only a hash of it.
 * See the note on revocation in lib/entitlement.ts — holding keys in
 * recoverable form purely to enable a polling backstop is a worse trade than
 * not having the backstop.
 */

/**
 * Verifies the `creem-signature` header over the raw request body.
 *
 * Raw, not re-serialised: `JSON.stringify(await req.json())` produces different
 * bytes than arrived (key order, number formatting, whitespace) and would fail
 * against any correct signature.
 */
export async function signatureValid(
	secret: string,
	rawBody: string,
	header: string | null,
): Promise<boolean> {
	if (!secret || !header) return false;
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
	const expected = [...new Uint8Array(mac)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
	return timingSafeEqual(expected, header.trim().toLowerCase());
}

/** Constant time in the length-matched case, which is the one that matters. */
function timingSafeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}

/** SHA-256 of a licence key, hex. The key itself is never stored. */
export async function keyHash(key: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key.trim()));
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
