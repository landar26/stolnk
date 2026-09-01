import { readFileSync } from "node:fs";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { cloudflare } from "@cloudflare/vite-plugin";

/**
 * The apex origin, declared once for the whole repo in `wrangler.json` and
 * overridden for local dev in `.dev.vars`. The client needs it to tell an inbox
 * subdomain from the marketing site, and it cannot read a Worker binding, so it
 * is baked in at build time.
 */
function siteOrigin(isDev: boolean): string {
	// A build always takes the production value. Reading `.dev.vars` here too
	// would bake localhost into a deployed bundle on any machine that has one,
	// and the failure is silent: every real visitor's page would decide it was
	// not on an inbox subdomain and render the marketing 404.
	if (isDev) {
		try {
			const dev = readFileSync("./.dev.vars", "utf8").match(
				/^PUBLIC_SITE_ORIGIN\s*=\s*"?([^"\n]+)"?/m,
			);
			if (dev) return dev[1];
		} catch {
			// No .dev.vars — fall through to wrangler.json.
		}
	}
	const wrangler = JSON.parse(readFileSync("./wrangler.json", "utf8")) as {
		vars: { PUBLIC_SITE_ORIGIN: string };
	};
	return wrangler.vars.PUBLIC_SITE_ORIGIN;
}

export default defineConfig(({ command }) => {
	const origin = siteOrigin(command === "serve");
	return {
		plugins: [react(), cloudflare()],
		define: { __SITE_ORIGIN__: JSON.stringify(origin) },
		server: {
			// Inbox links carry this port, so it must not drift to 5174 when another
			// dev server is already up: fail loudly instead of handing out dead links.
			port: Number(new URL(origin).port) || 5173,
			strictPort: true,
		},
	};
});
