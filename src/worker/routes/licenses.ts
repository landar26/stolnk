import { Hono } from "hono";
import { PRO_SEATS, RATE_MAX_LICENSE } from "../limits";
import { activate, deactivate, keyHash, CreemError } from "../lib/creem";
import { AppleStoreError, transactionInfo } from "../lib/apple-store";
import { attachDevice, isProUnlock, recordApplePurchase } from "../lib/apple-purchase";
import { requireDevice } from "../lib/deviceauth";
import { planFor } from "../lib/entitlement";
import {
	activeBinding,
	applyPurchaseStatus,
	binding,
	bindDevice,
	findPurchase,
	reconcileDevice,
	seatsUsed,
	unbindDevice,
	unbindOthers,
	upsertPurchase,
} from "../lib/purchases";
import {
	badRequest,
	clientIp,
	fail,
	notFound,
	readJson,
	requireString,
	type AppEnv,
} from "../lib/http";
import { enforce } from "../lib/ratelimit";
import { licenseActivated, licenseReleased } from "../lib/metrics";
import { deviceName } from "../lib/inbox";

/**
 * Turning a purchase into an entitlement (PRD 16).
 *
 * The purchase flow deliberately has no account in it: the buyer gets a key by
 * email from Creem and pastes it into the Mac app. That keeps PRD 7.1 intact —
 * nobody, sender or receiver, ever makes an account — and it is why the licence
 * attaches to a device rather than to a person.
 */
export const licenses = new Hono<AppEnv>();

/** Keys are short, opaque, and typed in by hand. Be generous but bounded. */
const MAX_KEY = 128;

licenses.get("/status", async (c) => {
	const deviceId = await requireDevice(c.env, c.req.raw);
	return c.json(await planFor(c.env, deviceId));
});

/**
 * Turns a StoreKit 2 transaction into the service-side entitlement that all
 * quota checks use. No receipt fields from the phone are trusted: the only
 * input is an opaque transaction id, which is looked up again at Apple.
 */
licenses.post("/apple/verify", async (c) => {
	enforce(`license:${clientIp(c)}`, RATE_MAX_LICENSE);
	const deviceId = await requireDevice(c.env, c.req.raw);
	const body = await readJson<{ transaction_id?: unknown }>(c);
	const transactionId = requireString(body.transaction_id, "transaction_id", 32);
	if (!/^\d+$/.test(transactionId)) return badRequest("Invalid App Store transaction id.");

	let transaction;
	try {
		transaction = await transactionInfo(c.env, transactionId);
	} catch (error) {
		if (error instanceof AppleStoreError) {
			return fail(
				error.status,
				error.status === 404 ? "purchase_not_found" : "purchase_verification_failed",
				error.message,
			);
		}
		throw error;
	}

	if (!isProUnlock(transaction)) {
		return fail(400, "purchase_invalid", "This purchase doesn't unlock Stolnk Pro.");
	}

	const now = Date.now();
	const { purchaseId, refunded } = await recordApplePurchase(c.env, transaction, now);

	if (refunded) {
		// The calling device is typically not attached yet, so this usually touches
		// nobody — and does not need to. `planFor` reads the now-refunded status
		// through the join and answers accordingly.
		await applyPurchaseStatus(c.env, purchaseId);
		return c.json(await planFor(c.env, deviceId));
	}

	await attachDevice(c.env, deviceId, purchaseId, now);
	await reconcileDevice(c.env, deviceId);
	return c.json(await planFor(c.env, deviceId));
});

/**
 * Claims a seat for this Mac.
 *
 * Creem is the authority on whether the key is real and whether a seat is free;
 * this route's job is to ask it and then write down the answer. The order
 * matters: nothing is written locally until Creem has confirmed the activation,
 * so a failed call cannot leave a device believing it is Pro.
 */
