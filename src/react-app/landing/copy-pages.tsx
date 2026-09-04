import { COMPANY_EN, COMPANY_ZH } from "./contact.ts";

/**
 * The long-form prose pages, in both languages.
 *
 * Values are JSX rather than strings on purpose: this copy carries links,
 * emphasis and lists, and flattening it to strings would either lose that or
 * push HTML through `dangerouslySetInnerHTML` — which the CSP in
 * `worker/index.ts` exists to make unnecessary.
 *
 * `pagesZh` is typed as `typeof pagesEn`, so a key added on one side and
 * forgotten on the other fails the build rather than rendering `undefined`.
 */

/*
 * PRD 16.1 — the price list. Two rules from PRD 16.3 shape every line of the
 * pricing copy below, and both are honesty constraints rather than marketing
 * ones:
 *
 *  1. **The word "unlimited" does not appear.** What is sold is a perpetual
 *     licence, every V1.x update, and 300 GB of relay a month — a number the
 *     cost model in PRD 8.6 can honour forever. A "lifetime everything" that
 *     later has to be walked back is the standard way this kind of product
 *     breaks its word.
 *  2. **Nothing is listed that does not exist yet.** Link expiry and delivery
 *     webhooks are on the V1.1 roadmap, so they appear under what the purchase
 *     will grow into — the roadmap section on the home page — not as a row in
 *     the table someone is paying for today.
 *
 *     Password protection is the awkward one. PRD 16.1 lists it as a headline
 *     Pro capability and the server enforces it as one — but the Mac app can
 *     only display that a link has a password, not set it, so a buyer today
 *     cannot switch it on. It sits with the roadmap items until that UI
 *     exists, at which point it moves up into the table.
 *
 * The free column is likewise stated as what it is. PRD 16.2 argued the free
 * tier could be generous because LAN direct costs nothing to serve — but LAN
 * direct (M4) is not in V1, so free means 3 GB of relay a month and the page
 * says exactly that.
 */

