import { Hono } from "hono";
import { CHUNK_SIZE } from "../limits";
import { hubFor, pushInBackground, requireDevice } from "../lib/deviceauth";
import { badRequest, notFound, readJson, type AppEnv } from "../lib/http";
import { fileDelivered } from "../lib/metrics";

/**
 * The Mac side of the relay. Everything here is authenticated as a device.
 *
 * The lifecycle is deliberately short (PRD 8.5): the Mac pulls the ciphertext,
 * decrypts and lands it, then ACKs — and the ACK deletes the object
 * immediately. Storing briefly is what makes offline delivery possible; storing
 * any longer than that is just cost and liability.
 */
export const delivery = new Hono<AppEnv>();

interface PendingRow {
	file_id: string;
	transfer_id: string;
	inbox_id: string;
	inbox_name: string;
	enc_name: string;
	name_iv: string;
	size: number;
	cipher_size: number;
	nonce_prefix: string;
	wrapped_key: string;
	key_iv: string;
	eph_pub: string;
	plain_sha256: string;
	created_at: number;
	expires_at: number;
	sender_session: string;
	confirm_first: number;
	trusted: number;
}

async function ownedFile(env: Env, deviceId: string, fileId: string) {
	const row = await env.DB.prepare(
		`SELECT f.*, t.inbox_id, t.sender_session, i.owner_device_id, i.confirm_first
		 FROM files f
		 JOIN transfers t ON t.transfer_id = f.transfer_id
		 JOIN inboxes i ON i.inbox_id = t.inbox_id
		 WHERE f.file_id = ? AND i.owner_device_id = ?`,
	)
		.bind(fileId, deviceId)
		.first<{
			file_id: string;
			transfer_id: string;
			r2_key: string;
			state: string;
			inbox_id: string;
			sender_session: string;
			cipher_size: number;
			created_at: number;
		}>();
	if (!row) return notFound("No such file.");
	return row;
}

/**
 * Everything waiting for this Mac. This is what makes an asleep Mac a
 * non-event: on wake it asks once and collects whatever arrived (PRD 10.5).
 */
delivery.get("/pending", async (c) => {
	const deviceId = await requireDevice(c.env, c.req.raw);
	const { results } = await c.env.DB.prepare(
		`SELECT f.file_id, f.transfer_id, t.inbox_id, i.display_name AS inbox_name,
		        f.enc_name, f.name_iv, f.size, f.cipher_size, f.nonce_prefix,
		        f.wrapped_key, f.key_iv, f.eph_pub, f.plain_sha256, f.created_at,
		        t.expires_at, t.sender_session, i.confirm_first,
		        (SELECT count(*) FROM trusted_senders ts
		         WHERE ts.inbox_id = t.inbox_id AND ts.sender_session = t.sender_session) AS trusted
		 FROM files f
		 JOIN transfers t ON t.transfer_id = f.transfer_id
		 JOIN inboxes i ON i.inbox_id = t.inbox_id
		 WHERE i.owner_device_id = ? AND f.state = 'ready'
		 ORDER BY f.created_at ASC`,
	)
		.bind(deviceId)
		.all<PendingRow>();

	return c.json({
		chunk_size: CHUNK_SIZE,
		files: results.map((row) => ({
			file_id: row.file_id,
			transfer_id: row.transfer_id,
			inbox_id: row.inbox_id,
			inbox_name: row.inbox_name,
			sender_session: row.sender_session,
			// PRD 13.2 — confirm the first file of each new sending session, then
			// stop asking. Silently writing a stranger's files to disk is the single
			// most alarming thing this product could do.
			needs_confirmation: !!row.confirm_first && !row.trusted,
			enc_name: row.enc_name,
			name_iv: row.name_iv,
			size: row.size,
			cipher_size: row.cipher_size,
			nonce_prefix: row.nonce_prefix,
			wrapped_key: row.wrapped_key,
			key_iv: row.key_iv,
			eph_pub: row.eph_pub,
			plain_sha256: row.plain_sha256,
			created_at: row.created_at,
			expires_at: row.expires_at,
		})),
	});
});

