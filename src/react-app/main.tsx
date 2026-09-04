import { StrictMode, Suspense, lazy } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { SendPage } from "./send/SendPage.tsx";
import { SITE_ORIGIN } from "../shared/site-origin";

/**
 * Routing by hand rather than with a router dependency.
 *
 * The hostname decides which of two sites this is. On the apex there are a
 * handful of fixed marketing pages and nothing else; on `<name>.stolnk.com`
 * every path is an inbox address (PRD 1.2) — including `/how-it-works`, which
 * is a perfectly ordinary slug there. That split is exactly the shape a router
 * is worst at, and keeping the dependency out keeps the send page's bundle
 * small enough to be worth auditing (PRD 9.4).
 *
 * Names that would shadow one of our own hostnames are reserved server-side in
 * `worker/lib/inbox.ts`.
 */
function inboxName(): string | null {
	const base = new URL(SITE_ORIGIN).hostname;
	const host = location.hostname;
	if (host === base || host === `www.${base}`) return null;
	if (!host.endsWith(`.${base}`)) return null;
	return host.slice(0, -(base.length + 1));
}

/**
 * The same PRD 9.4 argument, one step further: the marketing pages carry two
 * languages of copy and a page's worth of sections that the send page has no
 * use for. `SendPage` stays a static import because it is the latency-sensitive
 * half; the apex can afford a second round trip.
 */
const Marketing = lazy(() =>
	import("./landing/Marketing.tsx").then((module) => ({ default: module.Marketing })),
);

function Root() {
	const path = location.pathname.replace(/^\/+|\/+$/g, "");

	// An unknown or malformed subdomain needs no special case: resolve answers
	// 404 and the send page already knows how to say so.
	if (inboxName() !== null) return <SendPage slug={path} />;

	// No fallback: the chunk resolves in a frame or two on a warm cache, and a
	// spinner that flashes for one frame is worse than nothing appearing yet.
	return (
		<Suspense fallback={null}>
			<Marketing path={path} />
		</Suspense>
	);
}

createRoot(document.getElementById("root")!).render(
	<StrictMode>
		<Root />
	</StrictMode>,
);
