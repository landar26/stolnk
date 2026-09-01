import { RATE_WINDOW_MS } from "../limits";
import { fail } from "./http";

/**
 * PRD 13.3 — per-IP request budgets.
 *
 * This counter lives in the isolate, so it is best-effort: a client spread
 * across many colos gets a proportionally larger budget. That is a deliberate
 * trade. The limits that actually bound cost are durable and enforced
 * elsewhere — per-inbox daily caps and the per-device pending quota in D1
 * (PRD 8.5), plus the hard architectural ceilings in limits.ts. This layer only
 * blunts the cheap, noisy cases: handle enumeration and upload floods.
 */

interface Bucket {
	count: number;
	resetAt: number;
}

const buckets = new Map<string, Bucket>();
let lastSweep = 0;

function sweep(now: number): void {
	if (now - lastSweep < RATE_WINDOW_MS) return;
	lastSweep = now;
	for (const [key, bucket] of buckets) {
		if (bucket.resetAt <= now) buckets.delete(key);
	}
}

/** Returns false when the caller is over budget. */
export function consume(key: string, max: number, windowMs = RATE_WINDOW_MS): boolean {
	const now = Date.now();
	sweep(now);
	const bucket = buckets.get(key);
	if (!bucket || bucket.resetAt <= now) {
		buckets.set(key, { count: 1, resetAt: now + windowMs });
		return true;
	}
	bucket.count += 1;
	return bucket.count <= max;
}

export function enforce(key: string, max: number, windowMs = RATE_WINDOW_MS): void {
	if (!consume(key, max, windowMs)) {
		fail(429, "rate_limited", "Too many requests. Try again in a minute.");
	}
}
