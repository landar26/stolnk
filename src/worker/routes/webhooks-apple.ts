import type { Context } from "hono";
import {
	AppleStoreError,
	decodeUnverifiedJws,
	transactionInfo,
	type AppleTransaction,
} from "../lib/apple-store";
import { isProUnlock, recordApplePurchase } from "../lib/apple-purchase";
import { type AppEnv } from "../lib/http";
import { licenseRevoked, paymentEvent, type PaymentOutcome } from "../lib/metrics";
import { beginEvent, finishEvent } from "../lib/payment-events";
import { applyPurchaseStatus, findPurchase } from "../lib/purchases";

/**
 * Apple's side of the conversation: App Store Server Notifications V2.
 *
 * **The payload is not verified, and that is the design.** A V2 notification's
 * only credential is the x5c certificate chain in its JWS header, and building
 * and pinning that chain is not something this runtime can do. So the body is
 * treated as a hint and nothing else: exactly one field is read out of it, an
 * `originalTransactionId`, and it is used solely to decide *what to ask Apple
 * about*. Every byte that reaches the database afterwards comes back from
 * `transactionInfo()` — an outbound HTTPS request authenticated with our own
 * ES256 key. That call is the trust anchor; the request body never is.
 *
 * The consequence to hold on to: a stranger who POSTs here can, at most, make
 * this Worker ask Apple a question and then write down Apple's true answer.
 * They cannot assert a refund, because "refunded" is only ever read off a
 * re-queried transaction (`lib/apple-purchase.ts`).
 *
 * The other half of the file is status codes, and they run opposite to the rest
 * of this codebase. `lib/http.ts`'s `fail()` throws and `index.ts`'s `onError`
 * turns anything unhandled into a 500 — which is already what Apple wants,
 * since a non-2xx is what earns a retry. So the work here is not taking over
 * status codes but deliberately pushing permanent failures *down* to 200, so
 * Apple stops retrying something that will never succeed. Every `return` below
 * is that decision made once. Two rules follow, and they are easy to "fix" by
 * mistake:
 *
 *   - the body is parsed inline rather than through `readJson()`, because a 400
 *     here is a contract and should not look like an accident; and
 *   - there is no `enforce()` rate limit, for the reason `index.ts` already
 *     gives for this whole router: throttling a webhook turns a refund into one
 *     that silently never applies.
 */

interface NotificationPayload {
	notificationType?: unknown;
	subtype?: unknown;
	notificationUUID?: unknown;
	data?: { signedTransactionInfo?: unknown };
}

function stringOr(value: unknown, fallback: string): string {
	return typeof value === "string" && value ? value : fallback;
}

function optionalString(value: unknown): string | null {
	return typeof value === "string" && value ? value : null;
}

/**
 * Asks Apple about the transaction two different ways.
 *
 * Both candidates come out of the unverified payload and are hints, nothing
 * more. `transactionId` is tried first because that is what the endpoint is
 * documented to take; `originalTransactionId` is the fallback for the shapes
 * that carry only one of the two. For a non-consumable the two are the same
 * value anyway — there is only ever one transaction — but relying on that
 * identity would make this quietly wrong if the product mix ever changes.
 *
 * A 404 means "try the next one". Any other `AppleStoreError` stops here, since
 * it says something about our request rather than about this id.
 */
async function lookUp(env: Env, candidates: (string | null)[]): Promise<AppleTransaction | null> {
	let seen = false;
	for (const candidate of candidates) {
		if (!candidate || !/^\d+$/.test(candidate)) continue;
		seen = true;
		try {
			return await transactionInfo(env, candidate);
		} catch (error) {
			if (error instanceof AppleStoreError && error.status === 404) continue;
			throw error;
		}
	}
	if (!seen) return null;
	throw new AppleStoreError(404, "This App Store purchase wasn't found.");
}

