/**
 * Receipts for payment providers' webhooks (`payment_events`).
 *
 * Every provider redelivers what it did not get a 2xx for, so every provider
 * needs the same two things: skip what was already applied, and leave a trace
 * of what was not. This file is both, for all of them.
 */

export type EventProvider = "creem" | "apple";

export interface IncomingEvent {
	provider: EventProvider;
	/** The provider's own id for this delivery. Null means it is not deduped. */
	eventId: string | null;
	type: string;
	subtype: string | null;
	/** A hint from the unverified payload, kept for reconciliation only. */
	externalRef: string | null;
	payload: string;
}

async function sha256Hex(input: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Records the delivery as `pending`, and answers whether to process it.
 *
 * `status <> 'ok'` is the whole point. A dedupe that bailed on the mere
 * existence of a row would swallow the retry of an event we failed on: the
 * retry would find the 'pending' row the failed attempt left, call itself a
 * duplicate, answer 200, and the refund would be lost in exactly the case the
 * retry exists for.
 *
 * `?? 1`, not `?? 0`: if D1 does not report a change count the safe default is
 * to process, because processing is idempotent by construction while skipping
 * loses a refund. Two concurrent deliveries can both run; the second is a
 * no-op, and a lock could strand a row in 'pending'.
 *
 * An event with no id is not deduped at all. Processing it twice is harmless;
 * dropping it is not.
 */
export async function beginEvent(env: Env, event: IncomingEvent): Promise<boolean> {
	if (!event.eventId) return true;
	const inserted = await env.DB.prepare(
		`INSERT INTO payment_events
		   (provider, event_id, event_type, subtype, external_ref, payload_sha256,
		    status, received_at)
		 VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)
		 ON CONFLICT (provider, event_id) DO UPDATE SET
		   event_type = excluded.event_type,
		   subtype = excluded.subtype,
		   external_ref = excluded.external_ref,
		   payload_sha256 = excluded.payload_sha256,
		   received_at = excluded.received_at,
		   status = 'pending'
		 WHERE payment_events.status <> 'ok'`,
	)
		.bind(
			event.provider,
			event.eventId,
			event.type,
			event.subtype,
			event.externalRef,
			await sha256Hex(event.payload),
			Date.now(),
		)
		.run();
	return (inserted.meta.changes ?? 1) !== 0;
}

/**
 * Stamps how the delivery ended, and swallows its own failure on purpose.
 *
 * Failing to write 'ok' must not flip the outcome of an event that was applied:
 * the 500 it would produce sends the provider back to re-apply it. Callers that
 * stamp 'error' rethrow afterwards themselves.
 */
export async function finishEvent(
	env: Env,
	provider: EventProvider,
	eventId: string | null,
	status: "ok" | "error",
	outcome: string,
	lastError: string | null = null,
): Promise<void> {
	if (!eventId) return;
	await env.DB.prepare(
		`UPDATE payment_events
		 SET status = ?, outcome = ?, processed_at = ?, last_error = ?
		 WHERE provider = ? AND event_id = ?`,
	)
		.bind(status, outcome, Date.now(), lastError, provider, eventId)
		.run()
		.catch((error: unknown) => {
			console.warn("payment event receipt not stamped", { provider, eventId, status, error });
		});
}
