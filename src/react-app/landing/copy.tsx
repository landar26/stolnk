import {
	COMPANY_EN,
	COMPANY_ZH,
	DISCORD_URL,
	SUPPORT_EMAIL,
	X_HANDLE,
	X_URL,
} from "./contact.ts";
import { legalEn, legalZh } from "./copy-legal.tsx";
import { pagesEn, pagesZh } from "./copy-pages.tsx";

/**
 * Every word on the marketing side of the site, in both languages.
 *
 * It lives in one dictionary rather than beside each component so that a
 * translation cannot quietly go missing: `zh` is typed as `typeof en`, so
 * adding an English key without a Chinese one fails `tsc -b` instead of
 * rendering `undefined` on a page nobody reloads in that language.
 *
 * The send page deliberately does not use this. Its bundle is the one PRD 9.4
 * commits to keeping small enough to audit, and a marketing dictionary is
 * exactly the kind of weight that promise exists to keep out — which is why
 * `main.tsx` loads everything under `landing/` as a separate chunk.
 */
export type Lang = "en" | "zh";

const en = {
	langLabel: "中文",
	skipToContent: "Skip to content",

	nav: {
		home: "Stolnk",
		menu: "Menu",
		links: [
			{ label: "Use cases", href: "/#scenarios" },
			{ label: "Features", href: "/#features" },
			{ label: "Compare", href: "/compare" },
			{ label: "Pricing", href: "/pricing" },
			{ label: "FAQ", href: "/#faq" },
		],
		cta: "Download",
		discord: "Discord",
	},

	hero: {
		badge: (version: string) => `v${version} · latest build`,
		badgeFallback: "For macOS 13 and later",
		title: "Turn your folders into inboxes.",
		lede: "Share a link. Anyone can send you files — no account, no app. They land in the right folder on your Mac, even when it's asleep.",
		cta: "Download for Mac",
		meta: "Free to start · macOS 13+",
		/*
		 * Said in the hero rather than left to be discovered. A Windows reader who
		 * gets as far as the download page before finding out leaves annoyed; one
		 * who is told in the first screen either leaves an address or leaves
		 * quickly, and both of those are better outcomes than the first.
		 */
		windows: "On Windows? Get told when it lands →",
		figureFrom: "ryan.stolnk.com/client-a",
		figureTo: "~/Projects/ClientA/Incoming",
		figureCaption: "One link. One folder. Nothing in between to check.",
	},

	scenarios: {
		title: "Three ways people use it",
		lede: "Same mechanism every time — a link that ends in a folder you chose.",
		items: [
			{
				n: "01",
				name: "Client uploads",
				note: "Deliverables land straight in the project folder",
				from: "acme.stolnk.com/client-a",
				meta: "no account, no app",
				to: "~/Projects/ClientA/Incoming",
			},
			{
				n: "02",
				name: "Shoot handoff",
				note: "4K footage with no cloud drive in between",
				from: "studio.stolnk.com/shoot-0913",
				meta: "4.2 GB · encrypted in the browser",
				to: "/Volumes/Media/Shoot0913",
			},
			{
				n: "03",
				name: "Phone → Mac",
				note: "Scan the QR code from the menu bar and send",
				from: "ryan.stolnk.com/phone",
				meta: "scanned, not typed",
				to: "~/Desktop/Inbox",
			},
		],
	},

	routing: {
		figureFrom: "ryan.stolnk.com/photos",
		figureMeta: "one of as many as you like",
		figureTo: "~/Pictures/Client Shoots",
		title: "One link per folder.",
		lede: "Give your client a link, your photographer another one. Everything arrives exactly where it belongs, and you never sort a Downloads folder again.",
		cards: [
			{
				title: "An address of your own",
				body: "A name you pick, and a path per folder. Rename it and the old one is free the same second.",
			},
			{
				title: "Nothing for the sender",
				body: "They open the link in any browser and drop a file. No account to create, nothing to install, no app to be nagged about.",
			},
			{
				title: "It lands, it does not queue up in a chat",
				body: "A notification when a file arrives, and Finder opens on the folder it went to.",
			},
		],
	},

	sleep: {
		title: "Arrives while your Mac sleeps.",
		lede: "Close the lid mid-transfer. The encrypted bytes wait, and land the moment your Mac wakes. The sender is never shown a failure for something that is not their fault.",
		cards: [
			{
				title: "Held, not bounced",
				body: "Up to 24 hours on Free, 7 days on Pro. The sender is told it will be delivered when your Mac wakes — because it will be.",
			},
			{
				title: "Deleted on arrival",
				body: "The stored copy is removed the moment your Mac confirms the file landed. Not on a schedule — immediately.",
			},
			{
				title: "Resumable, in 64 MiB parts",
				body: "A dropped connection resumes where it stopped instead of starting a 4 GB upload over.",
			},
		],
		figureAsleep: "Mac asleep",
		figureAwake: "Mac awake",
		figureQueued: "waiting",
		figureLanded: "landed",
	},

	crypto: {
		title: "Encrypted in the browser. Only your Mac can open it.",
		lede: "We route your files. We can't read them — not in transit, not at rest. Your Mac's keys are generated in its Secure Enclave and cannot be exported.",
		cards: [
			{
				title: "Keys that cannot leave",
				body: "Two P-256 keypairs, generated inside the Secure Enclave on first launch. The private halves never touch memory or disk.",
			},
			{
				title: "Filenames too",
				body: "Not just contents. The name travels encrypted with the file, though its length can be inferred from the ciphertext — and we say so.",
			},
			{
				title: "The limitation, stated",
				body: "The encryption runs in JavaScript we serve. Every browser-delivered E2EE product shares that, and we explain it rather than saying zero knowledge.",
			},
		],
		link: "How it works →",
		figurePlain: "quarterly-review.mp4",
		figureCipher: "8f3ac91e2b7d40f6…",
	},

	features: {
		title: "What it actually does",
		lede: "A menu bar app, a link, and a folder. The list is short because the product is.",
		items: [
			{
				title: "Menu bar only",
				body: "No Dock icon, no window unless you open one.",
			},
			{
				title: "Folders you choose",
				body: "Anywhere on disk, including external volumes. It writes nowhere else.",
			},
			{
				title: "Quarantined like a download",
				body: "Every received file is marked com.apple.quarantine, exactly as a browser download would be.",
			},
			{
				title: "Does not keep your Mac awake",
				body: "It sleeps when your Mac sleeps. That is the whole point.",
			},
			{
				title: "Tampering is refused, not written",
				body: "Reordered or altered parts fail verification and never reach the folder.",
			},
			{
				title: "Names are sanitised",
				body: "A hostile filename — leading dots, path separators, right-to-left overrides — lands as a safe one.",
			},
			{
				title: "The sender is told the truth",
				body: "Delivered, or will be delivered when it wakes. Never a success that did not happen.",
			},
			{
				title: "Signed, notarised, hashed",
				body: "Developer ID signed and notarised by Apple, with every build's SHA-256 published on the download page.",
			},
		],
	},

	roadmap: {
		title: "Coming in V1.x",
		lede: "Not built yet, so they are not part of what the price promises today. They arrive as ordinary updates, included.",
		items: [
			"Turning on a password for a link, from the Mac app",
			"Expiring and single-use links",
			"A webhook when a file lands",
			"Dropping a whole folder into the send page",
		],
	},

	/*
	 * The promise in `doneBody` is deliberately narrow, and the endpoint is built
	 * to keep it: one table, no marketing list, nothing joined to it. An address
	 * given for a single announcement should not turn into a mailing list, and
	 * saying so plainly is also the only reason a stranger types one in.
	 */
	waitlist: {
		title: "Not on a Mac?",
		lede: "Stolnk is macOS only today. The receiving half has to run on the machine the files land on, and that half does not exist for Windows yet — so rather than a date, here is a way to hear about it first.",
		placeholder: "you@example.com",
		cta: "Notify me",
		sending: "Sending…",
		doneTitle: "You're on the list.",
		doneBody: "One email, on the day a Windows build ships. Nothing else, ever.",
		failed: "That did not go through. Check the address and try again.",
		tooMany: "Too many tries just now. Give it a minute.",
	},

	pricingTeaser: {
		title: "Paid once, not monthly.",
		lede: "Free covers one inbox and 3 GB of relayed files a month. Pro is a single payment for three Macs, as many inboxes as you want, and 300 GB a month.",
		more: "See everything that's included →",
	},

	faq: {
		title: "Questions people actually ask",
		items: [
			{
				q: "Does the sender need an account, or an app?",
				a: "Neither. They open the link in any modern browser and drop a file in. There is nothing to install and nothing to sign up for — that is the reason the product exists in this shape.",
			},
			{
				q: "What happens if my Mac is asleep?",
				a: "The encrypted file waits — up to 24 hours on Free, 7 days on Pro — and is delivered the moment your Mac wakes. The sender sees “will be delivered when it wakes”, not an error.",
			},
			{
				q: "Can I move to a new Mac?",
				a: "Not with the same keys. They are generated inside the Secure Enclave and cannot be exported, so a new machine means new keys, and anything still queued for the old one becomes undecryptable. Clear your queue before you switch.",
			},
			{
				q: "What can you see?",
				a: "File sizes, when they were sent, which inbox they were addressed to, and your Mac's public keys. Not contents, not filenames, and never the folder on your Mac a file lands in.",
			},
			{
				q: "What happens when I run out of the monthly allowance?",
				a: "Links stop accepting new files until the month turns over, and start again on their own. Nothing is ever billed on top — there is no mechanism in Stolnk that could produce an invoice.",
			},
			{
				q: "How big can a single file be?",
				a: "2 GB on Free, 20 GB on Pro. Uploads go up in 64 MiB parts, so a dropped connection resumes rather than restarts.",
			},
			{
				q: "Refunds?",
				a: "14 days, no questions — email and it is done. A refund puts that Mac back on Free and pauses any inbox beyond the first. Nothing is deleted.",
			},
		],
	},

	cta: {
		title: "Give your first folder an address.",
		lede: "Free to start: one inbox, 3 GB of relayed files a month, and nobody has to create an account to send you something.",
		button: "Download for Mac",
	},

	footer: {
		groups: [
			{
				title: "Product",
				links: [
					{ label: "Download", href: "/download" },
					{ label: "How it works", href: "/how-it-works" },
					{ label: "Pricing", href: "/pricing" },
					{ label: "Roadmap", href: "/#roadmap" },
				],
			},
			{
				title: "Compare",
				links: [
					{ label: "vs cloud drives", href: "/compare" },
					{ label: "vs AirDrop", href: "/compare" },
					{ label: "vs transfer links", href: "/compare" },
				],
			},
			{
				title: "Company",
				links: [
					{ label: "Support", href: `mailto:${SUPPORT_EMAIL}` },
					{ label: "Discord", href: DISCORD_URL },
					{ label: `X (${X_HANDLE})`, href: X_URL },
				],
			},
			{
				title: "Legal",
				links: [
					{ label: "Privacy", href: "/privacy" },
					{ label: "Terms of Service", href: "/terms" },
				],
			},
		],
		copyright: COMPANY_EN,
	},

	compare: {
		title: "How Stolnk differs",
		lede: "Four ways a file gets from someone else onto your Mac. None of these is bad at its own job — they are just built around different assumptions, and only one of them ends in a folder you chose.",
		columns: ["Stolnk", "Cloud drive", "Transfer link", "AirDrop"],
		rows: [
			{
				label: "Sender needs an account",
				values: ["No", "Usually, to upload to yours", "No", "An Apple device"],
			},
			{
				label: "Sender installs something",
				values: ["No", "Often", "No", "Built in, Apple only"],
			},
			{
				label: "Where the file ends up",
				values: [
					"The folder you chose, on your Mac",
					"The drive's own folder, then syncs",
					"Your Downloads folder, after you fetch it",
					"Your Downloads folder",
				],
			},
			{
				label: "While your Mac is asleep",
				values: [
					"Held, then delivered on wake",
					"Syncs when it next runs",
					"Waits for you to click the link, until it expires",
					"Nothing is sent",
				],
			},
			{
				label: "End-to-end encrypted",
				values: ["Yes, in the sender's browser", "Depends on the provider", "Generally not", "Yes"],
			},
			{
				label: "Across networks",
				values: ["Yes", "Yes", "Yes", "Same room, roughly"],
			},
			{
				label: "You do the filing",
				values: ["No", "Sometimes", "Yes, every time", "Yes, every time"],
			},
			{
				label: "Billing",
				values: ["One payment", "Subscription", "Subscription, above a free tier", "Free"],
			},
		],
		note: "Capabilities of the default configuration, as of this writing. Any of them can change, and a paid tier of any of these products may behave differently — check before you rely on a row.",
		notGood: {
			title: "What Stolnk is not for",
			items: [
				"It is not sync. A file lands once and stays where it landed; changing it later on either side changes nothing on the other.",
				"It is not backup. Once your Mac has the file, we have deleted our copy — that is the design, and it means there is nothing to restore from.",
				"It only goes one way, inward. There is no way to share a file back out of a folder.",
				"The encryption runs in JavaScript we serve, which is a real limitation we describe in full.",
				"Keys cannot move to a new Mac, so switching machines means a new address and a cleared queue.",
			],
			link: "The full honest version →",
		},
		cta: "Download for Mac",
	},

	legal: legalEn,
	pages: pagesEn,
};

