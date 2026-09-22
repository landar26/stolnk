import { APPLE_BUNDLE_ID, APPLE_PRO_PRODUCT_ID, type AppleTransaction } from "./apple-store";
import { downgradeToFree, upgradeToPro } from "./entitlement";

/**
 * Writing an App Store purchase down, from either of the two mouths it can
 * arrive through: the phone reporting its own transaction (`routes/licenses.ts`)
 * and Apple reporting one unprompted (`routes/webhooks-apple.ts`).
 *
 * Both hand these functions an `AppleTransaction` that came back over an
 * authenticated call to the App Store Server API — never one assembled from a
 * request body — so there are no trust decisions in this file. That is the
 * whole reason it exists as its own module: the webhook's payload is a hint and
 * nothing more, and keeping the writes here makes it impossible to reach them
 * with anything but a re-queried transaction.
 *
 * It is the Apple counterpart to `lib/creem.ts`. `lib/entitlement.ts` is about
 * *reading* a tier on the request path; provider-shaped writes belong next to
 * their provider.
 */

/** Whether this is the thing we sell, rather than some other purchase in the same app. */
export function isProUnlock(transaction: AppleTransaction): boolean {
	return (
		transaction.bundleId === APPLE_BUNDLE_ID &&
		transaction.productId === APPLE_PRO_PRODUCT_ID &&
		transaction.type === "Non-Consumable"
	);
}

/**
 * Upserts the purchase, and answers whether Apple says it is revoked.
 *
 * Absolute, never incremental: every column is overwritten with what this
 * lookup returned. That is what lets a replayed webhook, an out-of-order pair
 * of notifications and a phone re-reporting the same transaction all land on
 * the same row without any of them having to know about the others.
 */
export async function recordApplePurchase(
	env: Env,
	transaction: AppleTransaction,
	now: number,
): Promise<boolean> {
	// Only ever read off a re-queried transaction. Inferring this from a
	// notification payload would hand anyone who can POST the endpoint the power
	// to revoke a stranger's purchase.
	const refunded = typeof transaction.revocationDate === "number";
	await env.DB.prepare(
		`INSERT INTO apple_purchases
		 (original_transaction_id, transaction_id, product_id, environment, status,
		  purchased_at, revocation_date, last_verified_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT (original_transaction_id) DO UPDATE SET
		   transaction_id = excluded.transaction_id,
		   status = excluded.status,
		   revocation_date = excluded.revocation_date,
		   last_verified_at = excluded.last_verified_at`,
	)
		.bind(
			transaction.originalTransactionId,
			transaction.transactionId,
			transaction.productId,
			transaction.environment,
			refunded ? "refunded" : "active",
			transaction.purchaseDate,
			transaction.revocationDate ?? null,
			now,
		)
		.run();
	return refunded;
}

/**
 * Applies a purchase's state to every device attached to it, and answers how
 * many there were.
 *
 * Note what it does *not* do: delete from `apple_purchase_devices`. The Creem
 * refund path drops `license_devices` rows because a seat is a scarce thing
 * that has to go back in the pool; an App Store purchase has no seats, and
 * keeping the link is what lets a reversed refund — or the same phone calling
 * verify again — restore Pro without re-linking anything. `tierFor` reads the
 * purchase's status through the join, so a kept link on a refunded purchase
 * already reads Free.
 *
 * Zero devices is an ordinary answer, not a failure. A refund for a purchase
 * the buyer has since replaced finds none, because `apple_purchase_devices` is
 * keyed on `device_id` and the phone has already re-pointed at the newer
 * purchase — so the late notification correctly downgrades nobody.
 */
export async function applyApplePurchase(
	env: Env,
	originalTransactionId: string,
	refunded: boolean,
): Promise<number> {
	const { results } = await env.DB.prepare(
		"SELECT device_id FROM apple_purchase_devices WHERE original_transaction_id = ?",
	)
		.bind(originalTransactionId)
		.all<{ device_id: string }>();
	for (const device of results) {
		if (refunded) await downgradeToFree(env, device.device_id);
		else await upgradeToPro(env, device.device_id);
	}
	return results.length;
}

/** Points a device at the purchase that unlocked it. One purchase per device. */
export async function attachDevice(
	env: Env,
	deviceId: string,
	originalTransactionId: string,
	now: number,
): Promise<void> {
	await env.DB.prepare(
		`INSERT INTO apple_purchase_devices (device_id, original_transaction_id, activated_at)
		 VALUES (?, ?, ?)
		 ON CONFLICT (device_id) DO UPDATE SET
		   original_transaction_id = excluded.original_transaction_id,
		   activated_at = excluded.activated_at`,
	)
		.bind(deviceId, originalTransactionId, now)
		.run();
}
