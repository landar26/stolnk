import { formatBytes } from "../lib/format.ts";
import { useLang } from "./lang-context.ts";
import { useMacRelease } from "./useMacRelease.ts";

/**
 * PRD 19 risk #7 — Gatekeeper friction on first launch is a real drop-off
 * point for a directly distributed app, so the instructions are here from the
 * start rather than buried in a support page after people start emailing.
 *
 * The button is an anchor, not a fetch: it has to work before the release
 * manifest has arrived, and with JavaScript off entirely.
 */
export function Download() {
	const { t } = useLang();
	const copy = t.pages.download;
	const { release, state } = useMacRelease();

	return (
		<main className="page prose" id="main">
			<h1 className="inbox-title">{copy.title}</h1>
			<p>
				{copy.lede} <a href="/pricing">{copy.pricingLink}</a>
			</p>

			<p className="page-cta">
				{/*
				 * No `download` attribute on purpose. The server already sends
				 * `content-disposition: attachment`, and the attribute would name the
				 * saved file after this link's last segment — "mac", with no extension —
				 * rather than after the versioned file it redirects to.
				 */}
				<a className="button primary" href="/download/mac">
					{copy.cta}
				</a>
				{state === "ready" && release && (
					<small className="download-meta">
						{copy.meta(release.version, formatBytes(release.size), release.min_macos)}
					</small>
				)}
				{state === "unavailable" && (
					<small className="download-meta">{copy.unavailable}</small>
				)}
			</p>

			<h2>{copy.firstLaunch}</h2>
			{copy.firstLaunchBody}
			<div className="callout">
				<p>{copy.gatekeeper}</p>
			</div>

			{state === "ready" && release && (
				<>
					<h2>{copy.verify}</h2>
					<p>
						{copy.verifyBody} <a href="/how-it-works">{copy.verifyWhy}</a>
					</p>
					<pre className="routing wrap">
						{`shasum -a 256 ~/Downloads/${release.filename}\n${release.sha256}`}
					</pre>
				</>
			)}

			<h2>{copy.onYourMac}</h2>
			{copy.onYourMacBody}
		</main>
	);
}