export type Dict = typeof en;

const zh: Dict = {
	langLabel: "EN",
	skipToContent: "跳到正文",

	nav: {
		home: "Stolnk",
		menu: "菜单",
		links: [
			{ label: "使用场景", href: "/#scenarios" },
			{ label: "功能", href: "/#features" },
			{ label: "对比", href: "/compare" },
			{ label: "定价", href: "/pricing" },
			{ label: "常见问题", href: "/#faq" },
		],
		cta: "下载",
		discord: "Discord 社群",
	},

	hero: {
		badge: (version: string) => `v${version} · 最新构建`,
		badgeFallback: "适用于 macOS 13 及以上",
		title: "把文件夹变成收件箱。",
		lede: "分享一条链接，任何人都能给你发文件——不用注册，不用装 App。文件会落进你 Mac 上指定的那个文件夹，哪怕它正在睡觉。",
		cta: "下载 Mac 版",
		meta: "免费开始 · 需要 macOS 13+",
		windows: "用 Windows？做好了第一时间通知你 →",
		figureFrom: "ryan.stolnk.com/client-a",
		figureTo: "~/Projects/ClientA/Incoming",
		figureCaption: "一条链接，一个文件夹，中间没有需要你去查看的环节。",
	},

	scenarios: {
		title: "三种常见用法",
		lede: "机制每次都一样——一条链接，终点是你自己选的文件夹。",
		items: [
			{
				n: "01",
				name: "客户交付",
				note: "甲方的文件直接落进项目文件夹",
				from: "acme.stolnk.com/client-a",
				meta: "不用注册，不用装 App",
				to: "~/Projects/ClientA/Incoming",
			},
			{
				n: "02",
				name: "素材回收",
				note: "4K 素材不用先过一遍网盘",
				from: "studio.stolnk.com/shoot-0913",
				meta: "4.2 GB · 在浏览器里就已加密",
				to: "/Volumes/Media/Shoot0913",
			},
			{
				n: "03",
				name: "手机 → Mac",
				note: "扫一下菜单栏里的二维码就能传",
				from: "ryan.stolnk.com/phone",
				meta: "扫码，不用手输",
				to: "~/Desktop/Inbox",
			},
		],
	},

	routing: {
		figureFrom: "ryan.stolnk.com/photos",
		figureMeta: "想开几个就开几个",
		figureTo: "~/Pictures/Client Shoots",
		title: "一条链接，对应一个文件夹。",
		lede: "给客户一条链接，给摄影师另一条。每份文件都精确地落在该去的地方，你再也不用从「下载」文件夹里往外扒。",
		cards: [
			{
				title: "一个属于你的地址",
				body: "名字你自己起，每个文件夹配一段路径。改名之后，旧名字同一秒就被释放。",
			},
			{
				title: "发送方什么都不用做",
				body: "用任意浏览器打开链接，把文件拖进去就行。不用注册账号，不用安装任何东西，也没有 App 反复提醒他更新。",
			},
			{
				title: "它是「到货」，不是躺在聊天记录里",
				body: "文件到达时会有一条通知，Finder 会直接打开它落进的那个文件夹。",
			},
		],
	},

	sleep: {
		title: "你的 Mac 睡着时，文件照样到。",
		lede: "传到一半合上盖子也没关系。密文会等着，等你的 Mac 一醒就落盘。发送方不会因为一件不是他造成的事而看到失败。",
		cards: [
			{
				title: "是保留，不是打回",
				body: "免费版最多 24 小时，专业版 7 天。发送方看到的是「等它醒来就会送达」——因为确实会。",
			},
			{
				title: "一到货就删",
				body: "你的 Mac 一确认落盘，存储里那份副本立刻删除。不是按计划清理，是立刻。",
			},
			{
				title: "可续传，按 64 MiB 分片",
				body: "断线后从断点继续，而不是让一个 4 GB 的上传从头再来。",
			},
		],
		figureAsleep: "Mac 睡眠中",
		figureAwake: "Mac 已唤醒",
		figureQueued: "等待中",
		figureLanded: "已落盘",
	},

	crypto: {
		title: "在浏览器里就加密。只有你的 Mac 打得开。",
		lede: "我们只负责转发。我们读不到内容——传输中读不到，存着的时候也读不到。你 Mac 的密钥在 Secure Enclave 里生成，无法导出。",
		cards: [
			{
				title: "出不来的密钥",
				body: "首次启动时在 Secure Enclave 内生成两对 P-256 密钥。私钥那一半从不进入内存，也从不落盘。",
			},
			{
				title: "文件名也一样",
				body: "不只是内容。文件名是跟着文件一起加密传输的——不过从密文长度可以推断出名字的长度，这一点我们也照说不误。",
			},
			{
				title: "局限，明说",
				body: "加密是在我们分发的 JavaScript 里跑的。所有走浏览器的端到端加密产品都有这个问题，我们选择解释它，而不是说一句「零知识」。",
			},
		],
		link: "看它是怎么工作的 →",
		figurePlain: "quarterly-review.mp4",
		figureCipher: "8f3ac91e2b7d40f6…",
	},

	features: {
		title: "它到底做什么",
		lede: "一个菜单栏 App，一条链接，一个文件夹。清单很短，因为产品本身就很短。",
		items: [
			{
				title: "只在菜单栏",
				body: "没有 Dock 图标，你不主动打开就不会有窗口。",
			},
			{
				title: "你自己选文件夹",
				body: "磁盘上任意位置，包括外接卷。除此之外它哪儿都不写。",
			},
			{
				title: "像下载一样被隔离标记",
				body: "每个收到的文件都会打上 com.apple.quarantine，和浏览器下载的行为完全一致。",
			},
			{
				title: "不会拖着你的 Mac 不让睡",
				body: "你的 Mac 睡，它就睡。这本来就是整件事的重点。",
			},
			{
				title: "被篡改的会被拒收，而不是写进去",
				body: "分片被重排或改动都过不了校验，永远到不了你的文件夹。",
			},
			{
				title: "文件名会被清洗",
				body: "带前导点、路径分隔符、从右到左覆写符的恶意文件名，落地时会是一个安全的名字。",
			},
			{
				title: "对发送方说实话",
				body: "要么「已送达」，要么「等它醒来就会送达」。绝不会有一个并没发生的成功。",
			},
			{
				title: "已签名、已公证、有哈希",
				body: "Developer ID 签名并经 Apple 公证，每个构建的 SHA-256 都公布在下载页上。",
			},
		],
	},

	roadmap: {
		title: "V1.x 内会做",
		lede: "还没做出来，所以不属于今天这个价格所承诺的内容。它们会以普通更新的形式发布，已包含在内。",
		items: [
			"在 Mac App 里给某条链接开启密码",
			"可过期链接和一次性链接",
			"文件落盘时触发 webhook",
			"在发送页里直接拖入整个文件夹",
		],
	},

	waitlist: {
		title: "不用 Mac？",
		lede: "Stolnk 目前只有 macOS 版。接收的那一半必须跑在文件最终落地的那台机器上，而这一半在 Windows 上还不存在——与其给一个做不准的日期，不如给你一个第一时间知道的方式。",
		placeholder: "you@example.com",
		cta: "通知我",
		sending: "提交中…",
		doneTitle: "已经记下了。",
		doneBody: "Windows 版发布那天给你发一封邮件。除此之外不会再有别的。",
		failed: "没提交成功，检查一下地址再试一次。",
		tooMany: "刚才试得太频繁了，过一分钟再来。",
	},

	pricingTeaser: {
		title: "买断，不按月。",
		lede: "免费版包含一个收件箱、每月 3 GB 中转流量。专业版一次付清，覆盖三台 Mac、不限收件箱数量，每月 300 GB。",
		more: "看看具体包含什么 →",
	},

	faq: {
		title: "大家真的会问的问题",
		items: [
			{
				q: "发送方需要账号或者 App 吗？",
				a: "都不需要。用任意现代浏览器打开链接，把文件拖进去就行。没有要装的东西，也没有要注册的东西——产品做成这个样子，原因就在这里。",
			},
			{
				q: "如果我的 Mac 正在睡觉会怎样？",
				a: "加密后的文件会等着——免费版最多 24 小时，专业版 7 天——你的 Mac 一醒就送达。发送方看到的是「等它醒来就会送达」，而不是一个错误。",
			},
			{
				q: "能换到新 Mac 上吗？",
				a: "密钥没法一起换过去。它们在 Secure Enclave 内生成且无法导出，所以新机器意味着一套新密钥，还在等旧 Mac 的文件会变得无法解密。换机之前先把队列清空。",
			},
			{
				q: "你们能看到什么？",
				a: "文件大小、发送时间、发往哪个收件箱，以及你 Mac 的公钥。看不到内容，看不到文件名，也永远不知道文件落在你 Mac 上的哪个文件夹。",
			},
			{
				q: "每月额度用完之后会怎样？",
				a: "链接会暂停接收新文件，到下个月自动恢复。永远不会额外扣费——Stolnk 里根本不存在能生成账单的机制。",
			},
			{
				q: "单个文件最大能有多大？",
				a: "免费版 2 GB，专业版 20 GB。上传按 64 MiB 分片，断线之后是续传而不是重来。",
			},
			{
				q: "能退款吗？",
				a: "14 天内无理由，发封邮件就办好。退款会把这台 Mac 退回免费版，并暂停第一个之外的收件箱。什么都不会被删除。",
			},
		],
	},

	cta: {
		title: "先给一个文件夹配个地址。",
		lede: "免费开始：一个收件箱，每月 3 GB 中转流量，而且别人给你发东西不需要注册任何账号。",
		button: "下载 Mac 版",
	},

	footer: {
		groups: [
			{
				title: "产品",
				links: [
					{ label: "下载", href: "/download" },
					{ label: "工作原理", href: "/how-it-works" },
					{ label: "定价", href: "/pricing" },
					{ label: "路线图", href: "/#roadmap" },
				],
			},
			{
				title: "对比",
				links: [
					{ label: "对比网盘", href: "/compare" },
					{ label: "对比 AirDrop", href: "/compare" },
					{ label: "对比传输链接", href: "/compare" },
				],
			},
			{
				title: "公司",
				links: [
					{ label: "支持", href: `mailto:${SUPPORT_EMAIL}` },
					{ label: "Discord 社群", href: DISCORD_URL },
					{ label: `X（${X_HANDLE}）`, href: X_URL },
				],
			},
			{
				title: "法律",
				links: [
					{ label: "隐私政策", href: "/privacy" },
					{ label: "服务条款", href: "/terms" },
				],
			},
		],
		copyright: COMPANY_ZH,
	},

	compare: {
		title: "Stolnk 和别的方式差在哪",
		lede: "别人的文件到你 Mac 上，大致有四条路。它们各自都不差，只是建立在不同的假设之上——而其中只有一条的终点是你自己选的文件夹。",
		columns: ["Stolnk", "网盘", "传输链接", "AirDrop"],
		rows: [
			{
				label: "发送方需要账号",
				values: ["不需要", "往你的空间上传通常需要", "不需要", "需要一台 Apple 设备"],
			},
			{
				label: "发送方需要安装东西",
				values: ["不需要", "经常需要", "不需要", "系统自带，仅限 Apple"],
			},
			{
				label: "文件最终去了哪",
				values: [
					"你 Mac 上你选定的那个文件夹",
					"网盘自己的目录，再同步下来",
					"你手动取回后进「下载」文件夹",
					"你的「下载」文件夹",
				],
			},
			{
				label: "你的 Mac 睡着时",
				values: [
					"先保留，唤醒后送达",
					"下次运行时才同步",
					"一直等你去点链接，直到过期",
					"根本发不出去",
				],
			},
			{
				label: "端到端加密",
				values: ["有，在发送方浏览器里完成", "取决于服务商", "一般没有", "有"],
			},
			{
				label: "跨网络",
				values: ["可以", "可以", "可以", "基本上要在同一个房间"],
			},
			{
				label: "需要你手动归档",
				values: ["不需要", "有时需要", "每次都要", "每次都要"],
			},
			{
				label: "计费方式",
				values: ["一次付清", "订阅", "免费额度之上订阅", "免费"],
			},
		],
		note: "以上是各自默认配置在撰写时的能力。任何一项都可能变化，付费档位的行为也可能不同——真要依赖某一行之前，请自己核实一下。",
		notGood: {
			title: "Stolnk 不适合做什么",
			items: [
				"它不是同步。文件落地一次就待在那儿，之后任何一边改动都不会影响另一边。",
				"它不是备份。你的 Mac 一拿到文件，我们那份就删掉了——这是设计如此，也意味着没有可供恢复的副本。",
				"它只朝一个方向走，向内。没有办法把文件夹里的文件再分享出去。",
				"加密跑在我们分发的 JavaScript 里，这是一个真实存在的局限，我们把它完整写清楚了。",
				"密钥没法迁移到新 Mac，换机器意味着一个新地址和一个清空的队列。",
			],
			link: "完整的诚实版本 →",
		},
		cta: "下载 Mac 版",
	},

	legal: legalZh,
	pages: pagesZh,
};

export const copy: Record<Lang, Dict> = { en, zh };
