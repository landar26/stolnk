/**
 * PRD 19 risk #7 — Gatekeeper friction on first launch is a real drop-off
 * point for a directly distributed app, so the instructions are here from the
 * start rather than buried in a support page after people start emailing.
 */
export function Download() {
	return (
		<main className="page prose">
			<h1 className="inbox-title">Download Stolnk</h1>
			<p>
				macOS 13 or later. Free — one inbox, 3 GB of relayed files a month.{" "}
				<a href="/pricing">Pricing</a>
			</p>

			<p style={{ margin: "24px 0" }}>
				<button className="primary" disabled>
					Download for Mac (not yet released)
				</button>
			</p>

			<h2>Building it yourself</h2>
			<p>Until there is a signed release, build from source:</p>
			<pre className="routing">
				{"cd stolnk_mac\nmake app\nopen build/Stolnk.app"}
			</pre>

			<h2>First launch</h2>
			<p>
				Stolnk is distributed directly rather than through the App Store, because it writes
				to folders you choose anywhere on disk — including external volumes — which the
				sandbox does not allow.
			</p>
			<p>
				Released builds are signed with a Developer ID and notarised by Apple, so they open
				normally. A build you compiled yourself is not, and macOS will refuse it on the
				first try: <strong>right-click the app and choose Open</strong>, then confirm.
			</p>

			<h2>What it does on your Mac</h2>
			<ul>
				<li>Lives in the menu bar. No Dock icon, no window unless you open one.</li>
				<li>Generates its keys in the Secure Enclave on first launch.</li>
				<li>Writes only to the folders you pick.</li>
				<li>
					Marks every received file with <code>com.apple.quarantine</code>, exactly as a
					browser download would.
				</li>
				<li>Does not keep your Mac awake.</li>
			</ul>

			<footer className="footer" style={{ marginTop: 48 }}>
				<a href="/">← Back</a>
			</footer>
		</main>
	);
}