export async function appleNotificationRoute(c: Context<AppEnv>) {
	// A noise gate, not a boundary, and the distinction matters. App Store
	// Connect lets us configure exactly one thing — the URL — so this is the
	// only place a secret can live, and a path secret appears in every log that
	// records URLs. It stops scanners; it is not what makes the endpoint safe.
	// The doc comment above is.
	//
	// Optional, deliberately. A required secret mistyped once makes every
	// notification 401 for three days and then Apple gives up for good, and
	// refunds silently stop applying with nothing to notice. That failure is
	// worse than the one an absent secret allows.
	const expected = c.env.APPLE_NOTIFICATION_SECRET;
	if (expected && c.req.param("secret") !== expected) {
		return c.json({ error: "bad_secret" }, 401);
	}

	let signedPayload: string;
	try {
		const body = (await c.req.json()) as { signedPayload?: unknown };
		if (typeof body?.signedPayload !== "string" || !body.signedPayload) {
			return c.json({ error: "bad_payload" }, 400);
		}
		signedPayload = body.signedPayload;
	} catch {
		return c.json({ error: "bad_payload" }, 400);
	}

	const notification = decodeUnverifiedJws(signedPayload) as NotificationPayload | null;
	if (!notification) return c.json({ error: "bad_payload" }, 400);

	const type = stringOr(notification.notificationType, "UNKNOWN");
	const subtype = optionalString(notification.subtype);
	const uuid = optionalString(notification.notificationUUID);

	const hint = typeof notification.data?.signedTransactionInfo === "string"
		? (decodeUnverifiedJws(notification.data.signedTransactionInfo) as {
				transactionId?: unknown;
				originalTransactionId?: unknown;
			} | null)
		: null;
	const hintedOriginal = optionalString(hint?.originalTransactionId);

	/** Records how this ended, and answers Apple. */
	const done = async (outcome: PaymentOutcome, body: Record<string, unknown>, devices = 0) => {
		await finishEvent(c.env, "apple", uuid, "ok", outcome);
		paymentEvent({
			provider: "apple",
			type,
			subtype,
			outcome,
			external_ref: hintedOriginal,
			devices,
		});
		return c.json({ ok: true, ...body });
	};

	// Dedupe semantics, and why a failed row does not count as a duplicate, are
	// documented on `beginEvent`.
	const fresh = await beginEvent(c.env, {
		provider: "apple",
		eventId: uuid,
		type,
		subtype,
		externalRef: hintedOriginal,
		payload: signedPayload,
	});
	if (!fresh) {
		paymentEvent({
			provider: "apple",
			type,
			subtype,
			outcome: "duplicate",
			external_ref: hintedOriginal,
			devices: 0,
		});
		return c.json({ ok: true, ignored: "duplicate" });
	}
	// A notification with no uuid is not deduped at all. It should not happen;
	// if it does, processing it twice is harmless and dropping it is not.

	try {
		// TEST, CONSUMPTION_REQUEST and the renewal-extension notifications carry
		// no transaction to ask about. Nothing to do, and nothing wrong.
		if (!hint) return await done("no_transaction", { ignored: "no_transaction" });

		const hintedTransaction = optionalString(hint.transactionId);
		if (!hintedTransaction && !hintedOriginal) {
			return await done("no_transaction_id", { ignored: "no_transaction_id" });
		}

		// The local lookup matches the *hint's* id, which is the purchase's
		// external_id; the write further down keys off the *re-queried*
		// response. They are the same value in every real case, and spelling them
		// differently is what keeps the trust boundary visible.
		//
		// Short-circuiting here also means someone posting made-up ids never
		// reaches Apple at all.
		const known = hintedOriginal ? await findPurchase(c.env, "apple", hintedOriginal) : null;
		if (!known) return await done("orphan", { ignored: "orphan" });

		let transaction: AppleTransaction | null;
		try {
			transaction = await lookUp(c.env, [hintedTransaction, hintedOriginal]);
		} catch (error) {
			if (error instanceof AppleStoreError) {
				// 404: Apple cannot find it in either environment. 400: Apple rejected
				// the shape of our query. Both are permanent — a retry produces the
				// same answer — so they go down to 200 with a loud line.
				if (error.status === 404) {
					return await done("unknown_transaction", { ignored: "unknown_transaction" });
				}
				if (error.status === 400) return await done("rejected", { ignored: "rejected" });
			}
			// 503 and anything else: our keys, or Apple being down. This is precisely
			// what Apple's retry window is for, so let it become a 500.
			throw error;
		}
		if (!transaction) return await done("no_transaction_id", { ignored: "no_transaction_id" });

		// Another product in the same app, or a family-shared item we do not sell.
		if (!isProUnlock(transaction)) {
			return await done("other_product", { ignored: "other_product" });
		}

		const { purchaseId, refunded } = await recordApplePurchase(c.env, transaction, Date.now());
		const devices = await applyPurchaseStatus(c.env, purchaseId);
		if (refunded) licenseRevoked({ reason: `apple:${type}`, devices });
		return await done(refunded ? "revoked" : "active", {
			applied: refunded ? "revoked" : "active",
			devices,
		}, devices);
	} catch (error) {
		// Stamp the row before rethrowing, so the 500 `onError` produces earns a
		// retry that `beginEvent` will actually let through.
		await finishEvent(
			c.env,
			"apple",
			uuid,
			"error",
			"failed",
			error instanceof Error ? error.message : String(error),
		);
		paymentEvent({
			provider: "apple",
			type,
			subtype,
			outcome: "failed",
			external_ref: hintedOriginal,
			devices: 0,
		});
		throw error;
	}
}
