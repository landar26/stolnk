import { Hono } from "hono";
import {
	MAX_FILENAME_CIPHERTEXT,
	MAX_FILES_PER_TRANSFER,
	PART_SIZE,
	RATE_MAX_PARTS,
	RATE_MAX_TRANSFERS,
	UPLOAD_TOKEN_TTL_MS,
	cipherSizeFor,
	partCountFor,
	tierForDevice,
} from "../limits";
import { randomId } from "../lib/bytes";
import { hubFor, pushInBackground } from "../lib/deviceauth";
import {
	badRequest,
	clientIp,
	fail,
	notFound,
	quotaExceeded,
	readJson,
	requireInt,
	requireString,
	unauthorized,
	utcDay,
	type AppEnv,
} from "../lib/http";
import { type InboxRow } from "../lib/inbox";
import { fileCompleted, quotaRefused, transferStarted } from "../lib/metrics";
import { verifierMatches } from "../lib/password";
import { enforce } from "../lib/ratelimit";
import { signToken, verifyToken, type UploadToken } from "../lib/tokens";

/**
 * The relay path (PRD 8.3): the browser encrypts, R2 parks the ciphertext, the
 * Mac collects it whenever it next wakes up.
 *
 * The two properties that fall out of parking bytes rather than streaming them
 * peer-to-peer are the ones Rev. A could not offer: the sender can upload while
 * the Mac is asleep, and resume is free because R2 multipart already tracks
 * which parts landed.
 */
export const transfers = new Hono<AppEnv>();

interface FileInit {
	enc_name?: unknown;
	name_iv?: unknown;
	size?: unknown;
	nonce_prefix?: unknown;
	wrapped_key?: unknown;
	key_iv?: unknown;
	eph_pub?: unknown;
}

interface InitBody {
	inbox_id?: unknown;
	password?: unknown;
	sender_session?: unknown;
	via?: unknown;
	files?: unknown;
}

function r2Key(transferId: string, fileId: string): string {
	return `relay/${transferId}/${fileId}`;
}

async function authoriseUpload(c: { env: Env; req: { raw: Request } }, transferId: string) {
	const header = c.req.raw.headers.get("authorization");
	const token = header?.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : null;
	const payload = await verifyToken<UploadToken>(c.env.SESSION_SECRET, token, "upload");
	if (!payload || payload.transfer !== transferId) {
		return unauthorized("This upload session is not valid.");
	}
	return payload;
}

