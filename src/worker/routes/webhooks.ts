import { Hono } from "hono";
import { PRO_SEATS } from "../limits";
import { keyHash, signatureValid } from "../lib/creem";
import { type AppEnv } from "../lib/http";
import {
	licenseRevoked,
	licenseRevokeUnmatched,
	paymentEvent,
	type PaymentOutcome,
} from "../lib/metrics";
import { beginEvent, finishEvent } from "../lib/payment-events";
import {
	applyPurchaseStatus,
	findByRef,
	findPurchase,
	setStatus,
	upsertPurchase,
} from "../lib/purchases";
import { appleNotificationRoute } from "./webhooks-apple";

/**
 * Creem's side of the conversation (PRD 16.5).
 *
 * Two events matter. `checkout.completed` records a licence before anyone has
 * activated it, so the row exists the moment the money does. `refund.created`
 * is the one that takes capabilities away, and it is the reason revocation is
 * push rather than poll: a refunded user should stop being Pro in seconds, not
 * at the next daily sweep.
 *
 * The two are not symmetric, and that asymmetry shapes this file. Only the
 * checkout event carries the licence key; a refund carries an order, a
 * checkout, a transaction and a customer, and no key at all. Since `purchases`
 * stores an unrecoverable hash of the key, a refund can only find its row
 * through an identifier written down at purchase (`order_ref`, `checkout_ref`),
 * which is why the checkout branch below writes more than it needs to.
 *
 * This route is unauthenticated by necessity — Creem has no device session — so
 * the signature *is* the authentication. Everything below the check treats the
 * body as trusted; nothing above it writes anything.
 */
export const webhooks = new Hono<AppEnv>();

// Apple's half lives in its own file: its trust model is the inverse of the one
// documented above (the signature is authentication here; there, the body is
// only a hint), and mixing the two doc comments would blur both.
webhooks.post("/apple/:secret", appleNotificationRoute);
webhooks.post("/apple", appleNotificationRoute);

interface CreemEvent {
	id?: unknown;
	eventType?: string;
	type?: string;
	object?: Record<string, unknown>;
	data?: Record<string, unknown>;
}

/** Creem writes nested resources either inline or as a bare id string. */
function idOf(value: unknown): string | null {
	if (typeof value === "string") return value || null;
	if (value && typeof value === "object") {
		const id = (value as { id?: unknown }).id;
		if (typeof id === "string") return id || null;
	}
	return null;
}

function containersOf(event: CreemEvent): Record<string, unknown>[] {
	return [event.object, event.data].filter(Boolean) as Record<string, unknown>[];
}

/**
 * Creem has moved the licence key around between payload shapes. Current
 * checkout objects expose it in `license_keys`; `feature[].license_key` is the
 * deprecated predecessor, and the direct forms are retained for older events.
 */
function licenseKeyOf(event: CreemEvent): string | null {
	for (const container of containersOf(event)) {
		const direct = container.key ?? container.license_key;
		if (typeof direct === "string") return direct;
		const nested = container.license as { key?: unknown } | undefined;
		if (nested && typeof nested.key === "string") return nested.key;

		const licenseKeys = container.license_keys;
		if (Array.isArray(licenseKeys)) {
			for (const license of licenseKeys) {
				if (
					license &&
					typeof license === "object" &&
					typeof (license as { key?: unknown }).key === "string"
				) {
					return (license as { key: string }).key;
				}
			}
		}

		const features = container.feature;
		if (Array.isArray(features)) {
			for (const feature of features) {
				if (!feature || typeof feature !== "object") continue;
				const legacy = (feature as { license_key?: { key?: unknown } }).license_key;
				if (legacy && typeof legacy.key === "string") return legacy.key;
			}
		}
	}
	return null;
}

/** The first entry of `license_keys`, which is where seats and Creem's own id live. */
function licenseObjectOf(event: CreemEvent): { id?: unknown; activation_limit?: unknown } | null {
	for (const container of containersOf(event)) {
		const licenseKeys = container.license_keys;
		if (Array.isArray(licenseKeys)) {
			for (const license of licenseKeys) {
				if (license && typeof license === "object") return license;
			}
		}
	}
	return null;
}

interface CreemIds {
	order: string | null;
	checkout: string | null;
	customer: string | null;
}

/**
 * The identifiers a refund and its originating checkout have in common.
 *
 * On `checkout.completed` the payload object *is* the checkout, so its own `id`
 * is the checkout id; on `refund.created` the checkout sits one level down. Both
 * carry `order` and `customer`. Taking the container's own id only when it
 * carries no nested `checkout` is what keeps the two shapes from disagreeing.
 */
