import { Hono } from "hono";
import { utcDay, utcMonth, badRequest, readJson, requireString, type AppEnv } from "../lib/http";
import { adminGrant } from "../lib/metrics";
import {
	bindDevice,
	findPurchase,
	reconcileDevice,
	setStatus,
	upsertPurchase,
} from "../lib/purchases";

/**
 * The operator console's data, for one person looking at one screen.
 *
 * Everything here is a `GET` except the two that hand out Pro by hand, and the
 * split is the design: "how is this being used" is a question that should never
 * be able to change an answer. The two writes are named after what they do to a
 * device rather than to a row, because that is the level the console thinks at.
 *
 * What is deliberately absent: file names, inbox display names, transfer
 * contents, e-mail addresses beyond the waitlist count, and anything that could
 * reconstruct who sent what to whom. This console answers how much and how
 * many; PRD 15.5 already says those are the only questions the service gets to
 * ask about its own users, and a screen the operator stares at daily is the
 * easiest place for that line to quietly move.
 *
 * Mounted behind `requireAdmin` (lib/admin.ts) in index.ts, so nothing in this
 * file re-checks the token.
 */
export const admin = new Hono<AppEnv>();

/** One screen of rows. Anything longer is a query, not a console. */
const PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;
const MAX_NOTE = 200;
/** Two years of history would still render, but nobody reads past a quarter. */
const MAX_DAYS = 90;

function paging(url: URL): { limit: number; offset: number } {
	const limit = Number.parseInt(url.searchParams.get("limit") ?? "", 10);
	const offset = Number.parseInt(url.searchParams.get("offset") ?? "", 10);
	return {
		limit: Number.isInteger(limit) && limit > 0 ? Math.min(limit, MAX_PAGE_SIZE) : PAGE_SIZE,
		offset: Number.isInteger(offset) && offset > 0 ? offset : 0,
	};
}

/**
 * Every device that is Pro, from every source at once. The same rule `tierFor`
 * applies to one device, applied to all of them.
 */
const PRO_DEVICES = `
	SELECT DISTINCT d.device_id FROM purchase_devices d
	  JOIN purchases p ON p.purchase_id = d.purchase_id
	  WHERE p.status = 'active'
`;

admin.get("/overview", async (c) => {
	const now = Date.now();
	const day = utcDay(now);
	const month = utcMonth(now);
	const weekAgo = now - 7 * 24 * 60 * 60 * 1000;

	// One batch, one round trip. D1 charges per statement either way, but a
	// console that fires eleven awaits in series is a console that feels slow on
	// a connection that is not this one.
	const [
		devices,
		active,
		pro,
		inboxes,
		shares,
		today,
		monthUsage,
		relay,
		waitlist,
		failures,
	] = await c.env.DB.batch<Record<string, number>>([
		c.env.DB.prepare("SELECT count(*) AS n FROM devices"),
		c.env.DB.prepare("SELECT count(*) AS n FROM devices WHERE last_seen >= ?").bind(weekAgo),
		c.env.DB.prepare(`SELECT count(*) AS n FROM (${PRO_DEVICES})`),
		c.env.DB.prepare(
			"SELECT count(*) AS n, sum(paused) AS paused FROM inboxes",
		),
		c.env.DB.prepare(
			"SELECT count(*) AS n, sum(state IN ('uploading', 'ready')) AS live FROM shares",
		),
		c.env.DB.prepare(
			"SELECT coalesce(sum(files), 0) AS files, coalesce(sum(bytes), 0) AS bytes FROM usage_daily WHERE day = ?",
		).bind(day),
		c.env.DB.prepare(
			"SELECT coalesce(sum(files), 0) AS files, coalesce(sum(bytes), 0) AS bytes FROM usage_daily WHERE day LIKE ?",
		).bind(`${month}%`),
		c.env.DB.prepare(
			"SELECT coalesce(sum(relay_bytes), 0) AS bytes FROM usage_monthly WHERE month = ?",
		).bind(month),
		c.env.DB.prepare("SELECT count(*) AS n FROM waitlist"),
		// The one number on this screen that is a call to action rather than a
		// measurement: a notification we failed to process is a refund that has
		// not been applied. See lib/payment-events.ts.
		c.env.DB.prepare(
			"SELECT count(*) AS n FROM payment_events WHERE status <> 'ok'",
		),
	]);

	const first = <T>(result: D1Result<T>): T => result.results[0];
	return c.json({
		devices: { total: first(devices).n, active_7d: first(active).n, pro: first(pro).n },
		inboxes: { total: first(inboxes).n, paused: first(inboxes).paused ?? 0 },
		shares: { total: first(shares).n, live: first(shares).live ?? 0 },
		delivered: {
			today: { files: first(today).files, bytes: first(today).bytes },
			month: { files: first(monthUsage).files, bytes: first(monthUsage).bytes },
		},
		relay_bytes_month: first(relay).bytes,
		waitlist: first(waitlist).n,
		notification_failures: first(failures).n,
		day,
		month,
	});
});

