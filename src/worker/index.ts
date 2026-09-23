import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { hubFor } from "./lib/deviceauth";
import { refundRelayBytes } from "./lib/entitlement";
import { utcMonth, type AppEnv } from "./lib/http";
import {
	SHARE_CODE_ROUTE,
	PAYMENT_EVENT_TTL_MS,
	SHARE_RECORD_TTL_MS,
	TRANSFER_RECORD_TTL_MS,
	UPLOAD_TOKEN_TTL_MS,
} from "./limits";
import { transferExpired } from "./lib/metrics";
import { isInboxHost, rewriteInboxPreview } from "./lib/preview";
import { verifyToken, type DeviceToken, type SignalToken, type UploadToken } from "./lib/tokens";
import { requireAdmin } from "./lib/admin";
import { admin } from "./routes/admin";
import { adminPage } from "./routes/admin-page";
import { checkout } from "./routes/checkout";
import { delivery } from "./routes/delivery";
import { devices, names } from "./routes/devices";
import { inboxCapabilities, inboxUpload, wantsCapabilities } from "./routes/inbox-address";
import { inboxes } from "./routes/inboxes";
import { licenses } from "./routes/licenses";
import { downloads, release } from "./routes/releases";
import { shareLink } from "./routes/share-link";
import { shareDownload, shareLanding } from "./routes/share-public";
import { shares } from "./routes/shares";
import { resolve } from "./routes/resolve";
import { transfers } from "./routes/transfers";
import { waitlist } from "./routes/waitlist";
import { webhooks } from "./routes/webhooks";

export { DeviceHub } from "./do/DeviceHub";

const app = new Hono<AppEnv>();

/**
 * PRD 9.4 — the honest description of browser-delivered E2EE is that a
 * compromised server could ship tampered JavaScript. A strict CSP plus SRI is
 * the mitigation we can actually offer, so the headers are not decoration.
 *
 * Relaxed on localhost because the Vite dev server needs inline scripts.
 */
app.use("*", async (c, next) => {
	await next();
	// Every inbox is served from its own subdomain, so the dev check has to accept
	// `ryan.localhost` as readily as `localhost`. `hostname` drops the port and
	// keeps an IPv6 literal bracketed.
	const hostname = new URL(c.req.url).hostname;
	const isLocal =
		hostname === "localhost" ||
		hostname.endsWith(".localhost") ||
		hostname === "127.0.0.1" ||
		hostname === "[::1]";
	if (!isLocal) {
		// A handler that set its own policy means it, and this one would be wrong
		// for it: the admin console is a single inline document (routes/admin-page.ts)
		// that `script-src 'self'` blanks outright. `c.header` replaces rather than
		// merges, so the check has to happen here, not there.
		if (!c.res.headers.has("content-security-policy")) {
			c.header(
				"content-security-policy",
				[
					"default-src 'self'",
					"script-src 'self'",
					"style-src 'self'",
					"img-src 'self' data: blob:",
					"connect-src 'self' wss:",
					"frame-ancestors 'none'",
					"base-uri 'none'",
					"form-action 'none'",
					"object-src 'none'",
				].join("; "),
			);
		}
		c.header("strict-transport-security", "max-age=63072000; includeSubDomains; preload");
	}
	c.header("x-content-type-options", "nosniff");
	c.header("referrer-policy", "no-referrer");

	/*
	 * An inbox address is handed to one person, and it stays private only for as
	 * long as nobody publishes it. Somebody eventually will — in a public issue,
	 * a forum post, a screenshot — and from there a crawler finds it. This is the
	 * difference between that link being known to whoever was given it and being
	 * a search result.
	 *
	 * Deliberately a header and not `Disallow: /` in robots.txt, which would be
	 * the blunter version of the same idea and would also stop the unfurlers that
	 * do read it: an inbox link pasted into a chat should still show what it is,
	 * since the recipient deciding whether to trust it is the whole reason the
	 * send page has preview tags at all. `noindex` is a search directive; the
	 * preview fetchers ignore it. That split is the one we want.
	 */
	if (isInboxHost(c.req.url)) c.header("x-robots-tag", "noindex, nofollow");
});