function creemIdsOf(event: CreemEvent): CreemIds {
	const ids: CreemIds = { order: null, checkout: null, customer: null };
	for (const container of containersOf(event)) {
		ids.order ??= idOf(container.order);
		ids.checkout ??= idOf(container.checkout) ?? idOf(container.id);
		ids.customer ??= idOf(container.customer);
	}
	return ids;
}

webhooks.post("/creem", async (c) => {
	// Raw text, before any parsing: the signature covers the bytes that arrived,
	// not a re-serialisation of them.
	const raw = await c.req.text();
	const signature = c.req.header("creem-signature");
	if (!(await signatureValid(c.env.CREEM_WEBHOOK_SECRET, raw, signature ?? null))) {
		// No detail, and nothing written. An unsigned caller learns only that it
		// was rejected.
		return c.json({ error: "bad_signature" }, 401);
	}

	let event: CreemEvent;
	try {
		event = JSON.parse(raw) as CreemEvent;
	} catch {
		return c.json({ error: "bad_json" }, 400);
	}

	const kind = event.eventType ?? event.type ?? "";
	const key = licenseKeyOf(event);
	const ids = creemIdsOf(event);
	const eventId = typeof event.id === "string" && event.id ? event.id : null;

	const fresh = await beginEvent(c.env, {
		provider: "creem",
		eventId,
		type: kind || "unknown",
		subtype: null,
		externalRef: ids.order ?? ids.checkout,
		payload: raw,
	});
	if (!fresh) {
		paymentEvent({ provider: "creem", type: kind, subtype: null, outcome: "duplicate", external_ref: ids.order, devices: 0 });
		return c.json({ ok: true, ignored: "duplicate" });
	}

	/** Records how this ended, and answers Creem. */
	const done = async (outcome: PaymentOutcome, body: Record<string, unknown>, devices = 0) => {
		await finishEvent(c.env, "creem", eventId, "ok", outcome);
		paymentEvent({ provider: "creem", type: kind, subtype: null, outcome, external_ref: ids.order, devices });
		return c.json({ ok: true, ...body });
	};

	try {
		return await handle();
	} catch (error) {
		// Stamped before rethrowing, so the 500 earns a retry that `beginEvent`
		// will actually let through.
		await finishEvent(
			c.env,
			"creem",
			eventId,
			"error",
			"failed",
			error instanceof Error ? error.message : String(error),
		);
		paymentEvent({ provider: "creem", type: kind, subtype: null, outcome: "failed", external_ref: ids.order, devices: 0 });
		throw error;
	}

	async function handle() {
		const now = Date.now();

		if (kind.startsWith("checkout.completed") || kind.startsWith("license.created")) {
			// 200 on an event with no key. A non-2xx makes Creem retry with backoff
			// forever over something that will never succeed.
			if (!key) return done("ignored", { ignored: kind });
			const license = licenseObjectOf(event);
			// Creem's activation limit is the authority on seats — the price list says
			// three Macs, but the product's own setting is what will actually be
			// enforced when the Mac calls activate, so record that rather than our copy.
			const seats =
				typeof license?.activation_limit === "number" ? license.activation_limit : PRO_SEATS;
			const licenseId = typeof license?.id === "string" ? license.id : null;

			await upsertPurchase(c.env, "creem", await keyHash(key), {
				status: "active",
				seats,
				orderRef: ids.order,
				checkoutRef: ids.checkout,
				customerRef: ids.customer,
				metadata: licenseId ? { license_id: licenseId } : {},
				purchasedAt: now,
				verifiedAt: now,
			});
			return done("recorded", {});
		}

		if (kind.startsWith("refund") || kind.startsWith("dispute") || kind.includes("revoked")) {
			// The key first, for the shapes that still carry one, then the order the
			// licence was sold under.
			const purchase = key
				? await findPurchase(c.env, "creem", await keyHash(key))
				: await findByRef(c.env, "creem", ids);
			if (!purchase) {
				licenseRevokeUnmatched({ reason: kind, order_id: ids.order, checkout_id: ids.checkout });
				return done("unmatched", { ignored: kind });
			}

			await setStatus(c.env, purchase.purchase_id, "refunded", now);
			// Back to the free ceilings unless something else still holds a device
			// up, and inboxes past the free allowance are paused. Paused, never
			// deleted: a refund must not destroy the folders someone routed their
			// work to, and a webhook that fires by mistake must be undoable by
			// buying again.
			// Seats are released too, as Creem does on its side.
			const devices = await applyPurchaseStatus(c.env, purchase.purchase_id, true);

			licenseRevoked({ reason: kind, devices });
			return done("revoked", {}, devices);
		}

		return done("ignored", { ignored: kind });
	}
});
