import { useLang } from "./lang-context.ts";
import { CtaBand } from "./sections/CtaBand.tsx";
import { Faq } from "./sections/Faq.tsx";
import { Features } from "./sections/Features.tsx";
import { Hero } from "./sections/Hero.tsx";
import { PricingTeaser } from "./sections/PricingTeaser.tsx";
import { Roadmap } from "./sections/Roadmap.tsx";
import { Scenarios } from "./sections/Scenarios.tsx";
import { Showcase } from "./sections/Showcase.tsx";
import { CryptoFigure, RoutingFigure, SleepFigure } from "./sections/figures.tsx";

/**
 * PRD 21 — the landing page.
 *
 * The order is the argument, and it is deliberately the same one the README
 * makes: an address, then the thing no free alternative does (it arrives while
 * the Mac is asleep), then why that is safe to accept. The sections after it —
 * features, roadmap, price, questions — are there so someone who is already
 * convinced does not have to leave the page to finish deciding.
 *
 * This file is only the order. Every section owns its own markup, and every
 * word is in `copy.tsx`.
 */
export function Landing() {
	const { t } = useLang();

	return (
		<>
			<Hero />
			<Scenarios />

			<Showcase
				title={t.routing.title}
				lede={t.routing.lede}
				cards={t.routing.cards}
				figure={
					<div className="figure-slot">
						<RoutingFigure
							from={t.routing.figureFrom}
							meta={t.routing.figureMeta}
							to={t.routing.figureTo}
						/>
					</div>
				}
			/>

			<Showcase
				title={t.sleep.title}
				lede={t.sleep.lede}
				cards={t.sleep.cards}
				figure={
					<div className="figure-slot">
						<SleepFigure
							asleep={t.sleep.figureAsleep}
							awake={t.sleep.figureAwake}
							queued={t.sleep.figureQueued}
							landed={t.sleep.figureLanded}
						/>
					</div>
				}
			/>

			<Showcase
				title={t.crypto.title}
				lede={t.crypto.lede}
				cards={t.crypto.cards}
				link={{ label: t.crypto.link, href: "/how-it-works" }}
				figure={
					<div className="figure-slot">
						<CryptoFigure plain={t.crypto.figurePlain} cipher={t.crypto.figureCipher} />
					</div>
				}
			/>

			<Features />
			<Roadmap />
			<PricingTeaser />
			<Faq />
			<CtaBand />
		</>
	);
}
