/**
 * Where Creem sends the buyer after payment (PRD 16.5).
 *
 * This page grants nothing and checks nothing. Creem appends `checkout_id`,
 * `order_id`, `customer_id`, `product_id` and a `signature` to the return URL,
 * and the signature is an HMAC under the API key — which by the argument in
 * `worker/lib/creem.ts` cannot exist in a browser bundle, because a key inside
 * something anyone can download is a public key. So the parameters are not read
 * at all: verifying them here would be theatre, and the real record of the sale
 * arrives independently on the webhook, which is signed with a secret that never
 * leaves the Worker.
 *
 * What is left for this page to do is the thing the buyer actually needs at this
 * moment, which is to know where their licence key is. Creem shows it on its own
 * confirmation page and emails it; neither of those is obvious from here, so the
 * page says both, and says what to do with it.
 */
export function Thanks() {
	return (
		<main className="page prose">
			<h1 className="inbox-title">Thank you — you have Stolnk Pro.</h1>
			<p>
				The payment went through. Your licence key is in the confirmation Creem just showed
				you, and a copy is on its way to the email address you paid with.
			</p>

			<h2>Turning it on</h2>
			<ol>
				<li>
					Open Stolnk from the menu bar and choose <strong>Settings → Licence</strong>.
				</li>
				<li>Paste the key and click Activate.</li>
			</ol>
			<p>
				That is the whole of it — there is no account to create, and nothing to sign in to.
				The key covers up to three Macs, so repeat it on each one; releasing a Mac later
				frees its seat for another.
			</p>

			<p style={{ margin: "24px 0" }}>
				<a className="button primary" href="/download">
					Download for Mac
				</a>
			</p>

			<h2>If the key has not arrived</h2>
			<p>
				Check spam first — it arrives within a minute or two. If it is genuinely missing,
				email and it will be resent; the order exists on Creem's side whether or not the
				message reached you.
			</p>

			<h2>Refunds</h2>
			<p>
				14 days, no questions — email and it is done, exactly as{" "}
				<a href="/pricing">the pricing page</a> says. A refund puts this Mac back on Free and
				pauses any inbox beyond the first. Nothing is deleted, and buying again brings it all
				back as it was.
			</p>

			<footer className="footer" style={{ marginTop: 48 }}>
				<a href="/">← Back</a>
			</footer>
		</main>
	);
}
