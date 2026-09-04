import { useLang } from "./lang-context.ts";

/**
 * Four grouped columns rather than the single line of links this replaced.
 *
 * There is no Legal column yet on purpose: `/privacy` and `/terms` do not
 * exist, and a footer link to a page that 404s is worse than the absence of the
 * link. It goes in when those pages do.
 */
export function SiteFooter() {
	const { t } = useLang();
	const year = new Date().getFullYear();

	return (
		<footer className="site-footer">
			<div className="footer-inner">
				<div className="footer-cols">
					{t.footer.groups.map((group) => (
						<div key={group.title}>
							<h2 className="footer-heading">{group.title}</h2>
							<ul className="footer-links">
								{group.links.map((link) => (
									<li key={link.label}>
										<a href={link.href}>{link.label}</a>
									</li>
								))}
							</ul>
						</div>
					))}
				</div>
				<p className="footer-legal">
					© {year} {t.footer.copyright}
				</p>
			</div>
		</footer>
	);
}
