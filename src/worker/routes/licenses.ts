import { Hono } from "hono";
import { FREE, PRO, PRO_SEATS, RATE_MAX_LICENSE } from "../limits";
import { activate, deactivate, keyHash, CreemError } from "../lib/creem";
import { requireDevice } from "../lib/deviceauth";
import { applyTierToInboxes, pauseInboxesOverFreeLimit, planFor } from "../lib/entitlement";
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
	const existing = await c.env.DB.prepare(
		"SELECT key_hash FROM license_devices WHERE device_id = ?",
	)
		.bind(deviceId)
		.first<{ key_hash: string }>();
	if (existing) {
		if (existing.key_hash === hash) {
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
	await c.env.DB.batch([
		c.env.DB.prepare(
			`INSERT INTO licenses (key_hash, creem_license_id, status, major_version, seats,
			                       purchased_at, revalidated_at)
			 VALUES (?, ?, 'active', 1, ?, ?, ?)
			 ON CONFLICT (key_hash) DO UPDATE SET
			   status = 'active', creem_license_id = excluded.creem_license_id,
			   seats = excluded.seats, revalidated_at = excluded.revalidated_at`,
		).bind(hash, license.id, license.activation_limit ?? PRO_SEATS, now, now),
		c.env.DB.prepare(
			`INSERT INTO license_devices (device_id, key_hash, instance_id, activated_at)
			 VALUES (?, ?, ?, ?)`,
		).bind(deviceId, hash, instanceId, now),
	]);

	// The inbox created at registration carries the free 2 GB ceiling. Raise it,
	// or the buyer's own link keeps refusing the large files they just paid to
	// be able to receive.
	await applyTierToInboxes(c.env, deviceId, PRO);

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
	const seat = await c.env.DB.prepare(
		"SELECT instance_id FROM license_devices WHERE device_id = ? AND key_hash = ?",
	)
		.bind(target, hash)
		.first<{ instance_id: string }>();
	// Same answer whether the key is wrong or the device is not on it: this route
	// is reachable without a session, and it must not become a way to test keys
	// or to ask which devices a licence covers.
	if (!seat) return notFound("No such activation for that licence.");

	try {
		await deactivate(c.env, key, seat.instance_id);
	} catch (error) {
		// Creem having already dropped the instance is a success for our purposes:
		// the seat is free, which is what the caller asked for. Anything else is
		// left alone rather than half-applied.
		if (!(error instanceof CreemError) || error.status !== 404) throw error;
	}

	await c.env.DB.prepare("DELETE FROM license_devices WHERE device_id = ?").bind(target).run();
	await applyTierToInboxes(c.env, target, FREE);
	await pauseInboxesOverFreeLimit(c.env, target);

	const remaining = await c.env.DB.prepare(
		"SELECT count(*) AS n FROM license_devices WHERE key_hash = ?",
	)
		.bind(hash)
		.first<{ n: number }>();
	licenseReleased({ seats_used: remaining?.n ?? 0 });

	return c.json({ released: true, seats_used: remaining?.n ?? 0 });
});
