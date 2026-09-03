import { Hono } from "hono";
import type { MacRelease } from "../../shared/release";
import { notFound, type AppEnv } from "../lib/http";
import { nameFromHost } from "../lib/site";

/**
 * The download button (PRD 10.1).
 *
 * Stolnk is distributed directly rather than through the App Store, because it
 * writes to folders the user picks anywhere on disk — which the sandbox does
 * not allow — so the installer has to come from here. It is served out of R2
 * through the Worker rather than from a public bucket URL or a redirect to
 * someone else's release page: the download stays on stolnk.com, egress is
 * free, and publishing a build needs no deploy.
 *
 * Two surfaces, because they answer different questions:
 *
 *   GET /download/mac                302 to the current versioned dmg
 *   GET /download/mac/<filename>     the bytes, Range and ETag included
 *   GET /api/v1/release/mac          the manifest the download page renders
 *
 * The alias exists so the marketing page can link to something stable, and it
 * redirects rather than serving bytes for a reason: the saved filename then
 * carries the version for every client, including `curl -O` and `wget`, which
 * ignore `content-disposition`. That in turn lets the versioned URL be
 * `immutable` for a year while a new release goes live within the alias's five
 * minutes — with no cache to purge, from a publish script that has no purge
 * credentials.
 *
 * 302 and not 301, for the reason `checkout.ts` gives about the discount code:
 * a permanent redirect would pin browsers to one version forever.
 *
 * These paths only reach this file because `wrangler.json` sets
 * `run_worker_first: true`. Left to itself the static-asset layer runs ahead of
 * the Worker, and `not_found_handling: "single-page-application"` makes it
 * answer any *navigation* that matches no asset with `index.html` — so a
 * browser clicking the download link is served the SPA and the Worker never
 * sees the request, while `curl` (not a navigation) gets the redirect and
 * everything looks fine. That asymmetry is why the e2e suite sends
 * `sec-fetch-mode: navigate`: without it the test passes on a broken button.
 *
 * The flag was briefly the array form, `["/download/*"]`, which reads like
 * "and also run the Worker here" and is in fact the opposite: an array is an
 * exclusive allow-list, so every path not in it — the whole of `/api/*` —
 * stopped reaching the Worker at all. `true` is the only form that covers this
 * route, the API, and the CSP the pages need (see `index.ts`'s notFound).
 *
 * Deliberately no `caches.default`. The Cache API refuses to store 206s, and
 * `cache.match()` ignores `Range` — so the obvious implementation returns a
 * whole-object hit to a ranged request and silently breaks resumption. The
 * `cache-control` headers below do the work, and the upgrade path is a
 * dashboard Cache Rule on `/download/mac/*`, not code.
 */

const MANIFEST_KEY = "mac/latest.json";
const PREFIX = "mac/";

/** The only filenames this route will look up. Anything else is a probe. */
const DMG_RE = /^Stolnk-[0-9A-Za-z.+-]{1,32}-universal\.dmg$/;

/** Long enough to be worth having, short enough that a release is never stuck. */
const ALIAS_CACHE = "public, max-age=300";
const OBJECT_CACHE = "public, max-age=31536000, immutable";

async function currentRelease(env: Env): Promise<MacRelease | null> {
	const object = await env.RELEASES.get(MANIFEST_KEY);
	if (!object) return null;
	let manifest: MacRelease;
	try {
		manifest = await object.json<MacRelease>();
	} catch {
		return null;
	}
	if (typeof manifest?.filename !== "string" || !DMG_RE.test(manifest.filename)) return null;
	// Recomputed, never echoed: a malformed publish must not be able to put a
	// foreign URL on the download page.
	return { ...manifest, url: `/download/mac/${manifest.filename}` };
}

/**
 * The marketing site is the apex. On `<name>.stolnk.com` every path is an inbox
 * address (`site.ts`) and a release download is not one, so these paths simply
 * do not exist there. `c.notFound()` inside a mounted sub-app runs the parent's
 * handler, which means the subdomain gets the SPA (or the standard JSON 404
 * under `/api/`) rather than a second 404 mechanism invented here.
 *
 * Nothing collides: `SLUG_RE` is a single segment, so `download/mac` could
 * never be an inbox slug, and `RESERVED_NAMES` already holds `download`.
 */
