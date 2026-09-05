/**
 * Every tunable number lives here.
 *
 * Three of these are not tuning knobs but cost constraints from PRD 8.6 — under
 * a one-time-purchase model the marginal cost per user has to be bounded by
 * construction, not by watching the bill:
 *
 *   1. PART_SIZE is 64 MiB, not 5 MiB. R2 Class A operations are billed per
 *      call, so a 1 GB file is ~18 writes instead of ~200.
 *   2. The signalling Durable Object must use the WebSocket Hibernation API.
 *      See do/DeviceHub.ts.
 *   3. Running out of quota downgrades, it never bills overage.
 */

/** Plaintext chunk size for AES-256-GCM framing (PRD 9.2). */
export const CHUNK_SIZE = 1024 * 1024;

/** AES-GCM authentication tag, appended to every chunk. */
export const TAG_SIZE = 16;

/** R2 multipart part size. Do not lower this — see note 1 above. */
export const PART_SIZE = 64 * 1024 * 1024;

export interface Tier {
	name: "free" | "pro";
	/** 6.2 — number of inboxes. */
	maxInboxes: number;
	/** 13.4 — per-file ceiling. */
	maxFileSize: number;
	/** 8.5 — total bytes this device may keep parked in R2 at once. */
	pendingQuota: number;
	/** 8.5 — how long an undelivered object survives. */
	ttlHours: number;
	/** 13.3 — per-inbox daily ceilings. */
	dailyFiles: number;
	dailyBytes: number;
	/** 16.1 — monthly relayed bytes. Exhausting it disables relay, not service. */
	monthlyRelayBytes: number;
}

export const FREE: Tier = {
	name: "free",
	maxInboxes: 1,
	maxFileSize: 2 * 1024 ** 3,
	pendingQuota: 3 * 1024 ** 3,
	ttlHours: 24,
	dailyFiles: 200,
	dailyBytes: 3 * 1024 ** 3,
	monthlyRelayBytes: 3 * 1024 ** 3,
};

export const PRO: Tier = {
	name: "pro",
	maxInboxes: Number.MAX_SAFE_INTEGER,
	maxFileSize: 20 * 1024 ** 3,
	pendingQuota: 100 * 1024 ** 3,
	ttlHours: 24 * 7,
	dailyFiles: 5000,
	dailyBytes: 300 * 1024 ** 3,
	monthlyRelayBytes: 300 * 1024 ** 3,
};

/**
 * 16.1 — activations per licence. Creem is told the same number when the
 * product is configured and is the one that enforces it; this copy exists so
 * the settings screen can say "2 of 3" without a round trip.
 */
export const PRO_SEATS = 3;

/*
 * Which tier a device is on is a database question, not a constant, so it lives
 * in lib/entitlement.ts — `tierFor(env, deviceId)`. It used to be a
 * `tierForDevice()` here that returned PRO unconditionally, which made every
 * paywall in the codebase unreachable.
 */

/**
 * 6.1 — a name is a DNS label, because it *is* one: `<name>.stolnk.com`.
 * 3–20 characters, and neither end may be a hyphen. The old grammar allowed
 * `-ryan`, which is not a legal hostname label at all.
 */
export const NAME_RE = /^[a-z0-9][a-z0-9-]{1,18}[a-z0-9]$/;
/** 6.2 — sub-inbox path segment. */
export const SLUG_RE = /^[a-z0-9-]{1,32}$/;

/**
 * How long a finished transfer's metadata row survives.
 *
 * The ciphertext is already gone by then — every terminal state releases its R2
 * object at the moment it becomes terminal — so what this expires is the row:
 * size, timestamps, the encrypted name, the wrapped key, the plaintext digest.
 * Nothing reads those rows once the transfer is over; the pending list and the
 * quota check both filter on `('uploading', 'ready')`, and there is no history
 * feature for them to feed.
 *
 * It is not shorter because the sender's own status poll reads the transfer row
 * (`routes/transfers.ts`), and a row deleted out from under a page someone
 * still has open turns "Delivered" into a 404.
 *
 * This number is a published promise, not a tuning knob: /privacy states it.
 * Changing it here means changing `landing/copy-legal.tsx` in both languages.
 */
export const TRANSFER_RECORD_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Device auth challenge lifetime. */
export const CHALLENGE_TTL_MS = 5 * 60 * 1000;
/** Device session token lifetime. */
export const DEVICE_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
/** 13.3 — upload session lifetime. */
export const UPLOAD_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

/** 13.3 — metadata field ceilings, enforced before anything touches the DB. */
export const MAX_FILENAME_CIPHERTEXT = 2048;
export const MAX_DISPLAY_NAME = 64;
export const MAX_FILES_PER_TRANSFER = 200;

/** 13.1 — fixed delay on unresolved addresses, to blunt name enumeration. */
export const NOT_FOUND_DELAY_MS = 300;

/** 13.3 — per-IP request budgets, per rolling window. */
export const RATE_WINDOW_MS = 60_000;
export const RATE_MAX_RESOLVES = 60;
export const RATE_MAX_TRANSFERS = 20;
export const RATE_MAX_PARTS = 600;
/**
 * 16 — licence calls. Far tighter than the rest, because `deactivate` takes a
 * key and no session: it is the one endpoint where guessing gets you something.
 * A real user activates once and releases a seat almost never, so a low ceiling
 * costs nobody anything.
 */
export const RATE_MAX_LICENSE = 20;

/**
 * The Windows waiting list. A person signs up once, so the only caller who
 * needs more than a couple a minute is someone stuffing the table.
 */
export const RATE_MAX_WAITLIST = 5;

/** Ciphertext length for a given plaintext length under the chunk framing. */
export function cipherSizeFor(plainSize: number): number {
	const chunks = Math.max(1, Math.ceil(plainSize / CHUNK_SIZE));
	return plainSize + chunks * TAG_SIZE;
}

/** Number of R2 parts a ciphertext stream of this length occupies. */
export function partCountFor(cipherSize: number): number {
	return Math.max(1, Math.ceil(cipherSize / PART_SIZE));
}
