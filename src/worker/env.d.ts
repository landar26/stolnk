/**
 * Secrets that `wrangler types` cannot see.
 *
 * `worker-configuration.d.ts` is generated from wrangler.json, and secrets are
 * deliberately not in wrangler.json — so they are declared here by merging into
 * the same global `Env`. Regenerating the types does not clobber this file.
 *
 * They are set with `npm run secrets:push`; `npm run secrets:check` reports
 * what production is missing. The APPLE_ ones were only covered by that claim
 * from the change that added `APPLE_NOTIFICATION_SECRET` — before it, the
 * script's arrays were Creem-only and `check` reported all green while every
 * transaction lookup 503'd on an unset key.
 */
interface Env {
	/** App Store Server API key used only to validate iOS transactions. */
	APPLE_KEY_ID: string;
	APPLE_ISSUER_ID: string;
	APPLE_PRIVATE_KEY: string;
	/**
	 * Optional. Shared secret carried in the notification URL's last path
	 * segment. A noise gate, not a boundary — see `routes/webhooks-apple.ts`.
	 */
	APPLE_NOTIFICATION_SECRET?: string;
	/** Optional. Points transaction lookups at a stub. Development only. */
	APPLE_API_BASE?: string;
	/**
	 * Optional. Enables the operator console at /admin and /api/v1/admin/*.
	 * Unset — or shorter than 24 characters — and every one of those paths
	 * answers 404, so an unconfigured deployment exposes no login at all.
	 */
	ADMIN_TOKEN?: string;
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