/** Ciphertext stream. Range is supported so an interrupted pull resumes. */
delivery.get("/files/:fid/content", async (c) => {
	const deviceId = await requireDevice(c.env, c.req.raw);
	const file = await ownedFile(c.env, deviceId, c.req.param("fid"));
	if (file.state !== "ready") return badRequest("This file is not ready.");

	const rangeHeader = c.req.header("range");
	let range: { offset: number; length: number } | undefined;
	let status = 200;
	if (rangeHeader) {
		const match = /^bytes=(\d+)-(\d*)$/.exec(rangeHeader.trim());
		if (!match) return badRequest("Unsupported Range header.");
		const offset = Number(match[1]);
		const end = match[2] ? Number(match[2]) : file.cipher_size - 1;
		if (offset >= file.cipher_size || end < offset) {
			return c.body(null, 416, { "content-range": `bytes */${file.cipher_size}` });
		}
		range = { offset, length: end - offset + 1 };
		status = 206;
	}

	const object = await c.env.RELAY.get(file.r2_key, range ? { range } : undefined);
	if (!object) return notFound("The stored object is gone. Ask the sender to resend.");

	const headers = new Headers({
		"content-type": "application/octet-stream",
		"cache-control": "no-store",
		"x-stolnk-cipher-size": String(file.cipher_size),
	});
	if (range) {
		const end = range.offset + range.length - 1;
		headers.set("content-range", `bytes ${range.offset}-${end}/${file.cipher_size}`);
		headers.set("content-length", String(range.length));
	} else {
		headers.set("content-length", String(file.cipher_size));
	}
	return new Response(object.body, { status, headers });
});

/** PRD 13.2 — accept this session, optionally for good. */
delivery.post("/files/:fid/accept", async (c) => {
	const deviceId = await requireDevice(c.env, c.req.raw);
	const file = await ownedFile(c.env, deviceId, c.req.param("fid"));
	const body = await readJson<{ always?: unknown }>(c).catch(() => ({ always: false }));

	if (body.always === true) {
		await c.env.DB.prepare(
			"INSERT OR IGNORE INTO trusted_senders (inbox_id, sender_session, created_at) VALUES (?, ?, ?)",
		)
			.bind(file.inbox_id, file.sender_session, Date.now())
			.run();
	}

	// Mirrors decline: without this the send page cannot distinguish "still
	// waiting on a person" from "accepted, now downloading".
	pushInBackground(c.executionCtx, () =>
		hubFor(c.env, deviceId).notifySender(file.transfer_id, {
			type: "file.accepted",
			file_id: file.file_id,
		}),
	);
	return c.json({ accepted: true });
});

delivery.post("/files/:fid/decline", async (c) => {
	const deviceId = await requireDevice(c.env, c.req.raw);
	const file = await ownedFile(c.env, deviceId, c.req.param("fid"));

	try {
		await c.env.RELAY.delete(file.r2_key);
	} catch {
		// Sweep will catch it.
	}
	await c.env.DB.prepare("UPDATE files SET state = 'declined' WHERE file_id = ?")
		.bind(file.file_id)
		.run();

	pushInBackground(c.executionCtx, () =>
		hubFor(c.env, deviceId).notifySender(file.transfer_id, {
			type: "file.declined",
			file_id: file.file_id,
		}),
	);
	return c.json({ declined: true });
});

/**
 * Landed on disk. PRD 8.5 and the acceptance list in 18 both require the object
 * to disappear right away, so this deletes synchronously rather than queueing.
 */
delivery.post("/files/:fid/ack", async (c) => {
	const deviceId = await requireDevice(c.env, c.req.raw);
	const file = await ownedFile(c.env, deviceId, c.req.param("fid"));

	await c.env.RELAY.delete(file.r2_key);
	fileDelivered({
		inbox_id: file.inbox_id,
		bytes: file.cipher_size,
		residency_ms: Date.now() - file.created_at,
		was_offline: Date.now() - file.created_at > 60_000,
	});
	await c.env.DB.prepare(
		"UPDATE files SET state = 'delivered', delivered_at = ? WHERE file_id = ?",
	)
		.bind(Date.now(), file.file_id)
		.run();

	// Mark the whole transfer delivered once nothing is outstanding.
	const remaining = await c.env.DB.prepare(
		"SELECT count(*) AS n FROM files WHERE transfer_id = ? AND state IN ('uploading', 'ready')",
	)
		.bind(file.transfer_id)
		.first<{ n: number }>();
	if ((remaining?.n ?? 0) === 0) {
		await c.env.DB.prepare("UPDATE transfers SET state = 'delivered' WHERE transfer_id = ?")
			.bind(file.transfer_id)
			.run();
	}

	pushInBackground(c.executionCtx, () =>
		hubFor(c.env, deviceId).notifySender(file.transfer_id, {
			type: "file.delivered",
			file_id: file.file_id,
			transfer_complete: (remaining?.n ?? 0) === 0,
		}),
	);

	return c.json({ delivered: true });
});
