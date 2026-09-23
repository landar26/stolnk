import {
	PART_SIZE,
	SHARE_CODE_LENGTH,
	SHARE_CODE_RE,
	UPLOAD_TOKEN_TTL_MS,
	partCountFor,
} from "../limits";
import { randomId, randomSlug } from "./bytes";
import { bookRelayBytes, refundRelayBytes, relayUsed, tierFor } from "./entitlement";
import { badRequest, fail, quotaExceeded, upgradeRequired, utcMonth } from "./http";
import { upgradeWallHit } from "./metrics";
import { hashVerifier } from "./password";
import { shareUrl } from "./site";
import { signToken } from "./tokens";

export interface ShareRow {
	share_id: string;
	owner_device_id: string;
	code: string;
	r2_key: string;
	upload_id: string | null;
	filename: string;
	size: number;
	sha256: string | null;
	password_salt: string | null;
	password_verifier_hash: string | null;
	max_downloads: number | null;
	downloads: number;
	state: "uploading" | "ready" | "spent" | "revoked" | "expired" | "aborted";
	paused: number;
	created_at: number;
	expires_at: number;
	revoked_at: number | null;
	last_download_at: number | null;
}

export function shareR2Key(shareId: string): string {
	return `share/${shareId}`;
}

/**
 * Why a revoked link does not hand its path back.
 *
 * `idx_shares_code` is UNIQUE over every row whatever its state, and terminal
 * rows are only swept seven days after creation (`SHARE_RECORD_TTL_MS`). That
 * looks like a bug and is the opposite of one: if revoking freed the path, the
 * next share could take it and everyone still holding the old link would be
 * handed a *different file*. A 404 is the honest answer to a dead link; a
 * stranger's invoice is not.
 */
export const CODE_TAKEN =
	"That path is in use by another of your links. A revoked or expired link releases its path seven days after it was created.";

/**
 * The reason this path cannot be used, or null. Never throws — the availability
 * probe reports a bad path as an answer, not as an error (see `nameProblem`).
 */
export function shareCodeProblem(raw: string): "invalid" | null {
	return SHARE_CODE_RE.test(raw.trim().toLowerCase()) ? null : "invalid";
}

/** Normalised, or a 400. Lower-cased like an inbox slug: a URL path is not a name. */
export function validateShareCode(raw: string): string {
	const code = raw.trim().toLowerCase();
	if (shareCodeProblem(code)) {
		return badRequest(
			"A link path is 3–32 characters of a–z, 0–9 and hyphens, and is a single segment.",
		);
	}
	return code;
}

/** The owner already has this path. Checked before any R2 work is started. */
export async function codeTaken(
	env: Env,
	ownerDeviceId: string,
	code: string,
	exceptShareId?: string,
): Promise<boolean> {
	const row = await env.DB.prepare(
		`SELECT share_id FROM shares
		 WHERE owner_device_id = ? AND code = ? AND share_id IS NOT ?`,
	)
		.bind(ownerDeviceId, code, exceptShareId ?? null)
		.first<{ share_id: string }>();
	return row !== null;
}

export async function findPublicShare(env: Env, name: string, code: string): Promise<ShareRow | null> {
	return env.DB.prepare(
		`SELECT s.* FROM shares s JOIN devices d ON d.device_id = s.owner_device_id
		 WHERE d.name = ? AND s.code = ?`,
	)
		.bind(name, code)
		.first<ShareRow>();
}

export function presentShare(name: string, row: ShareRow) {
	const state = row.state === "ready" && row.expires_at <= Date.now() ? "expired" : row.state;
	return {
		share_id: row.share_id,
		code: row.code,
		url: shareUrl(name, row.code),
		filename: row.filename,
		size: row.size,
		sha256: row.sha256 || null,
		max_downloads: row.max_downloads,
		downloads: row.downloads,
		downloads_left:
			row.max_downloads === null ? null : Math.max(0, row.max_downloads - row.downloads),
		state,
		paused: !!row.paused,
		has_password: !!row.password_verifier_hash,
		created_at: row.created_at,
		expires_at: row.expires_at,
		last_download_at: row.last_download_at,
	};
}

