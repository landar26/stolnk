/**
 * Structured events, emitted as JSON lines and picked up by Workers
 * observability.
 *
 * Two groups matter (PRD 15):
 *
 * - `sender_is_owner` decides whether this product is a file inbox or a
 *   cross-device AirDrop patch. PRD 2.2 sets a hard line: above 40% of
 *   transfers from other people, the inbox positioning holds; below 20%, the
 *   naming, pricing and roadmap are wrong and have to change. The whole point of
 *   emitting it from day one is to be able to answer that within eight weeks.
 *
 * - The cost fields exist because a one-time purchase makes cost a product
 *   question rather than a finance one (PRD 15.3). `class_a_ops` in particular
 *   is the check that the 64 MiB part size is actually in effect: more than
 *   about 30 operations per GB means something has silently reverted to small
 *   parts.
 *
 * What is deliberately absent: file contents, plaintext names, local paths,
 * content hashes usable for tracking, and any durable record of sender IPs
 * (PRD 15.5). These are counters, not a profile.
 */

type Fields = Record<string, string | number | boolean | null>;

function emit(event: string, fields: Fields): void {
	// One JSON object per line keeps this greppable in `wrangler tail` and
	// queryable in observability without a schema migration.
	console.log(JSON.stringify({ event, at: Date.now(), ...fields }));
}

export function transferStarted(fields: {
	inbox_id: string;
	files: number;
	bytes: number;
	sender_is_owner: boolean;
	sub_inbox: boolean;
	/**
	 * Which client sent it. `curl` is the inbox address used as an API
	 * (routes/inbox-address.ts) — the one path where the plaintext passes through
	 * the Worker, so "is anyone actually using it" is a question worth being able
	 * to answer before deciding how much to invest in it.
	 */
	via: "browser" | "curl";
	/**
	 * Which path it was opened for (PRD 8.2). Paired with `file.completed`, this
	 * is what answers "what share of transfers actually went direct" — the number
	 * that says whether the LAN path earned the framework it costs to ship.
	 */
	transport: "relay" | "lan";
}): void {
	emit("transfer.started", fields);
}

export function fileCompleted(fields: {
	inbox_id: string;
	bytes: number;
	parts: number;
	transport: "relay" | "lan";
}): void {
	emit("file.completed", {
		...fields,
		// Writes per GB. Watch this: the target is ~18, and anything over 30 means
		// the part size is not what limits.ts says it is.
		class_a_ops_per_gb:
			fields.bytes > 0 ? Math.round((fields.parts / (fields.bytes / 1024 ** 3)) * 10) / 10 : 0,
	});
}

export function fileDelivered(fields: {
	inbox_id: string;
	bytes: number;
	/** Time parked in R2. Drives the storage half of the cost model (PRD 8.6). */
	residency_ms: number;
	was_offline: boolean;
}): void {
	emit("file.delivered", fields);
}

export function quotaRefused(fields: { inbox_id: string; reason: string; bytes: number }): void {
	// PRD 8.6 #3 — refusals are a product signal, not an incident. Too many means
	// the quota is set wrong, in one direction or the other.
	emit("quota.refused", fields);
}

export function transferExpired(fields: { inbox_id: string; bytes: number }): void {
	emit("transfer.expired", fields);
}

/**
 * PRD 15.4 — the conversion funnel.
 *
 * `wall` on an upgrade prompt says which capability someone reached for, which
 * is the difference between "people buy this" and knowing *why*. The second
 * inbox in particular is the primary evidence for H2 (PRD 2.1): a refusal
 * recorded here is a user who wanted a second folder, whether or not they paid.
 */
export function upgradeWallHit(fields: {
	wall: "second_inbox" | "password" | "share_ttl" | "share_password" | "share_limit";
}): void {
	emit("upgrade.wall", fields);
}

export function licenseActivated(fields: { seats_used: number; seats: number }): void {
	emit("license.activated", fields);
}

export function licenseReleased(fields: { seats_used: number }): void {
	emit("license.released", fields);
}

/** Refund or revocation. Deliberately loud: it is money going back out. */
export function licenseRevoked(fields: { reason: string; devices: number }): void {
	emit("license.revoked", fields);
}

/**
 * A refund arrived for an order this server cannot map to a licence.
 *
 * Louder than it looks: the refund route answers 200 to these (a non-2xx makes
 * Creem retry forever over something that will never succeed), so this line is
 * the only trace that money went back out and a seat did not. It fires for a
 * checkout webhook that never arrived, and for any payload shape Creem changes
 * underneath us.
 */
export function licenseRevokeUnmatched(fields: {
	reason: string;
	order_id: string | null;
	checkout_id: string | null;
}): void {
	emit("license.revoke_unmatched", fields);
}

/**
 * One line per payment-provider webhook, whatever became of it.
 *
 * The webhook handlers answer 200 to almost everything they cannot act on — an
 * orphan, an unknown product, a refund for an order nobody bought — because a
 * non-2xx makes the provider retry for days over something that will never
 * succeed. This line is the only trace that any of it happened.
 *
 * `external_ref` (an order id, an App Store transaction id) is here on purpose
 * and is not a new disclosure: it is an opaque provider identifier already
 * sitting in `purchases`, and without it a refund that did not apply cannot be
 * reconciled against the provider's own dashboard.
 */
export type PaymentOutcome =
	| "recorded"
	| "revoked"
	| "active"
	| "unmatched"
	| "ignored"
	| "orphan"
	| "duplicate"
	| "no_transaction"
	| "no_transaction_id"
	| "unknown_transaction"
	| "other_product"
	| "rejected"
	| "failed";

export function paymentEvent(fields: {
	provider: "creem" | "apple";
	type: string;
	subtype: string | null;
	outcome: PaymentOutcome;
	external_ref: string | null;
	devices: number;
}): void {
	emit("payment.event", fields);
}

/**
 * Pro handed out or taken back from the operator console .
 *
 * This line *is* the audit trail — there is no ledger table, because Workers
 * observability is already append-only, timestamped and where the record of
 * money moving lives. The note is the operator's own words and is carried here
 * verbatim, so "why did this device have Pro" stays answerable after the row
 * has been overwritten by a later grant.
 *
 * The device name rather than its id: the id is meaningless to the person
 * reading this back, and the name is already public — it is the subdomain every
 * one of that device's links is served from.
 */
export function adminGrant(fields: {
	action: "grant" | "revoke";
	device: string;
	note: string;
}): void {
	emit("admin.grant", fields);
}
