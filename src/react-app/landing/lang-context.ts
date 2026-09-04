import { createContext, useContext } from "react";
import type { Dict, Lang } from "./copy.tsx";

/**
 * Split from `lang.tsx` only so that file exports a component and nothing else,
 * which is what Fast Refresh needs to swap the provider without dropping the
 * tree's state.
 */
export interface LangValue {
	lang: Lang;
	/** The dictionary for `lang`, so a component reads `t.hero.title` and nothing else. */
	t: Dict;
	setLang: (next: Lang) => void;
}

export const LangContext = createContext<LangValue | null>(null);

export function useLang(): LangValue {
	const value = useContext(LangContext);
	if (!value) throw new Error("useLang must be used within LangProvider");
	return value;
}
