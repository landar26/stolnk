import { useLang } from "../lang-context.ts";

/**
 * `<details>` rather than a JavaScript accordion: it opens with the bundle
 * still downloading, it is findable by the browser's own in-page search in
 * Chrome, and it costs nothing.
 *
 * Every answer here is a restatement of something the product already commits
 * to somewhere else — the pricing table, the how-it-works page, the Mac app's
 * behaviour. Nothing is softened on the way into this section; the answer about
 * keys not moving to a new Mac is the test of that.
 */
export function Faq() {
	const { t } = useLang();

	return (
		<section className="faq" id="faq">
			<div className="shell">
				<div className="section-head">
					<h2>{t.faq.title}</h2>
				</div>
				<div className="faq-list">
					{t.faq.items.map((item) => (
						<details className="faq-item" key={item.q}>
							<summary>{item.q}</summary>
							<p>{item.a}</p>
						</details>
					))}
				</div>
			</div>
		</section>
	);
}