export const pagesEn = {
	download: {
		title: "Download Stolnk",
		lede: "macOS 13 or later, Apple Silicon and Intel. Free — one inbox, 3 GB of relayed files a month.",
		pricingLink: "Pricing",
		cta: "Download for Mac",
		meta: (version: string, size: string, minMacos: string) =>
			`Version ${version} · ${size} · macOS ${minMacos} or later`,
		unavailable: "No build is published right now — please check back shortly.",
		firstLaunch: "First launch",
		firstLaunchBody: (
			<>
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
			</>
		),
		gatekeeper: (
			<>
				macOS shows one dialog the first time — the ordinary “downloaded from the Internet”
				confirmation every direct download gets. It names the signer:{" "}
				<strong>{COMPANY_EN}</strong>, the company behind Stolnk.
			</>
		),
		verify: "Verify what you downloaded",
		verifyBody: "The hash of every published build is listed here, so you can check that the file you got is the file we shipped.",
		verifyWhy: "Why that matters →",
		onYourMac: "What it does on your Mac",
		onYourMacBody: (
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
		),
	},

	howItWorks: {
		title: "How Stolnk works",
		lede: "Files are encrypted in the sender's browser and can only be decrypted by your Mac. We can't read them — not in transit, not at rest.",
		/*
		 * PRD 9.4 — the honest description of what this encryption does and does
		 * not do. The claims here are deliberately narrower than the marketing
		 * temptation. Every web-delivered end-to-end encrypted product shares the
		 * limitation in the second-to-last section, and saying so plainly is worth
		 * more than a phrase like "zero knowledge" that a reader on Hacker News
		 * will take apart on launch day.
		 */
		body: (
			<>
				<h2>The path a file takes</h2>
				<p>
					When someone opens your link, their browser asks our server for one thing: your
					Mac's public key. It generates a one-time key for the file, encrypts the file with
					it, and wraps that key so that only your Mac's private key can unwrap it.
				</p>
				<p>
					The encrypted bytes are held briefly in object storage. Your Mac collects them, and
					the stored copy is deleted the moment it confirms the file landed. If your Mac is
					asleep, they wait — up to the inbox's expiry — and are delivered when it wakes.
				</p>

				<h2>What the keys are</h2>
				<p>
					Your Mac generates two P-256 keypairs inside its <strong>Secure Enclave</strong> on
					first launch: one to prove its identity to our server, one to unwrap file keys. The
					private halves never enter memory, never touch disk, and cannot be exported — by
					us, by the app, or by anyone with access to the machine's storage.
				</p>
				<p>
					The direct consequence, stated plainly:{" "}
					<strong>keys cannot move to a new Mac.</strong> Setting up a new machine means new
					keys. Anything still waiting for the old Mac becomes undecryptable, so clear your
					queue before you switch.
				</p>

				<h2>What we can see</h2>
				<p>We store, and can read:</p>
				<ul>
					<li>The size of each file, and when it was sent.</li>
					<li>Which inbox it was addressed to.</li>
					<li>Your Mac's public keys.</li>
				</ul>
				<p>We cannot read:</p>
				<ul>
					<li>File contents.</li>
					<li>
						Filenames — they are encrypted too, though their <em>length</em> can be inferred
						from the ciphertext.
					</li>
					<li>The folder on your Mac a file lands in. We never learn your local paths.</li>
				</ul>

				<h2>The limitation we will not hide</h2>
				<p>
					<strong>
						The encryption runs in JavaScript that we serve. A compromised or malicious
						server could, in principle, serve tampered code that leaks the key.
					</strong>{" "}
					This is inherent to every browser-delivered end-to-end encrypted product, including
					well-regarded ones, and it is worth understanding before you trust any of them with
					something critical.
				</p>
				<p>What we do about it:</p>
				<ul>
					<li>A strict Content Security Policy with no inline scripts or styles.</li>
					<li>
						The send page is served from its own bundle, kept small enough that reading it
						is a realistic afternoon rather than a project.
					</li>
					<li>The sending code is open source and auditable.</li>
					<li>
						The Mac app's hash is published on the <a href="/download">download page</a>, so
						you can check the installer you got is the one we shipped.
					</li>
				</ul>
				<p>
					None of that turns the limitation into a guarantee. It narrows it. A file that must
					never be readable by anyone but you should be encrypted before it reaches any
					browser.
				</p>

				<h2>Things we deliberately do not say</h2>
				<p>
					Not "zero knowledge" — we know file sizes and timing. Not "your files never touch
					our servers" — the encrypted bytes do, briefly, and that is exactly what lets them
					arrive while your Mac is asleep. Not "military-grade" — that phrase means nothing.
				</p>
			</>
		),
	},

	pricing: {
		title: "One price. Paid once.",
		lede: "Stolnk is a one-time purchase from a single developer. There is no subscription, and no plan that expires.",
		freeName: "Free",
		freePrice: "$0",
		freeNote: "One inbox and 3 GB of relayed files a month. Enough to use properly, and enough to see your Mac collect something it slept through.",
		freeCta: "Download for Mac",
		proName: "Pro",
		proNote: "Launch price for the first 500. After that it is $39 — the long-term price, not a discount that comes back.",
		proCta: "Buy Stolnk Pro",
		proFootnote: "One payment. Yours permanently.",
		rows: [
			{ label: "Inboxes", free: "1", pro: "As many as you like" },
			{ label: "Relayed files", free: "3 GB / month", pro: "300 GB / month" },
			{ label: "Largest single file", free: "2 GB", pro: "20 GB" },
			{ label: "Held while your Mac sleeps", free: "24 hours", pro: "7 days" },
			{ label: "Macs", free: "1", pro: "3" },
			{ label: "Updates", free: "All of V1.x", pro: "All of V1.x" },
		],
		body: (
			<>
				<h2>What "paid once" actually covers</h2>
				<p>
					Being precise about this matters more than it sounds. A perpetual promise that
					cannot be kept is worse than a smaller one that can, so here is the whole of it:
				</p>
				<ul>
					<li>A permanent licence to the software, on up to 3 Macs.</li>
					<li>Every V1.x update.</li>
					<li>300 GB of relayed files per month, for as long as Stolnk runs.</li>
				</ul>
				<p>
					That is a number rather than the word "unlimited" on purpose. Relaying costs real
					money per gigabyte, and 300 GB a month is an amount a one-time payment can carry
					indefinitely. If Stolnk ever reaches a V2 with genuinely new capabilities, it will
					be a paid upgrade at half price — and your V1 licence and allowance keep working
					whether or not you take it.
				</p>

				<h2>Running out</h2>
				<p>
					Nothing is ever billed on top, and your inbox never goes down. If a month's
					allowance runs out, links stop accepting new files and start again when the month
					turns over. You will not get a surprise invoice, because there is no mechanism in
					Stolnk that could produce one.
				</p>

				<h2>Coming in V1.x, included</h2>
				<p>
					These are not built yet, so they are not part of what the table above promises
					today. They are listed on the <a href="/#roadmap">roadmap</a>, and they arrive as
					ordinary updates rather than as a new tier.
				</p>

				<h2>Refunds and support</h2>
				<p>
					14 days, no questions — email and it is done. Support is email only and
					best-effort: Stolnk is one person, and promising more than that would be another
					thing that could not be kept.
				</p>
			</>
		),
	},

	/*
	 * Where Creem sends the buyer after payment (PRD 16.5).
	 *
	 * This page grants nothing and checks nothing. Creem appends `checkout_id`,
	 * `order_id`, `customer_id`, `product_id` and a `signature` to the return
	 * URL, and the signature is an HMAC under the API key — which by the argument
	 * in `worker/lib/creem.ts` cannot exist in a browser bundle, because a key
	 * inside something anyone can download is a public key. So the parameters are
	 * not read at all: verifying them here would be theatre, and the real record
	 * of the sale arrives independently on the webhook, which is signed with a
	 * secret that never leaves the Worker.
	 *
	 * What is left for this page to do is the thing the buyer actually needs at
	 * this moment, which is to know where their licence key is.
	 */
	thanks: {
		title: "Thank you — you have Stolnk Pro.",
		lede: "The payment went through. Your licence key is in the confirmation Creem just showed you, and a copy is on its way to the email address you paid with.",
		activate: "Turning it on",
		activateBody: (
			<>
				<ol>
					<li>
						Open Stolnk from the menu bar and choose <strong>Settings → Licence</strong>.
					</li>
					<li>Paste the key and click Activate.</li>
				</ol>
				<p>
					That is the whole of it — there is no account to create, and nothing to sign in
					to. The key covers up to three Macs, so repeat it on each one; releasing a Mac
					later frees its seat for another.
				</p>
			</>
		),
		cta: "Download for Mac",
		rest: (
			<>
				<h2>If the key has not arrived</h2>
				<p>
					Check spam first — it arrives within a minute or two. If it is genuinely missing,
					email and it will be resent; the order exists on Creem's side whether or not the
					message reached you.
				</p>

				<h2>Refunds</h2>
				<p>
					14 days, no questions — email and it is done, exactly as{" "}
					<a href="/pricing">the pricing page</a> says. A refund puts this Mac back on Free
					and pauses any inbox beyond the first. Nothing is deleted, and buying again brings
					it all back as it was.
				</p>
			</>
		),
	},

	/*
	 * The apex 404. Under the path-based model every unmatched path was an inbox
	 * address, so there was nothing to say; now inboxes live on their own
	 * subdomains and an unknown path on the apex is simply a wrong turn.
	 */
	notFound: {
		title: "Nothing here",
		body: (
			<p>
				Inbox links look like <code>ryan.stolnk.com/client-a</code> — a name and a path,
				always both. If you were given one, check it for a typo.
			</p>
		),
		home: "Stolnk home",
	},
};

