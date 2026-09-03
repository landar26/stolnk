import { Hono } from "hono";
import { FREE, PRO_SEATS } from "../limits";
import { keyHash, signatureValid } from "../lib/creem";
import { applyTierToInboxes, pauseInboxesOverFreeLimit } from "../lib/entitlement";
import { type AppEnv } from "../lib/http";
import { licenseRevoked, licenseRevokeUnmatched } from "../lib/metrics";

/**
 * Creem's side of the conversation (PRD 16.5).
 *
 * Two events matter. `checkout.completed` records a licence before anyone has
 * activated it, so the row exists the moment the money does. `refund.created`
 * is the one that takes capabilities away, and it is the reason revocation is
 * push rather than poll: a refunded user should stop being Pro in seconds, not
 * at the next daily sweep.
 *
 * The two are not symmetric, and that asymmetry shapes this file. Only the
 * checkout event carries the licence key; a refund carries an order, a
 * checkout, a transaction and a customer, and no key at all. Since `licenses`
 * stores an unrecoverable hash of the key, a refund can only find its row
 * through an identifier written down at purchase — which is what migration 0003
 * exists for, and why the checkout branch below writes more than it needs to.
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

/** Creem writes nested resources either inline or as a bare id string. */
function idOf(value: unknown): string | null {
	if (typeof value === "string") return value || null;
	if (value && typeof value === "object") {
		const id = (value as { id?: unknown }).id;
		if (typeof id === "string") return id || null;
	}
	return null;
}

function containersOf(event: CreemEvent): Record<string, unknown>[] {
	return [event.object, event.data].filter(Boolean) as Record<string, unknown>[];
}

/**
 * Creem has moved the licence key around between payload shapes. Current
 * checkout objects expose it in `license_keys`; `feature[].license_key` is the
 * deprecated predecessor, and the direct forms are retained for older events.
 */
function licenseKeyOf(event: CreemEvent): string | null {
	for (const container of containersOf(event)) {
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

/** The first entry of `license_keys`, which is where seats and Creem's own id live. */
function licenseObjectOf(event: CreemEvent): { id?: unknown; activation_limit?: unknown } | null {
	for (const container of containersOf(event)) {
		const licenseKeys = container.license_keys;
		if (Array.isArray(licenseKeys)) {
			for (const license of licenseKeys) {
				if (license && typeof license === "object") return license;
			}
		}
	}
	return null;
}

interface CreemIds {
	order: string | null;
	checkout: string | null;
	customer: string | null;
}

/**
 * The identifiers a refund and its originating checkout have in common.
 *
 * On `checkout.completed` the payload object *is* the checkout, so its own `id`
 * is the checkout id; on `refund.created` the checkout sits one level down. Both
 * carry `order` and `customer`. Taking the container's own id only when it
 * carries no nested `checkout` is what keeps the two shapes from disagreeing.
 */
function creemIdsOf(event: CreemEvent): CreemIds {
	const ids: CreemIds = { order: null, checkout: null, customer: null };
	for (const container of containersOf(event)) {
		ids.order ??= idOf(container.order);
		ids.checkout ??= idOf(container.checkout) ?? idOf(container.id);
		ids.customer ??= idOf(container.customer);
	}
	return ids;
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
	const ids = creemIdsOf(event);
	const now = Date.now();

	if (kind.startsWith("checkout.completed") || kind.startsWith("license.created")) {
		// 200 on an event with no key. A non-2xx makes Creem retry with backoff
		// forever over something that will never succeed.
		if (!key) return c.json({ ok: true, ignored: kind });
		const hash = await keyHash(key);
		const license = licenseObjectOf(event);
		// Creem's activation limit is the authority on seats — the price list says
		// three Macs, but the product's own setting is what will actually be
		// enforced when the Mac calls activate, so record that rather than our copy.
		const seats =
			typeof license?.activation_limit === "number" ? license.activation_limit : PRO_SEATS;
		const licenseId = typeof license?.id === "string" ? license.id : null;

		await c.env.DB.prepare(
			`INSERT INTO licenses (key_hash, creem_license_id, status, major_version, seats,
			                       purchased_at, revalidated_at,
			                       creem_order_id, creem_checkout_id, creem_customer_id)
			 VALUES (?, ?, 'active', 1, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT (key_hash) DO UPDATE SET
			   status = 'active',
			   revalidated_at = excluded.revalidated_at,
			   -- coalesce, not replace: a re-delivered or partial event must be able
			   -- to fill a blank in, and must never blank out what is already there.
			   creem_license_id = coalesce(excluded.creem_license_id, licenses.creem_license_id),
			   creem_order_id = coalesce(excluded.creem_order_id, licenses.creem_order_id),
			   creem_checkout_id = coalesce(excluded.creem_checkout_id, licenses.creem_checkout_id),
			   creem_customer_id = coalesce(excluded.creem_customer_id, licenses.creem_customer_id)`,
		)
			.bind(hash, licenseId, seats, now, now, ids.order, ids.checkout, ids.customer)
			.run();
		return c.json({ ok: true });
	}

	if (kind.startsWith("refund") || kind.startsWith("dispute") || kind.includes("revoked")) {
		// The key first, for the shapes that still carry one, then the order the
		// licence was sold under. Customer is deliberately not a fallback: one
		// person can hold several licences, and refunding one must not revoke the
		// others.
		const hash = key ? await keyHash(key) : await hashForOrder(c.env, ids);
		if (!hash) {
			licenseRevokeUnmatched({ reason: kind, order_id: ids.order, checkout_id: ids.checkout });
			return c.json({ ok: true, ignored: kind });
		}

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

/** The reverse of what the checkout branch wrote down. Order first: it is the
 * narrower of the two, and a checkout that was never completed has no row. */
async function hashForOrder(env: Env, ids: CreemIds): Promise<string | null> {
	for (const [column, value] of [
		["creem_order_id", ids.order],
		["creem_checkout_id", ids.checkout],
	] as const) {
		if (!value) continue;
		const row = await env.DB.prepare(`SELECT key_hash FROM licenses WHERE ${column} = ?`)
			.bind(value)
			.first<{ key_hash: string }>();
		if (row) return row.key_hash;
	}
	return null;
}
