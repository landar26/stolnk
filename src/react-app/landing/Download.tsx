import { useEffect, useState } from "react";
import type { MacRelease } from "../../shared/release";
import { formatBytes } from "../lib/format.ts";

/**
 * PRD 19 risk #7 — Gatekeeper friction on first launch is a real drop-off
 * point for a directly distributed app, so the instructions are here from the
 * start rather than buried in a support page after people start emailing.
 *
 * The button is an anchor, not a fetch: it has to work before this component's
 * effect has run, and with JavaScript off entirely. What the manifest adds is
 * the version, the size and the hash — useful, and none of it load-bearing.
 */
export function Download() {
	const [release, setRelease] = useState<MacRelease | null>(null);
	const [state, setState] = useState<"loading" | "ready" | "unavailable">("loading");

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

	return (
		<main className="page prose">
			<h1 className="inbox-title">Download Stolnk</h1>
			<p>
				macOS 13 or later, Apple Silicon and Intel. Free — one inbox, 3 GB of relayed files a
				month. <a href="/pricing">Pricing</a>
			</p>

			<p style={{ margin: "24px 0" }}>
				{/*
				 * No `download` attribute on purpose. The server already sends
				 * `content-disposition: attachment`, and the attribute would name the
				 * saved file after this link's last segment — "mac", with no extension —
				 * rather than after the versioned file it redirects to.
				 */}
				<a className="button primary" href="/download/mac">
					Download for Mac
				</a>
				{state === "ready" && release && (
					<small className="download-meta">
						Version {release.version} · {formatBytes(release.size)} · macOS{" "}
						{release.min_macos} or later
					</small>
				)}
				{state === "unavailable" && (
					<small className="download-meta">
						No build is published right now — please check back shortly.
					</small>
				)}
			</p>

			<h2>First launch</h2>
			<p>
				Stolnk is distributed directly rather than through the App Store, because it writes
				to folders you choose anywhere on disk — including external volumes — which the
				sandbox does not allow.
			</p>
			<p>
				Released builds are signed with a Developer ID and notarised by Apple, so the disk
				image opens without a warning and so does the app. Drag Stolnk to Applications and
				double-click it.
			</p>
			<div className="callout">
				<p>
					macOS shows one dialog the first time — the ordinary “downloaded from the
					Internet” confirmation every direct download gets. It names the signer:{" "}
					<strong>Ningbo Tangxiaoyuan Technology Co., Ltd</strong>, the company behind
					Stolnk.
				</p>
			</div>

			{state === "ready" && release && (
				<>
					<h2>Verify what you downloaded</h2>
					<p>
						The hash of every published build is listed here, so you can check that the
						file you got is the file we shipped.{" "}
						<a href="/how-it-works">Why that matters →</a>
					</p>
					<pre className="routing wrap">
						{`shasum -a 256 ~/Downloads/${release.filename}\n${release.sha256}`}
					</pre>
				</>
			)}

			<h2>What it does on your Mac</h2>
			<ul>
				<li>Lives in the menu bar. No Dock icon, no window unless you open one.</li>
				<li>Generates its keys in the Secure Enclave on first launch.</li>
				<li>Writes only to the folders you pick.</li>
				<li>
					Marks every received file with <code>com.apple.quarantine</code>, exactly as a
					browser download would.
				</li>
				<li>Does not keep your Mac awake.</li>
			</ul>

			<footer className="footer" style={{ marginTop: 48 }}>
				<a href="/">← Back</a>
			</footer>
		</main>
	);
}
