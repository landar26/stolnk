import { Hono } from "hono";
import { RATE_MAX_SHARE_LOOKUPS, RATE_MAX_SHARE_UNLOCK, SHARE_TOKEN_TTL_MS } from "../limits";
import { clientIp, notFound, readJson, requireString, unauthorized, type AppEnv } from "../lib/http";
import { verifierMatches } from "../lib/password";
import { enforce } from "../lib/ratelimit";
import { findPublicShare, type ShareRow } from "../lib/share";
import { nameFromHost } from "../lib/site";
import { signToken } from "../lib/tokens";

export const shareLink = new Hono<AppEnv>();

async function liveShare(env: Env, requestUrl: string, code: string): Promise<ShareRow> {
	const name = nameFromHost(requestUrl);
	if (!name) return notFound();
	const row = await findPublicShare(env, name, code);
	if (
		!row ||
		row.state !== "ready" ||
		row.paused ||
		row.revoked_at !== null ||
		row.expires_at <= Date.now() ||
		(row.max_downloads !== null && row.downloads >= row.max_downloads)
	) {
		return notFound("This link is unavailable.");
	}
	return row;
}

function publicInfo(row: ShareRow) {
	return {
		code: row.code,
		filename: row.filename,
		size: row.size,
		expires_at: row.expires_at,
		downloads_left:
			row.max_downloads === null ? null : Math.max(0, row.max_downloads - row.downloads),
		password: { required: !!row.password_verifier_hash },
	};
}

shareLink.get("/lookup", async (c) => {
	// Rate-limited since share paths became choosable. A 16-character random
	// code made enumeration pointless and this endpoint free to leave open;
	// `~invoice` is a guess worth making, and an unprotected share answers with
	// its filename and size. (A password-protected one still answers with
	// neither — see below.)
	enforce(`share-lookup:${clientIp(c)}`, RATE_MAX_SHARE_LOOKUPS);
	const code = c.req.query("code") ?? "";
	const row = await liveShare(c.env, c.req.url, code);
	if (row.password_verifier_hash) {
		return c.json({
			password: {
				required: true,
				salt: row.password_salt,
				iterations: 210_000,
			},
		});
	}
	return c.json(publicInfo(row));
});

shareLink.post("/unlock", async (c) => {
	enforce(`share-unlock:${clientIp(c)}`, RATE_MAX_SHARE_UNLOCK);
	const body = await readJson<{ code?: unknown; verifier?: unknown }>(c);
	const code = requireString(body.code, "code", 32);
	const verifier = requireString(body.verifier, "verifier", 256);
	const row = await liveShare(c.env, c.req.url, code);
	if (!row.password_verifier_hash || !(await verifierMatches(verifier, row.password_verifier_hash))) {
		return unauthorized("Incorrect password.");
	}
	const token = await signToken(c.env.SESSION_SECRET, {
		t: "share_access",
		share: row.share_id,
		exp: Date.now() + SHARE_TOKEN_TTL_MS,
	});
	return c.json({ ...publicInfo(row), token });
});
