/** PRD 21 — the landing page. */
export function Landing() {
	return (
		<>
			<section className="hero">
				<h1>Turn your folders into inboxes.</h1>
				<p>
					Share a link. Anyone can send you files — no account, no app. They land in the
					right folder on your Mac, even when it's asleep.
				</p>
				<a href="/download">
					<button className="primary">Download for Mac</button>
				</a>
				<small>Free to start · macOS 13+</small>
			</section>

			<section className="panel">
				<div className="page wide">
					<div className="routing">
						{"ryan.stolnk.com/client-a\n           │\n           ▼\n"}
						<b>~/Projects/ClientA/Incoming</b>
					</div>
					<h2>One link per folder.</h2>
					<p>
						Give your client a link, your photographer another one. Everything arrives
						exactly where it belongs.
					</p>
				</div>
			</section>

			<section className="panel">
				<div className="page wide">
					<h2>Encrypted in the browser. Only your Mac can open it.</h2>
					<p>
						We route your files. We can't read them — not in transit, not at rest. Your
						Mac's keys are generated in its Secure Enclave and cannot be exported.
					</p>
					<p>
						<a href="/how-it-works">How it works →</a>
					</p>
				</div>
			</section>

			<section className="panel">
				<div className="page wide">
					<h2>Ten seconds to see it work</h2>
					<ol className="steps">
						<li>
							<b>Open the menu bar item</b> — a QR code appears.
						</li>
						<li>
							<b>Scan it with your phone</b> and pick a 4K video.
						</li>
						<li>
							<b>Watch it arrive</b> — a notification, and Finder opens.
						</li>
						<li>
							<b>Close your Mac's lid</b> and send another one.
						</li>
						<li>
							The sender is told: <b>"Will be delivered when it wakes."</b>
						</li>
						<li>
							<b>Open your Mac.</b> The file is already in the folder.
						</li>
					</ol>
					<p style={{ marginTop: 16 }}>
						The last two steps are the ones no free alternative can do.
					</p>
				</div>
			</section>

			<section className="panel">
				<div className="page wide">
					<h2>Paid once, not monthly.</h2>
					<p>
						Free covers one inbox and 3 GB of relayed files a month. Pro is $39 — one
						payment, three Macs, as many inboxes as you want, and 300 GB a month.
					</p>
					<p>
						<a href="/pricing">See what's included →</a>
					</p>
				</div>
			</section>

			<footer className="footer">
				Stolnk · <a href="/how-it-works">How it works</a> · <a href="/pricing">Pricing</a>
			</footer>
		</>
	);
}
