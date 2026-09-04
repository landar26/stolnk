import { useLang } from "./lang-context.ts";

/**
 * The comparison page.
 *
 * The honesty rules that govern `/pricing` govern this page harder, because it
 * is the one page whose whole subject is other people's products. Two of them
 * apply here:
 *
 *  1. **Rows state capabilities, not verdicts.** "Your Downloads folder" is a
 *     fact about where a file ends up. "Clutters your Downloads folder" would
 *     be the same fact with a thumb on the scale, and a reader can tell.
 *  2. **The page says what Stolnk is bad at, on the same page.** A comparison
 *     that only runs one way is an advertisement, and it is read as one.
 *
 * The note under the table is not a disclaimer for its own sake either: these
 * products change, and a row that was true at launch and is quietly wrong two
 * years later is the failure mode this page has.
 */
export function Compare() {
	const { t } = useLang();

	return (
		<main className="page prose wide" id="main">
			<h1 className="inbox-title">{t.compare.title}</h1>
			<p>{t.compare.lede}</p>

			<div className="table-scroll">
				<table className="compare">
					<thead>
						<tr>
							<th />
							{t.compare.columns.map((column) => (
								<th key={column}>{column}</th>
							))}
						</tr>
					</thead>
					<tbody>
						{t.compare.rows.map((row) => (
							<tr key={row.label}>
								<th scope="row">{row.label}</th>
								{row.values.map((value, index) => (
									<td className={index === 0 ? "compare-own" : undefined} key={value + index}>
										{value}
									</td>
								))}
							</tr>
						))}
					</tbody>
				</table>
			</div>
			<p className="note compare-note">{t.compare.note}</p>

			<h2>{t.compare.notGood.title}</h2>
			<ul>
				{t.compare.notGood.items.map((item) => (
					<li key={item}>{item}</li>
				))}
			</ul>
			<p>
				<a href="/how-it-works">{t.compare.notGood.link}</a>
			</p>

			<p className="page-cta">
				<a className="button primary" href="/download">
					{t.compare.cta}
				</a>
			</p>
		</main>
	);
}