/**
 * Daily delivered files and bytes, for the chart.
 *
 * Gaps are filled here rather than in the page: `usage_daily` has no row for a
 * day nothing arrived, and a chart that silently closes those gaps draws a
 * straight line through a quiet week and calls it traffic.
 */
admin.get("/usage", async (c) => {
	const asked = Number.parseInt(new URL(c.req.url).searchParams.get("days") ?? "", 10);
	const days = Number.isInteger(asked) && asked > 0 ? Math.min(asked, MAX_DAYS) : 30;
	const from = utcDay(Date.now() - (days - 1) * 24 * 60 * 60 * 1000);

	const { results } = await c.env.DB.prepare(
		`SELECT day, sum(files) AS files, sum(bytes) AS bytes
		 FROM usage_daily WHERE day >= ? GROUP BY day`,
	)
		.bind(from)
		.all<{ day: string; files: number; bytes: number }>();

	const byDay = new Map(results.map((row) => [row.day, row]));
	const series = [];
	for (let i = days - 1; i >= 0; i -= 1) {
		const day = utcDay(Date.now() - i * 24 * 60 * 60 * 1000);
		const row = byDay.get(day);
		series.push({ day, files: row?.files ?? 0, bytes: row?.bytes ?? 0 });
	}
	return c.json({ days, series });
});

/**
 * Who is using this, one row per device.
 *
 * `name` is in here and nothing else identifying is. It has to be: it is the
 * only label the operator can match against a support e-mail, and it is already
 * public — it is the subdomain every one of that device's links is served from.
 */
admin.get("/devices", async (c) => {
	const url = new URL(c.req.url);
	const { limit, offset } = paging(url);
	const query = (url.searchParams.get("q") ?? "").trim().slice(0, 64);
	const month = utcMonth();

	const { results } = await c.env.DB.prepare(
		`SELECT d.device_id, d.name, d.created_at, d.last_seen,
		        (SELECT count(*) FROM inboxes WHERE owner_device_id = d.device_id) AS inboxes,
		        (SELECT count(*) FROM shares WHERE owner_device_id = d.device_id) AS shares,
		        coalesce((SELECT relay_bytes FROM usage_monthly
		                  WHERE device_id = d.device_id AND month = ?), 0) AS relay_bytes,
		        (d.device_id IN (${PRO_DEVICES})) AS pro,
		        g.status AS grant_status,
		        g.note AS grant_note
		 FROM devices d
		 LEFT JOIN purchases g ON g.provider = 'admin' AND g.external_id = d.device_id
		 WHERE (? = '' OR d.name LIKE ?)
		 ORDER BY d.last_seen DESC
		 LIMIT ? OFFSET ?`,
	)
		.bind(month, query, `%${query}%`, limit, offset)
		.all();

	const total = await c.env.DB.prepare(
		"SELECT count(*) AS n FROM devices WHERE (? = '' OR name LIKE ?)",
	)
		.bind(query, `%${query}%`)
		.first<{ n: number }>();

	return c.json({ total: total?.n ?? 0, limit, offset, devices: results });
});

