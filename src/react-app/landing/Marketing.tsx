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
	return (
		<LangProvider>
			<SiteHeader />
			<Page path={path} />
			<SiteFooter />
		</LangProvider>
	);
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