transfers.post("/", async (c) => {
	enforce(`transfer:${clientIp(c)}`, RATE_MAX_TRANSFERS);

	const body = await readJson<InitBody>(c);
	const inboxId = requireString(body.inbox_id, "inbox_id", 64);
	const files = body.files;
	if (!Array.isArray(files) || files.length === 0) return badRequest("No files.");
	if (files.length > MAX_FILES_PER_TRANSFER) return badRequest("Too many files in one transfer.");

	const inbox = await c.env.DB.prepare("SELECT * FROM inboxes WHERE inbox_id = ?")
		.bind(inboxId)
		.first<InboxRow>();
	if (!inbox) return notFound("That inbox does not exist.");
	if (inbox.paused) {
		return fail(423, "paused", "This inbox is not accepting files right now.");
	}

	if (inbox.password_verifier_hash) {
		const verifier = requireString(body.password, "password", 256);
		if (!(await verifierMatches(verifier, inbox.password_verifier_hash))) {
			return unauthorized("Wrong password.");
		}
	}

	const tier = tierForDevice(inbox.owner_device_id);
	const now = Date.now();

	// Validate every file before creating any R2 upload, so a rejected batch
	// leaves no orphaned multipart uploads behind.
	const planned = (files as FileInit[]).map((file, index) => {
		const size = requireInt(file.size, `files[${index}].size`, 0, tier.maxFileSize);
		return {
			file_id: randomId(),
			enc_name: requireString(file.enc_name, `files[${index}].enc_name`, MAX_FILENAME_CIPHERTEXT),
			name_iv: requireString(file.name_iv, `files[${index}].name_iv`, 64),
			size,
			cipher_size: cipherSizeFor(size),
			nonce_prefix: requireString(file.nonce_prefix, `files[${index}].nonce_prefix`, 32),
			wrapped_key: requireString(file.wrapped_key, `files[${index}].wrapped_key`, 256),
			key_iv: requireString(file.key_iv, `files[${index}].key_iv`, 64),
			eph_pub: requireString(file.eph_pub, `files[${index}].eph_pub`, 256),
		};
	});

	const totalBytes = planned.reduce((sum, file) => sum + file.size, 0);
	for (const file of planned) {
		if (file.size > inbox.size_limit) {
			return quotaExceeded(
				`Files over ${Math.floor(inbox.size_limit / 1024 ** 3)} GB are not accepted by this inbox.`,
			);
		}
	}

	// PRD 8.5 — total parked bytes per device. This is a hard ceiling, not a
	// billing trigger: over quota we refuse the upload rather than charge for it.
	const pending = await c.env.DB.prepare(
		`SELECT ifnull(sum(f.size), 0) AS bytes
		 FROM files f
		 JOIN transfers t ON t.transfer_id = f.transfer_id
		 JOIN inboxes i ON i.inbox_id = t.inbox_id
		 WHERE i.owner_device_id = ? AND f.state IN ('uploading', 'ready')`,
	)
		.bind(inbox.owner_device_id)
		.first<{ bytes: number }>();
	if ((pending?.bytes ?? 0) + totalBytes > tier.pendingQuota) {
		quotaRefused({ inbox_id: inboxId, reason: "pending_quota", bytes: totalBytes });
		return quotaExceeded(
			"This inbox has too many files still waiting to be delivered. Try again once the Mac has collected them.",
		);
	}

	// PRD 13.3 — per-inbox daily ceilings.
	const day = utcDay(now);
	const usage = await c.env.DB.prepare(
		"SELECT files, bytes FROM usage_daily WHERE inbox_id = ? AND day = ?",
	)
		.bind(inboxId, day)
		.first<{ files: number; bytes: number }>();
	if (
		(usage?.files ?? 0) + planned.length > tier.dailyFiles ||
		(usage?.bytes ?? 0) + totalBytes > tier.dailyBytes
	) {
		quotaRefused({ inbox_id: inboxId, reason: "daily_cap", bytes: totalBytes });
		return quotaExceeded("This inbox has hit its limit for today. Try again tomorrow.");
	}

	const transferId = randomId();
	const senderSession =
		typeof body.sender_session === "string" && body.sender_session.length <= 64
			? body.sender_session
			: randomId();
	// PRD 15.1 — a coarse "did the owner send this to themselves?" signal. It is
	// a hint from the client, deliberately not a tracking mechanism.
	const senderIsOwner = body.via === "app" ? 1 : 0;
	const expiresAt = now + tier.ttlHours * 60 * 60 * 1000;

	// Signed before the first write, for the same reason registration is: it reads
	// SESSION_SECRET and throws when that is unset, and a throw after the inserts
	// would leave a transfer and its file rows behind that no caller ever got a
	// token for. Every input to it is already known here.
	const token = await signToken(c.env.SESSION_SECRET, {
		t: "upload",
		transfer: transferId,
		inbox: inboxId,
		session: senderSession,
		exp: now + UPLOAD_TOKEN_TTL_MS,
	});

	await c.env.DB.prepare(
		`INSERT INTO transfers (transfer_id, inbox_id, sender_session, state, total_bytes,
		                        sender_is_owner, created_at, expires_at)
		 VALUES (?, ?, ?, 'uploading', ?, ?, ?, ?)`,
	)
		.bind(transferId, inboxId, senderSession, totalBytes, senderIsOwner, now, expiresAt)
		.run();

	const created: Array<{ file_id: string; part_size: number; part_count: number }> = [];
	for (const file of planned) {
		const key = r2Key(transferId, file.file_id);
		const multipart = await c.env.RELAY.createMultipartUpload(key);
		await c.env.DB.prepare(
			`INSERT INTO files (file_id, transfer_id, r2_key, upload_id, enc_name, name_iv, size,
			                    cipher_size, nonce_prefix, wrapped_key, key_iv, eph_pub,
			                    plain_sha256, state, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', 'uploading', ?)`,
		)
			.bind(
				file.file_id,
				transferId,
				key,
				multipart.uploadId,
				file.enc_name,
				file.name_iv,
				file.size,
				file.cipher_size,
				file.nonce_prefix,
				file.wrapped_key,
				file.key_iv,
				file.eph_pub,
				now,
			)
			.run();
		created.push({
			file_id: file.file_id,
			part_size: PART_SIZE,
			part_count: partCountFor(file.cipher_size),
		});
	}

	await c.env.DB.prepare(
		`INSERT INTO usage_daily (inbox_id, day, files, bytes) VALUES (?, ?, ?, ?)
		 ON CONFLICT (inbox_id, day) DO UPDATE SET files = files + ?, bytes = bytes + ?`,
	)
		.bind(inboxId, day, planned.length, totalBytes, planned.length, totalBytes)
		.run();

	transferStarted({
		inbox_id: inboxId,
		files: planned.length,
		bytes: totalBytes,
		sender_is_owner: senderIsOwner === 1,
		sub_inbox: inbox.path_slug !== null,
	});

	return c.json(
		{
			transfer_id: transferId,
			sender_session: senderSession,
			token,
			expires_at: expiresAt,
			part_size: PART_SIZE,
			files: created,
		},
		201,
	);
});

