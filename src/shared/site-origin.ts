/**
 * The apex origin the site is served from. Every URL in the product is built
 * from it: an inbox lives at `<name>.<this host>/<slug>`.
 *
 * Deliberately not an environment variable or a Worker binding. It is not a
 * secret, it never varies between two deploys of the same environment, and both
 * halves of the app need it — the browser bundle cannot read a binding, so as a
 * binding it needed a second copy baked in by `vite.config.ts`, and nothing
 * stopped the two from disagreeing. One constant, imported by both.
 */

export const PRODUCTION_SITE_ORIGIN = "https://stolnk.com";

/**
 * `*.localhost` resolves to loopback with no `/etc/hosts` entry, so an inbox is
 * reachable at `http://ryan.localhost:5173` in development. `vite.config.ts`
 * pins the dev server to this port: inbox links carry it, so drifting to 5174
 * would hand out dead links.
 */
export const DEVELOPMENT_SITE_ORIGIN = "http://localhost:5173";

/**
 * Vite replaces `import.meta.env.DEV` at build time in the Worker bundle and the
 * browser bundle alike, so this collapses to one literal in each. The optional
 * chain covers `vite.config.ts`, which runs in plain Node with no `import.meta.env`
 * and only ever reads the two constants above.
 */
export const SITE_ORIGIN = import.meta.env?.DEV
	? DEVELOPMENT_SITE_ORIGIN
	: PRODUCTION_SITE_ORIGIN;