/**
 * Money, and the one place it can silently fail to move.
 *
 * The failed-notification list is the point of this endpoint. Everything else
 * here can be read off Creem's and Apple's own dashboards; a notification this
 * server accepted and then could not process appears nowhere but in its own
 * table, and what it means is that somebody's refund did not take effect.
 */
admin.get("/billing", async (c) => {
	const [purchases, failed] = await c.env.DB.batch([
		c.env.DB.prepare(
			`SELECT provider, status, environment, count(*) AS n FROM purchases
			 GROUP BY provider, status, environment
			 ORDER BY provider, status`,
		),
		c.env.DB.prepare(
			`SELECT provider, event_id, event_type, subtype, external_ref,
			        received_at, status, last_error
			 FROM payment_events WHERE status <> 'ok'
			 ORDER BY received_at DESC LIMIT 50`,
		),
	]);

	return c.json({
		purchases: purchases.results,
		failed_events: failed.results,
	});
});

/**
 * Pro, by hand.
 *
 * The note is required and goes into the row, not just the log line: the
 * question this table gets asked months later is "why does this device have
 * Pro", and a blank is not an answer. `upgradeToPro` runs for the same reason
 * `/apple/verify` runs it — a device whose inboxes still carry the free ceiling
 * is Pro in the settings screen and Free everywhere that matters.
 */
admin.post("/devices/:id/grant", async (c) => {
	const deviceId = c.req.param("id");
	const body = await readJson<{ note?: unknown }>(c);
	const note = requireString(body.note, "note", MAX_NOTE).trim();
	if (!note) return badRequest("Say why this device is being given Pro.");

	const device = await c.env.DB.prepare("SELECT name FROM devices WHERE device_id = ?")
		.bind(deviceId)
		.first<{ name: string }>();
	if (!device) return c.json({ error: "not_found", message: "No such device." }, 404);

	const now = Date.now();
	// A grant is a purchase nobody paid for: keyed on the device it was made to,
	// unlimited, and carrying the operator's reason. `provider = 'admin'` is what
	// keeps it out of any "how many did we sell" answer.
	const purchaseId = await upsertPurchase(c.env, "admin", deviceId, {
		status: "active",
		note,
		purchasedAt: now,
		verifiedAt: now,
	});
	await bindDevice(c.env, purchaseId, deviceId, now);
	await reconcileDevice(c.env, deviceId);

	adminGrant({ action: "grant", device: device.name, note });
	return c.json({ ok: true, device: device.name, status: "active" });
});

/**
 * Taking it back.
 *
 * `downgradeToFree` pauses what is over the free allowance and destroys
 * nothing, which is the same promise a Creem refund makes (routes/webhooks.ts).
 * A revoked row stays, so the console can still show that this device once had
 * Pro and on whose say-so.
 *
 * Note that this only takes away *this* source. A device that also holds a real
 * licence stays Pro, and `tierFor` is what decides that — which is correct, and
 * is why this route reports the tier it left the device on rather than assuming.
 */
admin.post("/devices/:id/revoke", async (c) => {
	const deviceId = c.req.param("id");
	const body = await readJson<{ note?: unknown }>(c);
	const note = requireString(body.note, "note", MAX_NOTE).trim();
	if (!note) return badRequest("Say why this grant is being taken back.");

	const device = await c.env.DB.prepare("SELECT name FROM devices WHERE device_id = ?")
		.bind(deviceId)
		.first<{ name: string }>();
	const grant = device ? await findPurchase(c.env, "admin", deviceId) : null;
	if (!device || !grant) return c.json({ error: "not_found", message: "No such grant." }, 404);

	await setStatus(c.env, grant.purchase_id, "revoked", Date.now(), note);
	// Only downgrades if nothing else is holding this device up. Downgrading a
	// device that also bought a licence would be the console quietly undoing a
	// purchase.
	const tier = await reconcileDevice(c.env, deviceId);

	adminGrant({ action: "revoke", device: device.name, note });
	return c.json({ ok: true, device: device.name, status: tier.name });
});
