import { Hono } from "hono";
import { CHUNK_SIZE } from "../limits";
import { hubFor, pushInBackground, requireDevice } from "../lib/deviceauth";
import { badRequest, notFound, readJson, requireString, type AppEnv } from "../lib/http";
import { fileCompleted, fileDelivered } from "../lib/metrics";

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
}

async function ownedFile(env: Env, deviceId: string, fileId: string) {
	const row = await env.DB.prepare(
		`SELECT f.*, t.inbox_id, t.transport, i.owner_device_id
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
			transport: string;
			cipher_size: number;
			created_at: number;
			plain_sha256: string;
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
		        t.expires_at
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

/**
 * PRD 8.2 — the metadata for one file that is about to arrive over a LAN
 * DataChannel, rather than out of R2.
 *
 * The Mac needs this before it can decrypt a single byte, and on the LAN path
 * the file never reaches `state = 'ready'`, so it never appears in `/pending`.
 * The sender could send all of it down the DataChannel instead — it knows every
 * field — but `inbox_id` decides which folder the file lands in, and that is
 * not a question the other end of a peer connection gets to answer. So the Mac
 * asks the server, authenticated as itself, and the DataChannel carries only a
 * file id.
 *
 * Restricted to LAN transfers still uploading: this must not become a way to
 * read a relay file's envelope before its ciphertext is complete.
 */
delivery.get("/files/:fid/meta", async (c) => {
	const deviceId = await requireDevice(c.env, c.req.raw);
	const row = await c.env.DB.prepare(
		`SELECT f.file_id, f.transfer_id, t.inbox_id, i.display_name AS inbox_name,
		        f.enc_name, f.name_iv, f.size, f.cipher_size, f.nonce_prefix,
		        f.wrapped_key, f.key_iv, f.eph_pub, f.plain_sha256, f.created_at,
		        t.expires_at
		 FROM files f
		 JOIN transfers t ON t.transfer_id = f.transfer_id
		 JOIN inboxes i ON i.inbox_id = t.inbox_id
		 WHERE f.file_id = ? AND i.owner_device_id = ?
		   AND t.transport = 'lan' AND f.state = 'uploading'`,
	)
		.bind(c.req.param("fid"), deviceId)
		.first<PendingRow>();
	if (!row) return notFound("No such file.");

	// Field for field what `/pending` returns, so the receiving code cannot tell
	// the two paths apart — which is the whole design: LAN is a second pipe onto
	// the same stream, not a second format.
	return c.json({
		chunk_size: CHUNK_SIZE,
		file: {
			file_id: row.file_id,
			transfer_id: row.transfer_id,
			inbox_id: row.inbox_id,
			inbox_name: row.inbox_name,
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
		},
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

/**
 * Landed on disk. PRD 8.5 and the acceptance list in 18 both require the object
 * to disappear right away, so this deletes synchronously rather than queueing.
 */
delivery.post("/files/:fid/ack", async (c) => {
	const deviceId = await requireDevice(c.env, c.req.raw);
	const file = await ownedFile(c.env, deviceId, c.req.param("fid"));

	/*
	 * PRD 8.2 — a LAN file is finished here and nowhere else.
	 *
	 * Its sender never calls `complete`, because there are no parts to complete,
	 * so the digest that binds the plaintext arrives with this ACK instead: the
	 * Mac has just verified it against the bytes it actually landed, which makes
	 * it the only party in a position to report it. The row is written from what
	 * the Mac saw, not from what the sender promised.
	 */
	let plainSha256: string | null = null;
	if (file.transport === "lan" && !file.plain_sha256) {
		const body = await readJson<{ plain_sha256?: unknown }>(c);
		plainSha256 = requireString(body.plain_sha256, "plain_sha256", 64);
		if (!/^[0-9a-f]{64}$/.test(plainSha256)) {
			return badRequest("plain_sha256 must be 64 hex characters.");
		}
	}

	// A no-op on the LAN path — nothing was ever stored under this key — and the
	// call is left unconditional because "delete on ACK" is the invariant PRD 8.5
	// states, and an `if` here would be one more place for the two paths to drift.
	await c.env.RELAY.delete(file.r2_key);
	if (file.transport === "lan") {
		// The relay path books this in `finishFile`, which a LAN transfer never
		// reaches. `parts: 0` is the honest number: no Class A operations were
		// spent, which is exactly what this metric exists to show.
		fileCompleted({
			inbox_id: file.inbox_id,
			bytes: file.cipher_size,
			parts: 0,
			transport: "lan",
		});
	}
	fileDelivered({
		inbox_id: file.inbox_id,
		bytes: file.cipher_size,
		residency_ms: Date.now() - file.created_at,
		was_offline: Date.now() - file.created_at > 60_000,
	});
	await c.env.DB.prepare(
		plainSha256
			? "UPDATE files SET state = 'delivered', delivered_at = ?, plain_sha256 = ? WHERE file_id = ?"
			: "UPDATE files SET state = 'delivered', delivered_at = ? WHERE file_id = ?",
	)
		.bind(...(plainSha256 ? [Date.now(), plainSha256, file.file_id] : [Date.now(), file.file_id]))
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
