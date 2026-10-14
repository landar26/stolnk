import { APP_STORE_URL } from "./contact.ts";
import { useLang } from "./lang-context.ts";

/**
 * One price, paid to Apple. Nothing is sold on this website: the iPhone app is
 * a paid download with every feature included, so this page only says what
 * that price buys. The numbers are the `PRO` tier in `worker/limits.ts`.
 */
export function Pricing() {
	const { t } = useLang();
	const copy = t.pages.pricing;

	return (
		<main className="page prose" id="main">
			<h1 className="inbox-title">{copy.title}</h1>
			<p>{copy.lede}</p>

			<div className="plans single">
				<div className="plan featured">
					<h2>{copy.planName}</h2>
					<p className="price">{copy.price}</p>
					<p className="plan-note">{copy.planNote}</p>
					<a className="button primary" href={APP_STORE_URL}>
						{copy.cta}
					</a>
					<small>{copy.footnote}</small>
				</div>
			</div>

			<div className="table-scroll">
				<table className="compare">
					<tbody>
						{copy.rows.map((row) => (
							<tr key={row.label}>
								<th scope="row">{row.label}</th>
								<td>{row.value}</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>

			{copy.body}
		</main>
	);
}
