import { useCallback, useEffect, useRef, useState } from "react";
import {
	abortTransfer,
	deriveVerifier,
	resolveInbox,
	watchTransfer,
	type InboxInfo,
} from "../lib/api.ts";
import { formatBytes } from "../lib/format.ts";
import { openLanSession, type LanSession } from "../lib/lan.ts";
import { sendFileOverLan } from "../lib/lan-send.ts";
import { listResumable, matches, type ResumeRecord } from "../lib/resume.ts";
import { uploadFile, type UploadProgress } from "../lib/uploader.ts";

type Screen = "loading" | "missing" | "locked" | "ready" | "sending" | "finished";

/**
 * Whether dropping is something this device can actually do.
 *
 * On a phone it is not — there is nothing to drag a file from — so "Drop files
 * here" is an instruction the reader cannot follow, sitting above the one they
 * can in smaller, dimmer type. Phones are most of what a shared link is opened
 * on, which makes this the wrong way round by default.
 *
 * Read once at module scope: a pointer does not change kind mid-session, and a
 * `matchMedia` subscription for something that cannot happen is noise in the
 * bundle PRD 9.4 asks to keep auditable. The `?? true` covers a browser without
 * `matchMedia` by assuming a desktop, which is what such a browser is.
 */
const CAN_DROP = window.matchMedia?.("(hover: hover) and (pointer: fine)").matches ?? true;

/**
 * The curl path's per-file ceiling, in MiB. It mirrors `MAX_CURL_UPLOAD_BYTES`
 * in worker/limits.ts, where the reasoning for the number lives; it is not
 * carried on the resolve response because it is a property of the transport
 * rather than of this inbox, and it is the same for everybody.
 */
const CURL_MAX_MIB = 95;

/**
 * The tab title, which the static `index.html` cannot get right: it is one file
 * serving both the apex and every inbox, so it ships the marketing title and
 * this replaces it once the inbox has a name. The crawler-facing half of the
 * same problem is solved server-side in `worker/lib/preview.ts`.
 */
function setTitle(title: string): void {
	document.title = `${title} — Stolnk`;
}

/**
 * The same address, for a terminal.
 *
 * `POST`ing a multipart body to an inbox address uploads a file
 * (worker/routes/inbox-address.ts), which is the only way a shell script, a CI
 * job or an agent can use one of these links — none of them can run the
 * encryption this page runs.
 *
 * Folded away by default and *below* the note above, in that order on purpose.
 * Almost nobody opening a link they were sent wants a command line, and the
 * caveat inside is the kind that has to sit next to the promise it qualifies:
 * "Encrypted in your browser" is four lines up and is not true of this route.
 */
function TerminalHint({ url, passworded }: { url: string; passworded: boolean }) {
	const command = `curl --fail-with-body ${passworded ? '-F "password=…" ' : ""}-F "file=@./path/to/file" "${url}"`;
	const [copied, setCopied] = useState(false);

	return (
		<details className="agents">
			<summary>For terminal &amp; AI agents</summary>
			<p>
				You do not need the box above — run this, with your own file in place of the
				path.
			</p>
			<code className="cmd">{command}</code>
			<p className="row">
				<button
					className="link"
					onClick={() => {
						// No fallback path: `navigator.clipboard` needs a secure context,
						// which every real inbox address has, and the command is selectable
						// text either way.
						void navigator.clipboard?.writeText(command).then(
							() => setCopied(true),
							() => undefined,
						);
					}}
				>
					{copied ? "Copied" : "Copy"}
				</button>
			</p>
			<p>
				One file per request, up to {CURL_MAX_MIB} MiB. Add{" "}
				<code>?format=json</code> to this address for a machine-readable description
				of it.
			</p>
			<p className="warn-note">
				Files sent this way are encrypted on our server with this Mac&rsquo;s public
				key, not in your browser: the plaintext passes through us for the length of
				one request. Use the box above for browser-side encryption.
			</p>
		</details>
	);
}

