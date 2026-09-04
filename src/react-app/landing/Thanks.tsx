import { useLang } from "./lang-context.ts";

/** PRD 16.5 — Creem's return URL. Why it verifies nothing is explained in `copy-pages.tsx`. */
export function Thanks() {
	const { t } = useLang();
	const copy = t.pages.thanks;

	return (
		<main className="page prose" id="main">
			<h1 className="inbox-title">{copy.title}</h1>
			<p>{copy.lede}</p>

			<h2>{copy.activate}</h2>
			{copy.activateBody}

			<p className="page-cta">
				<a className="button primary" href="/download">
					{copy.cta}
				</a>
			</p>

			{copy.rest}
		</main>
	);
}
