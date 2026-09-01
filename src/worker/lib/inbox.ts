import { NAME_RE, SLUG_RE, tierForDevice } from "../limits";
import { randomId } from "./bytes";
import { badRequest } from "./http";

/**
 * Inbox storage and the name/slug grammar. The address model itself lives in
 * `site.ts`; this file is what the database knows.
 *
 * A name belongs to exactly one device and a device has exactly one name
 * (`devices.name` is UNIQUE), so an inbox stores only its path. Global
 * uniqueness of (name, path) follows from that plus `idx_inboxes_path`, with no
 * second copy of the name to keep in sync.
 *
 * Every inbox has a path. There is no bare-subdomain address: the name says
 * whose Mac it is, the path says which folder, and a link has to answer both.
 */

/**
 * Labels a user may not take as a name. Everything here would either collide
 * with our own hostnames or make a convincing lure — `localhost.stolnk.com` is
 * a classic. Names shorter than three characters are already excluded by
 * `NAME_RE`, which is why `ns`, `mx` and `go` need no entry.
 */
export const RESERVED_NAMES = new Set([
	"account", "admin", "alpha", "api", "app", "assets", "auth", "autoconfig",
	"autodiscover", "beta", "billing", "blog", "cdn", "dashboard", "demo", "dev",
	"dns", "docs", "download", "email", "ftp", "help", "how-it-works", "imap",
	"internal", "localhost", "login", "mail", "media", "mta-sts", "mx1", "mx2",
	"ns1", "ns2", "ns3", "pop", "pop3", "preview", "pricing", "privacy", "relay",
	"sandbox", "secure", "settings", "signin", "signup", "smtp", "sso", "staging",
	"static", "status", "support", "terms", "test", "vpn", "webmail", "www",
]);

/**
 * First path segments a slug may not take. Under the old path-based model these
 * were protected as *names*; now that the name is the host, the first path
 * segment sits directly under the API and the built assets, both of which the
 * platform serves on every hostname.
 */
const RESERVED_SLUG_HEADS = new Set(["api", "assets"]);

export interface InboxRow {
	inbox_id: string;
	owner_device_id: string;
	path_slug: string;
	display_name: string;
	password_salt: string | null;
	password_verifier_hash: string | null;
	size_limit: number;
	paused: number;
	confirm_first: number;
	created_at: number;
}

export type NameProblem = "invalid" | "reserved";

/** The reason this name cannot be used, or null. Never throws. */
export function nameProblem(raw: string): NameProblem | null {
	const name = raw.trim().toLowerCase();
	if (!NAME_RE.test(name)) return "invalid";
	// RFC 5891's reserved LDH form. One line, and it takes `xn--` punycode
	// homographs with it.
	if (name.slice(2, 4) === "--") return "invalid";
	if (RESERVED_NAMES.has(name)) return "reserved";
	return null;
}

export function validateName(raw: string): string {
	const name = raw.trim().toLowerCase();
	switch (nameProblem(name)) {
		case "invalid":
			return badRequest(
				"A name is 3–20 characters of a–z, 0–9 and hyphens, and cannot start or end with one.",
			);
		case "reserved":
			return badRequest("That name is reserved.");
		default:
			return name;
	}
}

/** Every link needs a path, so an absent or empty one is a client error. */
export function requireSlug(value: unknown): string {
	if (typeof value !== "string") return badRequest('Missing "slug".');
	const trimmed = value.trim();
	if (trimmed.length === 0) return badRequest("An inbox needs a path.");
	if (trimmed.length > 128) return badRequest('"slug" is too long.');
	return validateSlug(trimmed);
}

export function validateSlug(slug: string): string {
	const normalised = slug.trim().toLowerCase();
	const segments = normalised.split("/");
	if (segments.length > 3) return badRequest("An inbox path can be at most three segments deep.");
	for (const segment of segments) {
		if (!SLUG_RE.test(segment)) {
			return badRequest("Inbox path segments use a–z, 0–9 and hyphens.");
		}
	}
	if (RESERVED_SLUG_HEADS.has(segments[0])) {
		return badRequest(`An inbox path cannot start with "${segments[0]}".`);
	}
	return normalised;
}

/** The name this device holds. Every device has exactly one. */
export async function deviceName(env: Env, deviceId: string): Promise<string | null> {
	const row = await env.DB.prepare("SELECT name FROM devices WHERE device_id = ?")
		.bind(deviceId)
		.first<{ name: string }>();
	return row?.name ?? null;
}

/** Resolves an address. Two unique indexes, one join, no denormalised name. */
export async function findInbox(
	env: Env,
	name: string,
	slug: string,
): Promise<InboxRow | null> {
	return env.DB.prepare(
		`SELECT i.* FROM inboxes i
		 JOIN devices d ON d.device_id = i.owner_device_id
		 WHERE d.name = ? AND i.path_slug = ?`,
	)
		.bind(name, slug)
		.first<InboxRow>();
}

export interface NewInbox {
	deviceId: string;
	slug: string;
	displayName: string;
}

/**
 * Builds the row and the statement that writes it, without running either.
 * Registration needs the insert inside a batch with the device it belongs to,
 * so that a device can never exist without its root inbox.
 */
export function inboxInsert(
	env: Env,
	options: NewInbox,
): { row: InboxRow; stmt: D1PreparedStatement } {
	const tier = tierForDevice(options.deviceId);
	const row: InboxRow = {
		inbox_id: randomId(),
		owner_device_id: options.deviceId,
		path_slug: options.slug,
		display_name: options.displayName,
		password_salt: null,
		password_verifier_hash: null,
		size_limit: tier.maxFileSize,
		paused: 0,
		// Every name is guessable by construction now (PRD 13.1), so the
		// first-receive prompt is load-bearing for everyone. Settings can still
		// turn it off deliberately; nothing turns it off implicitly.
		confirm_first: 1,
		created_at: Date.now(),
	};
	const stmt = env.DB.prepare(
		`INSERT INTO inboxes (inbox_id, owner_device_id, path_slug, display_name,
		                      size_limit, paused, confirm_first, created_at)
		 VALUES (?, ?, ?, ?, ?, 0, 1, ?)`,
	).bind(
		row.inbox_id,
		row.owner_device_id,
		row.path_slug,
		row.display_name,
		row.size_limit,
		row.created_at,
	);
	return { row, stmt };
}

export async function createInbox(env: Env, options: NewInbox): Promise<InboxRow> {
	const { row, stmt } = inboxInsert(env, options);
	await stmt.run();
	return row;
}
