import { Hono } from "hono";
import { MAX_DISPLAY_NAME, RATE_MAX_RESOLVES } from "../limits";
import { fromBase64Url, randomId } from "../lib/bytes";
import {
	consumeChallenge,
	issueChallenge,
	issueDeviceToken,
	requireDevice,
	verifySignature,
} from "../lib/deviceauth";
import {
	badRequest,
	clientIp,
	fail,
	readJson,
	requireString,
	unauthorized,
	unknownDevice,
	type AppEnv,
} from "../lib/http";
import {
	deviceName,
	inboxInsert,
	nameProblem,
	requireSlug,
	validateName,
	type InboxRow,
} from "../lib/inbox";
import { enforce } from "../lib/ratelimit";
import { inboxUrl } from "../lib/site";
import { present } from "./inboxes";

/**
 * PRD 7.1: registration is one screen and one round trip. The name is not a
 * later upgrade over a random identity — it *is* the identity, so it is part of
 * the request that creates the device.
 */
export const devices = new Hono<AppEnv>();

interface RegisterBody {
	name?: unknown;
	slug?: unknown;
	pubkey_sig?: unknown;
	pubkey_kex?: unknown;
	display_name?: unknown;
}

devices.post("/", async (c) => {
	const body = await readJson<RegisterBody>(c);
	const name = validateName(requireString(body.name, "name", 32));
	// Every link is a name *and* a path, so the first inbox needs one too — there
	// is no bare-subdomain address to fall back on.
	const slug = requireSlug(body.slug);
	const pubkeySig = requireString(body.pubkey_sig, "pubkey_sig", 256);
	const pubkeyKex = requireString(body.pubkey_kex, "pubkey_kex", 256);
	// The first inbox is the device's own, so the name is the honest default —
	// the send page reads "Send files to ryan" rather than "Send files to Inbox".
	// Later inboxes take their folder's name instead, which carries more.
	const displayName =
		typeof body.display_name === "string" && body.display_name.trim()
			? body.display_name.trim().slice(0, MAX_DISPLAY_NAME)
			: name;

	// Both keys are raw uncompressed P-256 points: 0x04 || X(32) || Y(32).
	for (const [field, key] of [["pubkey_sig", pubkeySig], ["pubkey_kex", pubkeyKex]] as const) {
		let bytes: Uint8Array;
		try {
			bytes = fromBase64Url(key);
		} catch {
			return badRequest(`"${field}" is not base64url.`);
		}
		if (bytes.length !== 65 || bytes[0] !== 0x04) {
			return badRequest(`"${field}" must be an uncompressed P-256 public key.`);
		}
	}

	const taken = await c.env.DB.prepare("SELECT 1 AS x FROM devices WHERE name = ?")
		.bind(name)
		.first();
	if (taken) return fail(409, "name_taken", "That name is already in use.");

	const deviceId = randomId();
	const now = Date.now();

	// Registration hands back a working URL in one round trip, so the first inbox
	// is created here rather than in a follow-up call. It is an ordinary inbox —
	// deletable and movable like the rest.
	const { row: inbox, stmt: insertInbox } = inboxInsert(c.env, {
		deviceId,
		slug,
		displayName,
	});

	try {
		// One batch, so a device can never exist without the inbox that gives it a
		// URL — and so the UNIQUE(name) that loses a race takes the inbox with it.
		await c.env.DB.batch([
			c.env.DB.prepare(
				`INSERT INTO devices (device_id, name, pubkey_sig, pubkey_kex, created_at, last_seen)
				 VALUES (?, ?, ?, ?, ?, ?)`,
			).bind(deviceId, name, pubkeySig, pubkeyKex, now, now),
			insertInbox,
		]);
	} catch (error) {
		if (String(error).includes("UNIQUE")) {
			return fail(409, "name_taken", "That name is already in use.");
		}
		throw error;
	}

	const session = await issueDeviceToken(c.env, deviceId);
	return c.json(
		{
			device_id: deviceId,
			name,
			token: session.token,
			expires_at: session.expires_at,
			inbox: {
				inbox_id: inbox.inbox_id,
				slug: inbox.path_slug,
				url: inboxUrl(c.env, name, inbox.path_slug),
				display_name: inbox.display_name,
			},
		},
		201,
	);
});

devices.get("/:id/challenge", async (c) => {
	const deviceId = c.req.param("id");
	const row = await c.env.DB.prepare("SELECT device_id FROM devices WHERE device_id = ?")
		.bind(deviceId)
		.first<{ device_id: string }>();
	if (!row) return unknownDevice();
	return c.json({ nonce: await issueChallenge(c.env, deviceId) });
});

