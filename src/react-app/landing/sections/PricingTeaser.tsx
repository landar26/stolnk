import { APP_STORE_URL } from "../contact.ts";
import { useLang } from "../lang-context.ts";

/**
 * The plan card, and nothing else. The numbers that matter — allowances and
 * limits — stay on `/pricing`, so there is one place for them to be right.
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

				<div className="plans single">
					<div className="plan featured">
						<h3>{pricing.planName}</h3>
						<p className="price">{pricing.price}</p>
						<p className="plan-note">{pricing.planNote}</p>
						<a className="button primary" href={APP_STORE_URL}>
							{pricing.cta}
						</a>
						<small>
							<a href="/pricing">{t.pricingTeaser.more}</a>
						</small>
					</div>
				</div>
			</div>
		</section>
	);
}
