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
export function upgradeWallHit(fields: { wall: "second_inbox" | "password" }): void {
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