licenses.post("/activate", async (c) => {
	enforce(`license:${clientIp(c)}`, RATE_MAX_LICENSE);
	const deviceId = await requireDevice(c.env, c.req.raw);
	const body = await readJson<{ key?: unknown }>(c);
	const key = requireString(body.key, "key", MAX_KEY).trim();

	const hash = await keyHash(key);
	// Only a licence that still grants something counts. One that was refunded
	// or disabled must not stop the same Mac from activating a replacement.
	const existing = await activeBinding(c.env, "creem", deviceId);
	if (existing) {
		if (existing.external_id === hash) {
			// Re-entering the same key is not an error — it is what someone does when
			// they are not sure it took. Burning a second seat for it would be.
			return c.json(await planFor(c.env, deviceId));
		}
		return badRequest("This Mac is already using a different licence. Release it first.");
	}

	// The instance name is what the buyer sees in Creem's customer portal when
	// they need to work out which Mac to release. The device's own name is the
	// only label they will recognise — it is the one in their links.
	const name = await deviceName(c.env, deviceId);
	if (!name) return notFound("This Mac is not registered on this server.");

	let license;
	try {
		license = await activate(c.env, key, name);
	} catch (error) {
		if (error instanceof CreemError) {
			// 4xx from Creem is a statement about the key: unknown, or out of seats.
			// Both need to reach the user as themselves rather than as "something
			// went wrong", because both have a specific next action.
			if (error.status === 404 || error.status === 400) {
				return fail(404, "license_not_found", "That licence key was not recognised.");
			}
			if (error.status === 409 || error.status === 403) {
				return fail(
					409,
					"seats_full",
					`This licence is already on ${PRO_SEATS} Macs. Release one of them first.`,
				);
			}
		}
		throw error;
	}

	const instanceId = license.instance?.id;
	if (!instanceId) {
		return fail(502, "activation_failed", "The licence server did not confirm this Mac.");
	}

	const now = Date.now();
	const purchaseId = await upsertPurchase(c.env, "creem", hash, {
		status: "active",
		seats: license.activation_limit ?? PRO_SEATS,
		metadata: { license_id: license.id },
		purchasedAt: now,
		verifiedAt: now,
	});
	await unbindOthers(c.env, "creem", deviceId, purchaseId, true);
	await bindDevice(c.env, purchaseId, deviceId, now, instanceId);

	// Every inbox this device already has carries the free 2 GB ceiling. Raise it,
	// or the buyer's own link keeps refusing the large files they just paid to
	// be able to receive. A device with none yet is not a special case — the
	// update matches nothing, and the inbox it makes next reads the live tier.
	await reconcileDevice(c.env, deviceId);

	licenseActivated({
		seats_used: license.activation,
		seats: license.activation_limit ?? PRO_SEATS,
	});
	return c.json(await planFor(c.env, deviceId));
});

/**
 * Releases a seat.
 *
 * Authenticated by holding the key, not by being the Mac. PRD 7.2 is the reason
 * and it is not a convenience: the device key lives in the Secure Enclave and
 * cannot be exported, so a Mac that is lost, sold or dead can never sign
 * anything again. If releasing a seat required the seat's own device, that seat
 * would be gone for good and a $39 purchase would quietly become a $39 purchase
 * with two Macs.
 *
 * The key is the bearer credential here, which is exactly what it is everywhere
 * else in this flow.
 */
licenses.post("/deactivate", async (c) => {
	// The only unauthenticated write in this file. Holding the key is the whole
	// credential, so the budget here is what stands between that and someone
	// trying keys in a loop.
	enforce(`license:${clientIp(c)}`, RATE_MAX_LICENSE);
	const body = await readJson<{ key?: unknown; device_id?: unknown }>(c);
	const key = requireString(body.key, "key", MAX_KEY).trim();
	const target = requireString(body.device_id, "device_id", 64);

	const hash = await keyHash(key);
	const purchase = await findPurchase(c.env, "creem", hash);
	const seat = purchase ? await binding(c.env, purchase.purchase_id, target) : null;
	// Same answer whether the key is wrong or the device is not on it: this route
	// is reachable without a session, and it must not become a way to test keys
	// or to ask which devices a licence covers.
	if (!purchase || !seat) return notFound("No such activation for that licence.");

	if (seat.instance_ref) {
		try {
			await deactivate(c.env, key, seat.instance_ref);
		} catch (error) {
			// Creem having already dropped the instance is a success for our purposes:
			// the seat is free, which is what the caller asked for. Anything else is
			// left alone rather than half-applied.
			if (!(error instanceof CreemError) || error.status !== 404) throw error;
		}
	}

	await unbindDevice(c.env, purchase.purchase_id, target);
	// Not a bare downgrade: a device that also holds another source stays Pro.
	await reconcileDevice(c.env, target);

	const remaining = await seatsUsed(c.env, purchase.purchase_id);
	licenseReleased({ seats_used: remaining });

	return c.json({ released: true, seats_used: remaining });
});
