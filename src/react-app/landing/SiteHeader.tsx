import { useState } from "react";
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
				<a className="brand" href="/">
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
						{/*
						 * Two languages, so a toggle rather than a select: the control can
						 * name the language it switches *to*, which is the only label a
						 * reader who cannot read the current one is able to act on.
						 */}
						<button
							className="lang-switch"
							type="button"
							onClick={() => setLang(lang === "en" ? "zh" : "en")}
						>
							{t.langLabel}
						</button>
						<a className="button primary" href="/download">
							{t.nav.cta}
						</a>
					</div>
				</nav>
			</div>
		</header>
	);
}