devices.post("/:id/auth", async (c) => {
	const deviceId = c.req.param("id");
	const body = await readJson<{ nonce?: unknown; signature?: unknown }>(c);
	const nonce = requireString(body.nonce, "nonce", 128);
	const signature = requireString(body.signature, "signature", 256);

	const device = await c.env.DB.prepare("SELECT pubkey_sig FROM devices WHERE device_id = ?")
		.bind(deviceId)
		.first<{ pubkey_sig: string }>();
	if (!device) return unknownDevice();

	// Consumed first: a replayed nonce is dead even if the signature is valid.
	if (!(await consumeChallenge(c.env, deviceId, nonce))) {
		return unauthorized("Challenge expired or already used.");
	}

	let signatureBytes: Uint8Array;
	try {
		signatureBytes = fromBase64Url(signature);
	} catch {
		return unauthorized("Malformed signature.");
	}
	const ok = await verifySignature(
		device.pubkey_sig,
		new TextEncoder().encode(nonce),
		signatureBytes,
	);
	if (!ok) return unauthorized("Signature did not verify.");

	await c.env.DB.prepare("UPDATE devices SET last_seen = ? WHERE device_id = ?")
		.bind(Date.now(), deviceId)
		.run();

	const session = await issueDeviceToken(c.env, deviceId);
	return c.json({ token: session.token, expires_at: session.expires_at });
});

/** Everything the Mac needs to render the menu bar after a cold start. */
devices.get("/me", async (c) => {
	const deviceId = await requireDevice(c.env, c.req.raw);
	const name = await deviceName(c.env, deviceId);
	if (!name) return unknownDevice();

	const { results } = await c.env.DB.prepare(
		"SELECT * FROM inboxes WHERE owner_device_id = ? ORDER BY created_at ASC",
	)
		.bind(deviceId)
		.all<InboxRow>();

	return c.json({
		device_id: deviceId,
		name,
		inboxes: results.map((row) => present(c.env, name, row)),
	});
});

/**
 * PRD 6.1 — the name. It belongs to the device, not to the inboxes, which is
 * why these two routes live next to registration rather than next to inbox
 * management.
 */
export const names = new Hono<AppEnv>();

/**
 * Renaming. One statement: inboxes do not store the name, so every link the
 * device owns moves with it. The old subdomain stops resolving immediately and
 * the name goes straight back into the pool — there is no grace redirect, so a
 * link that has been given out does not outlive the rename.
 */
names.post("/", async (c) => {
	const deviceId = await requireDevice(c.env, c.req.raw);
	const body = await readJson<{ name?: unknown }>(c);
	const name = validateName(requireString(body.name, "name", 32));

	const current = await deviceName(c.env, deviceId);
	if (!current) return unknownDevice();
	if (current === name) return badRequest("That is already your name.");

	const taken = await c.env.DB.prepare("SELECT 1 AS x FROM devices WHERE name = ?")
		.bind(name)
		.first();
	if (taken) return fail(409, "name_taken", "That name is already in use.");

	try {
		await c.env.DB.prepare("UPDATE devices SET name = ? WHERE device_id = ?")
			.bind(name, deviceId)
			.run();
	} catch (error) {
		if (String(error).includes("UNIQUE")) {
			return fail(409, "name_taken", "That name is already in use.");
		}
		throw error;
	}

	const { results } = await c.env.DB.prepare(
		"SELECT * FROM inboxes WHERE owner_device_id = ? ORDER BY created_at ASC",
	)
		.bind(deviceId)
		.all<InboxRow>();
	return c.json({ name, inboxes: results.map((row) => present(c.env, name, row)) });
});

/**
 * Availability. Unauthenticated and therefore rate limited: with names mandatory
 * and one-per-device, this is the cheapest enumeration oracle we expose.
 *
 * A reserved or malformed name answers 200 with a reason rather than 400. The
 * caller asked whether it can have this name, and "no, and here is why" is an
 * answer — a 400 makes clients that use it report that the question could not
 * be asked.
 */
names.get("/:name/available", async (c) => {
	enforce(`names:${clientIp(c)}`, RATE_MAX_RESOLVES);

	const raw = c.req.param("name").trim().toLowerCase();
	const problem = nameProblem(raw);
	if (problem) return c.json({ name: raw, available: false, reason: problem });

	const taken = await c.env.DB.prepare("SELECT 1 AS x FROM devices WHERE name = ?")
		.bind(raw)
		.first();
	return c.json({ name: raw, available: !taken, reason: taken ? "taken" : null });
});
