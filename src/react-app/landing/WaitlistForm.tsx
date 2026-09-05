import { useState } from "react";
import { useLang } from "./lang-context.ts";

type State = "idle" | "sending" | "done";

/**
 * The Windows waiting list.
 *
 * The `fetch` is written out here rather than added to `lib/api.ts`, which is
 * the send page's module and travels in the bundle PRD 9.4 commits to keeping
 * auditable. Everything under `landing/` is a separate lazy chunk (`main.tsx`),
 * so a marketing-only request belongs on this side of that line.
 */
export function WaitlistForm() {
	const { t, lang } = useLang();
	const copy = t.waitlist;

	const [email, setEmail] = useState("");
	const [state, setState] = useState<State>("idle");
	const [error, setError] = useState<string | null>(null);

	if (state === "done") {
		return (
			<div className="callout" role="status">
				<p>
					<strong>{copy.doneTitle}</strong> {copy.doneBody}
				</p>
			</div>
		);
	}

	return (
		<form
			onSubmit={async (event) => {
				event.preventDefault();
				setState("sending");
				setError(null);
				try {
					const response = await fetch("/api/v1/waitlist", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ email, platform: "windows", locale: lang }),
					});
					/*
					 * The status is read, the server's message is not. Every other word
					 * on this side of the site is translated, and the API answers in
					 * English only — so surfacing its text would put one English
					 * sentence in the middle of a Chinese page, at the exact moment the
					 * reader needs to understand what went wrong.
					 */
					if (!response.ok) {
						throw new Error(response.status === 429 ? copy.tooMany : copy.failed);
					}
					setState("done");
				} catch (failure) {
					// Back to `idle`, not to a dead end: the common causes here are a
					// typo and a flaky connection, and both are fixed by trying again.
					setState("idle");
					setError(failure instanceof Error ? failure.message : copy.failed);
				}
			}}
		>
			<div className="row">
				<input
					type="email"
					required
					value={email}
					placeholder={copy.placeholder}
					aria-label={copy.placeholder}
					autoComplete="email"
					onChange={(event) => setEmail(event.target.value)}
				/>
				<button className="primary" type="submit" disabled={state === "sending" || !email}>
					{state === "sending" ? copy.sending : copy.cta}
				</button>
			</div>
			{/* Outside the row: inside it, flex lays the message out as a third
			    column and squeezes the field it is describing. */}
			{error && (
				<p className="error" role="alert">
					{error}
				</p>
			)}
		</form>
	);
}
