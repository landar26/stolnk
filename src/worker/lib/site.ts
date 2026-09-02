import { SITE_ORIGIN } from "../../shared/site-origin";
import { NAME_RE } from "../limits";
import { RESERVED_NAMES } from "./inbox";

/**
 * The URL model (PRD 1.2 / 6.1). A link is a name and a path, and the name is
 * the subdomain:
 *
 *   ryan.stolnk.com/client-a   name "ryan",  slug "client-a"
 *   ryan.stolnk.com            not an address — every link carries a path
 *   stolnk.com                 the marketing site, no inbox
 *
 * Everything that knows what an address looks like lives here. `SITE_ORIGIN`
 * carries scheme and port, so `localhost:5173` in dev and `stolnk.com` in
 * production take exactly the same code path.
 */

export function site(): { scheme: string; host: string; hostname: string } {
	const url = new URL(SITE_ORIGIN);
	return { scheme: url.protocol.slice(0, -1), host: url.host, hostname: url.hostname };
}

/**
 * The inbox name this request was addressed to, or null for the apex, an
 * unrelated host, or a label that could never have been handed out.
 *
 * Deliberately total: a malformed host is a miss, not an error. Callers answer
 * every miss with the same delayed 404 (PRD 13.1), so no distinction here can
 * leak which names exist.
 *
 * Only one label deep. `a.b.stolnk.com` is rejected — `NAME_RE` has no dot —
 * and that is not fastidiousness: Cloudflare's Universal SSL covers
 * `*.stolnk.com` but nothing below it, so a nested name would have no
 * certificate at all.
 */
export function nameFromHost(requestUrl: string): string | null {
	const base = site().hostname;

	// A trailing dot is a legal FQDN and would otherwise slip past the suffix
	// test: `ryan.stolnk.com.` is the same host as `ryan.stolnk.com`.
	const hostname = new URL(requestUrl).hostname.toLowerCase().replace(/\.$/, "");

	if (hostname === base) return null;
	if (!hostname.endsWith(`.${base}`)) return null;

	const label = hostname.slice(0, -(base.length + 1));
	if (!NAME_RE.test(label)) return null;
	if (RESERVED_NAMES.has(label)) return null;
	return label;
}

/** The public address of an inbox. `host` carries the port, so dev works unchanged. */
export function inboxUrl(name: string, slug: string): string {
	const { scheme, host } = site();
	return `${scheme}://${name}.${host}/${slug}`;
}
