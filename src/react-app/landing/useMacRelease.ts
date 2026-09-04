import { useEffect, useState } from "react";
import type { MacRelease } from "../../shared/release";

export type ReleaseState = "loading" | "ready" | "unavailable";

/**
 * The published macOS build, or the honest absence of one.
 *
 * Two places need it — the download page's version line and the hero's version
 * badge — and a second copy of this fetch would eventually disagree with the
 * first about what "unavailable" looks like.
 *
 * Nothing here is load-bearing: the download button is a plain anchor that works
 * before this has resolved and with JavaScript off entirely. What the manifest
 * adds is the version, the size and the hash.
 */
export function useMacRelease(): { release: MacRelease | null; state: ReleaseState } {
	const [release, setRelease] = useState<MacRelease | null>(null);
	const [state, setState] = useState<ReleaseState>("loading");

	useEffect(() => {
		let cancelled = false;
		fetch("/api/v1/release/mac")
			.then((response) => (response.ok ? response.json() : Promise.reject(response.status)))
			.then((data: MacRelease) => {
				if (cancelled) return;
				setRelease(data);
				setState("ready");
			})
			.catch(() => {
				if (!cancelled) setState("unavailable");
			});
		return () => {
			cancelled = true;
		};
	}, []);

	return { release, state };
}