export function SendPage({ slug }: { slug: string }) {
	const [screen, setScreen] = useState<Screen>("loading");
	const [inbox, setInbox] = useState<InboxInfo | null>(null);
	const [online, setOnline] = useState(false);
	const [password, setPassword] = useState("");
	const [verifier, setVerifier] = useState<string | undefined>();
	const [error, setError] = useState<string | null>(null);
	const [files, setFiles] = useState<UploadProgress[]>([]);
	const [delivered, setDelivered] = useState<Set<string>>(new Set());
	const [resumable, setResumable] = useState<ResumeRecord[]>([]);
	const [dragging, setDragging] = useState(false);
	/** Which path the batch actually took, for the marker on the sending screen. */
	const [transport, setTransport] = useState<"relay" | "lan">("relay");
	/** Whether a DataChannel is open. Also decides whether a spent relay
	 *  allowance is a refusal or merely the slower path being unavailable. */
	const [lanReady, setLanReady] = useState(false);

	const inputRef = useRef<HTMLInputElement>(null);
	const resumeInputRef = useRef<HTMLInputElement>(null);
	const pendingResume = useRef<ResumeRecord | null>(null);
	const abort = useRef<AbortController | null>(null);
	const stopWatching = useRef<(() => void) | null>(null);
	const transfer = useRef<{ id: string; token: string } | null>(null);
	const lan = useRef<LanSession | null>(null);

	useEffect(() => {
		let cancelled = false;
		(async () => {
			try {
				const result = await resolveInbox(slug);
				if (cancelled) return;
				if (!result.inbox) {
					setTitle("This link is not active");
					setScreen("missing");
					return;
				}
				setTitle(`Send files to ${result.inbox.display_name}`);
				setInbox(result.inbox);
				setOnline(result.inbox.online);
				setScreen(result.inbox.password.required ? "locked" : "ready");
				setResumable(await listResumable(result.inbox.slug));

				/*
				 * PRD 8.2 — start negotiating now, not when someone presses send.
				 *
				 * ICE with host candidates settles in well under a second on a LAN,
				 * and choosing a file takes longer than that, so by send time the
				 * answer is almost always already known. The two-second race in
				 * PRD 8.1 is the fallback for the case where it is not.
				 *
				 * The token is absent whenever the Mac is asleep, which is also
				 * exactly when there is nothing to negotiate with.
				 */
				const token = result.inbox.signal_token;
				if (token) {
					const session = openLanSession(token);
					lan.current = session;
					void session.ready.then((channel) => {
						if (!cancelled) setLanReady(channel !== null);
					});
				}
			} catch {
				if (!cancelled) {
					setTitle("This link is not active");
					setScreen("missing");
				}
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [slug]);

	useEffect(
		() => () => {
			stopWatching.current?.();
			lan.current?.close();
		},
		[],
	);

	const unlock = useCallback(async () => {
		if (!inbox?.password.salt) return;
		setError(null);
		const derived = await deriveVerifier(
			password,
			inbox.password.salt,
			inbox.password.iterations ?? 210_000,
		);
		setVerifier(derived);
		setScreen("ready");
	}, [inbox, password]);

	const send = useCallback(
		async (selected: File[], resume?: ResumeRecord) => {
			if (!inbox || selected.length === 0) return;

			setScreen("sending");
			setError(null);
			abort.current = new AbortController();

			const initial: UploadProgress[] = selected.map((file) => ({
				fileId: null,
				name: file.name,
				size: file.size,
				sent: 0,
				phase: "queued",
			}));
			setFiles(initial);

			/*
			 * PRD 8.1 — try the direct path, give it two seconds, take the relay
			 * otherwise. Resuming is relay-only (there are no parts to resume on a
			 * DataChannel), so a resumed batch does not race at all.
			 */
			let channel: RTCDataChannel | null = null;
			if (lan.current && !resume) {
				channel = await Promise.race([
					lan.current.ready,
					new Promise<null>((settle) => setTimeout(() => settle(null), 2000)),
				]);
			}
			setTransport(channel ? "lan" : "relay");

			const via = new URLSearchParams(location.search).get("via") ?? "link";
			const onProgress = (index: number) => (progress: UploadProgress) => {
				setFiles((current) =>
					current.map((entry, position) =>
						position === index ? { ...entry, ...progress } : entry,
					),
				);
			};
			const onTransferCreated = (transferId: string, token: string) => {
				transfer.current = { id: transferId, token };
				stopWatching.current?.();
				stopWatching.current = watchTransfer(token, (event) => {
					if (event.type === "presence") setOnline(Boolean(event.online));
					if (event.type === "file.delivered" && typeof event.file_id === "string") {
						const id = event.file_id;
						setDelivered((current) => new Set(current).add(id));
					}
				});
			};

			for (let index = 0; index < selected.length; index++) {
				const file = selected[index];
				const callbacks = { onProgress: onProgress(index), onTransferCreated };
				const common = { password: verifier, via, signal: abort.current.signal };
				try {
					if (channel && channel.readyState === "open") {
						try {
							await sendFileOverLan(file, inbox, channel, common, callbacks);
							continue;
						} catch (lanFailure) {
							// An abort is the sender's decision, not a transport failure.
							if (abort.current?.signal.aborted) throw lanFailure;
							/*
							 * The direct path broke mid-file. There is nothing parked in R2
							 * to continue from — that is what makes LAN cheap — so this file
							 * starts again over the relay. It was a local transfer, so what
							 * is being re-sent cost seconds.
							 *
							 * The transfer that was in flight is withdrawn rather than left
							 * to expire, so it stops occupying the owner's pending quota.
							 */
							if (transfer.current) {
								await abortTransfer(transfer.current.id, transfer.current.token).catch(() => {});
							}
							channel = null;
							setTransport("relay");
							setLanReady(false);
							setFiles((current) =>
								current.map((entry, position) =>
									position === index ? { ...entry, sent: 0, phase: "encrypting" } : entry,
								),
							);
						}
					}
					await uploadFile(
						file,
						inbox,
						{ ...common, resume: index === 0 ? resume : undefined },
						callbacks,
					);
				} catch (failure) {
					const message =
						failure instanceof Error ? failure.message : "The upload could not finish.";
					setFiles((current) =>
						current.map((entry, position) =>
							position === index ? { ...entry, phase: "failed", error: message } : entry,
						),
					);
					setError(message);
				}
			}

			setScreen("finished");
			if (inbox) setResumable(await listResumable(inbox.slug));
		},
		[inbox, verifier],
	);

	const cancel = useCallback(async () => {
		abort.current?.abort();
		if (transfer.current) {
			// PRD 8.5 — the sender can withdraw anything not yet delivered.
			await abortTransfer(transfer.current.id, transfer.current.token).catch(() => {});
		}
		setScreen("ready");
		setFiles([]);
	}, []);

	if (screen === "loading") {
		return (
			<main className="page">
				<p className="note">Loading…</p>
			</main>
		);
	}

	if (screen === "missing" || !inbox) {
		return (
			<main className="page">
				<div className="card">
					<h1 className="inbox-title">This link is not active</h1>
					<p style={{ color: "var(--text-dim)" }}>
						It may have been reset by its owner, or it never existed. Ask the person who
						sent it to you for a current link.
					</p>
				</div>
			</main>
		);
	}

	const title = `Send files to ${inbox.display_name}`;

	if (screen === "locked") {
		return (
			<main className="page">
				<h1 className="inbox-title">{title}</h1>
				<p className="status">
					<span className="dot" />
					This inbox is password protected
				</p>
				<div className="card">
					<div className="row">
						<input
							type="password"
							value={password}
							placeholder="Password"
							onChange={(event) => setPassword(event.target.value)}
							onKeyDown={(event) => {
								if (event.key === "Enter") void unlock();
							}}
						/>
						<button className="primary" onClick={() => void unlock()} disabled={!password}>
							Unlock
						</button>
					</div>
					<p className="note" style={{ textAlign: "left", marginTop: 14 }}>
						The password is checked in your browser and never sent to our servers.
					</p>
				</div>
				{error && <p className="error">{error}</p>}
			</main>
		);
	}

	if (inbox.paused) {
		return (
			<main className="page">
				<h1 className="inbox-title">{title}</h1>
				<p className="status">
					<span className="dot" />
					Not accepting files right now
				</p>
				<div className="callout">
					<p>
						The owner has paused this inbox. Your files would not be delivered, so nothing
						is being accepted. Try again later.
					</p>
				</div>
			</main>
		);
	}

	/*
	 * PRD 16.2 — the allowance ran out.
	 *
	 * Only a refusal if the direct path is also unavailable. A spent allowance is
	 * a fact about the *relay*, and a file that never touches the relay costs the
	 * owner nothing — so on the same Wi-Fi this inbox still works perfectly, and
	 * saying otherwise would be turning away a file we could deliver.
	 *
	 * Told as a fact about the inbox, not as a failure and not as an error: the
	 * sender did nothing wrong, and they are a stranger who should not be reading
	 * anything about someone else's plan or bill. "Ask the person you are sending
	 * to" is the whole of the escalation path, deliberately — they are the only
	 * one who can act on it.
	 */
	if (!inbox.relay_available && !lanReady) {
		return (
			<main className="page">
				<h1 className="inbox-title">{title}</h1>
				<p className="status">
					<span className="dot" />
					Not accepting files right now
				</p>
				<div className="callout">
					<p>
						This inbox has reached its limit for this month. Nothing is wrong with your
						files — try again after the 1st, or let {inbox.display_name} know you are
						waiting to send something.
					</p>
				</div>
			</main>
		);
	}

	const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
	const sentBytes = files.reduce((sum, file) => sum + file.sent, 0);
	const overall = totalBytes > 0 ? Math.min(1, sentBytes / totalBytes) : 0;
	const allDelivered =
		files.length > 0 && files.every((file) => file.fileId && delivered.has(file.fileId));

	return (
		<main className="page">
			<h1 className="inbox-title">{title}</h1>

			{/*
			 * PRD 11.1 vs 11.2. The offline copy is the difference that matters:
			 * the sender is told their files will arrive, not that they failed.
			 */}
			<p className="status">
				<span className={`dot ${online ? "online" : "asleep"}`} />
				{online ? "Online · ready to receive" : "Mac is asleep"}
			</p>

			{!online && screen === "ready" && (
				<div className="callout">
					<p>
						Files will be encrypted and delivered automatically the moment it wakes up.
						They are kept for up to {inbox.ttl_hours} hours.
					</p>
				</div>
			)}

			{screen === "ready" && resumable.length > 0 && (
				<div className="callout warn">
					<p>
						<strong>Unfinished upload:</strong> {resumable[0].file_name} (
						{formatBytes(resumable[0].file_size)}).
					</p>
					<p>
						Your browser cannot reopen a file on its own, so choose the same file again and
						the upload continues from where it stopped.
						{" "}
						<button
							className="link"
							onClick={() => {
								pendingResume.current = resumable[0];
								resumeInputRef.current?.click();
							}}
						>
							Choose file to continue
						</button>
					</p>
					<input
						ref={resumeInputRef}
						className="hidden-input"
						type="file"
						onChange={(event) => {
							const file = event.target.files?.[0];
							const record = pendingResume.current;
							if (!file || !record) return;
							if (!matches(record, file)) {
								setError("That is a different file. Choose the same one to continue.");
								return;
							}
							void send([file], record);
						}}
					/>
				</div>
			)}

			{screen === "ready" && (
				<>
					<div
						className={`drop ${dragging ? "active" : ""}`}
						onClick={() => inputRef.current?.click()}
						onDragOver={(event) => {
							event.preventDefault();
							setDragging(true);
						}}
						onDragLeave={() => setDragging(false)}
						onDrop={(event) => {
							event.preventDefault();
							setDragging(false);
							void send(Array.from(event.dataTransfer.files));
						}}
					>
						<strong>{CAN_DROP ? "Drop files here" : "Choose files"}</strong>
						<span>{CAN_DROP ? "or choose files" : "photos, videos, anything"}</span>
					</div>
					<input
						ref={inputRef}
						className="hidden-input"
						type="file"
						multiple
						onChange={(event) => void send(Array.from(event.target.files ?? []))}
					/>
					<p className="note">
						Encrypted in your browser.
						<br />
						Only this Mac can open them.
					</p>

					<TerminalHint url={inbox.url} passworded={inbox.password.required} />
				</>
			)}

			{(screen === "sending" || screen === "finished") && (
				<div className="card">
					<p style={{ margin: "0 0 14px", color: "var(--text-dim)", fontSize: "0.9rem" }}>
						{files.length} {files.length === 1 ? "file" : "files"} · {formatBytes(totalBytes)}
					</p>

					<ul className="files">
						{files.map((file, index) => {
							const isDelivered = file.fileId ? delivered.has(file.fileId) : false;
							const percent = file.size > 0 ? Math.round((file.sent / file.size) * 100) : 100;
							return (
								<li className="file" key={`${file.name}-${index}`}>
									<span
										className={`file-icon ${
											file.phase === "failed" ? "failed" : file.phase === "done" ? "done" : ""
										}`}
									>
										{file.phase === "failed"
											? "✕"
											: file.phase === "done"
												? "✓"
												: file.phase === "queued"
													? "○"
													: "↓"}
									</span>
									<span className="file-name">{file.name}</span>
									<span className="file-meta">
										{file.phase === "failed"
											? "failed"
											: file.phase === "queued"
												? "queued"
												: file.phase === "done"
													? isDelivered
														? "delivered"
														: "waiting"
													: `${percent}%`}
									</span>
								</li>
							);
						})}
					</ul>

					{screen === "sending" && (
						<>
							<div className="overall">
								<span>Overall</span>
								<div className="bar">
									<div style={{ width: `${Math.round(overall * 100)}%` }} />
								</div>
								<span>{Math.round(overall * 100)}%</span>
							</div>
							{/*
							 * The transport marker is deliberately quiet: it tells you how it
							 * went without asking you to care. Nobody chose this and nobody
							 * can — the network decided — so it is a note, not a control.
							 */}
							<span className="transport">
								{transport === "lan" ? "⚡ Direct — same network" : "☁ Encrypted relay"}
							</span>
							<div className="row" style={{ marginTop: 16 }}>
								<button onClick={() => void cancel()}>Cancel upload</button>
							</div>
						</>
					)}

					{screen === "finished" && (
						<div className="callout" style={{ marginTop: 4, marginBottom: 0 }}>
							{allDelivered ? (
								// PRD 11.4 — "Delivered", never "Uploaded". The sender cares that it
								// arrived, not that a server accepted it.
								<p>
									<strong>✓ Delivered</strong> to {inbox.display_name}.
								</p>
							) : (
								<p>
									<strong>✓ Queued for delivery.</strong> Will be delivered when{" "}
									{inbox.display_name} comes online. Expires in {inbox.ttl_hours} hours.
								</p>
							)}
						</div>
					)}

					{screen === "finished" && (
						<div className="row" style={{ marginTop: 16 }}>
							<button
								onClick={() => {
									setFiles([]);
									setDelivered(new Set());
									setError(null);
									setScreen("ready");
								}}
							>
								Send more files
							</button>
						</div>
					)}
				</div>
			)}

			{error && <p className="error">{error}</p>}
		</main>
	);
}