/**
 * Every wall a share has to clear to become active, in one place.
 *
 * Shared by `openShare` and `reopenShare` because restoring a link is the same
 * promise as making one: it books the same bytes, occupies the same slot and
 * costs the same storage, so it has to be refused on the same terms. A device
 * that was Pro when it made a 30-day link and is Free now does not get to bring
 * that link back by the side door.
 *
 * The link count is the one wall a restore has to be excused from. It counts
 * records rather than serving links (`Tier.maxShares`), so the row being
 * restored is inside its own sum — and a Free device, whose allowance is one,
 * could never bring anything back. `exceptShareId` takes it out. The storage and
 * relay sums need no such excuse: they still filter on `state IN ('uploading',
 * 'ready')`, and a terminal row has no bytes left in R2 to count.
 */
async function admitShare(
	env: Env,
	options: {
		ownerDeviceId: string;
		size: number;
		ttlHours: number;
		hasPassword: boolean;
		now: number;
		/** The row being restored, which must not be counted against itself. */
		exceptShareId?: string;
	},
): Promise<void> {
	const tier = await tierFor(env, options.ownerDeviceId);
	const { now } = options;
	if (options.size > tier.maxFileSize) {
		quotaExceeded(`Files over ${Math.floor(tier.maxFileSize / 1024 ** 3)} GB cannot be shared.`);
	}
	if (options.ttlHours > tier.maxShareTtlHours) {
		upgradeWallHit({ wall: "share_ttl" });
		upgradeRequired(`Free share links last up to ${tier.maxShareTtlHours} hours.`);
	}
	if (options.hasPassword && !tier.sharePassword) {
		upgradeWallHit({ wall: "share_password" });
		upgradeRequired("Password-protected share links are part of Pro.");
	}

	// Every record the device still has, whatever state it is in — see
	// `Tier.maxShares`. A revoked link is still holding its path, so it is still
	// holding its slot; deleting it is what hands both back.
	const held = await env.DB.prepare(
		"SELECT count(*) AS n FROM shares WHERE owner_device_id = ? AND share_id IS NOT ?",
	)
		.bind(options.ownerDeviceId, options.exceptShareId ?? null)
		.first<{ n: number }>();
	if ((held?.n ?? 0) >= tier.maxShares) {
		upgradeWallHit({ wall: "share_limit" });
		// The second half is not padding. "Revoked, and still refused" is the one
		// thing about this wall that reads like a bug, so the refusal says why.
		upgradeRequired(
			tier.maxShares === 1
				? "Free includes one share link. Delete the one you have to make another — revoking keeps its address, and with it its slot."
				: `Your plan includes ${tier.maxShares} share links. Delete one to make another.`,
		);
	}

	// Kept separate from pending inbox bytes: sharing must not silently consume
	// the capacity needed for incoming files, and the refusal has different words.
	// Unlike the count above this one is over serving links only: a terminal row
	// released its R2 object when it ended and has no bytes left to charge for.
	const stored = await env.DB.prepare(
		"SELECT ifnull(sum(size), 0) AS bytes FROM shares WHERE owner_device_id = ? AND state IN ('uploading', 'ready') AND expires_at > ?",
	)
		.bind(options.ownerDeviceId, now)
		.first<{ bytes: number }>();
	if ((stored?.bytes ?? 0) + options.size > tier.shareStorageQuota) {
		quotaExceeded("Your active share links have reached their storage limit. Revoke one and try again.");
	}

	const month = utcMonth(now);
	if ((await relayUsed(env, options.ownerDeviceId, month)) + options.size > tier.monthlyRelayBytes) {
		quotaExceeded(
			"Your monthly transfer allowance is used up. Existing links keep working until they expire; it resets on the first of next month.",
		);
	}
}

