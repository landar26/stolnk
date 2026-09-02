/**
 * Secrets that `wrangler types` cannot see.
 *
 * `worker-configuration.d.ts` is generated from wrangler.json, and secrets are
 * deliberately not in wrangler.json — so they are declared here by merging into
 * the same global `Env`. Regenerating the types does not clobber this file.
 *
 * All three are set with `npm run secrets:push`; `npm run secrets:check`
 * reports what production is missing.
 */
interface Env {
	/** Server-side Creem API key. Never leaves the Worker (PRD 16.5). */
	CREEM_API_KEY: string;
	/** Shared secret for verifying the `creem-signature` header on webhooks. */
	CREEM_WEBHOOK_SECRET: string;
	/** The Pro product to send buyers to. */
	CREEM_PRODUCT_ID: string;
	/**
	 * Optional. Limited-run early-bird discount (PRD 16.1, first 500) — the run
	 * length is configured in Creem, not counted here, so selling out needs no
	 * deploy.
	 */
	CREEM_DISCOUNT_CODE?: string;
	/** Optional. Set to Creem's test host to exercise checkout without charging. */
	CREEM_API_BASE?: string;
	/** Optional. Overrides the hosted-checkout URL prefix. */
	CREEM_CHECKOUT_BASE?: string;
}
