import type { ReactNode } from "react";

/**
 * The shape every deep-dive section on the home page shares: a heading, one
 * paragraph, a row of short cards, and a diagram. Three sections used it before
 * it was a component, and they had already started to drift apart.
 */
export function Showcase({
	id,
	title,
	lede,
	cards,
	link,
	figure,
}: {
	id?: string;
	title: string;
	lede: string;
	cards: ReadonlyArray<{ title: string; body: string }>;
	link?: { label: string; href: string };
	figure: ReactNode;
}) {
	return (
		<section className="showcase" id={id}>
			<div className="shell">
				<div className="showcase-head">
					<h2>{title}</h2>
					<p>{lede}</p>
					{link && (
						<p className="showcase-link">
							<a href={link.href}>{link.label}</a>
						</p>
					)}
				</div>
				<div className="showcase-body">
					{figure}
					<ul className="cards">
						{cards.map((card) => (
							<li className="card-item" key={card.title}>
								<h3>{card.title}</h3>
								<p>{card.body}</p>
							</li>
						))}
					</ul>
				</div>
			</div>
		</section>
	);
}
