import { Hono } from "hono";
import { MAX_DISPLAY_NAME } from "../limits";
import { randomSlug } from "../lib/bytes";
import { requireDevice } from "../lib/deviceauth";
import { tierFor } from "../lib/entitlement";
import {
	badRequest,
	notFound,
	readJson,
	requireString,
	unknownDevice,
	upgradeRequired,
	type AppEnv,
} from "../lib/http";
import { createInbox, deviceName, requireSlug, type InboxRow } from "../lib/inbox";
import { upgradeWallHit } from "../lib/metrics";
import { hashVerifier, newSalt } from "../lib/password";
import { inboxUrl } from "../lib/site";

/** Inbox management. Every route here is the Mac talking about its own inboxes. */
export const inboxes = new Hono<AppEnv>();

/**
 * The wire shape of an inbox. `slug` is the part the owner edits; `url` is the
 * whole address. The name is not in the row — it belongs to the device — so it
 * is passed in, which is also what stops it from ever being stale.
 */
export function present(name: string, row: InboxRow) {
	return {
		inbox_id: row.inbox_id,
		slug: row.path_slug,
		url: inboxUrl(name, row.path_slug),
		display_name: row.display_name,
		paused: !!row.paused,
		confirm_first: !!row.confirm_first,
		size_limit: row.size_limit,
		has_password: !!row.password_verifier_hash,
	};
}

async function ownedInbox(env: Env, deviceId: string, inboxId: string): Promise<InboxRow> {
	const row = await env.DB.prepare(
		"SELECT * FROM inboxes WHERE inbox_id = ? AND owner_device_id = ?",
	)
		.bind(inboxId, deviceId)
		.first<InboxRow>();
	if (!row) return notFound("No such inbox.");
	return row;
}

async function nameOf(env: Env, deviceId: string): Promise<string> {
	const name = await deviceName(env, deviceId);
	if (!name) return unknownDevice();
	return name;
}

inboxes.get("/", async (c) => {
	const deviceId = await requireDevice(c.env, c.req.raw);
	const name = await nameOf(c.env, deviceId);
	const { results } = await c.env.DB.prepare(
		"SELECT * FROM inboxes WHERE owner_device_id = ? ORDER BY created_at ASC",
	)
		.bind(deviceId)
		.all<InboxRow>();
	// The name rides along so a refresh keeps the displayed address prefix
	// current without a second round trip.
	return c.json({ name, inboxes: results.map((row) => present(name, row)) });
});

/**
 * PRD 6.2 — the paywall for a second inbox sits at the *last* step of this
 * flow, not on the entry point, so that "how many people actually want a second
 * inbox" stays measurable (hypothesis H2) even from users who never convert.
 * V1 ships with Pro unlocked, so the check below never fires; it is here so the
 * signal has somewhere to be recorded when it does.
 */
inboxes.post("/", async (c) => {
	const deviceId = await requireDevice(c.env, c.req.raw);
	const body = await readJson<{ slug?: unknown; display_name?: unknown }>(c);
	const slug = requireSlug(body.slug);
	const displayName = requireString(body.display_name, "display_name", MAX_DISPLAY_NAME);

	const name = await nameOf(c.env, deviceId);
	const tier = await tierFor(c.env, deviceId);
	const count = await c.env.DB.prepare(
		"SELECT count(*) AS n FROM inboxes WHERE owner_device_id = ?",
	)
		.bind(deviceId)
		.first<{ n: number }>();
	if ((count?.n ?? 0) >= tier.maxInboxes) {
		// PRD 15.4 — this refusal is the primary signal for H2 ("will people want a
		// second inbox at all?"), which is why the wall is here at the end of the
		// flow rather than on the button that opens it. Someone who never converts
		// still tells us they wanted one.
		upgradeWallHit({ wall: "second_inbox" });
		upgradeRequired("Free includes one inbox. Upgrade to route files to more folders.");
	}

	// One path per device — and because a name belongs to exactly one device,
	// that is the same thing as (name, path) being globally unique.
	const clash = await c.env.DB.prepare(
		"SELECT inbox_id FROM inboxes WHERE owner_device_id = ? AND path_slug = ?",
	)
		.bind(deviceId, slug)
		.first();
	if (clash) return badRequest("That path is already in use.");

	const row = await createInbox(c.env, { deviceId, slug, displayName, tier });
	return c.json(present(name, row), 201);
});

