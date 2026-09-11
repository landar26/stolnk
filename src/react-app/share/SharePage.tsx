import { useEffect, useMemo, useState } from "react";
import { ApiError, deriveVerifier, lookupShare, unlockShare, type ShareInfo } from "../lib/api";
import { formatBytes } from "../lib/format";

type Screen = "loading" | "missing" | "locked" | "ready" | "downloading";

function downloadURL(code: string, info: ShareInfo): string {
	const path = `/~${code}/${encodeURIComponent(info.filename ?? "download")}`;
	return info.token ? `${path}?t=${encodeURIComponent(info.token)}` : path;
}

export function SharePage({ code }: { code: string }) {
	const [screen, setScreen] = useState<Screen>("loading");
	const [info, setInfo] = useState<ShareInfo | null>(null);
	const [password, setPassword] = useState("");
	const [error, setError] = useState("");

	useEffect(() => {
		let current = true;
		lookupShare(code)
			.then((next) => {
				if (!current) return;
				setInfo(next);
				setScreen(next.password.required ? "locked" : "ready");
			})
			.catch(() => current && setScreen("missing"));
		return () => {
			current = false;
		};
	}, [code]);

	const href = useMemo(() => (info?.filename ? downloadURL(code, info) : "#"), [code, info]);

	async function unlock() {
		if (!info?.password.salt || !info.password.iterations || !password) return;
		setError("");
		try {
			const verifier = await deriveVerifier(password, info.password.salt, info.password.iterations);
			const unlocked = await unlockShare(code, verifier);
			setInfo(unlocked);
			setScreen("ready");
		} catch (reason) {
			setError(reason instanceof ApiError ? reason.message : "无法解锁这个链接。");
		}
	}

	if (screen === "loading") return <main className="page" />;
	if (screen === "missing") {
		return (
			<main className="page">
				<section className="card">
					<h1 className="inbox-title">这个链接不可用</h1>
					<p className="note">它可能已过期、已用完，或被发送者撤销了。</p>
				</section>
			</main>
		);
	}

	if (screen === "locked") {
		return (
			<main className="page">
				<section className="card">
					<div className="status"><span className="dot" />受密码保护</div>
					<h1 className="inbox-title">解锁分享</h1>
					<p className="note">输入发送者提供的密码后才能看到文件详情。</p>
					<div className="row">
						<input
							type="password"
							value={password}
							onChange={(event) => setPassword(event.target.value)}
							onKeyDown={(event) => event.key === "Enter" && void unlock()}
							placeholder="密码"
							autoFocus
						/>
						<button className="button primary" onClick={() => void unlock()}>解锁</button>
					</div>
					{error && <p className="error">{error}</p>}
					<p className="note">密码在你的浏览器里校验，从不发送到我们的服务器。</p>
				</section>
			</main>
		);
	}

	return (
		<main className="page">
			<section className="card">
				<div className="status"><span className="dot" />可以下载</div>
				<h1 className="inbox-title">{info?.filename}</h1>
				<div className="file">
					<div className="file-icon">↓</div>
					<div><div className="file-name">{info?.filename}</div><div className="file-meta">{formatBytes(info?.size ?? 0)}</div></div>
				</div>
				{info?.downloads_left === 1 && (
					<div className="callout warn">这个链接只能用一次。下载一开始就会计数并删除服务器上的文件，即使下载中断也是如此。</div>
				)}
				<div className="callout">这个文件以未加密形式存放在我们的服务器上，这样任何浏览器都能打开这条链接。和发往 Stolnk 收件箱的文件不同，我们能读到它。链接过期时它会被删除。</div>
				<a
					className="button primary"
					href={href}
					download
					onClick={() => setScreen("downloading")}
				>
					{screen === "downloading" ? "正在下载…" : "下载文件"}
				</a>
				<p className="download-meta">
					有效期至 {info?.expires_at ? new Date(info.expires_at).toLocaleString() : "—"}
					{info?.downloads_left != null ? ` · 剩余 ${info.downloads_left} 次` : ""}
				</p>
				<div className="agents">
					<p className="note">也可以在终端下载：</p>
					<code className="cmd">
						{info?.password.required
							? `curl -LO -H "X-Stolnk-Password: 你的密码" "${location.origin}/~${code}/${encodeURIComponent(info.filename ?? "download")}"`
							: `curl -LO "${location.origin}/~${code}"`}
					</code>
				</div>
			</section>
		</main>
	);
}
