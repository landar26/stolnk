import {
	MAX_FILES_PER_TRANSFER,
	PART_SIZE,
	UPLOAD_TOKEN_TTL_MS,
	cipherSizeFor,
	partCountFor,
} from "../limits";
import { randomId } from "./bytes";
import { hubFor, pushInBackground } from "./deviceauth";
import { bookRelayBytes, refundRelayBytes, relayUsed, tierFor } from "./entitlement";
import { badRequest, quotaExceeded, utcDay, utcMonth } from "./http";
import { type InboxRow } from "./inbox";
import { fileCompleted, quotaRefused, transferStarted } from "./metrics";
import { signToken } from "./tokens";

/**
 * The relay path's shared middle (PRD 8.3): accepting a transfer, and finishing
 * a file once its ciphertext is all in R2.
 *
 * This lives apart from `routes/transfers.ts` because there are now two clients
 * with two entirely different front halves and one identical back half. The
 * browser (`react-app/lib/uploader.ts`) encrypts locally and pushes parts
 * through `PUT /api/v1/transfers/…`; curl (`routes/inbox-address.ts`) posts
 * plaintext to the inbox address and the Worker does the encrypting. What they
 * must not have two copies of is *this*: the tier ceilings, the monthly relay
 * booking, the daily caps, and the notify-on-ready push. Two copies of a quota
 * is a way to be billed for the one that was forgotten.
 */

export interface PlannedFile {
	/**
	 * Chosen by the caller, not here. The curl path needs it before it can
	 * encrypt a single byte — the id is inside every chunk's AAD
	 * (docs/wire-format.md) — so it cannot be something this function returns.
	 */
	file_id: string;
	enc_name: string;
	name_iv: string;
	size: number;
	cipher_size: number;
	nonce_prefix: string;
	wrapped_key: string;
	key_iv: string;
	eph_pub: string;
}

export interface OpenedFile {
	file_id: string;
	r2_key: string;
	upload_id: string;
	part_size: number;
	part_count: number;
}

export interface OpenedTransfer {
	transferId: string;
	token: string;
	expiresAt: number;
	/** The instant everything was booked against, so a correction can find it. */
	createdAt: number;
	files: OpenedFile[];
}

export function r2Key(transferId: string, fileId: string): string {
	return `relay/${transferId}/${fileId}`;
}

/**
 * Everything between "a sender wants to send these files" and "R2 is ready to
 * take their bytes": every quota in the product, the transfer and file rows,
 * the multipart uploads, the upload token, and the counters.
 *
 * Throws the caller's response on any refusal, so both routes answer a spent
 * allowance in exactly the same words.
 */
