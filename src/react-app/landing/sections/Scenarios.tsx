import { useState } from "react";
import { useLang } from "../lang-context.ts";
import { RoutingFigure } from "./figures.tsx";

/**
 * Three numbered tabs over one diagram.
 *
 * The point of showing them together rather than as three separate sections is
 * that the diagram barely changes between them: the same link-to-folder shape
 * with different words in it. Switching tabs makes that sameness the message,
 * which is harder to say in a paragraph.
 */
export function Scenarios() {
	const { t } = useLang();
	const [active, setActive] = useState(0);
	const scenario = t.scenarios.items[active];

	return (
		<section className="scenarios" id="scenarios">
			<div className="shell">
				<div className="section-head">
					<h2>{t.scenarios.title}</h2>
					<p>{t.scenarios.lede}</p>
				</div>

				<div className="scenario-tabs" role="tablist" aria-label={t.scenarios.title}>
					{t.scenarios.items.map((item, index) => (
						<button
							className={index === active ? "scenario-tab active" : "scenario-tab"}
							key={item.n}
							type="button"
							role="tab"
							id={`scenario-tab-${item.n}`}
							aria-selected={index === active}
							aria-controls="scenario-panel"
							onClick={() => setActive(index)}
						>
							<span className="scenario-n">{item.n}</span>
							<span className="scenario-name">{item.name}</span>
							<span className="scenario-note">{item.note}</span>
						</button>
					))}
				</div>

				<div
					className="scenario-panel"
					id="scenario-panel"
					role="tabpanel"
					aria-labelledby={`scenario-tab-${scenario.n}`}
				>
					{/*
					 * Keyed on the scenario so React remounts rather than patches: the
					 * figure's entrance animation is what makes the switch read as a
					 * switch, and a patched node keeps its finished animation.
					 */}
					<RoutingFigure
						key={scenario.n}
						from={scenario.from}
						meta={scenario.meta}
						to={scenario.to}
					/>
				</div>
			</div>
		</section>
	);
}
