import { APP_STORE_URL } from "../contact.ts";
import { useLang } from "../lang-context.ts";

export function CtaBand() {
	const { t } = useLang();

	return (
		<section className="cta-band">
			<div className="shell cta-inner">
				<div>
					<h2>{t.cta.title}</h2>
					<p>{t.cta.lede}</p>
				</div>
				<a className="button primary large" href={APP_STORE_URL}>
					{t.cta.button}
				</a>
			</div>
		</section>
	);
}
