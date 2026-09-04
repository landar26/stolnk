import { useLang } from "./lang-context.ts";

/** PRD 9.4. The claims, and the reasoning behind their narrowness, are in `copy-pages.tsx`. */
export function HowItWorks() {
	const { t } = useLang();
	const copy = t.pages.howItWorks;

	return (
		<main className="page prose" id="main">
			<h1 className="inbox-title">{copy.title}</h1>
			<p>{copy.lede}</p>
			{copy.body}
		</main>
	);
}
