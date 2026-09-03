/**
 * PRD 16.1 — the price list.
 *
 * Two rules from PRD 16.3 shape every line of copy here, and both are honesty
 * constraints rather than marketing ones:
 *
 *  1. **The word "unlimited" does not appear.** What is sold is a perpetual
 *     licence, every V1.x update, and 300 GB of relay a month — a number the
 *     cost model in PRD 8.6 can honour forever. A "lifetime everything" that
 *     later has to be walked back is the standard way this kind of product
 *     breaks its word.
 *  2. **Nothing is listed that does not exist yet.** Link expiry and delivery
 *     webhooks are on the V1.1 roadmap, so they appear under what the purchase
 *     will grow into, not as a row in the table someone is paying for today.
 *
 *     Password protection is the awkward one. PRD 16.1 lists it as a headline
 *     Pro capability and the server enforces it as one — but the Mac app can
 *     only display that a link has a password, not set it, so a buyer today
 *     cannot switch it on. It sits below with the roadmap items until that UI
 *     exists, at which point it moves up into the table.
 *
 * The free column is likewise stated as what it is. PRD 16.2 argued the free
 * tier could be generous because LAN direct costs nothing to serve — but LAN
 * direct (M4) is not in V1, so free means 3 GB of relay a month and the page
 * says exactly that.
 */

const rows: Array<{ label: string; free: string; pro: string }> = [
	{ label: "Inboxes", free: "1", pro: "As many as you like" },
	{ label: "Relayed files", free: "3 GB / month", pro: "300 GB / month" },
	{ label: "Largest single file", free: "2 GB", pro: "20 GB" },
	{ label: "Held while your Mac sleeps", free: "24 hours", pro: "7 days" },
	{ label: "Macs", free: "1", pro: "3" },
	{ label: "Updates", free: "All of V1.x", pro: "All of V1.x" },
];

export function Pricing() {
	return (
		<main className="page prose">
			<h1 className="inbox-title">One price. Paid once.</h1>
			<p>
				Stolnk is a one-time purchase from a single developer. There is no subscription,
				and no plan that expires.
			</p>

			<div className="plans">
				<div className="plan">
					<h2>Free</h2>
					<p className="price">$0</p>
					<p className="plan-note">
						One inbox and 3 GB of relayed files a month. Enough to use properly, and
						enough to see your Mac collect something it slept through.
					</p>
					<a className="button" href="/download">
						Download for Mac
					</a>
				</div>

				<div className="plan featured">
					<h2>Pro</h2>
					<p className="price">
						$29 <s>$39</s>
					</p>
					<p className="plan-note">
						Launch price for the first 500. After that it is $39 — the long-term price,
						not a discount that comes back.
					</p>
					<a className="button primary" href="/api/v1/checkout">
						Buy Stolnk Pro
					</a>
					<small>One payment. Yours permanently.</small>
				</div>
			</div>

			<table className="compare">
				<thead>
					<tr>
						<th />
						<th>Free</th>
						<th>Pro</th>
					</tr>
				</thead>
				<tbody>
					{rows.map((row) => (
						<tr key={row.label}>
							<th scope="row">{row.label}</th>
							<td>{row.free}</td>
							<td>{row.pro}</td>
						</tr>
					))}
				</tbody>
			</table>

			<h2>What "paid once" actually covers</h2>
			<p>
				Being precise about this matters more than it sounds. A perpetual promise that
				cannot be kept is worse than a smaller one that can, so here is the whole of it:
			</p>
			<ul>
				<li>A permanent licence to the software, on up to 3 Macs.</li>
				<li>Every V1.x update.</li>
				<li>300 GB of relayed files per month, for as long as Stolnk runs.</li>
			</ul>
			<p>
				That is a number rather than the word "unlimited" on purpose. Relaying costs real
				money per gigabyte, and 300 GB a month is an amount a one-time payment can carry
				indefinitely. If Stolnk ever reaches a V2 with genuinely new capabilities, it will
				be a paid upgrade at half price — and your V1 licence and allowance keep working
				whether or not you take it.
			</p>

			<h2>Running out</h2>
			<p>
				Nothing is ever billed on top, and your inbox never goes down. If a month's
				allowance runs out, links stop accepting new files and start again when the month
				turns over. You will not get a surprise invoice, because there is no mechanism in
				Stolnk that could produce one.
			</p>

			<h2>Coming in V1.x, included</h2>
			<p>
				These are not built yet, so they are not part of what the table above promises
				today: turning on a password for a link, expiring and single-use links, a webhook
				when a file lands, and dropping a whole folder into the send page.
			</p>

			<h2>Refunds and support</h2>
			<p>
				14 days, no questions — email and it is done. Support is email only and
				best-effort: Stolnk is one person, and promising more than that would be another
				thing that could not be kept.
			</p>

			<footer className="footer" style={{ marginTop: 48 }}>
				<a href="/">← Back</a>
			</footer>
		</main>
	);
}
