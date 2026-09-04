import { useCallback, useEffect, useState, type ReactNode } from "react";
import { copy, type Lang } from "./copy.tsx";
import { LangContext } from "./lang-context.ts";

/**
 * The language the marketing pages are in.
 *
 * Client-side only, and deliberately so for now: the site is a handful of
 * pages, and one URL per page keeps the Worker's routing — which already has to
 * distinguish the apex from every inbox subdomain — from growing a second axis.
 * The cost is that a search engine sees whichever language is the default, so if
 * Chinese search ever matters this has to become `/zh/*` prefixed routes.
 *
 * The send page does not use any of this. Its copy would have to travel in the
 * bundle PRD 9.4 keeps small enough to audit.
 */
const STORAGE_KEY = "stolnk.lang";

/** Reading `localStorage` throws outright in some privacy modes, not just returns null. */
function stored(): Lang | null {
	try {
		const saved = localStorage.getItem(STORAGE_KEY);
		return saved === "en" || saved === "zh" ? saved : null;
	} catch {
		return null;
	}
}

function initialLang(): Lang {
	const saved = stored();
	if (saved) return saved;
	return navigator.language?.toLowerCase().startsWith("zh") ? "zh" : "en";
}

export function LangProvider({ children }: { children: ReactNode }) {
	const [lang, setLangState] = useState<Lang>(initialLang);

	// `index.html` ships `lang="en"`, which is right for the default and wrong the
	// moment the reader's browser is Chinese. Screen readers and the browser's own
	// translation prompt both read this attribute, so it has to follow the state.
	useEffect(() => {
		document.documentElement.lang = lang === "zh" ? "zh-Hans" : "en";
	}, [lang]);

	const setLang = useCallback((next: Lang) => {
		setLangState(next);
		try {
			localStorage.setItem(STORAGE_KEY, next);
		} catch {
			// A preference that cannot be remembered is still worth honouring for
			// this pageview.
		}
	}, []);

	return (
		<LangContext.Provider value={{ lang, t: copy[lang], setLang }}>
			{children}
		</LangContext.Provider>
	);
}