/**
 * Uploading one part. Idempotent by design: a part that already has an etag is
 * acknowledged without touching R2, which is the whole of resume support
 * (PRD 8.3 #2) — the phone that locked mid-upload just re-sends what it is
 * unsure about.
 */
transfers.put("/:tid/files/:fid/parts/:n", async (c) => {
	enforce(`part:${clientIp(c)}`, RATE_MAX_PARTS);

	const transferId = c.req.param("tid");
	await authoriseUpload(c, transferId);
	const fileId = c.req.param("fid");
	const partNumber = Number(c.req.param("n"));
	if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10_000) {
		return badRequest("Bad part number.");
	}

	const file = await c.env.DB.prepare(
		"SELECT * FROM files WHERE file_id = ? AND transfer_id = ?",
	)
		.bind(fileId, transferId)
		.first<{ r2_key: string; upload_id: string; state: string; cipher_size: number }>();
	if (!file) return notFound("No such file in this transfer.");
	if (file.state !== "uploading") return badRequest("This file is no longer accepting parts.");

	const existing = await c.env.DB.prepare(
		"SELECT etag FROM file_parts WHERE file_id = ? AND part_number = ?",
	)
		.bind(fileId, partNumber)
		.first<{ etag: string }>();
	if (existing) return c.json({ part_number: partNumber, etag: existing.etag, skipped: true });

	const totalParts = partCountFor(file.cipher_size);
	if (partNumber > totalParts) return badRequest("Part number past the end of the file.");
	const expected =
		partNumber === totalParts ? file.cipher_size - (totalParts - 1) * PART_SIZE : PART_SIZE;
	const declared = Number(c.req.header("content-length") ?? "-1");
	if (declared !== expected) {
		return badRequest(`Part ${partNumber} must be exactly ${expected} bytes.`);
	}

	const body = c.req.raw.body;
	if (!body) return badRequest("Empty body.");

	const upload = c.env.RELAY.resumeMultipartUpload(file.r2_key, file.upload_id);
	const part = await upload.uploadPart(partNumber, body);

	await c.env.DB.prepare(
		"INSERT OR REPLACE INTO file_parts (file_id, part_number, etag, size) VALUES (?, ?, ?, ?)",
	)
		.bind(fileId, partNumber, part.etag, expected)
		.run();

	return c.json({ part_number: partNumber, etag: part.etag, skipped: false });
});

transfers.post("/:tid/files/:fid/complete", async (c) => {
	const transferId = c.req.param("tid");
	await authoriseUpload(c, transferId);
	const fileId = c.req.param("fid");
	const body = await readJson<{ plain_sha256?: unknown }>(c);
	const sha256 = requireString(body.plain_sha256, "plain_sha256", 64);
	if (!/^[0-9a-f]{64}$/.test(sha256)) return badRequest("plain_sha256 must be 64 hex characters.");

	const file = await c.env.DB.prepare(
		"SELECT * FROM files WHERE file_id = ? AND transfer_id = ?",
	)
		.bind(fileId, transferId)
		.first<{ r2_key: string; upload_id: string; state: string; cipher_size: number }>();
	if (!file) return notFound("No such file in this transfer.");
	if (file.state === "ready") return c.json({ state: "ready", already: true });
	if (file.state !== "uploading") return badRequest("This file cannot be completed.");

	const { results } = await c.env.DB.prepare(
		"SELECT part_number, etag FROM file_parts WHERE file_id = ? ORDER BY part_number ASC",
	)
		.bind(fileId)
		.all<{ part_number: number; etag: string }>();

	const expectedParts = partCountFor(file.cipher_size);
	if (results.length !== expectedParts) {
		return badRequest(`Expected ${expectedParts} parts, have ${results.length}.`);
	}

	const upload = c.env.RELAY.resumeMultipartUpload(file.r2_key, file.upload_id);
	await upload.complete(results.map((row) => ({ partNumber: row.part_number, etag: row.etag })));

	await c.env.DB.prepare(
		"UPDATE files SET state = 'ready', plain_sha256 = ?, upload_id = NULL WHERE file_id = ?",
	)
		.bind(sha256, fileId)
		.run();

	const owner = await c.env.DB.prepare(
		`SELECT i.owner_device_id AS device_id, i.display_name, i.confirm_first, t.sender_session,
		        t.inbox_id
		 FROM transfers t JOIN inboxes i ON i.inbox_id = t.inbox_id
		 WHERE t.transfer_id = ?`,
	)
		.bind(transferId)
		.first<{
			device_id: string;
			display_name: string;
			confirm_first: number;
			sender_session: string;
			inbox_id: string;
		}>();

	if (owner) {
		fileCompleted({
			inbox_id: owner.inbox_id,
			bytes: file.cipher_size,
			parts: results.length,
			transport: "relay",
		});

		const trusted = await c.env.DB.prepare(
			"SELECT 1 AS x FROM trusted_senders WHERE inbox_id = ? AND sender_session = ?",
		)
			.bind(owner.inbox_id, owner.sender_session)
			.first();
		const needsConfirmation = !!owner.confirm_first && !trusted;
		// Outlives this response deliberately: an asleep Mac simply finds it via
		// /pending on waking, but a Mac that is awake must not have to wait out a
		// polling interval for something it could have been told about.
		pushInBackground(c.executionCtx, () =>
			hubFor(c.env, owner.device_id).notifyDevice({
				type: "file.ready",
				file_id: fileId,
				transfer_id: transferId,
				inbox_id: owner.inbox_id,
				needs_confirmation: needsConfirmation,
			}),
		);
		// "Uploaded" and "waiting on a person" are different things to be looking
		// at, and only the sender can tell them apart from the copy.
		if (needsConfirmation) {
			pushInBackground(c.executionCtx, () =>
				hubFor(c.env, owner.device_id).notifySender(transferId, {
					type: "file.awaiting",
					file_id: fileId,
				}),
			);
		}
	}

	return c.json({ state: "ready" });
});

