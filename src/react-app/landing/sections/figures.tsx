/**
 * The three diagrams on the home page.
 *
 * They are CSS rather than video or screenshots for two reasons. The obvious
 * one is that there is no product footage to ship. The better one is that the
 * `.routing` block already on the site — a monospace address above a monospace
 * path — is the clearest thing the old page had, and these are that block with
 * motion added rather than a different visual language bolted on beside it.
 *
 * Every animation here is switched off under `prefers-reduced-motion`, and each
 * one is written so the *end* state is the readable one: stopped, the diagram
 * still says what it means.
 */

/**
 * Two words in one grid cell, crossfading. Stacking them rather than replacing
 * the text means the box is as wide as the longer of the two from the start, so
 * nothing around the diagram moves as it animates — and stopped, the second word
 * is the one left showing.
 */
function Swap({ before, after }: { before: string; after: string }) {
	return (
		<span className="swap">
			<span className="swap-a">{before}</span>
			<span className="swap-b">{after}</span>
		</span>
	);
}

/** The decorative arrow between two lines of a diagram. */
function Pipe({ short }: { short?: boolean }) {
	return (
		<div className={short ? "figure-pipe short" : "figure-pipe"} aria-hidden="true">
			<span className="figure-dot" />
		</div>
	);
}

export function RoutingFigure({ from, meta, to }: { from: string; meta?: string; to: string }) {
	return (
		<figure className="figure routing-figure">
			<div className="figure-line">{from}</div>
			<Pipe />
			{meta && <div className="figure-meta">{meta}</div>}
			<div className="figure-line figure-target">
				<b>{to}</b>
			</div>
		</figure>
	);
}

export function SleepFigure({
	asleep,
	awake,
	queued,
	landed,
}: {
	asleep: string;
	awake: string;
	queued: string;
	landed: string;
}) {
	const files = ["shoot-0913.mov", "contract.pdf", "cover-v3.psd"];
	return (
		<figure className="figure sleep-figure">
			<div className="sleep-state">
				<span className="dot asleep" aria-hidden="true" />
				<Swap before={asleep} after={awake} />
			</div>
			<ul className="queue">
				{files.map((file, index) => (
					<li className={`queue-item queue-item-${index + 1}`} key={file}>
						<span className="queue-name">{file}</span>
						<span className="queue-state">
							<Swap before={queued} after={landed} />
						</span>
					</li>
				))}
			</ul>
		</figure>
	);
}

export function CryptoFigure({ plain, cipher }: { plain: string; cipher: string }) {
	return (
		<figure className="figure crypto-figure">
			<div className="crypto-panel">
				<Swap before={plain} after={cipher} />
			</div>
			<Pipe short />
			<div className="figure-line figure-target">
				<b>~/Projects/ClientA/Incoming</b>
			</div>
		</figure>
	);
}
