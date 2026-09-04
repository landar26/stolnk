import { useLang } from "./lang-context.ts";

/** PRD 16.1. The two honesty rules that shape every line of this are in `copy-pages.tsx`. */
export function Pricing() {
	const { t } = useLang();
	const copy = t.pages.pricing;

	return (
		<main className="page prose" id="main">
			<h1 className="inbox-title">{copy.title}</h1>
			<p>{copy.lede}</p>

			<div className="plans">
				<div className="plan">
					<h2>{copy.freeName}</h2>
					<p className="price">{copy.freePrice}</p>
					<p className="plan-note">{copy.freeNote}</p>
					<a className="button" href="/download">
						{copy.freeCta}
					</a>
				</div>

				<div className="plan featured">
					<h2>{copy.proName}</h2>
					<p className="price">
						$29 <s>$39</s>
					</p>
					<p className="plan-note">{copy.proNote}</p>
					<a className="button primary" href="/api/v1/checkout">
						{copy.proCta}
					</a>
					<small>{copy.proFootnote}</small>
				</div>
			</div>

			<div className="table-scroll">
				<table className="compare">
					<thead>
						<tr>
							<th />
							<th>{copy.freeName}</th>
							<th>{copy.proName}</th>
						</tr>
					</thead>
					<tbody>
						{copy.rows.map((row) => (
							<tr key={row.label}>
								<th scope="row">{row.label}</th>
								<td>{row.free}</td>
								<td>{row.pro}</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>

			{copy.body}
		</main>
	);
}