/** Resume support: which parts already landed, and where each file stands. */
transfers.get("/:tid", async (c) => {
	const transferId = c.req.param("tid");
	await authoriseUpload(c, transferId);

	const transfer = await c.env.DB.prepare(
		"SELECT state, expires_at FROM transfers WHERE transfer_id = ?",
	)
		.bind(transferId)
		.first<{ state: string; expires_at: number }>();
	if (!transfer) return notFound("No such transfer.");

	const { results: files } = await c.env.DB.prepare(
		"SELECT file_id, size, cipher_size, state FROM files WHERE transfer_id = ?",
	)
		.bind(transferId)
		.all<{ file_id: string; size: number; cipher_size: number; state: string }>();

	const { results: parts } = await c.env.DB.prepare(
		`SELECT p.file_id, p.part_number FROM file_parts p
		 JOIN files f ON f.file_id = p.file_id
		 WHERE f.transfer_id = ? ORDER BY p.part_number ASC`,
	)
		.bind(transferId)
		.all<{ file_id: string; part_number: number }>();

	const byFile = new Map<string, number[]>();
	for (const row of parts) {
		const list = byFile.get(row.file_id) ?? [];
		list.push(row.part_number);
		byFile.set(row.file_id, list);
	}

	return c.json({
		transfer_id: transferId,
		state: transfer.state,
		expires_at: transfer.expires_at,
		files: files.map((file) => ({
			file_id: file.file_id,
			size: file.size,
			state: file.state,
			part_count: partCountFor(file.cipher_size),
			completed_parts: byFile.get(file.file_id) ?? [],
		})),
	});
});

/** PRD 8.5 — the sender can withdraw anything that has not been delivered yet. */
transfers.post("/:tid/abort", async (c) => {
	const transferId = c.req.param("tid");
	await authoriseUpload(c, transferId);

	const { results } = await c.env.DB.prepare(
		"SELECT file_id, r2_key, upload_id, state FROM files WHERE transfer_id = ?",
	)
		.bind(transferId)
		.all<{ file_id: string; r2_key: string; upload_id: string | null; state: string }>();

	for (const file of results) {
		if (file.state === "delivered") continue;
		try {
			if (file.upload_id) {
				await c.env.RELAY.resumeMultipartUpload(file.r2_key, file.upload_id).abort();
			} else {
				await c.env.RELAY.delete(file.r2_key);
			}
		} catch {
			// Already gone; the cron sweep is the backstop.
		}
	}

	await c.env.DB.batch([
		c.env.DB.prepare(
			"UPDATE files SET state = 'aborted', upload_id = NULL WHERE transfer_id = ? AND state != 'delivered'",
		).bind(transferId),
		c.env.DB.prepare("UPDATE transfers SET state = 'aborted' WHERE transfer_id = ?").bind(
			transferId,
		),
	]);

	return c.json({ aborted: true });
});