export async function openShare(
	env: Env,
	options: {
		ownerDeviceId: string;
		filename: string;
		size: number;
		ttlHours: number;
		maxDownloads: number | null;
		passwordVerifier: string | null;
		passwordSalt: string | null;
		/** A path the owner chose. Null means mint an unguessable one. */
		code?: string | null;
	},
) {
	const now = Date.now();
	await admitShare(env, {
		ownerDeviceId: options.ownerDeviceId,
		size: options.size,
		ttlHours: options.ttlHours,
		hasPassword: !!options.passwordVerifier,
		now,
	});
	const month = utcMonth(now);

	const shareId = randomId();
	// Checked before the multipart upload below, not after: the common way to
	// lose a race is to type a path someone already has, and that must not leak
	// an R2 upload every time it happens.
	if (options.code && (await codeTaken(env, options.ownerDeviceId, options.code))) {
		fail(409, "code_taken", CODE_TAKEN);
	}
	const code = options.code ?? randomSlug(SHARE_CODE_LENGTH);
	const r2Key = shareR2Key(shareId);
	const expiresAt = now + options.ttlHours * 60 * 60 * 1000;
	// Sign before the first durable write: a missing secret must not strand a row.
	const token = await signToken(env.SESSION_SECRET, {
		t: "share_upload",
		share: shareId,
		exp: now + UPLOAD_TOKEN_TTL_MS,
	});
	const upload = await env.RELAY.createMultipartUpload(r2Key);
	const passwordHash = options.passwordVerifier
		? await hashVerifier(options.passwordVerifier)
		: null;
	try {
		await env.DB.batch([
			env.DB.prepare(
				`INSERT INTO shares (share_id, owner_device_id, code, r2_key, upload_id,
				 filename, size, password_salt, password_verifier_hash, max_downloads,
				 state, created_at, expires_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'uploading', ?, ?)`,
			).bind(
				shareId,
				options.ownerDeviceId,
				code,
				r2Key,
				upload.uploadId,
				options.filename,
				options.size,
				options.passwordSalt,
				passwordHash,
				options.maxDownloads,
				now,
				expiresAt,
			),
			bookRelayBytes(env, options.ownerDeviceId, options.size, month),
		]);
	} catch (error) {
		await upload.abort().catch(() => undefined);
		// The pre-check above loses to a concurrent create. The batch is atomic,
		// so the relay bytes booked alongside the row rolled back with it.
		if (String(error).includes("UNIQUE")) fail(409, "code_taken", CODE_TAKEN);
		throw error;
	}
	return {
		shareId,
		code,
		token,
		partSize: PART_SIZE,
		partCount: partCountFor(options.size),
		expiresAt,
	};
}

export async function finishShare(
	env: Env,
	row: ShareRow,
	parts: Array<{ partNumber: number; etag: string }>,
	sha256: string,
): Promise<void> {
	if (!row.upload_id) throw new Error("Share upload has no multipart handle.");
	await env.RELAY.resumeMultipartUpload(row.r2_key, row.upload_id).complete(parts);
	await env.DB.prepare(
		"UPDATE shares SET state = 'ready', sha256 = ?, upload_id = NULL WHERE share_id = ? AND state = 'uploading'",
	)
		.bind(sha256, row.share_id)
		.run();
}

export async function abandonShare(env: Env, row: ShareRow): Promise<void> {
	if (row.state !== "uploading") return;
	try {
		if (row.upload_id) await env.RELAY.resumeMultipartUpload(row.r2_key, row.upload_id).abort();
	} catch {
		// Already gone.
	}
	await env.DB.batch([
		env.DB.prepare(
			"UPDATE shares SET state = 'aborted', upload_id = NULL WHERE share_id = ? AND state = 'uploading'",
		).bind(row.share_id),
		refundRelayBytes(env, row.owner_device_id, row.size, utcMonth(row.created_at)),
	]);
}

/**
 * Put the file back behind a link that has ended, at the address it already had.
 *
 * Revoking, burning through a download limit and expiring all leave the same
 * thing behind: a record that still knows its path, its filename, its limits and
 * its hash, and an R2 key with nothing at it. The Mac still has the file. So the
 * missing piece is only the bytes, and this hands back an upload slot for them.
 *
 * **The hash is the whole safety argument.** The URL comes back unchanged, so
 * allowing different bytes here would do precisely what the seven-day rule on
 * revoked paths exists to prevent — hand a different file to everyone still
 * holding the old link. `complete` therefore refuses any upload whose sha256 is
 * not the one the record already carries. That check is client-computed, like
 * the original upload's, and it is enough: an owner who wants a different file
 * at that address can delete the record and retake the path, which is a
 * deliberate act with its own confirmation, and this adds no capability they
 * did not already have.
 *
 * Two things are reset rather than resumed, because restoring without them
 * restores nothing: the download count (a spent burn-after-read would be spent
 * again on arrival) and the expiry, which is renewed for the span it originally
 * had. `paused` is cleared for the same reason.
 */