app.get("/api/v1/health", (c) => c.json({ ok: true }));

/*
 * Without this the SPA fallback answers robots.txt with `index.html`, and a
 * crawler reading HTML where it expected directives treats the site as having
 * no rules at all.
 */
app.get("/robots.txt", (c) =>
	c.text(
		isInboxHost(c.req.url)
			? // The pages are already `noindex` by the header above. Crawling is left
				// open on purpose so that unfurling still works.
				"User-agent: *\nAllow: /\n"
			: "User-agent: *\nAllow: /\n",
	),
);
// The operator console. `requireAdmin` answers 404 rather than 401 when
// ADMIN_TOKEN is unset, so a deployment that never configured one exposes
// nothing — not even a password box (lib/admin.ts).
app.use("/api/v1/admin/*", requireAdmin);
app.route("/api/v1/admin", admin);
app.route("/api/v1/devices", devices);
app.route("/api/v1/inboxes", inboxes);
app.route("/api/v1/names", names);
app.route("/api/v1/resolve", resolve);
app.route("/api/v1/transfers", transfers);
app.route("/api/v1/shares", shares);
app.route("/api/v1/share-link", shareLink);
app.route("/api/v1/licenses", licenses);
app.route("/api/v1/checkout", checkout);
app.route("/api/v1/release", release);
app.route("/api/v1/waitlist", waitlist);
// Not under a device session, and deliberately outside the per-IP rate limits
// that guard the rest: Creem retries with backoff, and throttling a webhook
// turns a refund into one that silently never applies (PRD 16.5).
app.route("/api/v1/webhooks", webhooks);
app.route("/api/v1", delivery);
// The installer (PRD 10.1). Not under /api/, so it has to be mounted before the
// SPA fallback below; only /download/mac and /download/mac/<file> are claimed,
// leaving bare /download to the page that links to them.
app.route("/download", downloads);
// The console's shell, and the host check is load-bearing. Hono routes without
// regard to hostname, and on `<name>.stolnk.com` every path is an inbox address
// — `admin` is reserved as a *name* (lib/inbox.ts) but not as a slug, so
// without this the route would shadow a real inbox at /admin. Falling through
// rather than 404ing is what hands that request back to the send page.
app.get("/admin", (c) => (isInboxHost(c.req.url) ? c.notFound() : adminPage(c)));
app.get(`/:code{${SHARE_CODE_ROUTE}}`, shareLanding);
app.get(`/:code{${SHARE_CODE_ROUTE}}/:filename`, shareDownload);

/**
 * The inbox address used as an API rather than as a page (PRD 1.2 is silent on
 * this; it is new). `POST ryan.stolnk.com/client-a` with a multipart body is a
 * file upload, and `OPTIONS` describes how to make one — so a terminal, a
 * script or an agent that was handed one link needs nothing else.
 *
 * Catch-alls, and therefore mounted here: an inbox path is arbitrary
 * (`/client-a`, `/2026/invoices`) and cannot be expressed as a route. They sit
 * after every `/api/` route so those still win, and anything still addressed to
 * `/api/` — or arriving on the apex, which has no inboxes — is handed to the
 * fallback below exactly as before.
 */
app.post("*", (c) => {
	if (c.req.path.startsWith("/~")) return c.json({ error: "not_found", message: "No such endpoint." }, 404);
	if (c.req.path.startsWith("/api/") || !isInboxHost(c.req.url)) return c.notFound();
	return inboxUpload(c);
});

app.options("*", (c) => {
	if (c.req.path.startsWith("/~")) return c.json({ error: "not_found", message: "No such endpoint." }, 404);
	if (c.req.path.startsWith("/api/") || !isInboxHost(c.req.url)) return c.notFound();
	return inboxCapabilities(c);
});

/**
 * Signalling. Tokens travel in the query string because the WebSocket handshake
 * cannot carry an Authorization header; both are short-lived and single-purpose.
 */
