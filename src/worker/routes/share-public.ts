import type { Context } from "hono";
import { RATE_MAX_SHARE_DOWNLOADS, RATE_MAX_SHARE_LOOKUPS } from "../limits";
import { pushInBackground } from "../lib/deviceauth";
import { bookRelayBytes, relayUsed, tierFor } from "../lib/entitlement";
import { clientIp, fail, notFound, quotaExceeded, unauthorized, utcMonth, type AppEnv } from "../lib/http";
import { deriveVerifier, verifierMatches } from "../lib/password";
import { enforce } from "../lib/ratelimit";
import { findPublicShare, type ShareRow } from "../lib/share";
import { nameFromHost } from "../lib/site";
import { verifyToken, type ShareAccessToken } from "../lib/tokens";

async function resolve(c: Context<AppEnv>): Promise<ShareRow> {
	const name = nameFromHost(c.req.url);
	const code = c.req.param("code").slice(1);
	if (!name) return notFound();
	const row = await findPublicShare(c.env, name, code);
	if (!row || row.revoked_at !== null || row.state === "revoked" || row.state === "aborted") {
		return notFound("This link is unavailable.");
	}
	return row;
}

function unavailable(row: ShareRow): never | void {
	if (row.paused) fail(423, "unavailable", "This link is temporarily unavailable. Try again later, or tell the person who sent it.");
	if (row.expires_at <= Date.now() || row.state === "expired" || row.state === "spent") {
		fail(410, "gone", "This link is no longer available.");
	}
	if (row.state !== "ready") notFound("This link is unavailable.");
}

async function authorise(c: Context<AppEnv>, row: ShareRow): Promise<void> {
	if (!row.password_verifier_hash) return;
	const password = c.req.header("x-stolnk-password");
	if (password && row.password_salt) {
		const verifier = await deriveVerifier(password, row.password_salt);
		if (await verifierMatches(verifier, row.password_verifier_hash)) return;
	}
	const payload = await verifyToken<ShareAccessToken>(
		c.env.SESSION_SECRET,
		c.req.query("t"),
		"share_access",
	);
	if (!payload || payload.share !== row.share_id) unauthorized("Unlock this share first.");
}