inboxes.patch("/:id", async (c) => {
	const deviceId = await requireDevice(c.env, c.req.raw);
	const row = await ownedInbox(c.env, deviceId, c.req.param("id"));
	const body = await readJson<{
		display_name?: unknown;
		slug?: unknown;
		paused?: unknown;
		confirm_first?: unknown;
		password?: unknown;
	}>(c);

	const updates: string[] = [];
	const values: unknown[] = [];

	// Moving an inbox to a different path. Same rule as creating one — one path
	// per device — except that the row is allowed to keep the path it holds.
	if (body.slug !== undefined) {
		const slug = requireSlug(body.slug);
		const clash = await c.env.DB.prepare(
			`SELECT inbox_id FROM inboxes
			 WHERE owner_device_id = ? AND path_slug = ? AND inbox_id != ?`,
		)
			.bind(deviceId, slug, row.inbox_id)
			.first();
		if (clash) return badRequest("That path is already in use.");
		updates.push("path_slug = ?");
		values.push(slug);
	}

	if (body.display_name !== undefined) {
		updates.push("display_name = ?");
		values.push(requireString(body.display_name, "display_name", MAX_DISPLAY_NAME));
	}
	if (body.paused !== undefined) {
		if (typeof body.paused !== "boolean") return badRequest('"paused" must be a boolean.');
		updates.push("paused = ?");
		values.push(body.paused ? 1 : 0);
	}
	if (body.confirm_first !== undefined) {
		if (typeof body.confirm_first !== "boolean") {
			return badRequest('"confirm_first" must be a boolean.');
		}
		updates.push("confirm_first = ?");
		values.push(body.confirm_first ? 1 : 0);
	}
	// `password` carries a PBKDF2 verifier derived in the client, never the
	// password itself (PRD 18). null clears it.
	if (body.password !== undefined) {
		if (body.password === null) {
			// Clearing is allowed on every tier, deliberately. A Pro user who lapses
			// must never end up locked out of their own inbox by a password they can
			// no longer remove — downgrading takes capabilities away, not access.
			updates.push("password_salt = ?", "password_verifier_hash = ?");
			values.push(null, null);
		} else {
			// 16.1 — setting one is Pro.
			if ((await tierFor(c.env, deviceId)).name === "free") {
				upgradeWallHit({ wall: "password" });
				upgradeRequired("Password-protected links are part of Pro.");
			}
			const verifier = requireString(body.password, "password", 256);
			const salt = requireString(
				(body as { password_salt?: unknown }).password_salt,
				"password_salt",
				128,
			);
			updates.push("password_salt = ?", "password_verifier_hash = ?");
			values.push(salt, await hashVerifier(verifier));
		}
	}

	if (updates.length === 0) return badRequest("Nothing to update.");
	values.push(row.inbox_id);
	await c.env.DB.prepare(`UPDATE inboxes SET ${updates.join(", ")} WHERE inbox_id = ?`)
		.bind(...values)
		.run();

	const updated = await ownedInbox(c.env, deviceId, row.inbox_id);
	return c.json(present(await nameOf(c.env, deviceId), updated));
});

/** A fresh salt for the client to derive against when setting a password. */
inboxes.post("/:id/password-salt", async (c) => {
	const deviceId = await requireDevice(c.env, c.req.raw);
	await ownedInbox(c.env, deviceId, c.req.param("id"));
	return c.json({ salt: newSalt(), iterations: 210_000 });
});

/**
 * Any inbox, including the one registration created — it has no special status.
 * Deleting one frees its path for reuse and cascades to its transfers and files,
 * so anything still parked in the relay for it goes too — which is why the Mac
 * confirms first.
 */
inboxes.delete("/:id", async (c) => {
	const deviceId = await requireDevice(c.env, c.req.raw);
	const row = await ownedInbox(c.env, deviceId, c.req.param("id"));
	await c.env.DB.prepare("DELETE FROM inboxes WHERE inbox_id = ?").bind(row.inbox_id).run();
	return c.json({ deleted: true });
});

/**
 * Forget this inbox's finished transfers, and keep the inbox.
 *
 * The distinction from `DELETE /:id` is the whole reason this exists. Deleting
 * an inbox also clears its records, but it gives up the address to do it —
 * so anyone who wanted to clear a history had to hand back the link they had
 * given people. Reset was no help either: it rotates the path and leaves every
 * row where it was.
 *
 * **In-flight transfers are left alone.** `uploading` and `ready` both mean
 * ciphertext is parked in R2 and a sender is waiting on an answer; deleting
 * those rows would orphan the object and turn the sender's page into a 404.
 * That is exactly the difference from deleting the inbox, which does take them
 * — and is why the Mac confirms that one.
 *
 * Nothing here touches `usage_daily` or `usage_monthly`. Clearing a record must
 * not return allowance, or it becomes a way to buy relay bytes for free.
 */
inboxes.delete("/:id/transfers", async (c) => {
	const deviceId = await requireDevice(c.env, c.req.raw);
	const row = await ownedInbox(c.env, deviceId, c.req.param("id"));

	// Counted before rather than read off `meta.changes` afterwards: D1 reports
	// the cascade too, so a single transfer carrying one file comes back as two.
	// The Mac puts this number in front of the user — "cleared 2 records" for one
	// file is a small lie, and it is the only feedback the action gives.
	const TERMINAL = "('delivered', 'declined', 'aborted', 'expired')";
	const counted = await c.env.DB.prepare(
		`SELECT count(*) AS n FROM transfers WHERE inbox_id = ? AND state IN ${TERMINAL}`,
	)
		.bind(row.inbox_id)
		.first<{ n: number }>();

	await c.env.DB.prepare(
		`DELETE FROM transfers WHERE inbox_id = ? AND state IN ${TERMINAL}`,
	)
		.bind(row.inbox_id)
		.run();

	return c.json({ cleared: counted?.n ?? 0 });
});

/**
 * PRD 6.3 — Reset gives up this inbox's address and takes a new one. The old
 * URL 404s immediately: the point is to cut off whoever has the link, so unlike
 * a rename there is no grace period.
 *
 * Only the path rotates. The name is the device's identity, not a secret, and
 * resetting an inbox has never been a reason to change it.
 */
inboxes.post("/:id/reset", async (c) => {
	const deviceId = await requireDevice(c.env, c.req.raw);
	const row = await ownedInbox(c.env, deviceId, c.req.param("id"));

	await c.env.DB.prepare("UPDATE inboxes SET path_slug = ? WHERE inbox_id = ?")
		.bind(randomSlug(), row.inbox_id)
		.run();

	const updated = await ownedInbox(c.env, deviceId, row.inbox_id);
	return c.json(present(await nameOf(c.env, deviceId), updated));
});
