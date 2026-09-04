import { useLang } from "./lang-context.ts";

/**
 * The apex 404. Under the path-based model every unmatched path was an inbox
 * address, so there was nothing to say; now inboxes live on their own
 * subdomains and an unknown path on the apex is simply a wrong turn.
 */
export function NotFound() {
	const { t } = useLang();
	const copy = t.pages.notFound;

	return (
		<main className="page prose" id="main">
			<h1 className="inbox-title">{copy.title}</h1>
			{copy.body}
			<p className="page-cta">
				<a href="/">{copy.home}</a>
			</p>
		</main>
	);
}
