const PRODUCTION = "https://api.storekit.apple.com";
const SANDBOX = "https://api.storekit-sandbox.apple.com";

export const APPLE_BUNDLE_ID = "com.nbtxy.filego";
export const APPLE_PRO_PRODUCT_ID = "com.nbtxy.filego.pro.lifetime";

export interface AppleTransaction {
	transactionId: string;
	originalTransactionId: string;
	bundleId: string;
	productId: string;
	type: string;
	purchaseDate: number;
	revocationDate?: number;
	environment: string;
}

export class AppleStoreError extends Error {
	constructor(public readonly status: number, message: string) {
		super(message);
	}
}

function base64Url(input: Uint8Array | string): string {
	const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeBase64Url(value: string): string {
	const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
	return atob(padded);
}

function privateKeyBytes(pem: string): Uint8Array {
	const body = pem.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g, "");
	const binary = atob(body);
	return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function authorization(env: Env): Promise<string> {
	if (!env.APPLE_KEY_ID || !env.APPLE_ISSUER_ID || !env.APPLE_PRIVATE_KEY) {
		throw new AppleStoreError(503, "App Store verification is not configured.");
	}
	const now = Math.floor(Date.now() / 1000);
	const header = base64Url(JSON.stringify({ alg: "ES256", kid: env.APPLE_KEY_ID, typ: "JWT" }));
	const payload = base64Url(JSON.stringify({
		iss: env.APPLE_ISSUER_ID,
		iat: now,
		exp: now + 300,
		aud: "appstoreconnect-v1",
		bid: APPLE_BUNDLE_ID,
	}));
	const key = await crypto.subtle.importKey(
		"pkcs8",
		privateKeyBytes(env.APPLE_PRIVATE_KEY),
		{ name: "ECDSA", namedCurve: "P-256" },
		false,
		["sign"],
	);
	const signature = await crypto.subtle.sign(
		{ name: "ECDSA", hash: "SHA-256" },
		key,
		new TextEncoder().encode(`${header}.${payload}`),
	);
	return `${header}.${payload}.${base64Url(new Uint8Array(signature))}`;
}

function decodedTransaction(jws: unknown): AppleTransaction {
	if (typeof jws !== "string") throw new AppleStoreError(502, "The App Store returned no transaction.");
	const parts = jws.split(".");
	if (parts.length !== 3) throw new AppleStoreError(502, "The App Store returned a malformed transaction.");
	let value: unknown;
	try {
		value = JSON.parse(decodeBase64Url(parts[1]));
	} catch {
		throw new AppleStoreError(502, "The App Store returned a malformed transaction.");
	}
	if (!value || typeof value !== "object") {
		throw new AppleStoreError(502, "The App Store returned a malformed transaction.");
	}
	const record = value as Record<string, unknown>;
	for (const key of ["transactionId", "originalTransactionId", "bundleId", "productId", "type", "purchaseDate", "environment"]) {
		if (record[key] === undefined || record[key] === null) {
			throw new AppleStoreError(502, `The App Store transaction is missing ${key}.`);
		}
	}
	return record as unknown as AppleTransaction;
}

/**
 * Looks the transaction up at Apple instead of trusting fields supplied by the
 * app. The returned JWS rides inside an authenticated HTTPS response from the
 * App Store Server API; its payload is decoded only after that request succeeds.
 */
export async function transactionInfo(env: Env, transactionId: string): Promise<AppleTransaction> {
	const auth = await authorization(env);
	let lastStatus = 404;
	for (const base of [PRODUCTION, SANDBOX]) {
		const response = await fetch(`${base}/inApps/v1/transactions/${encodeURIComponent(transactionId)}`, {
			headers: { Authorization: `Bearer ${auth}` },
		});
		lastStatus = response.status;
		if (response.status === 404) continue;
		if (!response.ok) {
			throw new AppleStoreError(
				response.status >= 500 || response.status === 429 ? 503 : 400,
				`The App Store couldn't verify this purchase (${response.status}).`,
			);
		}
		const body = await response.json<{ signedTransactionInfo?: unknown }>();
		return decodedTransaction(body.signedTransactionInfo);
	}
	throw new AppleStoreError(lastStatus === 404 ? 404 : 400, "This App Store purchase wasn't found.");
}