export async function reopenShare(env: Env, row: ShareRow) {
	if (row.state === "ready" || row.state === "uploading") {
		badRequest("This link has not ended, so there is nothing to restore.");
	}
	const now = Date.now();
	// `(created_at, expires_at)` is kept as a pair so this subtraction always
	// means "the span this link has", not "the span it originally had plus every
	// renewal since". Moving only `expires_at` would make each restore longer
	// than the last, until a Free 24-hour link failed its own tier's wall.
	const span = Math.max(0, row.expires_at - row.created_at);
	await admitShare(env, {
		ownerDeviceId: row.owner_device_id,
		size: row.size,
		ttlHours: span / 3_600_000,
		hasPassword: !!row.password_verifier_hash,
		now,
		exceptShareId: row.share_id,
	});
	const expiresAt = now + span;
	// Signed before the first durable write, as in `openShare`.
	const token = await signToken(env.SESSION_SECRET, {
		t: "share_upload",
		share: row.share_id,
		exp: now + UPLOAD_TOKEN_TTL_MS,
	});
	const upload = await env.RELAY.createMultipartUpload(row.r2_key);
	try {
		await env.DB.batch([
			// The previous attempt's etags name parts of a multipart upload that
			// no longer exists; leaving them would let `complete` assemble a file
			// out of handles R2 has already forgotten.
			env.DB.prepare("DELETE FROM share_parts WHERE share_id = ?").bind(row.share_id),
			// `created_at` moves with it. The record is being made again — new
			// bytes, new expiry, counter back to zero — and it also puts the
			// seven-day sweep of terminal rows on the clock that matters: a link
			// restored on day eight and revoked on day nine should not be swept
			// the moment it ends because it was first created last week.
			env.DB.prepare(
				`UPDATE shares SET state = 'uploading', upload_id = ?, revoked_at = NULL,
				 paused = 0, downloads = 0, created_at = ?, expires_at = ? WHERE share_id = ?`,
			).bind(upload.uploadId, now, expiresAt, row.share_id),
			bookRelayBytes(env, row.owner_device_id, row.size, utcMonth(now)),
		]);
	} catch (error) {
		await upload.abort().catch(() => undefined);
		throw error;
	}
	return {
		shareId: row.share_id,
		code: row.code,
		token,
		partSize: PART_SIZE,
		partCount: partCountFor(row.size),
		expiresAt,
	};
}

/**
 * Remove the record entirely — the row, the object, and the claim on the path.
 *
 * The distinction from `revokeShare` is the whole reason both exist. Revoking
 * stops the link and keeps the record, so the path stays reserved and nobody
 * holding the old URL is ever handed a different file at the same address.
 * Deleting is the owner saying they are done with it: the record goes, and with
 * it that protection, which is why it is a separate and confirmed action rather
 * than what revoking quietly does.
 *
 * The object is released whatever state the row is in. A deleted row can no
 * longer tell anyone there is plaintext at `r2_key`, so leaving it would be a
 * bill and a disclosure that nothing in the system remembers how to end.
 */
export async function deleteShare(env: Env, row: ShareRow): Promise<void> {
	// Via `abandonShare` rather than a plain delete so an interrupted upload
	// still aborts its multipart and refunds its bytes in the one place that
	// knows how. The state it writes is immediately deleted below; the refund
	// and the abort are what this call is for.
	if (row.state === "uploading") await abandonShare(env, row);
	else await env.RELAY.delete(row.r2_key).catch(() => undefined);
	// `share_parts` follows on its ON DELETE CASCADE (0008_shares.sql:47).
	await env.DB.prepare("DELETE FROM shares WHERE share_id = ?").bind(row.share_id).run();
}

/** Stop the link and release the file, but keep the record and its path. */
export async function revokeShare(env: Env, row: ShareRow): Promise<void> {
	if (row.state === "uploading") await abandonShare(env, row);
	else {
		await env.RELAY.delete(row.r2_key).catch(() => undefined);
		await env.DB.prepare(
			"UPDATE shares SET state = 'revoked', revoked_at = ?, upload_id = NULL WHERE share_id = ?",
		)
			.bind(Date.now(), row.share_id)
			.run();
	}
}
