import { Hono } from "hono";
import {
	MAX_FILENAME_CIPHERTEXT,
	MAX_FILES_PER_TRANSFER,
	PART_SIZE,
	RATE_MAX_PARTS,
	RATE_MAX_TRANSFERS,
	PRO,
	cipherSizeFor,
	partCountFor,
} from "../limits";
import { randomId } from "../lib/bytes";
import {
	abandonTransfer,
	finishFile,
	openTransfer,
	type PlannedFile,
} from "../lib/relay";
import {
	badRequest,
	clientIp,
	fail,
	notFound,
	readJson,
	requireInt,
	requireString,
	unauthorized,
	type AppEnv,
} from "../lib/http";
import { type InboxRow } from "../lib/inbox";
import { verifierMatches } from "../lib/password";
import { enforce } from "../lib/ratelimit";
import { verifyToken, type UploadToken } from "../lib/tokens";

/**
 * The relay path (PRD 8.3): the browser encrypts, R2 parks the ciphertext, the
 * Mac collects it whenever it next wakes up.
 *
 * The two properties that fall out of parking bytes rather than streaming them
 * peer-to-peer are the ones Rev. A could not offer: the sender can upload while
 * the Mac is asleep, and resume is free because R2 multipart already tracks
 * which parts landed.
 *
 * This file is the browser's half of it. Everything a sender and the curl path
 * (routes/inbox-address.ts) have in common — the quotas, the booking, the
 * notify — is in lib/relay.ts.
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
	via?: unknown;
	files?: unknown;
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

	// Validate every file before creating any R2 upload, so a rejected batch
	// leaves no orphaned multipart uploads behind.
	//
	// The bound here is the largest any tier allows, deliberately, and not the
	// inbox's own ceiling. This call reports a malformed request (400 "out of
	// range"), and a 3 GB file from someone on Free is not malformed — it is over
	// quota, which PRD 8.6 #3 says is a state to explain rather than an error to
	// report. `openTransfer` applies the tier ceiling, where it can say so in
	// those words.
	const planned: PlannedFile[] = (files as FileInit[]).map((file, index) => {
		const size = requireInt(file.size, `files[${index}].size`, 0, PRO.maxFileSize);
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

	const opened = await openTransfer(c.env, {
		inbox,
		planned,
		// PRD 15.1 — a coarse "did the owner send this to themselves?" signal.
		senderIsOwner: body.via === "app",
		via: "browser",
	});

	return c.json(
		{
			transfer_id: opened.transferId,
			token: opened.token,
			expires_at: opened.expiresAt,
			part_size: PART_SIZE,
			files: opened.files.map((file) => ({
				file_id: file.file_id,
				part_size: file.part_size,
				part_count: file.part_count,
			})),
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

	await finishFile(c.env, c.executionCtx, {
		transferId,
		fileId,
		r2Key: file.r2_key,
		uploadId: file.upload_id,
		parts: results.map((row) => ({ partNumber: row.part_number, etag: row.etag })),
		plainSha256: sha256,
		cipherSize: file.cipher_size,
	});

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
	await abandonTransfer(c.env, transferId);
	return c.json({ aborted: true });
});
