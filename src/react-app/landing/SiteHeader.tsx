import { useState } from "react";
import { DISCORD_URL } from "./contact.ts";
import { useLang } from "./lang-context.ts";

/**
 * The site-wide navigation, which the marketing pages did not have at all
 * before: every page was reachable only from a link in someone else's prose, so
 * arriving on `/pricing` from a search result was a dead end.
 *
 * The links are ordinary anchors. There is no router (`main.tsx` explains why),
 * so `/#faq` from another page is a real navigation followed by a hash jump —
 * which is the behaviour a reader expects from a link that looks like that.
 */
export function SiteHeader() {
	const { lang, t, setLang } = useLang();
	const [open, setOpen] = useState(false);

	return (
		<header className="site-header">
			<a className="skip-link" href="#main">
				{t.skipToContent}
			</a>
			<div className="site-header-inner">
				{/*
				 * `alt=""` on purpose: the wordmark sits right beside it, so a described
				 * image would have a screen reader announce "Stolnk Stolnk". The mark is
				 * decoration here; the link's name comes from the text.
				 *
				 * Width and height as attributes so the row does not reflow when the
				 * image lands — it is the same file the favicon already pulled, so in
				 * practice it is warm, but a cold visit should not shift the header.
				 */}
				<a className="brand" href="/">
					<img className="brand-mark" src="/app-icon.png" alt="" width={28} height={28} />
					{t.nav.home}
				</a>

				<button
					className="nav-toggle"
					type="button"
					aria-expanded={open}
					aria-controls="site-nav"
					onClick={() => setOpen((was) => !was)}
				>
					{t.nav.menu}
				</button>

				<nav className={open ? "site-nav open" : "site-nav"} id="site-nav">
					<ul className="nav-links">
						{t.nav.links.map((link) => (
							<li key={link.label}>
								<a
									href={link.href}
									aria-current={link.href === location.pathname ? "page" : undefined}
									onClick={() => setOpen(false)}
								>
									{link.label}
								</a>
							</li>
						))}
					</ul>

					<div className="nav-actions">
						<a className="button primary" href="/download">
							{t.nav.cta}
						</a>

						{/*
						 * Inline rather than an <img>: the CSP is `img-src 'self' data:
						 * blob:`, so an external asset would be blocked outright — and a
						 * single icon does not deserve a request either way. The mark is
						 * Discord's; it is here as a link to a Discord server, which is what
						 * their brand guidelines allow it to be used for.
						 *
						 * The link has no readable text, so the accessible name comes from
						 * `aria-label` and the glyph is hidden from the tree entirely.
						 */}
						<a
							className="nav-discord"
							href={DISCORD_URL}
							target="_blank"
							rel="noopener noreferrer"
							aria-label={t.nav.discord}
							onClick={() => setOpen(false)}
						>
							<svg viewBox="0 0 24 18" aria-hidden="true" focusable="false">
								<path d="M20.317 1.492A19.79 19.79 0 0 0 15.432 0a13.86 13.86 0 0 0-.617 1.25 18.27 18.27 0 0 0-5.487 0A12.68 12.68 0 0 0 8.71 0 19.74 19.74 0 0 0 3.822 1.496C.729 6.084-.113 10.558.308 14.968a19.9 19.9 0 0 0 6.023 3.03 14.7 14.7 0 0 0 1.29-2.086 12.9 12.9 0 0 1-2.032-.972c.171-.124.338-.253.499-.386a14.2 14.2 0 0 0 12.164 0c.163.135.33.264.5.386-.65.383-1.331.708-2.037.974a14.6 14.6 0 0 0 1.29 2.084 19.85 19.85 0 0 0 6.028-3.029c.494-5.115-.844-9.548-3.53-13.477ZM8.02 12.276c-1.183 0-2.157-1.078-2.157-2.401 0-1.324.953-2.402 2.157-2.402s2.178 1.078 2.157 2.402c0 1.323-.953 2.401-2.157 2.401Zm7.975 0c-1.183 0-2.157-1.078-2.157-2.401 0-1.324.953-2.402 2.157-2.402s2.178 1.078 2.157 2.402c0 1.323-.953 2.401-2.157 2.401Z" />
							</svg>
						</a>

						{/*
						 * Two languages, so a toggle rather than a select: the control can
						 * name the language it switches *to*, which is the only label a
						 * reader who cannot read the current one is able to act on. That is
						 * why this stays text where the reference site uses a globe — a
						 * globe asks you to guess what is behind it.
						 */}
						<button
							className="lang-switch"
							type="button"
							onClick={() => setLang(lang === "en" ? "zh" : "en")}
						>
							{t.langLabel}
						</button>
					</div>
				</nav>
			</div>
		</header>
	);
}