export const pagesZh: typeof pagesEn = {
	download: {
		title: "下载 Stolnk",
		lede: "需要 macOS 13 及以上，Apple 芯片和 Intel 都支持。免费版包含一个收件箱、每月 3 GB 中转流量。",
		pricingLink: "查看定价",
		cta: "下载 Mac 版",
		meta: (version: string, size: string, minMacos: string) =>
			`版本 ${version} · ${size} · 需要 macOS ${minMacos} 及以上`,
		unavailable: "目前还没有已发布的构建，请稍后再来。",
		firstLaunch: "第一次打开",
		firstLaunchBody: (
			<>
				<p>
					Stolnk 通过官网直接分发，没有上架 App Store。原因是它需要往你自己指定的文件夹里写入文件——包括外接硬盘上的——这是沙盒不允许的。
				</p>
				<p>
					正式发布的构建都用 Developer ID 签名并经过 Apple 公证，所以磁盘映像和 App 打开时都不会有警告。把 Stolnk 拖进「应用程序」，双击即可。
				</p>
			</>
		),
		gatekeeper: (
			<>
				macOS 第一次会弹一个对话框——就是所有官网下载都会遇到的那句「来自互联网」的确认。它会显示签名方：
				<strong>{COMPANY_ZH}</strong>，也就是 Stolnk 背后的公司。
			</>
		),
		verify: "校验你下载到的文件",
		verifyBody: "每个已发布构建的哈希都列在这里，你可以核对拿到的文件是否就是我们发出的那一份。",
		verifyWhy: "为什么这件事重要 →",
		onYourMac: "它在你 Mac 上做什么",
		onYourMacBody: (
			<ul>
				<li>常驻菜单栏。没有 Dock 图标，不主动开窗口。</li>
				<li>首次启动时在 Secure Enclave 里生成密钥。</li>
				<li>只往你选定的文件夹里写。</li>
				<li>
					给每个收到的文件打上 <code>com.apple.quarantine</code> 标记，和浏览器下载的行为完全一致。
				</li>
				<li>不会阻止你的 Mac 进入睡眠。</li>
			</ul>
		),
	},

	howItWorks: {
		title: "Stolnk 是怎么工作的",
		lede: "文件在发送方的浏览器里就已加密，只有你的 Mac 能解开。我们读不到内容——传输中读不到，存着的时候也读不到。",
		body: (
			<>
				<h2>一个文件走过的路</h2>
				<p>
					别人打开你的链接时，他的浏览器只向我们的服务器要一样东西：你 Mac 的公钥。浏览器为这个文件生成一把一次性密钥，用它加密文件，再把这把密钥包起来——只有你 Mac 的私钥能解开。
				</p>
				<p>
					密文会在对象存储里短暂停留。你的 Mac 取走它，确认落盘之后，存储里那份副本立刻删除。如果你的 Mac 正在睡觉，密文就等着——不超过收件箱的保留期——等它醒来再送达。
				</p>

				<h2>密钥是什么</h2>
				<p>
					你的 Mac 在首次启动时于 <strong>Secure Enclave</strong> 内生成两对 P-256 密钥：一对用于向服务器证明身份，一对用于解开文件密钥。私钥那一半从不进入内存、从不落盘，也无法导出——我们不能，App 不能，能接触到这台机器存储的人也不能。
				</p>
				<p>
					由此直接带来的后果，说白了就是：<strong>密钥没法迁移到新 Mac。</strong>
					换新机器意味着一套新密钥，还在等旧 Mac 的文件会变得无法解密。所以换机之前先把队列清空。
				</p>

				<h2>我们能看到什么</h2>
				<p>我们会存储、也能读到：</p>
				<ul>
					<li>每个文件的大小，以及发送时间。</li>
					<li>它发往哪个收件箱。</li>
					<li>你 Mac 的公钥。</li>
				</ul>
				<p>我们读不到：</p>
				<ul>
					<li>文件内容。</li>
					<li>
						文件名——它同样是加密的，不过从密文长度可以推断出名字的<em>长度</em>。
					</li>
					<li>文件最终落在你 Mac 上的哪个文件夹。我们从不知道你的本地路径。</li>
				</ul>

				<h2>我们不打算掩饰的那个局限</h2>
				<p>
					<strong>
						加密是在我们分发的 JavaScript 里跑的。一台被攻陷或心怀恶意的服务器，理论上可以下发被篡改的代码，把密钥泄漏出去。
					</strong>{" "}
					所有通过浏览器交付的端到端加密产品都有这个问题，包括口碑很好的那些。在把重要东西托付给任何一个之前，值得先明白这一点。
				</p>
				<p>我们为此做了什么：</p>
				<ul>
					<li>严格的内容安全策略，不允许任何内联脚本或内联样式。</li>
					<li>发送页有自己独立的打包产物，小到「花一个下午读完」是现实的，而不是一个项目。</li>
					<li>发送端代码开源，可供审计。</li>
					<li>
						Mac App 的哈希公布在<a href="/download">下载页</a>上，你可以核对拿到的安装包是否就是我们发出的那份。
					</li>
				</ul>
				<p>
					这些都没有把局限变成保证，只是把它收窄了。如果某个文件绝对不能被除你之外的任何人读到，那它应该在进入任何浏览器之前就已经加密。
				</p>

				<h2>我们刻意不说的话</h2>
				<p>
					不说「零知识」——我们知道文件大小和时间。不说「你的文件从不经过我们的服务器」——密文确实经过，只是很短暂，而这恰恰是它能在你 Mac 睡觉时照样送达的原因。不说「军用级加密」——这个词没有任何含义。
				</p>
			</>
		),
	},

	pricing: {
		title: "一个价格，只付一次。",
		lede: "Stolnk 是一位独立开发者的一次性买断产品。没有订阅，也没有会到期的套餐。",
		freeName: "免费版",
		freePrice: "$0",
		freeNote: "一个收件箱，每月 3 GB 中转流量。足够正经用起来，也足够让你看到 Mac 把睡过去时错过的东西补收回来。",
		freeCta: "下载 Mac 版",
		proName: "专业版",
		proNote: "前 500 位的发布价。之后是 $39——那是长期价格，不是会再回来的折扣。",
		proCta: "购买 Stolnk Pro",
		proFootnote: "付一次，永久属于你。",
		rows: [
			{ label: "收件箱数量", free: "1 个", pro: "不限个数" },
			{ label: "中转流量", free: "3 GB / 月", pro: "300 GB / 月" },
			{ label: "单文件上限", free: "2 GB", pro: "20 GB" },
			{ label: "Mac 睡眠时的保留时长", free: "24 小时", pro: "7 天" },
			{ label: "可用 Mac 台数", free: "1 台", pro: "3 台" },
			{ label: "版本更新", free: "全部 V1.x", pro: "全部 V1.x" },
		],
		body: (
			<>
				<h2>「买断」到底包含什么</h2>
				<p>
					把这件事说准，比听上去更要紧。一个兑现不了的永久承诺，比一个更小但能兑现的承诺更糟。所以全部内容如下：
				</p>
				<ul>
					<li>软件的永久授权，最多 3 台 Mac。</li>
					<li>全部 V1.x 更新。</li>
					<li>每月 300 GB 中转流量，只要 Stolnk 还在运行就一直有效。</li>
				</ul>
				<p>
					这里写的是一个具体数字而不是「无限」，是刻意的。中转按 GB 计算是真金白银的成本，而每月 300 GB 是一次性付款能够长期扛住的量。如果 Stolnk 将来真的做出了能力上有实质变化的 V2，那会是一次半价的付费升级——而且不管你升不升，你的 V1 授权和额度都继续有效。
				</p>

				<h2>额度用完之后</h2>
				<p>
					永远不会额外扣费，你的收件箱也不会下线。如果某个月的额度用完了，链接会停止接收新文件，等到下个月自然恢复。你不会收到意料之外的账单——因为 Stolnk 里根本不存在能生成账单的机制。
				</p>

				<h2>V1.x 内会做、且已包含</h2>
				<p>
					这些还没做出来，所以不属于上面那张表今天所承诺的内容。它们列在<a href="/#roadmap">路线图</a>里，将以普通更新的形式发布，而不是变成一个新档位。
				</p>

				<h2>退款与支持</h2>
				<p>
					14 天内无理由退款——发封邮件就办好。支持只走邮件，且是尽力而为：Stolnk 只有一个人，承诺得比这更多，就又是一件兑现不了的事。
				</p>
			</>
		),
	},

	thanks: {
		title: "谢谢——你已经是 Stolnk Pro 用户了。",
		lede: "付款已完成。你的授权码就在 Creem 刚才显示的确认页上，同时也正在发往你付款时用的邮箱。",
		activate: "怎么激活",
		activateBody: (
			<>
				<ol>
					<li>
						从菜单栏打开 Stolnk，选择 <strong>设置 → 授权</strong>。
					</li>
					<li>粘贴授权码，点击「激活」。</li>
				</ol>
				<p>
					就这些——不用注册账号，也没有什么要登录的。一个授权码最多覆盖三台 Mac，在每台上重复一次即可；之后释放某台 Mac，它占的席位就会空出来给另一台。
				</p>
			</>
		),
		cta: "下载 Mac 版",
		rest: (
			<>
				<h2>如果没收到授权码</h2>
				<p>
					先看垃圾邮件——正常一两分钟内就会到。如果确实没有，发邮件给我们会重发一次；不管那封信有没有送到你手上，订单在 Creem 那边都是存在的。
				</p>

				<h2>退款</h2>
				<p>
					14 天内无理由退款——发封邮件就办好，和<a href="/pricing">定价页</a>写的完全一致。退款会把这台 Mac 退回免费版，并暂停第一个之外的收件箱。什么都不会被删除，重新购买后一切照旧回来。
				</p>
			</>
		),
	},

	notFound: {
		title: "这里什么都没有",
		body: (
			<p>
				收件箱链接长这样：<code>ryan.stolnk.com/client-a</code>——一个名字加一段路径，两者缺一不可。如果这是别人给你的链接，检查一下是不是打错了字。
			</p>
		),
		home: "回到 Stolnk 首页",
	},
};
