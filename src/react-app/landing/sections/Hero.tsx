import { APP_STORE_URL } from "../contact.ts";
import { useLang } from "../lang-context.ts";
import { RoutingFigure } from "./figures.tsx";

export function Hero() {
	const { t } = useLang();

	return (
		<section className="hero">
			<div className="shell">
				<span className="hero-badge static">{t.hero.badge}</span>

				<h1>{t.hero.title}</h1>
				<p className="hero-lede">{t.hero.lede}</p>

				<a className="button primary large" href={APP_STORE_URL}>
					{t.hero.cta}
				</a>
				<small className="hero-meta">{t.hero.meta}</small>

				<div className="hero-figure">
					<RoutingFigure from={t.hero.figureFrom} to={t.hero.figureTo} />
					<p className="figure-caption">{t.hero.figureCaption}</p>
				</div>
			</div>
		</section>
	);
}
