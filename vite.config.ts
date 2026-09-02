import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { cloudflare } from "@cloudflare/vite-plugin";
import { DEVELOPMENT_SITE_ORIGIN } from "./src/shared/site-origin";

export default defineConfig({
	plugins: [react(), cloudflare()],
	server: {
		// Inbox links carry this port, so it must not drift to 5174 when another
		// dev server is already up: fail loudly instead of handing out dead links.
		// The Worker and the browser bundle both read the origin straight from
		// src/shared/site-origin.ts, so this is the only place that needs the
		// number, and it cannot disagree with the links being handed out.
		port: Number(new URL(DEVELOPMENT_SITE_ORIGIN).port) || 5173,
		strictPort: true,
	},
});