function asciiFilename(filename: string): string {
	const safe = filename.replace(/[\r\n"\\]/g, "").replace(/[^\x20-\x7e]/g, "_").trim();
	return safe || "download";
}

function rfc5987Filename(filename: string): string {
	return encodeURIComponent(filename).replace(/[!'()*]/g, (character) =>
		`%${character.charCodeAt(0).toString(16).toUpperCase()}`,
	);
}

function downloadHeaders(row: ShareRow): Headers {
	const out = new Headers();
	out.set("content-type", "application/octet-stream");
	out.set(
		"content-disposition",
		`attachment; filename="${asciiFilename(row.filename)}"; filename*=UTF-8''${rfc5987Filename(row.filename)}`,
	);
	return out;
}

export async function shareLanding(c: Context<AppEnv>) {
	// The same enumeration surface as `share-link/lookup`, and open for the same
	// lapsed reason: chosen paths are guessable, so the landing page needs the
	// bucket too. Its own, not the download bucket — looking is not fetching.
	enforce(`share-lookup:${clientIp(c)}`, RATE_MAX_SHARE_LOOKUPS);
	const row = await resolve(c);
	if (c.req.query("format") === "json") {
		return c.json({
			kind: "outbound_share",
			plaintext: true,
			note: "The server can read this file. Outbound shares are not end-to-end encrypted.",
			download: `/${c.req.param("code")}/${encodeURIComponent(row.filename)}`,
			password_header: row.password_verifier_hash ? "X-Stolnk-Password" : null,
			range: row.max_downloads === null,
		});
	}
	if (
		row.state === "ready" &&
		!row.paused &&
		row.expires_at > Date.now() &&
		!row.password_verifier_hash &&
		row.max_downloads === null
	) {
		return c.redirect(`/${c.req.param("code")}/${encodeURIComponent(row.filename)}`, 302);
	}
	return c.notFound();
}

export async function shareDownload(c: Context<AppEnv>) {
	if (c.req.method !== "HEAD") enforce(`share-download:${clientIp(c)}`, RATE_MAX_SHARE_DOWNLOADS);
	let row = await resolve(c);
	unavailable(row);
	if (decodeURIComponent(c.req.param("filename")) !== row.filename) return notFound();
	await authorise(c, row);

	const tier = await tierFor(c.env, row.owner_device_id);
	const used = await relayUsed(c.env, row.owner_device_id);
	if (used + row.size > tier.monthlyRelayBytes) {
		return quotaExceeded("This link is temporarily unavailable. It is not broken—try again in a few days, or tell the person who sent it.");
	}

	// Hono dispatches HEAD to GET handlers. Only a non-HEAD request consumes one
	// download; otherwise link checkers would burn limited links.
	const counting = c.req.method !== "HEAD" && row.max_downloads !== null;
	if (counting) {
		const counted = await c.env.DB.prepare(
			`UPDATE shares SET downloads = downloads + 1, last_download_at = ?,
			 state = CASE WHEN downloads + 1 >= max_downloads THEN 'spent' ELSE state END
			 WHERE share_id = ? AND state = 'ready' AND paused = 0 AND revoked_at IS NULL
			 AND expires_at > ? AND downloads < max_downloads RETURNING *`,
		)
			.bind(Date.now(), row.share_id, Date.now())
			.first<ShareRow>();
		if (!counted) fail(410, "gone", "This link is no longer available.");
		row = counted;
	}

	const limited = row.max_downloads !== null;
	const out = downloadHeaders(row);
	out.set("accept-ranges", limited ? "none" : "bytes");
	out.set("cache-control", limited ? "no-store, private" : "public, max-age=3600");

	if (c.req.method === "HEAD") {
		const head = await c.env.RELAY.head(row.r2_key);
		if (!head) return notFound();
		out.set("content-length", String(head.size));
		if (!limited) out.set("etag", head.httpEtag);
		return new Response(null, { status: 200, headers: out });
	}

	const headers = c.req.raw.headers;
	const wantsRange = !limited && headers.has("range");
	const object = await c.env.RELAY.get(row.r2_key, limited ? undefined : { range: headers, onlyIf: headers });
	if (!object) {
		const head = await c.env.RELAY.head(row.r2_key);
		if (!head) return notFound();
		return c.body(null, 416, { "content-range": `bytes */${head.size}` });
	}
	const firstBytePos = /^bytes=(\d+)-/.exec(headers.get("range")?.trim() ?? "");
	if (wantsRange && firstBytePos && Number(firstBytePos[1]) >= object.size) {
		return c.body(null, 416, { "content-range": `bytes */${object.size}` });
	}
	if (!limited) out.set("etag", object.httpEtag);
	if (!("body" in object) || object.body === null) {
		const conditional = headers.has("if-none-match") || headers.has("if-modified-since");
		return new Response(null, { status: conditional ? 304 : 412, headers: out });
	}

	let status = 200;
	let length = object.size;
	if (wantsRange && object.range && "offset" in object.range) {
		const offset = object.range.offset ?? 0;
		length = object.range.length ?? object.size - offset;
		out.set("content-range", `bytes ${offset}-${offset + length - 1}/${object.size}`);
		status = 206;
	}
	out.set("content-length", String(length));

	const { readable, writable } = new TransformStream();
	const shouldDelete = limited && row.downloads >= (row.max_downloads ?? Infinity);
	pushInBackground(c.executionCtx, () =>
		object.body.pipeTo(writable).finally(async () => {
			await c.env.DB.batch([bookRelayBytes(c.env, row.owner_device_id, length, utcMonth())]);
			if (shouldDelete) await c.env.RELAY.delete(row.r2_key).catch(() => undefined);
		}),
	);
	return new Response(readable, { status, headers: out });
}
