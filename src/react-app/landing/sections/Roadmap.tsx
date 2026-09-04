import { useLang } from "../lang-context.ts";

/**
 * PRD 16.3 — nothing unbuilt appears in the price table, so it appears here
 * instead. The section exists so the pricing page can point at it rather than
 * carry a list of promises next to a list of guarantees.
 */
export function Roadmap() {
	const { t } = useLang();

	return (
		<section className="roadmap" id="roadmap">
			<div className="shell">
				<div className="section-head">
					<h2>{t.roadmap.title}</h2>
					<p>{t.roadmap.lede}</p>
				</div>
				<ul className="roadmap-list">
					{t.roadmap.items.map((item) => (
						<li key={item}>{item}</li>
					))}
				</ul>
			</div>
		</section>
	);
}
