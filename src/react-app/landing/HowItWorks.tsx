/**
 * PRD 9.4 — the honest description of what this encryption does and does not
 * do.
 *
 * The claims here are deliberately narrower than the marketing temptation.
 * Every web-delivered end-to-end encrypted product shares the limitation in the
 * last section, and saying so plainly is worth more than a phrase like "zero
 * knowledge" that a reader on Hacker News will take apart on launch day.
 */
export function HowItWorks() {
	return (
		<main className="page prose">
			<h1 className="inbox-title">How Stolnk works</h1>
			<p>
				Files are encrypted in the sender's browser and can only be decrypted by your Mac.
				We can't read them — not in transit, not at rest.
			</p>

			<h2>The path a file takes</h2>
			<p>
				When someone opens your link, their browser asks our server for one thing: your
				Mac's public key. It generates a one-time key for the file, encrypts the file with
				it, and wraps that key so that only your Mac's private key can unwrap it.
			</p>
			<p>
				The encrypted bytes are held briefly in object storage. Your Mac collects them, and
				the stored copy is deleted the moment it confirms the file landed. If your Mac is
				asleep, they wait — up to the inbox's expiry — and are delivered when it wakes.
			</p>

			<h2>What the keys are</h2>
			<p>
				Your Mac generates two P-256 keypairs inside its <strong>Secure Enclave</strong> on
				first launch: one to prove its identity to our server, one to unwrap file keys. The
				private halves never enter memory, never touch disk, and cannot be exported — by us,
				by the app, or by anyone with access to the machine's storage.
			</p>
			<p>
				The direct consequence, stated plainly: <strong>keys cannot move to a new Mac.</strong>{" "}
				Setting up a new machine means new keys. Anything still waiting for the old Mac
				becomes undecryptable, so clear your queue before you switch.
			</p>

			<h2>What we can see</h2>
			<p>We store, and can read:</p>
			<ul>
				<li>The size of each file, and when it was sent.</li>
				<li>Which inbox it was addressed to.</li>
				<li>Your Mac's public keys.</li>
			</ul>
			<p>We cannot read:</p>
			<ul>
				<li>File contents.</li>
				<li>
					Filenames — they are encrypted too, though their <em>length</em> can be inferred
					from the ciphertext.
				</li>
				<li>The folder on your Mac a file lands in. We never learn your local paths.</li>
			</ul>

			<h2>The limitation we will not hide</h2>
			<p>
				<strong>
					The encryption runs in JavaScript that we serve. A compromised or malicious
					server could, in principle, serve tampered code that leaks the key.
				</strong>{" "}
				This is inherent to every browser-delivered end-to-end encrypted product, including
				well-regarded ones, and it is worth understanding before you trust any of them with
				something critical.
			</p>
			<p>What we do about it:</p>
			<ul>
				<li>Subresource Integrity on every script the send page loads.</li>
				<li>A strict Content Security Policy with no inline scripts.</li>
				<li>The sending code is open source and auditable.</li>
				<li>
					The Mac app's hash is published on the{" "}
					<a href="/download">download page</a>, so you can check the installer you got is
					the one we shipped. The send page's own scripts are covered by the integrity
					attributes above rather than by that hash.
				</li>
			</ul>
			<p>
				None of that turns the limitation into a guarantee. It narrows it. A file that must
				never be readable by anyone but you should be encrypted before it reaches any
				browser.
			</p>

			<h2>Things we deliberately do not say</h2>
			<p>
				Not "zero knowledge" — we know file sizes and timing. Not "your files never touch
				our servers" — the encrypted bytes do, briefly, and that is exactly what lets them
				arrive while your Mac is asleep. Not "military-grade" — that phrase means nothing.
			</p>

			<footer className="footer" style={{ marginTop: 48 }}>
				<a href="/">← Back</a>
			</footer>
		</main>
	);
}
