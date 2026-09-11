import { Hono, type Context } from "hono";
import { MAX_SHARE_FILENAME, PART_SIZE, RATE_MAX_RESOLVES, partCountFor } from "../limits";
import { requireDevice } from "../lib/deviceauth";
import {
	badRequest,
	clientIp,
	fail,
	notFound,
	readJson,
	requireString,
	type AppEnv,
} from "../lib/http";
import { deviceName } from "../lib/inbox";
import { newSalt, PBKDF2_ITERATIONS } from "../lib/password";
import { enforce } from "../lib/ratelimit";
import {
	abandonShare,
	CODE_TAKEN,
	codeTaken,
	deleteShare,
	finishShare,
	reopenShare,
	openShare,
	presentShare,
	revokeShare,
	shareCodeProblem,
	validateShareCode,
	type ShareRow,
} from "../lib/share";
import { shareUrl } from "../lib/site";
import { bearer, verifyToken, type ShareUploadToken } from "../lib/tokens";

export const shares = new Hono<AppEnv>();

async function owned(env: Env, deviceId: string, shareId: string): Promise<ShareRow> {
	const row = await env.DB.prepare(
		"SELECT * FROM shares WHERE share_id = ? AND owner_device_id = ?",
	)
		.bind(shareId, deviceId)
		.first<ShareRow>();
	if (!row) return notFound("No such share.");
	return row;
}

async function uploadRow(c: { env: Env; req: { raw: Request } }, shareId: string) {
	const payload = await verifyToken<ShareUploadToken>(
		c.env.SESSION_SECRET,
		bearer(c.req.raw),
		"share_upload",
	);
	if (!payload || payload.share !== shareId) return notFound("No such upload.");
	const row = await c.env.DB.prepare("SELECT * FROM shares WHERE share_id = ?")
		.bind(shareId)
		.first<ShareRow>();
	if (!row) return notFound("No such upload.");
	return row;
}

/**
 * Is this path free?
 *
 * Shaped like `names/:name/available` down to the path parameter, and 200 with
 * a reason rather than 400 for that route's reason: a field being typed into is
 * asking a question, and "that is not a path" is an answer to it, not a failed
 * request. Device-authed, unlike the name probe, which has to serve a Mac that
 * does not have a device yet.
 */
async function availability(c: Context<AppEnv>, exceptShareId?: string) {
	const deviceId = await requireDevice(c.env, c.req.raw);
	enforce(`share-code:${clientIp(c)}`, RATE_MAX_RESOLVES);
	if (exceptShareId) await owned(c.env, deviceId, exceptShareId);
	const code = c.req.param("code").trim().toLowerCase();
	if (shareCodeProblem(code)) return c.json({ code, available: false, reason: "invalid" });
	const taken = await codeTaken(c.env, deviceId, code, exceptShareId);
	return c.json({ code, available: !taken, reason: taken ? "taken" : null });
}

shares.get("/code-available/:code", (c) => availability(c));

/**
 * The same question asked from the edit screen, where the share being renamed
 * already holds a path — including, for the moment between the save landing and
 * the list refreshing, the new one. Without excepting it the server answers
 * truthfully that the path is taken, by the share doing the asking, and the
 * field reports a successful rename as a collision. `PATCH` below excepts the
 * row for the same reason; this is that rule made visible while typing.
 */
shares.get("/:sid/code-available/:code", (c) => availability(c, c.req.param("sid")));

// Must precede /:sid.
shares.get("/salt", async (c) => {
	await requireDevice(c.env, c.req.raw);
	return c.json({ salt: newSalt(), iterations: PBKDF2_ITERATIONS });
});

shares.post("/", async (c) => {
	const deviceId = await requireDevice(c.env, c.req.raw);
	const body = await readJson<{
		filename?: unknown;
		size?: unknown;
		code?: unknown;
		ttl_hours?: unknown;
		max_downloads?: unknown;
		password?: unknown;
		password_salt?: unknown;
	}>(c);
	const filename = requireString(body.filename, "filename", MAX_SHARE_FILENAME);
	if (/[/\\\r\n]/.test(filename)) return badRequest("filename must be a single safe path component.");
	// Absent or empty means "mint me an unguessable one" — the original
	// behaviour, and still the default everywhere the owner does not type.
	const code =
		body.code === undefined || body.code === null || body.code === ""
			? null
			: validateShareCode(requireString(body.code, "code", 32));
	if (typeof body.size !== "number" || !Number.isSafeInteger(body.size) || body.size < 0) {
		return badRequest('"size" must be a non-negative integer.');
	}
	// The API deliberately accepts any positive duration so expiry can be tested
	// without a one-hour sleep. The Mac offers only the published presets.
	if (typeof body.ttl_hours !== "number" || !Number.isFinite(body.ttl_hours) || body.ttl_hours <= 0) {
		return badRequest('"ttl_hours" must be a positive number.');
	}
	let maxDownloads: number | null = null;
	if (body.max_downloads !== undefined && body.max_downloads !== null) {
		if (!Number.isSafeInteger(body.max_downloads) || (body.max_downloads as number) < 1) {
			return badRequest('"max_downloads" must be a positive integer.');
		}
		maxDownloads = body.max_downloads as number;
	}
	let verifier: string | null = null;
	let salt: string | null = null;
	if (body.password !== undefined && body.password !== null) {
		verifier = requireString(body.password, "password", 256);
		salt = requireString(body.password_salt, "password_salt", 128);
	}

	const opened = await openShare(c.env, {
		ownerDeviceId: deviceId,
		filename,
		size: body.size,
		ttlHours: body.ttl_hours,
		maxDownloads,
		passwordVerifier: verifier,
		passwordSalt: salt,
		code,
	});
	const name = await deviceName(c.env, deviceId);
	if (!name) return notFound();
	return c.json(
		{
			share_id: opened.shareId,
			code: opened.code,
			url: shareUrl(name, opened.code),
			token: opened.token,
			part_size: opened.partSize,
			part_count: opened.partCount,
			expires_at: opened.expiresAt,
		},
		201,
	);
});

