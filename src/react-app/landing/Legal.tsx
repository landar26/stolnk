import { useLang } from "./lang-context.ts";

/**
 * The privacy policy and the terms, which are the same page with different
 * words in it: a title, the date it last changed, one orienting sentence, and
 * a run of headed sections.
 *
 * The date is above the fold rather than in the footer on purpose — it is the
 * first thing anyone checking whether a policy is current looks for.
 */
export function Legal({ document }: { document: "privacy" | "terms" }) {
	const { t } = useLang();
	const copy = t.legal[document];

	return (
		<main className="page prose" id="main">
			<h1 className="inbox-title">{copy.title}</h1>
			<p className="legal-updated">{copy.updated}</p>
			<p>{copy.lede}</p>
			{copy.body}
		</main>
	);
}
