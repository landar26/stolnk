import { Hono } from "hono";
import { notFound, type AppEnv } from "../lib/http";

/**
 * The buy button (PRD 16.1).
 *
 * A redirect rather than an embedded overlay, and that is a security decision
 * before it is a UX one. The CSP in index.ts is `default-src 'self'` with no
 * `frame-src` and `form-action 'none'` — it is the only real mitigation on
 * offer for browser-delivered E2EE (PRD 9.4), and widening it so a payment
 * iframe can load would trade the product's central security claim for a
 * slightly smoother checkout. Sending the buyer to Creem's own page costs one
 * navigation and keeps the policy intact.
 *
 * The early-bird run (first 500, PRD 16.1) is a limited discount code
 * configured in Creem. It sells out on Creem's count, not ours: no counter to
 * get wrong, and no deploy on the day it runs out.
 */
export const checkout = new Hono<AppEnv>();

const DEFAULT_BASE = "https://www.creem.io/payment";

checkout.get("/", (c) => {
	if (!c.env.CREEM_PRODUCT_ID) return notFound("Purchases are not set up on this server.");
	const base = c.env.CREEM_CHECKOUT_BASE || DEFAULT_BASE;
	const url = new URL(`${base}/${c.env.CREEM_PRODUCT_ID}`);
	if (c.env.CREEM_DISCOUNT_CODE) url.searchParams.set("discount_code", c.env.CREEM_DISCOUNT_CODE);
	// 302, not 301: the discount code changes when the early-bird run ends, and a
	// permanent redirect would be cached in browsers past that point.
	return c.redirect(url.toString(), 302);
});
