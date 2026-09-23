import { randomId } from "./bytes";
import { downgradeToFree, tierFor, upgradeToPro } from "./entitlement";
import type { Tier } from "../limits";

/**
 * Every source of Pro, whoever took the money (migration 0001, "Commerce").
 *
 * A Creem licence, an App Store purchase and a grant from the operator console
 * are all one row in `purchases`, and the devices each one covers are rows in
 * `purchase_devices`. Provider-shaped code — talking to Creem, re-querying
 * Apple, parsing webhooks — stays next to its provider; this file is only the
 * writes they have in common, so a new provider is a new caller rather than a
 * new table.
 *
 * `lib/entitlement.ts` reads the same two tables on the request path. Nothing
 * here is ever reached from the send path.
 */

export type Provider = "creem" | "apple" | "admin";
export type PurchaseStatus = "active" | "refunded" | "disabled" | "revoked";

export interface PurchaseFields {
	status: PurchaseStatus;
	productId?: string | null;
	seats?: number | null;
	environment?: string | null;
	orderRef?: string | null;
	checkoutRef?: string | null;
	customerRef?: string | null;
	note?: string | null;
	/** Merged into the stored JSON, key by key, never replacing it wholesale. */
	metadata?: Record<string, unknown>;
	purchasedAt: number;
	verifiedAt: number;
}

export interface PurchaseRow {
	purchase_id: string;
	provider: Provider;
	external_id: string;
	status: PurchaseStatus;
	seats: number | null;
	note: string | null;
}

/**
 * Writes down what a provider just said about a purchase, and answers its id.
 *
 * Absolute for status, additive for everything else: a NULL in `fields` never
 * blanks out a value already recorded, so a re-delivered or partial webhook can
 * fill a gap without erasing the refund lookup path a full one wrote. That is
 * what lets a replayed event, an out-of-order pair and a client re-reporting
 * the same purchase all land on the same row without knowing about each other.
 *
 * `purchased_at` is kept from the first write: it is when the money moved, not
 * when we last heard about it.
 */
export async function upsertPurchase(
	env: Env,
	provider: Provider,
	externalId: string,
	fields: PurchaseFields,
): Promise<string> {
	const revokedAt = fields.status === "active" ? null : fields.verifiedAt;
	const row = await env.DB.prepare(
		`INSERT INTO purchases
		   (purchase_id, provider, external_id, product_id, status, seats, environment,
		    order_ref, checkout_ref, customer_ref, note, metadata,
		    purchased_at, verified_at, revoked_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT (provider, external_id) DO UPDATE SET
		   status = excluded.status,
		   product_id = coalesce(excluded.product_id, purchases.product_id),
		   seats = coalesce(excluded.seats, purchases.seats),
		   environment = coalesce(excluded.environment, purchases.environment),
		   order_ref = coalesce(excluded.order_ref, purchases.order_ref),
		   checkout_ref = coalesce(excluded.checkout_ref, purchases.checkout_ref),
		   customer_ref = coalesce(excluded.customer_ref, purchases.customer_ref),
		   note = coalesce(excluded.note, purchases.note),
		   metadata = json_patch(purchases.metadata, excluded.metadata),
		   verified_at = excluded.verified_at,
		   revoked_at = CASE WHEN excluded.status = 'active' THEN NULL
		                     ELSE coalesce(purchases.revoked_at, excluded.revoked_at) END
		 RETURNING purchase_id`,
	)
		.bind(
			randomId(),
			provider,
			externalId,
			fields.productId ?? null,
			fields.status,
			fields.seats ?? null,
			fields.environment ?? null,
			fields.orderRef ?? null,
			fields.checkoutRef ?? null,
			fields.customerRef ?? null,
			fields.note ?? null,
			JSON.stringify(fields.metadata ?? {}),
			fields.purchasedAt,
			fields.verifiedAt,
			revokedAt,
		)
		.first<{ purchase_id: string }>();
	if (!row) throw new Error("purchase upsert returned no row");
	return row.purchase_id;
}

export async function findPurchase(
	env: Env,
	provider: Provider,
	externalId: string,
): Promise<PurchaseRow | null> {
	return env.DB.prepare(
		`SELECT purchase_id, provider, external_id, status, seats, note
		 FROM purchases WHERE provider = ? AND external_id = ?`,
	)
		.bind(provider, externalId)
		.first<PurchaseRow>();
}

/**
 * The reverse of what a checkout wrote down, for refunds that arrive without
 * the purchase's own identity. Order first: it is the narrower of the two, and
 * a checkout that was never completed has no row. Customer is deliberately not
 * a fallback — one person can hold several purchases.
 */
export async function findByRef(
	env: Env,
	provider: Provider,
	refs: { order: string | null; checkout: string | null },
): Promise<PurchaseRow | null> {
	for (const [column, value] of [
		["order_ref", refs.order],
		["checkout_ref", refs.checkout],
	] as const) {
		if (!value) continue;
		const row = await env.DB.prepare(
			`SELECT purchase_id, provider, external_id, status, seats, note
			 FROM purchases WHERE provider = ? AND ${column} = ?`,
		)
			.bind(provider, value)
			.first<PurchaseRow>();
		if (row) return row;
	}
	return null;
}