function offApex(url: string): boolean {
	return nameFromHost(url) !== null;
}

/** Mounted at `/download`. Bare `/download` is deliberately not a route here —
 *  it falls through to the SPA, which renders the page that links to these. */
export const downloads = new Hono<AppEnv>();

downloads.get("/mac", async (c) => {
	if (offApex(c.req.url)) return c.notFound();
	const current = await currentRelease(c.env);
	if (!current) return notFound("No macOS build has been published yet.");
	c.header("cache-control", ALIAS_CACHE);
	return c.redirect(current.url, 302);
});

downloads.get("/mac/:filename", async (c) => {
	if (offApex(c.req.url)) return c.notFound();

	const filename = c.req.param("filename");
	// A path parameter never contains "/", so this cannot address anything
	// outside the mac/ prefix — but the whitelist is what keeps `latest.json`
	// and every other object in the bucket from being reachable here.
	if (!DMG_RE.test(filename)) return notFound("No such build.");

	const headers = c.req.raw.headers;
	// R2 parses the Range header itself, which is worth the union-narrowing
	// below: the hand-rolled regex in delivery.ts rejects the legal suffix form
	// `bytes=-1024` that resumers and download managers send.
	//
	// It populates `object.range` whether or not the request carried a Range,
	// so the header — not the response — is what decides between 200 and 206.
	const wantsRange = headers.has("range");
	const object = await c.env.RELEASES.get(PREFIX + filename, {
		range: headers,
		onlyIf: headers,
	});

	if (object === null) {
		// Either the object is gone, or a precondition failed. One extra head()
		// on a rare path buys a correct 416 instead of a misleading 404.
		const head = await c.env.RELEASES.head(PREFIX + filename);
		if (!head) return notFound("No such build.");
		return c.body(null, 416, { "content-range": `bytes */${head.size}` });
	}

	// R2 answers a range it cannot satisfy by ignoring it and returning the whole
	// object, which is legal but useless to a resumer: it asked to continue from
	// byte N and would be handed the file from the start with no way to tell.
	// Only the first-byte-pos forms can be unsatisfiable — a suffix range is
	// always clamped — so that is all this parses.
	const firstBytePos = /^bytes=(\d+)-/.exec(headers.get("range")?.trim() ?? "");
	if (firstBytePos && Number(firstBytePos[1]) >= object.size) {
		return c.body(null, 416, { "content-range": `bytes */${object.size}` });
	}

	const out = new Headers();
	object.writeHttpMetadata(out);
	if (!out.has("content-type")) out.set("content-type", "application/x-apple-diskimage");
	out.set("etag", object.httpEtag);
	out.set("accept-ranges", "bytes");
	out.set("cache-control", OBJECT_CACHE);
	// Not a CSP concern — a same-origin navigation is not governed by one — but
	// it guarantees the response is never treated as a document, and it fixes
	// the saved filename. `x-content-type-options: nosniff` is already global.
	out.set("content-disposition", `attachment; filename="${filename}"`);

	if (!("body" in object) || object.body === null) {
		// `onlyIf` matched nothing to send: a conditional GET is a 304, an
		// unmet precondition is a 412.
		const conditional = headers.has("if-none-match") || headers.has("if-modified-since");
		return new Response(null, { status: conditional ? 304 : 412, headers: out });
	}

	if (wantsRange && object.range && "offset" in object.range) {
		const offset = object.range.offset ?? 0;
		const length = object.range.length ?? object.size - offset;
		out.set("content-range", `bytes ${offset}-${offset + length - 1}/${object.size}`);
		out.set("content-length", String(length));
		return new Response(object.body, { status: 206, headers: out });
	}

	out.set("content-length", String(object.size));
	return new Response(object.body, { status: 200, headers: out });
});

/** Mounted at `/api/v1/release`. */
export const release = new Hono<AppEnv>();

release.get("/mac", async (c) => {
	if (offApex(c.req.url)) return c.notFound();
	const current = await currentRelease(c.env);
	if (!current) return notFound("No macOS build has been published yet.");
	c.header("cache-control", ALIAS_CACHE);
	return c.json(current satisfies MacRelease);
});
