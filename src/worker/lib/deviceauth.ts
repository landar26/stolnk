import { CHALLENGE_TTL_MS, DEVICE_TOKEN_TTL_MS } from "../limits";
import { fromBase64Url, randomId } from "./bytes";
import { unauthorized, unknownDevice } from "./http";
import { bearer, signToken, verifyToken, type DeviceToken } from "./tokens";

/**
 * Devices authenticate by signing a server nonce with the Secure Enclave key
 * they registered (PRD 9.1). There is no password anywhere in this flow, which
 * is what lets onboarding stay under 20 seconds with no input fields (PRD 7.1).
 *
 * Wire format note: the signature is raw r||s (64 bytes), which is exactly what
 * CryptoKit's `ECDSASignature.rawRepresentation` produces. DER would need
 * transcoding on one side or the other.
 */

export async function verifySignature(
	publicKeyRaw: string,
	message: Uint8Array,
	signature: Uint8Array,
): Promise<boolean> {
	let key: CryptoKey;
	try {
		key = await crypto.subtle.importKey(
			"raw",
			fromBase64Url(publicKeyRaw) as BufferSource,
			{ name: "ECDSA", namedCurve: "P-256" },
			false,
			["verify"],
		);
	} catch {
		return false;
	}
	if (signature.length !== 64) return false;
	try {
		return await crypto.subtle.verify(
			{ name: "ECDSA", hash: "SHA-256" },
			key,
			signature as BufferSource,
			message as BufferSource,
		);
	} catch {
		return false;
	}
}

export async function issueChallenge(env: Env, deviceId: string): Promise<string> {
	const nonce = randomId(32);
	await env.DB.prepare("INSERT INTO challenges (nonce, device_id, expires_at) VALUES (?, ?, ?)")
		.bind(nonce, deviceId, Date.now() + CHALLENGE_TTL_MS)
		.run();
	return nonce;
}

/** Single-use: the nonce is deleted whether or not the signature checks out. */
export async function consumeChallenge(
	env: Env,
	deviceId: string,
	nonce: string,
): Promise<boolean> {
	const row = await env.DB.prepare(
		"DELETE FROM challenges WHERE nonce = ? AND device_id = ? RETURNING expires_at",
	)
		.bind(nonce, deviceId)
		.first<{ expires_at: number }>();
	return !!row && row.expires_at >= Date.now();
}

export async function issueDeviceToken(env: Env, deviceId: string): Promise<{
	token: string;
	expires_at: number;
}> {
	const exp = Date.now() + DEVICE_TOKEN_TTL_MS;
	const token = await signToken(env.SESSION_SECRET, { t: "device", sub: deviceId, exp });
	return { token, expires_at: exp };
}

/** Resolves the calling device, or rejects. Used by every Mac-side endpoint. */
export async function requireDevice(env: Env, request: Request): Promise<string> {
	const payload = await verifyToken<DeviceToken>(env.SESSION_SECRET, bearer(request), "device");
	if (!payload) return unauthorized("Device session expired. Re-authenticate.");
	const row = await env.DB.prepare("SELECT device_id FROM devices WHERE device_id = ?")
		.bind(payload.sub)
		.first<{ device_id: string }>();
	if (!row) return unknownDevice();
	return row.device_id;
}

export function hubFor(env: Env, deviceId: string) {
	return env.HUB.get(env.HUB.idFromName(deviceId));
}
