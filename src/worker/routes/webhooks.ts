import { Hono } from "hono";
import { FREE } from "../limits";
import { keyHash, signatureValid } from "../lib/creem";
import { applyTierToInboxes, pauseInboxesOverFreeLimit } from "../lib/entitlement";
import { type AppEnv } from "../lib/http";
import { licenseRevoked } from "../lib/metrics";

/**
 * Creem's side of the conversation (PRD 16.5).
 *
 * Two events matter. `checkout.completed` records a licence before anyone has
 * activated it, so the row exists the moment the money does. `refund.created`
 * is the one that takes capabilities away, and it is the reason revocation is
 * push rather than poll: a refunded user should stop being Pro in seconds, not
 * at the next daily sweep.
 *
 * This route is unauthenticated by necessity — Creem has no device session — so
 * the signature *is* the authentication. Everything below the check treats the
 * body as trusted; nothing above it writes anything.
 */
export const webhooks = new Hono<AppEnv>();

interface CreemEvent {
	eventType?: string;
	type?: string;
	object?: Record<string, unknown>;
	data?: Record<string, unknown>;
}

/**
 * Creem has moved the licence key around between payload shapes. Current
 * checkout objects expose it in `license_keys`; `feature[].license_key` is the
 * deprecated predecessor, and the direct forms are retained for older events.
 */
function licenseKeyOf(event: CreemEvent): string | null {
	const containers = [event.object, event.data].filter(Boolean) as Record<string, unknown>[];
	for (const container of containers) {
		const direct = container.key ?? container.license_key;
		if (typeof direct === "string") return direct;
		const nested = container.license as { key?: unknown } | undefined;
		if (nested && typeof nested.key === "string") return nested.key;

		const licenseKeys = container.license_keys;
		if (Array.isArray(licenseKeys)) {
			for (const license of licenseKeys) {
				if (
					license &&
					typeof license === "object" &&
					typeof (license as { key?: unknown }).key === "string"
				) {
					return (license as { key: string }).key;
				}
			}
		}

		const features = container.feature;
		if (Array.isArray(features)) {
			for (const feature of features) {
				if (!feature || typeof feature !== "object") continue;
				const legacy = (feature as { license_key?: { key?: unknown } }).license_key;
				if (legacy && typeof legacy.key === "string") return legacy.key;
			}
		}
	}
	return null;
}

webhooks.post("/creem", async (c) => {
	// Raw text, before any parsing: the signature covers the bytes that arrived,
	// not a re-serialisation of them.
	const raw = await c.req.text();
	const signature = c.req.header("creem-signature");
	if (!(await signatureValid(c.env.CREEM_WEBHOOK_SECRET, raw, signature ?? null))) {
		// No detail, and nothing written. An unsigned caller learns only that it
		// was rejected.
		return c.json({ error: "bad_signature" }, 401);
	}

	let event: CreemEvent;
	try {
		event = JSON.parse(raw) as CreemEvent;
	} catch {
		return c.json({ error: "bad_json" }, 400);
	}

	const kind = event.eventType ?? event.type ?? "";
	const key = licenseKeyOf(event);
	// 200 on events we do not handle, and on ones with no key. A non-2xx makes
	// Creem retry with backoff forever over something that will never succeed.
	if (!key) return c.json({ ok: true, ignored: kind });
	const hash = await keyHash(key);
	const now = Date.now();

	if (kind.startsWith("checkout.completed") || kind.startsWith("license.created")) {
		await c.env.DB.prepare(
			`INSERT INTO licenses (key_hash, status, major_version, seats, purchased_at, revalidated_at)
			 VALUES (?, 'active', 1, 3, ?, ?)
			 ON CONFLICT (key_hash) DO UPDATE SET status = 'active', revalidated_at = excluded.revalidated_at`,
		)
			.bind(hash, now, now)
			.run();
		return c.json({ ok: true });
	}

	if (kind.startsWith("refund") || kind.startsWith("dispute") || kind.includes("revoked")) {
		const { results } = await c.env.DB.prepare(
			"SELECT device_id FROM license_devices WHERE key_hash = ?",
		)
			.bind(hash)
			.all<{ device_id: string }>();

		await c.env.DB.batch([
			c.env.DB.prepare("UPDATE licenses SET status = 'refunded' WHERE key_hash = ?").bind(hash),
			c.env.DB.prepare("DELETE FROM license_devices WHERE key_hash = ?").bind(hash),
		]);

		// Back to the free ceilings, and inboxes past the free allowance are
		// paused. Paused, never deleted: a refund must not destroy the folders
		// someone routed their work to, and a webhook that fires by mistake must
		// be undoable by buying again.
		for (const row of results) {
			await applyTierToInboxes(c.env, row.device_id, FREE);
			await pauseInboxesOverFreeLimit(c.env, row.device_id);
		}

		licenseRevoked({ reason: kind, devices: results.length });
		return c.json({ ok: true });
	}

	return c.json({ ok: true, ignored: kind });
});