app.get("/api/v1/ws/device", async (c) => {
	const payload = await verifyToken<DeviceToken>(
		c.env.SESSION_SECRET,
		c.req.query("token"),
		"device",
	);
	if (!payload) return c.text("unauthorized", 401);
	const id = c.env.HUB.idFromName(payload.sub);
	const url = new URL(c.req.url);
	url.searchParams.set("role", "device");
	url.searchParams.set("device", payload.sub);
	return c.env.HUB.get(id).fetch(new Request(url, c.req.raw));
});

app.get("/api/v1/ws/sender", async (c) => {
	const payload = await verifyToken<UploadToken>(
		c.env.SESSION_SECRET,
		c.req.query("token"),
		"upload",
	);
	if (!payload) return c.text("unauthorized", 401);
	const owner = await c.env.DB.prepare("SELECT owner_device_id FROM inboxes WHERE inbox_id = ?")
		.bind(payload.inbox)
		.first<{ owner_device_id: string }>();
	if (!owner) return c.text("not found", 404);

	const url = new URL(c.req.url);
	url.searchParams.set("role", "sender");
	url.searchParams.set("device", owner.owner_device_id);
	url.searchParams.set("transfer", payload.transfer);
	return c.env.HUB.get(c.env.HUB.idFromName(owner.owner_device_id)).fetch(
		new Request(url, c.req.raw),
	);
});

/**
 * PRD 8.2 — WebRTC signalling for a LAN direct transfer. Separate from
 * `/ws/sender` because it has to be openable *before* a transfer exists: the
 * whole point is that the DataChannel is already negotiated by the time someone
 * presses send.
 *
 * The session id is minted here and never read from the client, so one sender
 * cannot address another's negotiation. `DeviceHub` bounds what a socket may
 * push through it, because the token behind this route is handed to anyone
 * holding the link.
 */
app.get("/api/v1/ws/lan", async (c) => {
	const payload = await verifyToken<SignalToken>(
		c.env.SESSION_SECRET,
		c.req.query("token"),
		"signal",
	);
	if (!payload) return c.text("unauthorized", 401);

	const url = new URL(c.req.url);
	url.searchParams.set("role", "signal");
	url.searchParams.set("device", payload.device);
	url.searchParams.set("session", crypto.randomUUID());
	return c.env.HUB.get(c.env.HUB.idFromName(payload.device)).fetch(new Request(url, c.req.raw));
});

/**
 * Everything the routes above did not claim, which under
 * `run_worker_first: true` means the static site as well as unknown paths.
 *
 * **This handler and that flag are one change.** The flag exists so the CSP and
 * HSTS middleware runs on the pages that need it most — PRD 9.4 makes that
 * policy the mitigation for browser-delivered E2EE, and it cannot be applied to
 * a response the Worker never sees. The cost is that real files arrive here
 * too: `/assets/index-<hash>.js`, `/app-icon.png`. Answering those with
 * `index.html`, as this did when the asset layer ran first, serves the bundle as
 * HTML and takes the whole site down.
 *
 * So the request is forwarded at its own path rather than rewritten to
 * `/index.html`. The binding's own `not_found_handling` is
 * `single-page-application`, which means it returns the file when there is one
 * and `index.html` when there is not — both of the answers needed here, and the
 * reason this is shorter than what it replaced.
 *
 * GET regardless of the method that arrived: this is the last stop, and a
 * request that reaches it is a request for a page. The one method that is no
 * longer true of is POST on an inbox host, which is claimed above as an upload
 * before it can ever get here.
 */