shares.put("/:sid/parts/:n", async (c) => {
	const shareId = c.req.param("sid");
	const row = await uploadRow(c, shareId);
	const partNumber = Number(c.req.param("n"));
	if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10_000) {
		return badRequest("Bad part number.");
	}
	if (row.state !== "uploading" || !row.upload_id) {
		return badRequest("This share is no longer accepting parts.");
	}
	const existing = await c.env.DB.prepare(
		"SELECT etag FROM share_parts WHERE share_id = ? AND part_number = ?",
	)
		.bind(shareId, partNumber)
		.first<{ etag: string }>();
	if (existing) return c.json({ part_number: partNumber, etag: existing.etag, skipped: true });

	const totalParts = partCountFor(row.size);
	if (partNumber > totalParts) return badRequest("Part number past the end of the file.");
	const expected = partNumber === totalParts ? row.size - (totalParts - 1) * PART_SIZE : PART_SIZE;
	if (Number(c.req.header("content-length") ?? "-1") !== expected) {
		return badRequest(`Part ${partNumber} must be exactly ${expected} bytes.`);
	}
	if (!c.req.raw.body) return badRequest("Empty body.");
	const part = await c.env.RELAY.resumeMultipartUpload(row.r2_key, row.upload_id).uploadPart(
		partNumber,
		c.req.raw.body,
	);
	await c.env.DB.prepare(
		"INSERT OR REPLACE INTO share_parts (share_id, part_number, etag, size) VALUES (?, ?, ?, ?)",
	)
		.bind(shareId, partNumber, part.etag, expected)
		.run();
	return c.json({ part_number: partNumber, etag: part.etag, skipped: false });
});

shares.post("/:sid/complete", async (c) => {
	const row = await uploadRow(c, c.req.param("sid"));
	const body = await readJson<{ sha256?: unknown }>(c);
	const sha256 = requireString(body.sha256, "sha256", 64);
	if (!/^[0-9a-f]{64}$/.test(sha256)) return badRequest("sha256 must be 64 hex characters.");
	if (row.state === "ready") return c.json({ state: "ready", already: true });
	if (row.state !== "uploading") return badRequest("This share cannot be completed.");
	// A row that already carries a hash is being restored, and the link it is
	// being restored to is unchanged — so the bytes must be too. See the note on
	// `reopenShare`: this is what keeps a restore from becoming a way to put a
	// different file behind a URL other people are already holding.
	if (row.sha256 && row.sha256 !== sha256) {
		// Abort rather than leave the multipart dangling. `abandonShare` also
		// refunds the bytes this attempt booked, and the row lands in `aborted`
		// — still terminal, still holding its path, still restorable with the
		// right file.
		await abandonShare(c.env, row);
		return badRequest(
			"That is not the file this link was created for. Restoring a link must use the same file.",
		);
	}
	const { results } = await c.env.DB.prepare(
		"SELECT part_number, etag FROM share_parts WHERE share_id = ? ORDER BY part_number ASC",
	)
		.bind(row.share_id)
		.all<{ part_number: number; etag: string }>();
	if (results.length !== partCountFor(row.size)) {
		return badRequest(`Expected ${partCountFor(row.size)} parts, have ${results.length}.`);
	}
	await finishShare(
		c.env,
		row,
		results.map((part) => ({ partNumber: part.part_number, etag: part.etag })),
		sha256,
	);
	const name = await deviceName(c.env, row.owner_device_id);
	return c.json({ state: "ready", url: name ? shareUrl(name, row.code) : null });
});

shares.post("/:sid/abort", async (c) => {
	const row = await uploadRow(c, c.req.param("sid"));
	await abandonShare(c.env, row);
	return c.json({ aborted: true });
});

