import { useCallback, useEffect, useRef, useState } from "react";
import {
	abortTransfer,
	deriveVerifier,
	resolveInbox,
	watchTransfer,
	type InboxInfo,
} from "../lib/api.ts";
import { formatBytes } from "../lib/format.ts";
import { listResumable, matches, type ResumeRecord } from "../lib/resume.ts";
import { uploadFile, type UploadProgress } from "../lib/uploader.ts";

type Screen = "loading" | "missing" | "locked" | "ready" | "sending" | "finished";

function sessionId(): string {
	const key = "stolnk-session";
	let value = sessionStorage.getItem(key);
	if (!value) {
		const bytes = crypto.getRandomValues(new Uint8Array(12));
		value = btoa(String.fromCharCode(...bytes)).replace(/[+/=]/g, "");
		sessionStorage.setItem(key, value);
	}
	return value;
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
	/// PRD 13.2 — an inbox that confirms first parks the file on a person, not
	/// on the network. "Uploaded" would be a lie about who is holding it up.
	const [reception, setReception] = useState<Map<string, "awaiting" | "accepted">>(new Map());
	const [resumable, setResumable] = useState<ResumeRecord[]>([]);
	const [dragging, setDragging] = useState(false);

	const inputRef = useRef<HTMLInputElement>(null);
	const resumeInputRef = useRef<HTMLInputElement>(null);
	const pendingResume = useRef<ResumeRecord | null>(null);
	const abort = useRef<AbortController | null>(null);
	const stopWatching = useRef<(() => void) | null>(null);
	const transfer = useRef<{ id: string; token: string } | null>(null);

	useEffect(() => {
		let cancelled = false;
		(async () => {
			try {
				const result = await resolveInbox(slug);
				if (cancelled) return;
				if (!result.inbox) {
					setScreen("missing");
					return;
				}
				setInbox(result.inbox);
				setOnline(result.inbox.online);
				setScreen(result.inbox.password.required ? "locked" : "ready");
				setResumable(await listResumable(result.inbox.slug));
			} catch {
				if (!cancelled) setScreen("missing");
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [slug]);

	useEffect(() => () => stopWatching.current?.(), []);

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

			for (let index = 0; index < selected.length; index++) {
				const file = selected[index];
				try {
					await uploadFile(
						file,
						inbox,
						{
							password: verifier,
							senderSession: sessionId(),
							via: new URLSearchParams(location.search).get("via") ?? "link",
							resume: index === 0 ? resume : undefined,
							signal: abort.current.signal,
						},
						{
							onProgress: (progress) => {
								setFiles((current) =>
									current.map((entry, position) =>
										position === index ? { ...entry, ...progress } : entry,
									),
								);
							},
							onTransferCreated: (transferId, token) => {
								transfer.current = { id: transferId, token };
								stopWatching.current?.();
								stopWatching.current = watchTransfer(token, (event) => {
									if (event.type === "presence") setOnline(Boolean(event.online));
									if (event.type === "file.delivered" && typeof event.file_id === "string") {
										const id = event.file_id;
										setDelivered((current) => new Set(current).add(id));
									}
									if (event.type === "file.declined") {
										setError("The recipient declined this transfer.");
									}
									if (
										(event.type === "file.awaiting" || event.type === "file.accepted") &&
										typeof event.file_id === "string"
									) {
										const id = event.file_id;
										const phase = event.type === "file.awaiting" ? "awaiting" : "accepted";
										setReception((current) => new Map(current).set(id, phase));
									}
								});
							},
						},
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
	 * PRD 16.2 — the allowance ran out. Relay is the only transport in V1, so
	 * nothing can be accepted until the month turns over or the owner upgrades.
	 *
	 * Told as a fact about the inbox, not as a failure and not as an error: the
	 * sender did nothing wrong, and they are a stranger who should not be reading
	 * anything about someone else's plan or bill. "Ask the person you are sending
	 * to" is the whole of the escalation path, deliberately — they are the only
	 * one who can act on it.
	 */
	if (!inbox.relay_available) {
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
	const awaitingConfirmation = files.some(
		(file) => file.fileId && !delivered.has(file.fileId) && reception.has(file.fileId),
	);

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
						<strong>Drop files here</strong>
						<span>or choose files</span>
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
							const phase = file.fileId ? reception.get(file.fileId) : undefined;
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
														: phase === "accepted"
															? "receiving"
															: phase === "awaiting"
																? "awaiting OK"
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
							 * went without asking you to care. Only the relay path exists today.
							 */}
							<span className="transport">☁ Encrypted relay</span>
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
							) : awaitingConfirmation ? (
								// Not a network delay — someone has to say yes. Saying "will be
								// delivered when it comes online" here would send the sender
								// looking for a fault that is not there.
								<p>
									<strong>✓ Uploaded.</strong> Waiting for {inbox.display_name} to accept it.
									Expires in {inbox.ttl_hours} hours.
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
									setReception(new Map());
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
