import {
	COMPANY_EN,
	COMPANY_ZH,
	DISCORD_URL,
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
		badge: "For iPhone · iOS 17 and later",
		title: "Turn your folders into inboxes.",
		lede: "Share a link. Anyone can send you files from any browser — no account, no app. They are encrypted on the way and land in the right folder on your iPhone.",
		cta: "Download on the App Store",
		meta: "$1.99 once · no in-app purchases · no subscription",
		figureFrom: "ryan.stolnk.com/client-a",
		figureTo: "Stolnk › Clients › Acme",
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
				to: "Stolnk › Clients › Acme",
			},
			{
				n: "02",
				name: "Shoot handoff",
				note: "Footage with no cloud drive in between",
				from: "studio.stolnk.com/shoot-0913",
				meta: "4.2 GB · encrypted in the browser",
				to: "Stolnk › Shoots › 0913",
			},
			{
				n: "03",
				name: "Any computer → iPhone",
				note: "Open the link on any computer and drop the file in",
				from: "ryan.stolnk.com/desk",
				meta: "no cable, no AirDrop",
				to: "Stolnk › Inbox",
			},
		],
	},

	routing: {
		figureFrom: "ryan.stolnk.com/photos",
		figureMeta: "one of as many as you like",
		figureTo: "Stolnk › Client Shoots",
		title: "One link per folder.",
		lede: "Give your client a link, your photographer another one. Everything arrives exactly where it belongs, and you never sort a pile of downloads again.",
		cards: [
			{
				title: "An address of your own",
				body: "A name you pick, and a path per folder. Change a path or reset it and the old address stops working the same second.",
			},
			{
				title: "Nothing for the sender",
				body: "They open the link in any browser and drop a file. No account to create, nothing to install, no app to be nagged about.",
			},
			{
				title: "It lands, it does not queue up in a chat",
				body: "Every file goes straight into the folder its link points to, ready to preview, move or share.",
			},
		],
	},

	sleep: {
		title: "Arrives even when your phone is away.",
		lede: "Phone offline, or Stolnk not open? The encrypted bytes wait, and land the next time you open the app. The sender is never shown a failure for something that is not their fault.",
		cards: [
			{
				title: "Held, not bounced",
				body: "Up to 7 days. The sender is told it will be delivered when you are next online — because it will be.",
			},
			{
				title: "Deleted on arrival",
				body: "The stored copy is removed the moment your iPhone confirms the file landed. Not on a schedule — immediately.",
			},
			{
				title: "Resumable, in 64 MiB parts",
				body: "A dropped connection resumes where it stopped instead of starting a 4 GB upload over.",
			},
		],
		figureAsleep: "iPhone offline",
		figureAwake: "Stolnk opened",
		figureQueued: "waiting",
		figureLanded: "landed",
	},

	crypto: {
		title: "Encrypted in the browser. Only your iPhone can open it.",
		lede: "We route your files. We can't read them — not in transit, not at rest. Your iPhone's keys are generated in its Secure Enclave and cannot be exported.",
		cards: [
			{
				title: "Keys that cannot leave",
				body: "Two P-256 keypairs, generated inside the Secure Enclave on first launch. The private halves never leave it.",
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

	/*
	 * The address used as an API. It sits between the encryption section and the
	 * feature list on purpose — see `Landing.tsx` — because the third card
	 * qualifies the claim the section above it makes, and a caveat that drifts
	 * away from its claim reads as a retraction later on.
	 *
	 * "95 MiB" is `MAX_CURL_UPLOAD_BYTES` in worker/limits.ts, where the
	 * arithmetic behind it lives. This dictionary cannot import from the worker,
	 * so the two move together by hand; `SendPage.tsx` carries the same number as
	 * `CURL_MAX_MIB` for the same reason.
	 */
	terminal: {
		title: "The same link, from a terminal.",
		lede: "An inbox address is an API as well as a page. A script, a build job or an AI agent can use the link it was handed and nothing else — there is no key to issue and no endpoint to look up.",
		cards: [
			{
				title: "One command",
				body: "curl, with the file and the address. No SDK, no token, no account. The URL is the whole interface.",
			},
			{
				title: "It describes itself",
				body: "Ask the same address for JSON and it answers with the field name, the limits and a command ready to run — so an agent given a bare link can work out the rest on its own.",
			},
			{
				title: "The trade, stated",
				body: "This route is encrypted on our server with your iPhone's public key, not in the sender's browser. Up to 95 MiB, one file per request.",
			},
		],
		link: "What that costs you →",
		figureCommand: 'curl -F "file=@shoot-0913.mov" ryan.stolnk.com/client-a',
		figureReply: "202 · Accepted. It will be delivered when Ryan next comes online.",
	},

	features: {
		title: "What it actually does",
		lede: "An iPhone app, a link, and a folder. The list is short because the product is.",
		items: [
			{
				title: "Folders, inside the app",
				body: "Each address ends in a folder in Stolnk. Browse as a list or grid, sort, rename and move files between folders.",
			},
			{
				title: "Previews built in",
				body: "Images, video, audio, PDFs, text, Markdown and HTML. Import from Photos or Files as well.",
			},
			{
				title: "Send files out too",
				body: "Share any file as a download link. Choose how long it lasts and how many downloads it allows; pause, revoke or delete it at any time.",
			},
			{
				title: "Addresses you control",
				body: "Pause an address, give it a password, change its path or reset it — the old address stops working at once.",
			},
			{
				title: "A QR code for face to face",
				body: "Show the address as a QR code for someone standing next to you. They scan it and send.",
			},
			{
				title: "Faster on the same Wi-Fi",
				body: "When the sender is on your network, the file goes straight to your iPhone and never passes through our servers.",
			},
			{
				title: "Tampering is refused, not saved",
				body: "Reordered or altered parts fail verification and never reach the folder. Hostile filenames land as safe ones.",
			},
			{
				title: "Trash, and a storage view",
				body: "Deleted items stay in Trash for 30 days, and you can see what is using space on your phone.",
			},
		],
	},

	roadmap: {
		title: "Coming in V1.x",
		lede: "Not built yet, so they are not part of what the price promises today. They arrive as ordinary updates, included.",
		items: [
			"Inbox addresses that expire, or accept only once",
			"A webhook when a file lands",
			"Dropping a whole folder into the send page",
		],
	},

	pricingTeaser: {
		title: "Paid once, not monthly.",
		lede: "Stolnk is a paid download on the App Store. Everything is included from the moment you install — no in-app purchases, no subscription, no tiers.",
		more: "See everything that's included →",
	},

	faq: {
		title: "Questions people actually ask",
		items: [
			{
				q: "Does the sender need an account, or an app?",
				a: "Neither. They open the link in any modern browser — on a phone, a Mac, a Windows PC, anything — and drop a file in. There is nothing to install and nothing to sign up for.",
			},
			{
				q: "Is there a Mac, Windows or Android version?",
				a: "No. Stolnk is an iPhone app. Only the receiving side needs it; anyone sending you a file just needs a browser.",
			},
			{
				q: "Can a script or an AI agent send me files?",
				a: "Yes — the link is the whole API. POST a file to the address with curl and it lands in the folder, and asking that address for JSON tells the caller how. The one difference from the browser: on that route the file is encrypted on our server with your iPhone's public key rather than in the sender's browser, so it passes through us readable for the length of one request. Up to 95 MiB, one file per request.",
			},
			{
				q: "What if my phone is offline, or Stolnk is not open?",
				a: "The encrypted file waits — up to 7 days — and is delivered the next time you open Stolnk. The sender sees “will be delivered”, not an error.",
			},
			{
				q: "Can I move to a new iPhone?",
				a: "Not with the same keys. They are generated inside the Secure Enclave and cannot be exported, so a new iPhone means new keys, and anything still queued for the old one becomes undecryptable. Open Stolnk on the old phone to collect everything before you switch.",
			},
			{
				q: "What can you see?",
				a: "File sizes, when they were sent, which inbox they were addressed to, and your iPhone's public keys. Not contents, not filenames, and never the folder a file lands in.",
			},
			{
				q: "Are there in-app purchases?",
				a: "No. Stolnk is a paid download: one payment on the App Store, every feature included, no subscription. Nothing is ever billed on top — when a month's 300 GB relay allowance runs out, links pause until the month turns over.",
			},
			{
				q: "How big can a single file be?",
				a: "20 GB. Uploads go up in 64 MiB parts, so a dropped connection resumes rather than restarts.",
			},
			{
				q: "Refunds?",
				a: "The App Store handles them. Request one from Apple at reportaproblem.apple.com.",
			},
		],
	},

	cta: {
		title: "Give your first folder an address.",
		lede: "One payment on the App Store, everything included, and nobody has to create an account to send you something.",
		button: "Download on the App Store",
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
					{ label: "Support", href: "/support" },
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
		lede: "Four ways a file gets from someone else onto your iPhone. None of these is bad at its own job — they are just built around different assumptions, and only one of them ends in a folder you chose.",
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
					"The folder you chose, in Stolnk on your iPhone",
					"The drive's own app",
					"Wherever you save it, after you fetch it",
					"Files or Photos, after you accept it",
				],
			},
			{
				label: "While your phone is offline",
				values: [
					"Held, then delivered when you open the app",
					"Waits in the drive",
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
				values: ["One paid download", "Subscription", "Subscription, above a free tier", "Free"],
			},
		],
		note: "Capabilities of the default configuration, as of this writing. Any of them can change, and a paid tier of any of these products may behave differently — check before you rely on a row.",
		notGood: {
			title: "What Stolnk is not for",
			items: [
				"It is not sync. A file lands once and stays where it landed; changing it later on either side changes nothing on the other.",
				"It is not backup. Once your iPhone has the file, we have deleted our copy — that is the design, and it means there is nothing to restore from.",
				"Files you send out as download links are stored unencrypted on our side for the life of the link, unlike everything coming in.",
				"The encryption runs in JavaScript we serve, which is a real limitation we describe in full.",
				"Keys cannot move to a new iPhone, so switching phones means new keys and a cleared queue.",
				"It is iPhone only. There is no Mac, Windows or Android app.",
			],
			link: "The full honest version →",
		},
		cta: "Download on the App Store",
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
		badge: "适用于 iPhone · iOS 17 及以上",
		title: "把文件夹变成收件箱。",
		lede: "分享一条链接，任何人用任意浏览器都能给你发文件——不用注册，不用装 App。文件一路加密，落进你 iPhone 上指定的那个文件夹。",
		cta: "在 App Store 下载",
		meta: "一次付费 $1.99 · 无内购 · 无订阅",
		figureFrom: "ryan.stolnk.com/client-a",
		figureTo: "Stolnk › 客户 › Acme",
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
				to: "Stolnk › 客户 › Acme",
			},
			{
				n: "02",
				name: "素材回收",
				note: "素材不用先过一遍网盘",
				from: "studio.stolnk.com/shoot-0913",
				meta: "4.2 GB · 在浏览器里就已加密",
				to: "Stolnk › 拍摄 › 0913",
			},
			{
				n: "03",
				name: "任意电脑 → iPhone",
				note: "在任何一台电脑上打开链接，把文件拖进去",
				from: "ryan.stolnk.com/desk",
				meta: "不用数据线，不用 AirDrop",
				to: "Stolnk › 收件箱",
			},
		],
	},

	routing: {
		figureFrom: "ryan.stolnk.com/photos",
		figureMeta: "想开几个就开几个",
		figureTo: "Stolnk › 客户样片",
		title: "一条链接，对应一个文件夹。",
		lede: "给客户一条链接，给摄影师另一条。每份文件都精确地落在该去的地方，你再也不用从一堆下载里往外扒。",
		cards: [
			{
				title: "一个属于你的地址",
				body: "名字你自己起，每个文件夹配一段路径。改路径或重置之后，旧地址同一秒就失效。",
			},
			{
				title: "发送方什么都不用做",
				body: "用任意浏览器打开链接，把文件拖进去就行。不用注册账号，不用安装任何东西，也没有 App 反复提醒他更新。",
			},
			{
				title: "它是「到货」，不是躺在聊天记录里",
				body: "每个文件都直接进入链接对应的那个文件夹，随时可以预览、移动或分享。",
			},
		],
	},

	sleep: {
		title: "手机不在身边，文件照样到。",
		lede: "手机离线，或者没打开 Stolnk？密文会等着，你下次打开 App 时就落进文件夹。发送方不会因为一件不是他造成的事而看到失败。",
		cards: [
			{
				title: "是保留，不是打回",
				body: "最多保留 7 天。发送方看到的是「等对方上线就会送达」——因为确实会。",
			},
			{
				title: "一到货就删",
				body: "你的 iPhone 一确认收到，存储里那份副本立刻删除。不是按计划清理，是立刻。",
			},
			{
				title: "可续传，按 64 MiB 分片",
				body: "断线后从断点继续，而不是让一个 4 GB 的上传从头再来。",
			},
		],
		figureAsleep: "iPhone 离线",
		figureAwake: "打开了 Stolnk",
		figureQueued: "等待中",
		figureLanded: "已到达",
	},

	crypto: {
		title: "在浏览器里就加密。只有你的 iPhone 打得开。",
		lede: "我们只负责转发。我们读不到内容——传输中读不到，存着的时候也读不到。你 iPhone 的密钥在安全隔区（Secure Enclave）里生成，无法导出。",
		cards: [
			{
				title: "出不来的密钥",
				body: "首次启动时在安全隔区内生成两对 P-256 密钥。私钥那一半从不离开它。",
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

	terminal: {
		title: "同一条链接，在终端里。",
		lede: "收件地址既是一个页面，也是一个 API。脚本、构建任务、AI agent，拿着别人给的那条链接就够了——没有要申请的密钥，也没有要查的接口地址。",
		cards: [
			{
				title: "一条命令",
				body: "curl，加上文件和地址。没有 SDK，没有令牌，没有账号。这个 URL 就是接口本身。",
			},
			{
				title: "它会自我描述",
				body: "向同一个地址要 JSON，它会回答字段名、各项上限，以及一条可以直接运行的命令——所以一个只拿到光秃秃链接的 agent，能自己把剩下的推出来。",
			},
			{
				title: "代价，明说",
				body: "这条路是在我们服务器上用你 iPhone 的公钥加密的，不是在发送方浏览器里。单个文件最大 95 MiB，每次请求一个文件。",
			},
		],
		link: "这要付出什么 →",
		figureCommand: 'curl -F "file=@shoot-0913.mov" ryan.stolnk.com/client-a',
		figureReply: "202 · 已接收。等 Ryan 下次上线就会送达。",
	},

	features: {
		title: "它到底做什么",
		lede: "一个 iPhone App，一条链接，一个文件夹。清单很短，因为产品本身就很短。",
		items: [
			{
				title: "文件夹就在 App 里",
				body: "每个地址都对应 Stolnk 里的一个文件夹。列表或网格浏览，排序、重命名，在文件夹之间移动。",
			},
			{
				title: "内置预览",
				body: "图片、视频、音频、PDF、文本、Markdown 和 HTML 都能直接看。也可以从相册或「文件」导入。",
			},
			{
				title: "也能往外发",
				body: "把任意文件分享为下载链接，自选有效期和下载次数，随时暂停、撤回或删除。",
			},
			{
				title: "地址由你掌控",
				body: "地址可以暂停、设密码、改路径或重置——旧地址立即失效。",
			},
			{
				title: "当面传，用二维码",
				body: "把地址显示成二维码，站在你旁边的人扫一下就能发。",
			},
			{
				title: "同一 Wi-Fi 下更快",
				body: "发送方和你在同一个网络时，文件直接到你的 iPhone，完全不经过我们的服务器。",
			},
			{
				title: "被篡改的会被拒收，而不是存下来",
				body: "分片被重排或改动都过不了校验，永远到不了你的文件夹。恶意文件名落地时会变成安全的名字。",
			},
			{
				title: "回收站和存储空间",
				body: "删除的内容在回收站保留 30 天，还能看到手机上的空间被什么占用。",
			},
		],
	},

	roadmap: {
		title: "V1.x 内会做",
		lede: "还没做出来，所以不属于今天这个价格所承诺的内容。它们会以普通更新的形式发布，已包含在内。",
		items: [
			"会过期、或只接收一次的收件地址",
			"文件到达时触发 webhook",
			"在发送页里直接拖入整个文件夹",
		],
	},

	pricingTeaser: {
		title: "买断，不按月。",
		lede: "Stolnk 是 App Store 上的付费下载应用。安装即享全部功能——没有内购，没有订阅，也不分档位。",
		more: "看看具体包含什么 →",
	},

	faq: {
		title: "大家真的会问的问题",
		items: [
			{
				q: "发送方需要账号或者 App 吗？",
				a: "都不需要。用任意现代浏览器——手机、Mac、Windows 电脑都行——打开链接，把文件拖进去就行。没有要装的东西，也没有要注册的东西。",
			},
			{
				q: "有 Mac、Windows 或安卓版吗？",
				a: "没有。Stolnk 是一个 iPhone App。只有接收方需要它；给你发文件的人只要有浏览器就够了。",
			},
			{
				q: "脚本或者 AI agent 能给我发文件吗？",
				a: "能——那条链接本身就是完整的 API。用 curl 把文件 POST 到这个地址，它就会落进文件夹；向同一个地址要 JSON，它会告诉调用方该怎么发。跟浏览器唯一的区别是：走这条路时，文件是在我们服务器上用你 iPhone 的公钥加密的，而不是在发送方浏览器里，所以它会以可读的形式在我们这里停留一次请求那么久。单个文件最大 95 MiB，每次请求一个文件。",
			},
			{
				q: "手机离线、或者没打开 Stolnk 时会怎样？",
				a: "加密后的文件会等着——最多 7 天——你下次打开 Stolnk 时就会送达。发送方看到的是「将会送达」，而不是一个错误。",
			},
			{
				q: "能换到新 iPhone 上吗？",
				a: "密钥没法一起换过去。它们在安全隔区内生成且无法导出，所以新手机意味着一套新密钥，还在等旧手机的文件会变得无法解密。换机之前，先在旧手机上打开 Stolnk 把文件都收完。",
			},
			{
				q: "你们能看到什么？",
				a: "文件大小、发送时间、发往哪个收件箱，以及你 iPhone 的公钥。看不到内容，看不到文件名，也永远不知道文件落在哪个文件夹。",
			},
			{
				q: "有内购吗？",
				a: "没有。Stolnk 是付费下载：在 App Store 付一次钱，全部功能都包含在内，没有订阅。永远不会额外扣费——某个月 300 GB 的中转额度用完时，链接会暂停接收，到下个月自动恢复。",
			},
			{
				q: "单个文件最大能有多大？",
				a: "20 GB。上传按 64 MiB 分片，断线之后是续传而不是重来。",
			},
			{
				q: "能退款吗？",
				a: "由 App Store 处理。请在 reportaproblem.apple.com 向 Apple 申请。",
			},
		],
	},

	cta: {
		title: "先给一个文件夹配个地址。",
		lede: "在 App Store 付一次钱，全部功能都有，而且别人给你发东西不需要注册任何账号。",
		button: "在 App Store 下载",
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
					{ label: "支持", href: "/support" },
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
		lede: "别人的文件到你 iPhone 上，大致有四条路。它们各自都不差，只是建立在不同的假设之上——而其中只有一条的终点是你自己选的文件夹。",
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
					"你 iPhone 上 Stolnk 里你选定的那个文件夹",
					"网盘自己的 App",
					"你手动取回后存到哪就是哪",
					"你接收后进「文件」或「照片」",
				],
			},
			{
				label: "你的手机离线时",
				values: [
					"先保留，打开 App 后送达",
					"在网盘里等着",
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
				values: ["一次性付费下载", "订阅", "免费额度之上订阅", "免费"],
			},
		],
		note: "以上是各自默认配置在撰写时的能力。任何一项都可能变化，付费档位的行为也可能不同——真要依赖某一行之前，请自己核实一下。",
		notGood: {
			title: "Stolnk 不适合做什么",
			items: [
				"它不是同步。文件落地一次就待在那儿，之后任何一边改动都不会影响另一边。",
				"它不是备份。你的 iPhone 一拿到文件，我们那份就删掉了——这是设计如此，也意味着没有可供恢复的副本。",
				"你用下载链接往外发的文件，在链接有效期间以明文存放在我们这边，这和所有发进来的文件不一样。",
				"加密跑在我们分发的 JavaScript 里，这是一个真实存在的局限，我们把它完整写清楚了。",
				"密钥没法迁移到新 iPhone，换手机意味着一套新密钥和一个清空的队列。",
				"它只有 iPhone 版。没有 Mac、Windows 或安卓 App。",
			],
			link: "完整的诚实版本 →",
		},
		cta: "在 App Store 下载",
	},

	legal: legalZh,
	pages: pagesZh,
};

export const copy: Record<Lang, Dict> = { en, zh };