export async function openTransfer(
	env: Env,
	options: {
		inbox: InboxRow;
		planned: PlannedFile[];
		/** PRD 15.1 — a hint from the client, deliberately not a tracking mechanism. */
		senderIsOwner: boolean;
		via: "browser" | "curl";
	},
): Promise<OpenedTransfer> {
	const { inbox, planned } = options;
	const inboxId = inbox.inbox_id;
	if (planned.length === 0) return badRequest("No files.");
	if (planned.length > MAX_FILES_PER_TRANSFER) {
		return badRequest("Too many files in one transfer.");
	}

	const tier = await tierFor(env, inbox.owner_device_id);
	const now = Date.now();

	// `inboxes.size_limit` was written when the inbox was created, so it can be a
	// tier behind. The lower of the two wins, which is what makes a refund take
	// effect immediately: the row may still say 20 GB, but the tier says 2.
	const fileCap = Math.min(inbox.size_limit, tier.maxFileSize);

	const totalBytes = planned.reduce((sum, file) => sum + file.size, 0);

	// V1 has one path (PRD 8.2 / M4 was cut), so this is a constant rather than
	// something the client asserts — a sender must not be able to send its
	// transfer for free by claiming "lan".
	const transport: "relay" | "lan" = "relay";
	for (const file of planned) {
		if (file.size > fileCap) {
			return quotaExceeded(
				`Files over ${Math.floor(fileCap / 1024 ** 3)} GB are not accepted by this inbox.`,
			);
		}
	}

	// PRD 16.1 — the monthly relay allowance. This is the paid boundary, and the
	// only quota in the product that a purchase moves.
	//
	// It is keyed by device, not by inbox: the daily ceiling below is abuse
	// control on one link, this is what someone bought. Booked now and returned
	// if the transfer never lands, so ciphertext that is aborted or expires
	// unread does not quietly eat the owner's month.
	//
	// Only the relay path counts. Everything is the relay path today, but writing
	// the condition now means M4 (LAN direct, PRD 8.2) does not have to revisit
	// billing — and PRD 16.2 turns on LAN being free forever.
	const month = utcMonth(now);
	const relayed = transport === "relay" ? totalBytes : 0;
	if (relayed > 0) {
		const used = await relayUsed(env, inbox.owner_device_id, month);
		if (used + relayed > tier.monthlyRelayBytes) {
			quotaRefused({ inbox_id: inboxId, reason: "monthly_relay", bytes: totalBytes });
			// Addressed to the sender, who is a stranger and not at fault. It says
			// what to do without naming the owner's tier, their usage, or their
			// bill — PRD 16.2 promises the inbox never looks broken, and 13.1 says
			// an unauthenticated caller learns nothing it did not already know.
			return quotaExceeded(
				"This inbox cannot take more files this month. Try again later, or ask the person you are sending to.",
			);
		}
	}

	// PRD 8.5 — total parked bytes per device. This is a hard ceiling, not a
	// billing trigger: over quota we refuse the upload rather than charge for it.
	//
	// Deliberately *after* the monthly allowance. On Free the two ceilings are
	// both 3 GB, so a single over-budget transfer trips both — and this one's
	// message ("files still waiting to be delivered") is a plain lie when the
	// queue is empty, which is exactly the case where a first-time sender meets
	// it. The monthly wall is also the only one of the two that the owner can do
	// something about.
	const pending = await env.DB.prepare(
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
	const usage = await env.DB.prepare(
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
	// Vestigial: `transfers.sender_session` is NOT NULL and used to key the
	// remembered "always accept from this link" decisions. Those are gone, and
	// dropping the column would mean rebuilding the largest table in the schema,
	// so it is filled with a value nobody reads.
	const senderSession = randomId();
	const senderIsOwner = options.senderIsOwner ? 1 : 0;
	const expiresAt = now + tier.ttlHours * 60 * 60 * 1000;

	// Signed before the first write, for the same reason registration is: it reads
	// SESSION_SECRET and throws when that is unset, and a throw after the inserts
	// would leave a transfer and its file rows behind that no caller ever got a
	// token for. Every input to it is already known here.
	const token = await signToken(env.SESSION_SECRET, {
		t: "upload",
		transfer: transferId,
		inbox: inboxId,
		exp: now + UPLOAD_TOKEN_TTL_MS,
	});

	await env.DB.prepare(
		`INSERT INTO transfers (transfer_id, inbox_id, sender_session, state, total_bytes,
		                        sender_is_owner, created_at, expires_at)
		 VALUES (?, ?, ?, 'uploading', ?, ?, ?, ?)`,
	)
		.bind(transferId, inboxId, senderSession, totalBytes, senderIsOwner, now, expiresAt)
		.run();

	const created: OpenedFile[] = [];
	for (const file of planned) {
		const key = r2Key(transferId, file.file_id);
		const multipart = await env.RELAY.createMultipartUpload(key);
		await env.DB.prepare(
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
			r2_key: key,
			upload_id: multipart.uploadId,
			part_size: PART_SIZE,
			part_count: partCountFor(file.cipher_size),
		});
	}

	// Both counters in one batch: a transfer that is accepted but not booked
	// would be free bytes, and one booked but not accepted would be stolen ones.
	const counters = [
		env.DB.prepare(
			`INSERT INTO usage_daily (inbox_id, day, files, bytes) VALUES (?, ?, ?, ?)
			 ON CONFLICT (inbox_id, day) DO UPDATE SET files = files + ?, bytes = bytes + ?`,
		).bind(inboxId, day, planned.length, totalBytes, planned.length, totalBytes),
	];
	if (relayed > 0) {
		counters.push(bookRelayBytes(env, inbox.owner_device_id, relayed, month));
	}
	await env.DB.batch(counters);

	transferStarted({
		inbox_id: inboxId,
		files: planned.length,
		bytes: totalBytes,
		sender_is_owner: senderIsOwner === 1,
		sub_inbox: inbox.path_slug !== null,
		via: options.via,
	});

	return { transferId, token, expiresAt, createdAt: now, files: created };
}

/**
 * Writes the real size of a file whose transfer was booked from an upper bound,
 * and gives back the difference.
 *
 * Only the curl path needs this. `Content-Length` leaves a body's payload
 * length ambiguous by exactly two bytes — the CRLF after the closing boundary
 * is optional (RFC 2046) and clients disagree about it — so that path books the
 * larger candidate and settles here once the bytes have actually arrived.
 *
 * `files.size` is the part that is not optional: the receiver derives every
 * chunk boundary from it (docs/wire-format.md), so a row two bytes out is a
 * file that will not decrypt. The three counters alongside it are corrected in
 * the same batch because a ledger that is quietly wrong is worse to debug than
 * one that is right for a reason nobody remembers.
 */
export async function settleSize(
	env: Env,
	options: {
		transferId: string;
		fileId: string;
		inboxId: string;
		ownerDeviceId: string;
		bookedSize: number;
		actualSize: number;
		createdAt: number;
	},
): Promise<void> {
	const over = options.bookedSize - options.actualSize;
	if (over === 0) return;

	await env.DB.batch([
		env.DB.prepare("UPDATE files SET size = ?, cipher_size = ? WHERE file_id = ?").bind(
			options.actualSize,
			cipherSizeFor(options.actualSize),
			options.fileId,
		),
		env.DB.prepare(
			"UPDATE transfers SET total_bytes = max(0, total_bytes - ?) WHERE transfer_id = ?",
		).bind(over, options.transferId),
		env.DB.prepare(
			"UPDATE usage_daily SET bytes = max(0, bytes - ?) WHERE inbox_id = ? AND day = ?",
		).bind(over, options.inboxId, utcDay(options.createdAt)),
		refundRelayBytes(env, options.ownerDeviceId, over, utcMonth(options.createdAt)),
	]);
}

/**
 * Closes the R2 multipart upload, marks the file ready, and tells the Mac.
 *
 * The parts come from the caller rather than from `file_parts`, because only
 * one of the two callers has that table to read: the browser path writes a row
 * per part so that an interrupted upload can resume, and the curl path has no
 * resume to support — one request either finishes or leaves nothing behind.
 */
export async function finishFile(
	env: Env,
	// Structural, matching `pushInBackground` — Hono's `c.executionCtx` and the
	// ambient `ExecutionContext` are not the same nominal type.
	ctx: { waitUntil(promise: Promise<unknown>): void },
	options: {
		transferId: string;
		fileId: string;
		r2Key: string;
		uploadId: string;
		parts: Array<{ partNumber: number; etag: string }>;
		plainSha256: string;
		cipherSize: number;
	},
): Promise<void> {
	const upload = env.RELAY.resumeMultipartUpload(options.r2Key, options.uploadId);
	await upload.complete(options.parts);

	await env.DB.prepare(
		"UPDATE files SET state = 'ready', plain_sha256 = ?, upload_id = NULL WHERE file_id = ?",
	)
		.bind(options.plainSha256, options.fileId)
		.run();

	const owner = await env.DB.prepare(
		`SELECT i.owner_device_id AS device_id, t.inbox_id
		 FROM transfers t JOIN inboxes i ON i.inbox_id = t.inbox_id
		 WHERE t.transfer_id = ?`,
	)
		.bind(options.transferId)
		.first<{ device_id: string; inbox_id: string }>();
	if (!owner) return;

	fileCompleted({
		inbox_id: owner.inbox_id,
		bytes: options.cipherSize,
		parts: options.parts.length,
		transport: "relay",
	});

	// Outlives this response deliberately: an asleep Mac simply finds it via
	// /pending on waking, but a Mac that is awake must not have to wait out a
	// polling interval for something it could have been told about.
	pushInBackground(ctx, () =>
		hubFor(env, owner.device_id).notifyDevice({
			type: "file.ready",
			file_id: options.fileId,
			transfer_id: options.transferId,
			inbox_id: owner.inbox_id,
		}),
	);
}

/**
 * PRD 8.5 — withdraw everything in this transfer that has not been delivered,
 * and give back the relay bytes it booked.
 *
 * Both the sender's own abort and a curl upload that failed part-way land here,
 * because they are the same event: bytes were charged against the owner's month
 * for a delivery that is not going to happen.
 */
export async function abandonTransfer(env: Env, transferId: string): Promise<void> {
	const { results } = await env.DB.prepare(
		"SELECT file_id, r2_key, upload_id, state, size FROM files WHERE transfer_id = ?",
	)
		.bind(transferId)
		.all<{
			file_id: string;
			r2_key: string;
			upload_id: string | null;
			state: string;
			size: number;
		}>();

	for (const file of results) {
		if (file.state === "delivered") continue;
		try {
			if (file.upload_id) {
				await env.RELAY.resumeMultipartUpload(file.r2_key, file.upload_id).abort();
			} else {
				await env.RELAY.delete(file.r2_key);
			}
		} catch {
			// Already gone; the cron sweep is the backstop.
		}
	}

	// PRD 16.1 — give back what was booked but never delivered. Per file, not
	// `transfers.total_bytes`: a transfer can be part delivered, and the owner
	// keeps paying only for the parts that actually reached them.
	//
	// Refunded against the month the transfer was *created* in, so a transfer
	// booked on the 31st and withdrawn on the 1st credits the month that charged
	// it rather than handing the new month a discount.
	const owner = await env.DB.prepare(
		`SELECT i.owner_device_id AS device_id, t.created_at
		 FROM transfers t JOIN inboxes i ON i.inbox_id = t.inbox_id
		 WHERE t.transfer_id = ?`,
	)
		.bind(transferId)
		.first<{ device_id: string; created_at: number }>();

	const undelivered = results
		.filter((file) => file.state !== "delivered" && file.state !== "aborted")
		.reduce((sum, file) => sum + file.size, 0);

	const writes = [
		env.DB.prepare(
			"UPDATE files SET state = 'aborted', upload_id = NULL WHERE transfer_id = ? AND state != 'delivered'",
		).bind(transferId),
		env.DB.prepare("UPDATE transfers SET state = 'aborted' WHERE transfer_id = ?").bind(
			transferId,
		),
	];
	if (owner && undelivered > 0) {
		writes.push(refundRelayBytes(env, owner.device_id, undelivered, utcMonth(owner.created_at)));
	}
	await env.DB.batch(writes);
}
