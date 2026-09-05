import { useLang } from "../lang-context.ts";
import { useMacRelease } from "../useMacRelease.ts";
import { RoutingFigure } from "./figures.tsx";

/**
 * The version badge is the one piece of this that can fail: it needs the
 * release manifest. Rather than reserving space for it and shifting the page
 * when it lands, the badge always renders — the published version when there is
 * one, the platform requirement when there is not — so the layout is settled
 * from the first paint either way.
 */
export function Hero() {
	const { t } = useLang();
	const { release, state } = useMacRelease();

	return (
		<section className="hero">
			<div className="shell">
				{state === "ready" && release ? (
					<a className="hero-badge" href="/download">
						{t.hero.badge(release.version)}
					</a>
				) : (
					<span className="hero-badge static">{t.hero.badgeFallback}</span>
				)}

				<h1>{t.hero.title}</h1>
				<p className="hero-lede">{t.hero.lede}</p>

				<a className="button primary large" href="/download">
					{t.hero.cta}
				</a>
				<small className="hero-meta">{t.hero.meta}</small>
				<small className="hero-meta">
					<a href="/download#windows">{t.hero.windows}</a>
				</small>

				<div className="hero-figure">
					<RoutingFigure from={t.hero.figureFrom} to={t.hero.figureTo} />
					<p className="figure-caption">{t.hero.figureCaption}</p>
				</div>
			</div>
		</section>
	);
}