app.notFound(async (c) => {
	if (c.req.path.startsWith("/api/")) {
		return c.json({ error: "not_found", message: "No such endpoint." }, 404);
	}
	/*
	 * An inbox address is also an API (routes/inbox-address.ts). A caller that
	 * asked for JSON in so many words gets the capability document instead of the
	 * page.
	 *
	 * The test is deliberately an opt-in. Under `run_worker_first` every asset
	 * request arrives here too, and those carry `Accept: * / *`; anything looser
	 * would answer JSON to a `<script src>` and take the whole site down.
	 */
	if (isInboxHost(c.req.url) && wantsCapabilities(c)) return inboxCapabilities(c);

	// An inbox address (PRD 1.2) otherwise lands here as an asset miss and is
	// rendered by the SPA, which resolves it through /api/v1/resolve and shows
	// its own 404.
	const asset = await c.env.ASSETS.fetch(new Request(new URL(c.req.url), { method: "GET" }));

	// The one thing the SPA cannot do for itself: a crawler building a link
	// preview does not run the bundle, so the tags it reads are whatever the
	// static `index.html` shipped. On an inbox subdomain those are the wrong
	// half of the product, and this is the only place left to say so.
	return isInboxHost(c.req.url) ? rewriteInboxPreview(asset, c.req.url) : asset;
});

app.onError((error, c) => {
	if (error instanceof HTTPException) return error.getResponse();
	console.error("unhandled", error);
	return c.json({ error: "internal", message: "Something went wrong." }, 500);
});

/**
 * PRD 8.5 — undelivered objects expire. Together with delete-on-ACK this is
 * what keeps average residency (and therefore storage cost) near zero.
 *
 * RELAY only. The RELEASES bucket holds published installers, which have no TTL
 * and no row in D1 to find them by; nothing here should ever touch it.
 */
async function sweep(env: Env): Promise<void> {
	const now = Date.now();
	await env.DB.prepare("DELETE FROM challenges WHERE expires_at < ?").bind(now).run();

	const { results } = await env.DB.prepare(
		`SELECT f.file_id, f.r2_key, f.upload_id, f.size, t.inbox_id, t.created_at,
		        t.transport, i.owner_device_id
		 FROM files f
		 JOIN transfers t ON t.transfer_id = f.transfer_id
		 JOIN inboxes i ON i.inbox_id = t.inbox_id
		 WHERE t.expires_at < ? AND f.state IN ('uploading', 'ready')
		 LIMIT 500`,
	)
		.bind(now)
		.all<{
			file_id: string;
			r2_key: string;
			upload_id: string | null;
			size: number;
			inbox_id: string;
			created_at: number;
			transport: string;
			owner_device_id: string;
		}>();

	for (const file of results) {
		try {
			if (file.upload_id) {
				await env.RELAY.resumeMultipartUpload(file.r2_key, file.upload_id).abort();
			} else {
				await env.RELAY.delete(file.r2_key);
			}
		} catch {
			// Object already gone.
		}
		// PRD 16.1 — the same refund the abort path makes. Bytes that were parked
		// and never collected were charged against the owner's month at upload; a
		// TTL running out is not a delivery, so they come back. Booked against the
		// month the transfer was created in, which is often not this one — that is
		// the whole reason a 24 hour TTL can straddle a month boundary.
		//
		// And, exactly as in `abandonTransfer`, only for a transfer that booked
		// something. A LAN transfer never charged the month, so "giving back" its
		// bytes would take them from whatever else booked that month.
		const writes = [
			env.DB.prepare("UPDATE files SET state = 'expired', upload_id = NULL WHERE file_id = ?").bind(
				file.file_id,
			),
		];
		if (file.transport !== "lan") {
			writes.push(
				refundRelayBytes(env, file.owner_device_id, file.size, utcMonth(file.created_at)),
			);
		}
		await env.DB.batch(writes);
		transferExpired({ inbox_id: file.inbox_id, bytes: file.size });
	}

	await env.DB.prepare(
		`UPDATE transfers SET state = 'expired'
		 WHERE expires_at < ? AND state IN ('uploading', 'ready')`,
	)
		.bind(now)
		.run();

	await sweepShares(env, now);

	await forgetOldRecords(env, now);
}

