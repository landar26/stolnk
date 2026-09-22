import type { Context, Next } from "hono";
import { type AppEnv } from "./http";

/**
 * The operator console's one credential.
 *
 * There is no second factor and no lockout, so length is the only source of
 * strength. Twenty-four is the line a hand-typed password never reaches and
 * `openssl rand -base64 32` clears without trying.
 */
const MIN_TOKEN_LENGTH = 24;

/**
 * Whether the console exists at all.
 *
 * Unset, or set to something too short, and every path under it answers 404 —
 * not 401. A deployment that never configured `ADMIN_TOKEN` should not expose
 * so much as a password box, and what a scanner sees is indistinguishable from
 * any other path this server does not have. The same posture `CREEM_API_BASE`
 * takes in `secrets.sh`: the feature is the presence of a value, never a flag.
 */
export function adminEnabled(env: Env): boolean {
	return (env.ADMIN_TOKEN ?? "").length >= MIN_TOKEN_LENGTH;
}

/**
 * Constant-time comparison, through SHA-256.
 *
 * A plain `===` returns at the first differing character, which turns guessing
 * into a per-character search instead of a search over the whole space. Hashing
 * both sides first also flattens the length difference, so "wrong, but the
 * right number of characters" stops being something an attacker can learn.
 */
async function tokenMatches(provided: string, expected: string): Promise<boolean> {
	const digest = async (value: string) =>
		new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
	const [a, b] = await Promise.all([digest(provided), digest(expected)]);
	let diff = a.length ^ b.length;
	for (let i = 0; i < a.length && i < b.length; i += 1) diff |= a[i] ^ b[i];
	return diff === 0;
}

/**
 * Gate for every `/api/v1/admin/*` call.
 *
 * Deliberately not `requireDevice`: the console is not a device and has no
 * session. It also sets nothing on the context — there is no "acting device"
 * here, and every route below names its target in the path.
 *
 * No rate limiting, on purpose. Cloudflare sits in front, and a 32-byte random
 * token is not something brute force reaches. Adding half a lockout here would
 * mostly create a way to lock the operator out of their own console.
 */
export async function requireAdmin(c: Context<AppEnv>, next: Next) {
	if (!adminEnabled(c.env)) {
		return c.json({ error: "not_found", message: "No such endpoint." }, 404);
	}
	const match = /^Bearer\s+(.+)$/i.exec((c.req.header("authorization") ?? "").trim());
	if (!match?.[1] || !(await tokenMatches(match[1], c.env.ADMIN_TOKEN as string))) {
		return c.json({ error: "unauthorized", message: "Not authorised." }, 401);
	}
	await next();
}
