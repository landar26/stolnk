import { FREE, PRO, PRO_SEATS, type Tier } from "../limits";
import { utcMonth } from "./http";

/**
 * Which tier a device is on, and what it has spent this month (PRD 16).
 *
 * The rule this file exists to keep: **Creem is never on the request path.**
 * Activation calls out once and the answer is written to D1; every tier
 * decision after that is a local read. Two reasons, and both are product
 * decisions rather than performance ones:
 *
 *  1. Under a one-time purchase, per-request cost has to be bounded by
 *     construction (PRD 8.6). A third-party round trip on every upload is not.
 *  2. An outage at the payment provider must never downgrade someone who paid.
 *     A cached entitlement that is a day stale is strictly better than one that
 *     evaporates when someone else's API is down.
 *
 * Revocation therefore arrives out of band, from the refund webhook
 * (routes/webhooks.ts) — and only from there. There is no polling backstop, and
 * that is a consequence of a deliberate choice made one layer down: `licenses`
 * stores only a SHA-256 of the key, and Creem's validate endpoint needs the key
 * itself. Keeping every customer's key in recoverable form so that a sweep
 * could re-ask a question the webhook already answers would turn the licence
 * table into something worth stealing.
 *
 * What that costs: a webhook that is never delivered leaves a refunded licence
 * active. Creem retries with backoff, so this means a sustained outage of this
 * endpoint, and the failure is bounded — one refunded user keeping Pro until
 * someone notices, against a database that is not a pile of working keys.
 * `licenses.revalidated_at` records when Creem last confirmed a row, so the
 * stale ones are findable by hand.
 */

export interface PlanState {
	tier: "free" | "pro";
	relay_used: number;
	relay_limit: number;
	/** Present only on Pro. `seats` mirrors the activation limit set in Creem. */
	license?: { seats: number; seats_used: number; status: string };
}

/**
 * Pro is the presence of a seat on a licence that is still good. Anything else
 * — no licence, a refunded one, a disabled one — is Free.
 *
 * One query, one index hit, on a table most rows will never appear in.
 */
export async function tierFor(env: Env, deviceId: string): Promise<Tier> {
	const row = await env.DB.prepare(
		`SELECT l.status FROM license_devices d
		 JOIN licenses l ON l.key_hash = d.key_hash
		 WHERE d.device_id = ?`,
	)
		.bind(deviceId)
		.first<{ status: string }>();
	return row?.status === "active" ? PRO : FREE;
}

/** Everything the settings screen shows about the plan, in one round trip. */
export async function planFor(env: Env, deviceId: string): Promise<PlanState> {
	const row = await env.DB.prepare(
		`SELECT l.key_hash, l.status, l.seats FROM license_devices d
		 JOIN licenses l ON l.key_hash = d.key_hash
		 WHERE d.device_id = ?`,
	)
		.bind(deviceId)
		.first<{ key_hash: string; status: string; seats: number }>();

	const tier = row?.status === "active" ? PRO : FREE;
	const used = await relayUsed(env, deviceId);

	if (!row) return { tier: tier.name, relay_used: used, relay_limit: tier.monthlyRelayBytes };

	const seats = await env.DB.prepare(
		"SELECT count(*) AS n FROM license_devices WHERE key_hash = ?",
	)
		.bind(row.key_hash)
		.first<{ n: number }>();

	return {
		tier: tier.name,
		relay_used: used,
		relay_limit: tier.monthlyRelayBytes,
		license: {
			seats: row.seats || PRO_SEATS,
			seats_used: seats?.n ?? 0,
			status: row.status,
		},
	};
}

export async function relayUsed(env: Env, deviceId: string, month = utcMonth()): Promise<number> {
	const row = await env.DB.prepare(
		"SELECT relay_bytes FROM usage_monthly WHERE device_id = ? AND month = ?",
	)
		.bind(deviceId, month)
		.first<{ relay_bytes: number }>();
	return row?.relay_bytes ?? 0;
}

/** Books bytes against the month at the moment a transfer is accepted. */
export function bookRelayBytes(env: Env, deviceId: string, bytes: number, month = utcMonth()) {
	return env.DB.prepare(
		`INSERT INTO usage_monthly (device_id, month, relay_bytes) VALUES (?, ?, ?)
		 ON CONFLICT (device_id, month) DO UPDATE SET relay_bytes = relay_bytes + ?`,
	).bind(deviceId, month, bytes, bytes);
}

/**
 * Returns bytes that were booked but never delivered — an aborted or expired
 * transfer.
 *
 * `max(0, ...)` is not defensive tidiness. Without it a double refund (an abort
 * racing the sweep, a replayed webhook) drives the counter negative and hands
 * the device an allowance larger than its tier, which is exactly the failure
 * this whole file exists to prevent. Clamping makes over-refunding merely
 * wrong, not exploitable.
 */
export function refundRelayBytes(env: Env, deviceId: string, bytes: number, month: string) {
	return env.DB.prepare(
		`UPDATE usage_monthly SET relay_bytes = max(0, relay_bytes - ?)
		 WHERE device_id = ? AND month = ?`,
	).bind(bytes, deviceId, month);
}

/**
 * Refreshes the per-inbox file ceiling after a tier change.
 *
 * `inboxes.size_limit` is a snapshot taken when the inbox was created, and
 * `resolve` hands it to the send page as `max_file_size` — so without this, a
 * user who registers, buys, and activates keeps being told 2 GB by their own
 * links. Enforcement separately clamps to the live tier, which is what covers
 * the other direction: a refunded Pro cannot keep a 20 GB ceiling just because
 * the row still says so.
 */
export async function applyTierToInboxes(env: Env, deviceId: string, tier: Tier): Promise<void> {
	await env.DB.prepare("UPDATE inboxes SET size_limit = ? WHERE owner_device_id = ?")
		.bind(tier.maxFileSize, deviceId)
		.run();
}

/**
 * Brings a device back inside the free allowance after a refund or a released
 * seat.
 *
 * PRD 16 architecture decision: **downgrading never destroys anything.** The
 * inboxes beyond the free allowance are paused, not deleted — their links
 * answer 423 rather than 404, the folders they point at are untouched, and
 * buying again restores them exactly as they were. Deleting them would make a
 * refund destructive and a mis-fired webhook catastrophic.
 *
 * The oldest inbox survives, on the assumption that it is the one from
 * onboarding and the one whose link is furthest into circulation.
 */
export async function pauseInboxesOverFreeLimit(env: Env, deviceId: string): Promise<void> {
	await env.DB.prepare(
		`UPDATE inboxes SET paused = 1
		 WHERE owner_device_id = ? AND inbox_id NOT IN (
		   SELECT inbox_id FROM inboxes WHERE owner_device_id = ?
		   ORDER BY created_at ASC LIMIT ?
		 )`,
	)
		.bind(deviceId, deviceId, FREE.maxInboxes)
		.run();
}
