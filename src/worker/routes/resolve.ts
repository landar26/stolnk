import { Hono } from "hono";
import {
	CHUNK_SIZE,
	NOT_FOUND_DELAY_MS,
	PART_SIZE,
	RATE_MAX_RESOLVES,
} from "../limits";
import { hubFor } from "../lib/deviceauth";
import { relayUsed, tierFor } from "../lib/entitlement";
import { clientIp, notFound, sleep, type AppEnv } from "../lib/http";
import { findInbox, requireSlug, type InboxRow } from "../lib/inbox";
import { PBKDF2_ITERATIONS } from "../lib/password";
import { enforce } from "../lib/ratelimit";
import { inboxUrl, nameFromHost } from "../lib/site";

/**
 * The one endpoint the send page needs before it can render. Public and
 * unauthenticated: PRD 4 principle #1 says the sender never needs an account.
 */
export const resolve = new Hono<AppEnv>();

resolve.get("/", async (c) => {
	enforce(`resolve:${clientIp(c)}`, RATE_MAX_RESOLVES);

	// The name is the host this request arrived on. The send page is served from
	// the inbox's own subdomain, so its fetch carries it with no help from the
	// client — and nothing the client says can claim a different name.
	const name = nameFromHost(c.req.url);

	// Uniform delay on every miss, so timing does not leak which names exist
	// (PRD 13.1). A malformed slug is a miss too: a 400 would answer a question
	// the caller is not entitled to ask.
	const miss = async () => {
		await sleep(NOT_FOUND_DELAY_MS);
		return notFound("That inbox does not exist.");
	};
	if (!name) return miss();

	// A bare subdomain is not an address: every link carries a path (PRD 6.2).
	let slug: string;
	try {
		slug = requireSlug(c.req.query("slug"));
	} catch {
		return miss();
	}

	const inbox = await findInbox(c.env, name, slug);
	if (!inbox) return miss();

	const owner = await c.env.DB.prepare("SELECT pubkey_kex FROM devices WHERE device_id = ?")
		.bind(inbox.owner_device_id)
		.first<{ pubkey_kex: string }>();
	if (!owner) return miss();

	const tier = await tierFor(c.env, inbox.owner_device_id);

	// PRD 16.2 — running out of relay does not take the inbox down, so the send
	// page needs to know before it lets someone pick a 4 GB video.
	//
	// A boolean, never the numbers. The sender is a stranger holding a link: how
	// much of their month the owner has spent, and which tier they are on, is
	// none of their business. This endpoint is unauthenticated.
	const relayAvailable = (await relayUsed(c.env, inbox.owner_device_id)) < tier.monthlyRelayBytes;
	let online = false;
	try {
		online = await hubFor(c.env, inbox.owner_device_id).isOnline();
	} catch {
		// Presence is a nicety: when in doubt the send page shows the offline copy,
		// which still accepts files (PRD 11.2).
		online = false;
	}

	return c.json({
		inbox_id: inbox.inbox_id,
		name,
		slug: inbox.path_slug,
		url: inboxUrl(name, inbox.path_slug),
		display_name: inbox.display_name,
		paused: !!inbox.paused,
		online,
		kex_pub: owner.pubkey_kex,
		max_file_size: inbox.size_limit,
		part_size: PART_SIZE,
		chunk_size: CHUNK_SIZE,
		ttl_hours: tier.ttlHours,
		relay_available: relayAvailable,
		password: inbox.password_verifier_hash
			? { required: true, salt: inbox.password_salt, iterations: PBKDF2_ITERATIONS }
			: { required: false },
	} satisfies ResolveResponse);
});

export interface ResolveResponse {
	inbox_id: string;
	name: string;
	slug: string | null;
	url: string;
	display_name: string;
	paused: boolean;
	online: boolean;
	kex_pub: string;
	max_file_size: number;
	part_size: number;
	chunk_size: number;
	ttl_hours: number;
	/** False once the owner's monthly relay allowance is spent (PRD 16.2). */
	relay_available: boolean;
	password: { required: boolean; salt?: string | null; iterations?: number };
}

export type { InboxRow };
