import { useLang } from "../lang-context.ts";

export function Features() {
	const { t } = useLang();

	return (
		<section className="features" id="features">
			<div className="shell">
				<div className="section-head">
					<h2>{t.features.title}</h2>
					<p>{t.features.lede}</p>
				</div>
				<ul className="feature-grid">
					{t.features.items.map((item) => (
						<li className="feature" key={item.title}>
							<h3>{item.title}</h3>
							<p>{item.body}</p>
						</li>
					))}
				</ul>
			</div>
		</section>
	);
}