async function sweepShares(env: Env, now: number): Promise<void> {
	const { results: uploads } = await env.DB.prepare(
		`SELECT * FROM shares WHERE state = 'uploading' AND created_at < ? LIMIT 500`,
	)
		.bind(now - UPLOAD_TOKEN_TTL_MS)
		.all<{
			share_id: string; owner_device_id: string; r2_key: string; upload_id: string | null;
			size: number; created_at: number;
		}>();
	for (const share of uploads) {
		try {
			if (share.upload_id) await env.RELAY.resumeMultipartUpload(share.r2_key, share.upload_id).abort();
		} catch {
			// Already gone.
		}
		await env.DB.batch([
			env.DB.prepare("UPDATE shares SET state = 'aborted', upload_id = NULL WHERE share_id = ? AND state = 'uploading'").bind(share.share_id),
			refundRelayBytes(env, share.owner_device_id, share.size, utcMonth(share.created_at)),
		]);
	}

	const { results: finished } = await env.DB.prepare(
		`SELECT share_id, r2_key FROM shares
		 WHERE (expires_at < ? AND state = 'ready') OR state IN ('spent', 'revoked')
		 LIMIT 500`,
	)
		.bind(now)
		.all<{ share_id: string; r2_key: string }>();
	for (const share of finished) {
		await env.RELAY.delete(share.r2_key).catch(() => undefined);
		// Unlike an undelivered inbox transfer, a share served its purpose while
		// published. Expiry/revocation never returns the upload allowance.
		await env.DB.prepare("UPDATE shares SET state = 'expired', upload_id = NULL WHERE share_id = ?")
			.bind(share.share_id)
			.run();
	}
}

/**
 * Retention. Delete-on-ACK empties the bucket; this empties the table.
 *
 * The two were never the same thing, and until this existed only the first one
 * happened: a delivered transfer's row — its size, its timestamps, its
 * encrypted name, its wrapped key, the digest of its plaintext — stayed in D1
 * for as long as the inbox did. Nothing read it. It was residue, and residue
 * with a content hash in it is residue worth deleting on a schedule rather than
 * when someone remembers to.
 *
 * Purely a D1 delete, and safely so: every terminal state releases its R2
 * object at the moment it becomes terminal — the ACK path in
 * `routes/delivery.ts`, `abort` in `routes/transfers.ts`, and the loop above
 * for `expired` — so there is no state this can reach in which an object is
 * still parked. The cascade takes `files` and `file_parts` with the transfer.
 *
 * What it deliberately does not touch is `usage_daily` and `usage_monthly`.
 * Those are accounting, keyed by inbox and by device rather than by transfer,
 * and returning allowance because a record aged out would make forgetting a
 * transfer the cheapest way to buy another 300 GB.
 */
async function forgetOldRecords(env: Env, now: number): Promise<void> {
	const cutoff = now - TRANSFER_RECORD_TTL_MS;

	// SQLite is not built with SQLITE_ENABLE_UPDATE_DELETE_LIMIT, so the batch
	// size has to come from a subquery rather than a LIMIT on the DELETE. Same
	// 500 as the expiry pass above: the cron runs every 30 minutes, and a sweep
	// that cannot finish in one pass finishes in the next.
	await env.DB.prepare(
		`DELETE FROM transfers WHERE transfer_id IN (
		   SELECT transfer_id FROM transfers
		   WHERE state IN ('delivered', 'aborted', 'expired')
		     AND created_at < ?
		   LIMIT 500
		 )`,
	)
		.bind(cutoff)
		.run();

	await env.DB.prepare(
		`DELETE FROM shares WHERE share_id IN (
		   SELECT share_id FROM shares
		   WHERE state IN ('spent', 'revoked', 'expired', 'aborted') AND created_at < ?
		   LIMIT 500
		 )`,
	)
		.bind(now - SHARE_RECORD_TTL_MS)
		.run();

	// Payment webhook receipts. Only the ones that were processed: an 'error'
	// row is the only record that a refund did not apply, and deleting it on a
	// timer would erase the evidence before anyone read it.
	await env.DB.prepare(
		`DELETE FROM payment_events WHERE rowid IN (
		   SELECT rowid FROM payment_events
		   WHERE status = 'ok' AND received_at < ?
		   LIMIT 500
		 )`,
	)
		.bind(now - PAYMENT_EVENT_TTL_MS)
		.run();
}

export default {
	fetch: app.fetch,
	async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
		ctx.waitUntil(sweep(env));
	},
} satisfies ExportedHandler<Env>;

export { hubFor };
