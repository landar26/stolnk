import { Hono } from "hono";
import { RATE_MAX_WAITLIST } from "../limits";
import { badRequest, clientIp, readJson, requireString, type AppEnv } from "../lib/http";
import { enforce } from "../lib/ratelimit";

/**
 * The Windows waiting list.
 *
 * Public and unauthenticated, like `/api/v1/resolve` and for the same reason:
 * the person filling it in does not have Stolnk and by definition cannot have
 * an account.
 */
export const waitlist = new Hono<AppEnv>();

/**
 * Deliberately loose. The only question worth asking here is whether a string
 * could plausibly be delivered to, and the strict grammar is both famously
 * unwritable as a regex and wrong in practice — it rejects real addresses. The
 * authoritative check is whether the announcement bounces, which happens once,
 * years from now, and costs nothing.
 */
const EMAIL_RE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

/** What the site actually offers a list for. */
const PLATFORMS = new Set(["windows"]);

waitlist.post("/", async (c) => {
	enforce(`waitlist:${clientIp(c)}`, RATE_MAX_WAITLIST);

	const body = await readJson<{ email?: unknown; platform?: unknown; locale?: unknown }>(c);

	// 254 is the longest an address can be and still be routable.
	const email = requireString(body.email, "email", 254).trim().toLowerCase();
	if (!EMAIL_RE.test(email)) badRequest("That does not look like an email address.");

	const platform = requireString(body.platform, "platform", 16).toLowerCase();
	if (!PLATFORMS.has(platform)) badRequest('Unknown "platform".');

	const locale = typeof body.locale === "string" ? body.locale.slice(0, 8) : null;

	/*
	 * `DO NOTHING`, so signing up twice is a success rather than a conflict.
	 *
	 * Both halves of that matter. Someone who cannot remember whether they
	 * already signed up will submit again, and telling them "you are already on
	 * the list" would turn this endpoint into an oracle for whether a given
	 * address is on it — which is not ours to answer, and is exactly the question
	 * an unauthenticated form must refuse to be useful for. The first
	 * submission's `created_at` and `locale` are the ones kept.
	 */
	await c.env.DB.prepare(
		`INSERT INTO waitlist (email, platform, locale, created_at) VALUES (?, ?, ?, ?)
		 ON CONFLICT(email) DO NOTHING`,
	)
		.bind(email, platform, locale, Date.now())
		.run();

	return c.json({ ok: true });
});
