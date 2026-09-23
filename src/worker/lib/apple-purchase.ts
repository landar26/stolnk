import { APPLE_BUNDLE_ID, APPLE_PRO_PRODUCT_ID, type AppleTransaction } from "./apple-store";
import { bindDevice, unbindOthers, upsertPurchase } from "./purchases";

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
 * It is the Apple counterpart to `lib/creem.ts`: the provider-shaped half of a
 * write whose storage is shared by every provider (`lib/purchases.ts`).
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
 * Upserts the purchase, and answers its id and whether Apple says it is revoked.
 *
 * Every field comes off this re-queried transaction, so a replayed webhook, an
 * out-of-order pair of notifications and a phone re-reporting the same purchase
 * all land on the same row with the same answer.
 */
export async function recordApplePurchase(
	env: Env,
	transaction: AppleTransaction,
	now: number,
): Promise<{ purchaseId: string; refunded: boolean }> {
	// Only ever read off a re-queried transaction. Inferring this from a
	// notification payload would hand anyone who can POST the endpoint the power
	// to revoke a stranger's purchase.
	const refunded = typeof transaction.revocationDate === "number";
	const purchaseId = await upsertPurchase(env, "apple", transaction.originalTransactionId, {
		status: refunded ? "refunded" : "active",
		productId: transaction.productId,
		environment: transaction.environment,
		orderRef: transaction.transactionId,
		metadata: { revocation_date: transaction.revocationDate ?? null },
		purchasedAt: transaction.purchaseDate,
		verifiedAt: now,
	});
	return { purchaseId, refunded };
}

/**
 * Points a device at the purchase that unlocked it. One App Store purchase per
 * device: a phone that re-verifies under a newer purchase is re-pointed, so a
 * late refund of the old one downgrades nobody.
 *
 * Bindings are never dropped on refund. Keeping the link is what lets a
 * reversed refund — or the same phone calling verify again — restore Pro
 * without re-linking anything; `tierFor` reads the purchase's status through
 * the join, so a kept link on a refunded purchase already reads Free.
 */
export async function attachDevice(
	env: Env,
	deviceId: string,
	purchaseId: string,
	now: number,
): Promise<void> {
	await unbindOthers(env, "apple", deviceId, purchaseId);
	await bindDevice(env, purchaseId, deviceId, now);
}
