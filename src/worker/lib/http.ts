import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";

export type AppEnv = { Bindings: Env };

/** Uniform machine-readable failure shape; the send page renders `message`. */
export function fail(status: number, code: string, message: string): never {
	throw new HTTPException(status as never, {
		res: Response.json({ error: code, message }, { status }),
	});
}

export function badRequest(message: string): never {
	return fail(400, "bad_request", message);
}

export function unauthorized(message = "Not authorised."): never {
	return fail(401, "unauthorized", message);
}

export function notFound(message = "Not found."): never {
	return fail(404, "not_found", message);
}

/**
 * The server has no record of this device.
 *
 * Deliberately 404 and not 401, at every endpoint that notices. A 401 means
 * "your session lapsed, get another one", which clients answer by
 * re-authenticating — and re-authenticating cannot conjure back a device row.
 * Its own code, because the client has to tell this apart from an expired
 * session to know that the only way forward is to register again.
 */
export function unknownDevice(): never {
	return fail(404, "unknown_device", "This Mac is not registered on this server.");
}

/**
 * PRD 8.6 #3 — running out of quota downgrades, it never bills overage.
 * The send page turns this into "ask the owner to upgrade or wait", not an error.
 */
export function quotaExceeded(message: string): never {
	return fail(413, "quota_exceeded", message);
}

export function clientIp(c: Context<AppEnv>): string {
	return (
		c.req.header("cf-connecting-ip") ??
		c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ??
		"0.0.0.0"
	);
}

export async function readJson<T>(c: Context<AppEnv>): Promise<T> {
	try {
		return (await c.req.json()) as T;
	} catch {
		return badRequest("Expected a JSON body.");
	}
}

export function requireString(value: unknown, field: string, maxLength: number): string {
	if (typeof value !== "string" || value.length === 0) {
		return badRequest(`Missing "${field}".`);
	}
	if (value.length > maxLength) {
		return badRequest(`"${field}" is too long.`);
	}
	return value;
}

export function requireInt(value: unknown, field: string, min: number, max: number): number {
	if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) {
		return badRequest(`"${field}" must be an integer.`);
	}
	if (value < min || value > max) return badRequest(`"${field}" is out of range.`);
	return value;
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function utcDay(now = Date.now()): string {
	return new Date(now).toISOString().slice(0, 10);
}

/**
 * The bucket key for the monthly relay allowance (PRD 16.1).
 *
 * Refunds are keyed by the *transfer's* month, not the current one, so a
 * transfer created on the 31st and expired on the 1st returns its bytes to the
 * month that booked them.
 */
export function utcMonth(now = Date.now()): string {
	return new Date(now).toISOString().slice(0, 7);
}

/**
 * PRD 16 — this capability needs Pro.
 *
 * 402 rather than 403 because the client has somewhere to go: every wall in the
 * product is an upgrade prompt, never a dead end. Distinct from
 * `quotaExceeded` (413), which means "Pro would not help, wait".
 */
export function upgradeRequired(message: string): never {
	return fail(402, "upgrade_required", message);
}
