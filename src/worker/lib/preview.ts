import { nameFromHost } from "./site";

/**
 * Link previews for the send page.
 *
 * `index.html` carries one set of Open Graph tags, and they are written for the
 * apex: someone deciding whether to install Stolnk. An inbox address is read by
 * the opposite person — a stranger who was handed `ryan.stolnk.com/client-a` in
 * a chat and is deciding whether it is safe to click. Serving them "Turn your
 * folders into inboxes" describes a product they are not being offered.
 *
 * Both pages are the same bundle, so the difference has to be made here.
 *
 * **No database read.** The host alone decides, which is what keeps this off
 * the cost curve: every unfurl a shared link produces would otherwise be a D1
 * query, and a link pasted into a busy channel is unfurled once per viewer. The
 * price of that is the copy below cannot name the inbox — the tab title picks
 * that up client-side once `/api/v1/resolve` has answered.
 */

const TITLE = "Send files — Stolnk";
const DESCRIPTION =
	"Drop files here and they go straight to a folder on the recipient's Mac. Encrypted in your browser — no account, no app, nothing to install.";
/*
 * Absolute, and hardcoded to the apex rather than built from `SITE_ORIGIN`.
 * A crawler resolves `og:image` with no page to be relative to, so it cannot be
 * a path — and pointing it at the inbox's own subdomain would have every name
 * serve its own copy of one shared image. `index.html` carries the apex twin of
 * this for the same reason, and being static it cannot import the constant at
 * all; if `PRODUCTION_SITE_ORIGIN` moves, both move with it.
 */
const IMAGE = "https://stolnk.com/og-send.png";
const IMAGE_ALT = "Stolnk — your files go to the folder they chose, encrypted in your browser";
const SHARE_TITLE = "Download a shared file — Stolnk";
const SHARE_DESCRIPTION = "A file was shared with you through Stolnk. Open the link to see its availability and download it.";
const SHARE_IMAGE = "https://stolnk.com/og-share.png";
const SHARE_IMAGE_ALT = "A file shared through Stolnk";

export function isInboxHost(requestUrl: string): boolean {
	return nameFromHost(requestUrl) !== null;
}

/**
 * Swap the apex's preview tags for the send page's.
 *
 * Only `text/html` is touched. Under `run_worker_first` this handler sees the
 * hashed bundle and the icon too, and an HTMLRewriter pointed at a PNG is both
 * pointless and a way to corrupt one.
 */
export function rewriteInboxPreview(response: Response, requestUrl: string): Response {
	if (!response.headers.get("content-type")?.includes("text/html")) return response;

	const url = new URL(requestUrl);
	// Percent-encoded already, and `setAttribute` escapes on top of that — but the
	// query string is dropped regardless. It carries `?via=`, which is the
	// sender's own attribution and has no business in a canonical URL.
	const canonical = `${url.origin}${url.pathname}`;
	const isShare = url.pathname.startsWith("/~");
	const title = isShare ? SHARE_TITLE : TITLE;
	const description = isShare ? SHARE_DESCRIPTION : DESCRIPTION;
	const image = isShare ? SHARE_IMAGE : IMAGE;
	const imageAlt = isShare ? SHARE_IMAGE_ALT : IMAGE_ALT;

	const content = (value: string) => ({
		element(element: { setAttribute(name: string, value: string): void }) {
			element.setAttribute("content", value);
		},
	});

	return new HTMLRewriter()
		.on("title", {
			element(element) {
				element.setInnerContent(title);
			},
		})
		.on('meta[name="description"]', content(description))
		.on('meta[property="og:title"]', content(title))
		.on('meta[property="og:description"]', content(description))
		.on('meta[property="og:url"]', content(canonical))
		.on('meta[property="og:image"]', content(image))
		.on('meta[property="og:image:alt"]', content(imageAlt))
		.on('meta[name="twitter:title"]', content(title))
		.on('meta[name="twitter:description"]', content(description))
		.on('meta[name="twitter:image"]', content(image))
		.transform(response);
}