/** Changes status only; `note`, when given, replaces the recorded reason. */
export async function setStatus(
	env: Env,
	purchaseId: string,
	status: PurchaseStatus,
	now: number,
	note: string | null = null,
): Promise<void> {
	await env.DB.prepare(
		`UPDATE purchases SET
		   status = ?1,
		   note = coalesce(?2, note),
		   revoked_at = CASE WHEN ?1 = 'active' THEN NULL ELSE coalesce(revoked_at, ?3) END
		 WHERE purchase_id = ?4`,
	)
		.bind(status, note, now, purchaseId)
		.run();
}

/** Attaches a device to a purchase. Re-attaching refreshes the instance handle. */
export async function bindDevice(
	env: Env,
	purchaseId: string,
	deviceId: string,
	now: number,
	instanceRef: string | null = null,
): Promise<void> {
	await env.DB.prepare(
		`INSERT INTO purchase_devices (purchase_id, device_id, instance_ref, activated_at)
		 VALUES (?, ?, ?, ?)
		 ON CONFLICT (purchase_id, device_id) DO UPDATE SET
		   instance_ref = excluded.instance_ref,
		   activated_at = excluded.activated_at`,
	)
		.bind(purchaseId, deviceId, instanceRef, now)
		.run();
}

export async function unbindDevice(env: Env, purchaseId: string, deviceId: string): Promise<void> {
	await env.DB.prepare("DELETE FROM purchase_devices WHERE purchase_id = ? AND device_id = ?")
		.bind(purchaseId, deviceId)
		.run();
}

/**
 * Drops this device's other bindings to one provider.
 *
 * With `onlyInactive`, only bindings to purchases that no longer grant anything
 * go — a refunded licence must not block activating a new one. Without it,
 * every other binding goes: the App Store keeps one purchase per device, so a
 * phone that re-verifies under a newer purchase is re-pointed, and a late
 * refund of the old one then correctly downgrades nobody.
 */
export async function unbindOthers(
	env: Env,
	provider: Provider,
	deviceId: string,
	keepPurchaseId: string | null,
	onlyInactive = false,
): Promise<void> {
	await env.DB.prepare(
		`DELETE FROM purchase_devices
		 WHERE device_id = ? AND purchase_id IN (
		   SELECT purchase_id FROM purchases
		   WHERE provider = ? AND purchase_id <> ? ${onlyInactive ? "AND status <> 'active'" : ""}
		 )`,
	)
		.bind(deviceId, provider, keepPurchaseId ?? "")
		.run();
}

/** This device's binding to an active purchase from one provider, if any. */
export async function activeBinding(
	env: Env,
	provider: Provider,
	deviceId: string,
): Promise<(PurchaseRow & { instance_ref: string | null }) | null> {
	return env.DB.prepare(
		`SELECT p.purchase_id, p.provider, p.external_id, p.status, p.seats, p.note, d.instance_ref
		 FROM purchase_devices d JOIN purchases p ON p.purchase_id = d.purchase_id
		 WHERE d.device_id = ? AND p.provider = ? AND p.status = 'active'
		 LIMIT 1`,
	)
		.bind(deviceId, provider)
		.first();
}

export async function binding(
	env: Env,
	purchaseId: string,
	deviceId: string,
): Promise<{ instance_ref: string | null } | null> {
	return env.DB.prepare(
		"SELECT instance_ref FROM purchase_devices WHERE purchase_id = ? AND device_id = ?",
	)
		.bind(purchaseId, deviceId)
		.first();
}

export async function seatsUsed(env: Env, purchaseId: string): Promise<number> {
	const row = await env.DB.prepare(
		"SELECT count(*) AS n FROM purchase_devices WHERE purchase_id = ?",
	)
		.bind(purchaseId)
		.first<{ n: number }>();
	return row?.n ?? 0;
}

/**
 * Brings a device's inboxes and shares in line with whatever it is entitled to
 * *now*, across every source.
 *
 * This is the one place a status change turns into capabilities, and it asks
 * `tierFor` rather than trusting the caller's idea of the answer: a refund of
 * one purchase must not downgrade a device that another purchase, or a grant,
 * still holds up. Idempotent, like the two functions it chooses between.
 */
export async function reconcileDevice(env: Env, deviceId: string): Promise<Tier> {
	const tier = await tierFor(env, deviceId);
	if (tier.name === "pro") await upgradeToPro(env, deviceId);
	else await downgradeToFree(env, deviceId);
	return tier;
}

/**
 * Reconciles every device attached to a purchase, and answers how many there
 * were. Zero is an ordinary answer: a refund for a purchase its buyer has since
 * replaced finds nobody, and correctly downgrades nobody.
 *
 * `releaseSeats` drops the bindings first. That is for a seated licence being
 * revoked: its seats go back to the pool, and a key that is later re-activated
 * must not silently bring back every Mac it once covered. Unlimited purchases
 * keep theirs, so a reversed refund restores Pro without re-linking anything.
 */
export async function applyPurchaseStatus(
	env: Env,
	purchaseId: string,
	releaseSeats = false,
): Promise<number> {
	const { results } = await env.DB.prepare(
		"SELECT device_id FROM purchase_devices WHERE purchase_id = ?",
	)
		.bind(purchaseId)
		.all<{ device_id: string }>();
	if (releaseSeats) {
		await env.DB.prepare("DELETE FROM purchase_devices WHERE purchase_id = ?")
			.bind(purchaseId)
			.run();
	}
	for (const device of results) await reconcileDevice(env, device.device_id);
	return results.length;
}