shares.get("/", async (c) => {
	const deviceId = await requireDevice(c.env, c.req.raw);
	const name = await deviceName(c.env, deviceId);
	if (!name) return notFound();
	const { results } = await c.env.DB.prepare(
		"SELECT * FROM shares WHERE owner_device_id = ? ORDER BY created_at DESC",
	)
		.bind(deviceId)
		.all<ShareRow>();
	return c.json({ name, shares: results.map((row) => presentShare(name, row)) });
});

shares.get("/:sid", async (c) => {
	const deviceId = await requireDevice(c.env, c.req.raw);
	const row = await owned(c.env, deviceId, c.req.param("sid"));
	const { results } = await c.env.DB.prepare(
		"SELECT part_number FROM share_parts WHERE share_id = ? ORDER BY part_number ASC",
	)
		.bind(row.share_id)
		.all<{ part_number: number }>();
	return c.json({
		share_id: row.share_id,
		state: row.state,
		expires_at: row.expires_at,
		part_count: partCountFor(row.size),
		completed_parts: results.map((part) => part.part_number),
	});
});

/**
 * Change a link that has not ended: its path, whether it is paused, or both.
 *
 * Pausing is the reversible half of stopping a link, and the reason revoking is
 * not offered as reversible: revoking deletes the object, so there would be
 * nothing left to turn back on. A paused link keeps its bytes and its path and
 * answers 423 until it is resumed.
 *
 * Terminal rows are refused. Repathing a spent or revoked share changes nothing
 * anyone can reach and would quietly reserve a second path, and resuming one
 * would promise bytes that are already gone.
 */
shares.patch("/:sid", async (c) => {
	const deviceId = await requireDevice(c.env, c.req.raw);
	const row = await owned(c.env, deviceId, c.req.param("sid"));
	if (row.state !== "uploading" && row.state !== "ready") {
		return badRequest("This link has ended, so it can no longer be changed.");
	}
	const body = await readJson<{ code?: unknown; paused?: unknown }>(c);
	const name = await deviceName(c.env, deviceId);
	if (!name) return notFound();

	let code = row.code;
	if (body.code !== undefined) {
		code = validateShareCode(requireString(body.code, "code", 32));
		if (code !== row.code && (await codeTaken(c.env, deviceId, code, row.share_id))) {
			return fail(409, "code_taken", CODE_TAKEN);
		}
	}
	let paused = row.paused;
	if (body.paused !== undefined) {
		if (typeof body.paused !== "boolean") return badRequest('"paused" must be a boolean.');
		paused = body.paused ? 1 : 0;
	}
	if (code === row.code && paused === row.paused) return c.json(presentShare(name, row));

	try {
		await c.env.DB.prepare("UPDATE shares SET code = ?, paused = ? WHERE share_id = ?")
			.bind(code, paused, row.share_id)
			.run();
	} catch (error) {
		// Lost the race with a concurrent create or rename.
		if (String(error).includes("UNIQUE")) return fail(409, "code_taken", CODE_TAKEN);
		throw error;
	}
	return c.json(presentShare(name, { ...row, code, paused }));
});

/**
 * Stop the link, keep the record.
 *
 * Its own verb because `DELETE` below now means what it says. Revoking leaves a
 * row behind on purpose: the path stays reserved, so nobody holding the old URL
 * can later be handed a different file at the same address.
 */
shares.post("/:sid/revoke", async (c) => {
	const deviceId = await requireDevice(c.env, c.req.raw);
	const row = await owned(c.env, deviceId, c.req.param("sid"));
	await revokeShare(c.env, row);
	return c.json({ revoked: true });
});

/**
 * Put the file back behind a link that has ended.
 *
 * Answers in the same shape as creating a share so the Mac can hand the result
 * to the identical upload loop — restoring is the same upload, aimed at a row
 * that already exists.
 */
shares.post("/:sid/restore", async (c) => {
	const deviceId = await requireDevice(c.env, c.req.raw);
	const row = await owned(c.env, deviceId, c.req.param("sid"));
	const reopened = await reopenShare(c.env, row);
	const name = await deviceName(c.env, deviceId);
	if (!name) return notFound();
	return c.json({
		share_id: reopened.shareId,
		code: reopened.code,
		url: shareUrl(name, reopened.code),
		token: reopened.token,
		part_size: reopened.partSize,
		part_count: reopened.partCount,
		expires_at: reopened.expiresAt,
		sha256: row.sha256,
	});
});

/**
 * Remove the record, whatever state it is in. Releases the object and the path.
 *
 * This used to be `revokeShare`, which made the verb a lie and left owners with
 * a list they could not clear and paths they could not reuse for seven days.
 */
shares.delete("/:sid", async (c) => {
	const deviceId = await requireDevice(c.env, c.req.raw);
	const row = await owned(c.env, deviceId, c.req.param("sid"));
	await deleteShare(c.env, row);
	return c.json({ deleted: true });
});
