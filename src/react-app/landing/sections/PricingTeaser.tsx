import { useLang } from "../lang-context.ts";

/**
 * The two plan cards, and nothing else. The numbers that matter — allowances,
 * limits, what "paid once" covers — stay on `/pricing`, where they are set out
 * with the qualifications PRD 16.3 requires. A summary that repeated them here
 * would be a second place for them to drift.
 */
export function PricingTeaser() {
	const { t } = useLang();
	const pricing = t.pages.pricing;

	return (
		<section className="pricing-teaser" id="pricing">
			<div className="shell">
				<div className="section-head">
					<h2>{t.pricingTeaser.title}</h2>
					<p>{t.pricingTeaser.lede}</p>
				</div>

				<div className="plans">
					<div className="plan">
						<h3>{pricing.freeName}</h3>
						<p className="price">{pricing.freePrice}</p>
						<p className="plan-note">{pricing.freeNote}</p>
						<a className="button" href="/download">
							{pricing.freeCta}
						</a>
					</div>

					<div className="plan featured">
						<h3>{pricing.proName}</h3>
						<p className="price">
							$29 <s>$39</s>
						</p>
						<p className="plan-note">{pricing.proNote}</p>
						<a className="button primary" href="/pricing">
							{t.pricingTeaser.more}
						</a>
						<small>{pricing.proFootnote}</small>
					</div>
				</div>
			</div>
		</section>
	);
}
