import { useEffect } from "react";
import { Compare } from "./Compare.tsx";
import { Download } from "./Download.tsx";
import { HowItWorks } from "./HowItWorks.tsx";
import { Landing } from "./Landing.tsx";
import { Legal } from "./Legal.tsx";
import { NotFound } from "./NotFound.tsx";
import { Pricing } from "./Pricing.tsx";
import { SiteFooter } from "./SiteFooter.tsx";
import { SiteHeader } from "./SiteHeader.tsx";
import { Thanks } from "./Thanks.tsx";
import { LangProvider } from "./lang.tsx";

/**
 * Everything served from the apex, and the reason it is one module.
 *
 * `main.tsx` imports this lazily, which puts every marketing page, both
 * languages of the dictionary and all of the section components into a chunk
 * the send page never downloads. That is not a page-weight nicety: PRD 9.4
 * commits to the send page being small enough that reading it is a realistic
 * way to check what it does with a file, and this is the boundary that keeps
 * that true as the marketing side grows.
 */
export function Marketing({ path }: { path: string }) {
	useAnchorOnLoad();

	return (
		<LangProvider>
			<SiteHeader />
			<Page path={path} />
			<SiteFooter />
		</LangProvider>
	);
}

/**
 * Land on the section a `/#faq` link asked for.
 *
 * The browser resolves a hash against the document it has, and on a cold load
 * that document is an empty root: this module is a lazy chunk, so by the time
 * `#faq` exists the browser has long since decided there was nothing to scroll
 * to. Every anchor in the header and footer is an absolute `/#…`, which means
 * arriving from any other page hit this — the link worked and simply did
 * nothing.
 *
 * Runs after the first paint of the page's own content, since that is when the
 * target exists. The `scroll-margin-top` on `[id]` keeps it clear of the
 * header, so this does no arithmetic of its own.
 */
function useAnchorOnLoad(): void {
	useEffect(() => {
		const id = location.hash.slice(1);
		if (!id) return;
		// `getElementById` rather than a selector: a hash is arbitrary text, and a
		// malformed one should be the no-op it always was, not a thrown error.
		document.getElementById(id)?.scrollIntoView();
	}, []);
}

function Page({ path }: { path: string }) {
	if (path === "") return <Landing />;
	if (path === "how-it-works") return <HowItWorks />;
	if (path === "download") return <Download />;
	if (path === "pricing") return <Pricing />;
	if (path === "compare") return <Compare />;
	if (path === "privacy") return <Legal document="privacy" />;
	if (path === "terms") return <Legal document="terms" />;
	// Creem's return URL after checkout, and only reachable that way.
	if (path === "thanks") return <Thanks />;
	return <NotFound />;
}
