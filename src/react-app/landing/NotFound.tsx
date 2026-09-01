/**
 * The apex 404. Under the path-based model every unmatched path was an inbox
 * address, so there was nothing to say; now inboxes live on their own
 * subdomains and an unknown path on the apex is simply a wrong turn.
 */
export function NotFound() {
	return (
		<main className="page prose">
			<h1 className="inbox-title">Nothing here</h1>
			<p>
				Inbox links look like <code>ryan.stolnk.com/client-a</code> — a name and a path,
				always both. If you were given one, check it for a typo.
			</p>
			<p style={{ marginTop: 24 }}>
				<a href="/">Stolnk home</a>
			</p>
		</main>
	);
}
