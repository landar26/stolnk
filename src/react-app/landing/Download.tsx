import { APP_STORE_URL } from "./contact.ts";
import { useLang } from "./lang-context.ts";

/**
 * Stolnk is an iPhone app sold through the App Store, so this page is a short
 * explanation in front of one link. The button is a plain anchor: it works
 * before the bundle has finished loading, and with JavaScript off entirely.
 */
export function Download() {
	const { t } = useLang();
	const copy = t.pages.download;

	return (
		<main className="page prose" id="main">
			<h1 className="inbox-title">{copy.title}</h1>
			<p>
				{copy.lede} <a href="/pricing">{copy.pricingLink}</a>
			</p>

			<p className="page-cta">
				<a className="button primary" href={APP_STORE_URL}>
					{copy.cta}
				</a>
				<small className="download-meta">{copy.meta}</small>
			</p>

			<h2>{copy.firstLaunch}</h2>
			{copy.firstLaunchBody}

			<h2>{copy.onYourPhone}</h2>
			{copy.onYourPhoneBody}
		</main>
	);
}
