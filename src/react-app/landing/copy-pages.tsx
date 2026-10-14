import { SUPPORT_EMAIL } from "./contact.ts";

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
 * The price list. Stolnk is an iPhone app sold as a paid download, so every
 * row below is the `PRO` tier in `worker/limits.ts` — installing the app is
 * what grants it (`routes/licenses.ts`, `/apple/app`). Two honesty rules still
 * shape the copy:
 *
 *  1. **The word "unlimited" does not appear.** What is sold is the app, every
 *     V1.x update, and 300 GB of relay a month — a number a one-time payment
 *     can honour forever.
 *  2. **Nothing is listed that does not exist yet.** Unbuilt features sit on
 *     the roadmap on the home page, not as a row in the table someone is
 *     paying for today.
 *
 * Nothing is sold on this website. Keep it that way: App Review treats a
 * second place to buy the same features as content bought outside the app.
 */

export const pagesEn = {
	download: {
		title: "Get Stolnk for iPhone",
		lede: "iPhone, iOS 17 or later. A paid download on the App Store — every feature included, with no in-app purchases and no subscription.",
		pricingLink: "Pricing",
		cta: "Download on the App Store",
		meta: "$1.99 · iPhone · iOS 17 or later",
		firstLaunch: "First launch",
		firstLaunchBody: (
			<ol>
				<li>
					Pick a name. That is your whole identity — there is no sign-in, no email and no
					password.
				</li>
				<li>
					Choose a folder and give it a path. You now have an address like{" "}
					<code>yourname.stolnk.com/clients</code>.
				</li>
				<li>
					Send the address to anyone, or show it as a QR code. Files sent to it land in that
					folder.
				</li>
				<li>
					If iOS asks for local network access, allowing it lets a sender on the same Wi-Fi
					reach your iPhone directly. Stolnk works without it.
				</li>
			</ol>
		),
		onYourPhone: "What it does on your iPhone",
		onYourPhoneBody: (
			<ul>
				<li>Generates its keys in the Secure Enclave on first launch.</li>
				<li>Keeps received files inside the app's own storage, in the folders you made.</li>
				<li>Collects files that waited while you were offline the next time you open it.</li>
				<li>Has no advertising, no analytics SDK and no tracking.</li>
				<li>Lets you delete your account, and everything we hold for it, from inside the app.</li>
			</ul>
		),
	},

	howItWorks: {
		title: "How Stolnk works",
		lede: "Files are encrypted in the sender's browser and can only be decrypted by your iPhone. We can't read them — not in transit, not at rest.",
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
					iPhone's public key. It generates a one-time key for the file, encrypts the file
					with it, and wraps that key so that only your iPhone's private key can unwrap it.
				</p>
				<p>
					The encrypted bytes are held briefly in object storage. Your iPhone collects them,
					and the stored copy is deleted the moment it confirms the file landed. If your
					iPhone is offline or Stolnk is not open, they wait — up to 7 days — and are
					delivered the next time it is.
				</p>

				<h2>On the same Wi-Fi</h2>
				<p>
					When the sender is on the same network as your iPhone, the same ciphertext goes
					straight to the phone instead. Our server only helps the two find each other; not
					one byte of the file reaches us. Whether that happens is decided by the network,
					and nothing else changes.
				</p>

				<h2>What the keys are</h2>
				<p>
					Your iPhone generates two P-256 keypairs inside its <strong>Secure Enclave</strong>{" "}
					on first launch: one to prove its identity to our server, one to unwrap file keys.
					The private halves never leave it and cannot be exported — by us, by the app, or by
					anyone with access to the phone's storage.
				</p>
				<p>
					The direct consequence, stated plainly:{" "}
					<strong>keys cannot move to a new iPhone.</strong> Setting up a new phone means new
					keys. Anything still waiting for the old one becomes undecryptable, so open Stolnk
					on the old phone and collect everything before you switch.
				</p>

				<h2>What we can see</h2>
				<p>We store, and can read:</p>
				<ul>
					<li>The size of each file, and when it was sent.</li>
					<li>Which inbox it was addressed to.</li>
					<li>Your iPhone's public keys.</li>
				</ul>
				<p>We cannot read:</p>
				<ul>
					<li>File contents.</li>
					<li>
						Filenames — they are encrypted too, though their <em>length</em> can be inferred
						from the ciphertext.
					</li>
					<li>Which folder in the app a file lands in.</li>
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
				</ul>
				<p>
					None of that turns the limitation into a guarantee. It narrows it. A file that must
					never be readable by anyone but you should be encrypted before it reaches any
					browser.
				</p>

				<h2>Two routes that are not browser-encrypted</h2>
				<p>
					An inbox address is also usable from a terminal —{" "}
					<code>curl -F &quot;file=@photo.jpg&quot; ryan.stolnk.com/client-a</code> — because
					scripts, build jobs and AI agents cannot run the encryption a browser runs.{" "}
					<strong>
						On that route the file arrives at our server as plaintext, and our server builds
						the envelope with your iPhone&rsquo;s public key.
					</strong>{" "}
					Your iPhone cannot tell the two apart and does not need to: what it receives, and
					what it alone can open, is identical either way.
				</p>
				<p>
					A file shared outward from the iPhone as a download link is the other deliberate
					exception. It is stored in plaintext so any browser can download it; Stolnk can
					read it until the link expires, is spent or is revoked. The app says so at the
					point you create the link.
				</p>
				<p>
					For the terminal route, what differs is one request&rsquo;s worth of exposure. The
					bytes exist in our server&rsquo;s memory in the clear for as long as it takes to
					encrypt them, and are written nowhere in that form. That is a real difference
					rather than a footnote, which is why it is here instead of left to be discovered —
					if it matters for a particular file, send that file through the page.
				</p>

				<h2>Things we deliberately do not say</h2>
				<p>
					Not "zero knowledge" — we know file sizes and timing. Not "your files never touch
					our servers" — the encrypted bytes do, briefly, and that is exactly what lets them
					arrive while your phone is offline. Not "military-grade" — that phrase means
					nothing.
				</p>
			</>
		),
	},

	pricing: {
		title: "One price. Paid once.",
		lede: "Stolnk is a paid download on the App Store, from a single developer. Every feature is included from the moment you install — no in-app purchases, no subscription, no plan that expires.",
		planName: "Stolnk for iPhone",
		price: "$1.99",
		planNote: "Paid once, on the App Store. Everything in the table below is included.",
		cta: "Download on the App Store",
		footnote: "US price. The App Store shows the price for your country.",
		rows: [
			{ label: "Inbox addresses", value: "As many as you like" },
			{ label: "Largest single file", value: "20 GB" },
			{ label: "Relayed files", value: "300 GB / month" },
			{ label: "Held while your phone is offline", value: "7 days" },
			{ label: "Download links", value: "Up to 100, each lasting up to 30 days" },
			{ label: "Passwords on addresses and links", value: "Included" },
			{ label: "Updates", value: "All of V1.x" },
		],
		body: (
			<>
				<h2>What "paid once" actually covers</h2>
				<p>
					Being precise about this matters more than it sounds. A perpetual promise that
					cannot be kept is worse than a smaller one that can, so here is the whole of it:
				</p>
				<ul>
					<li>The app, on the iPhones your Apple Account can download it to.</li>
					<li>Every V1.x update.</li>
					<li>300 GB of relayed files per month, for as long as Stolnk runs.</li>
				</ul>
				<p>
					That is a number rather than the word "unlimited" on purpose. Relaying costs real
					money per gigabyte, and 300 GB a month is an amount a one-time payment can carry
					indefinitely. Transfers on the same Wi-Fi go directly to your iPhone and do not
					count against it.
				</p>

				<h2>Running out</h2>
				<p>
					Nothing is ever billed on top, and your inbox never goes down. If a month's
					allowance runs out, links stop accepting new files and start again when the month
					turns over. There are no in-app purchases, so there is nothing to upsell you to.
				</p>

				<h2>Coming in V1.x, included</h2>
				<p>
					These are not built yet, so they are not part of what the table above promises
					today. They are listed on the <a href="/#roadmap">roadmap</a>, and they arrive as
					ordinary updates rather than as a new tier.
				</p>

				<h2>Refunds and support</h2>
				<p>
					The App Store handles payment and refunds: request one from Apple at{" "}
					<a href="https://reportaproblem.apple.com">reportaproblem.apple.com</a>. Support
					is by email at <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>, and
					best-effort: Stolnk is one person, and promising more than that would be another
					thing that could not be kept.
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
		title: "获取 Stolnk iPhone 版",
		lede: "适用于 iPhone，需要 iOS 17 及以上。App Store 付费下载——全部功能都包含在内，没有内购，也没有订阅。",
		pricingLink: "查看定价",
		cta: "在 App Store 下载",
		meta: "$1.99 · iPhone · iOS 17 及以上",
		firstLaunch: "第一次打开",
		firstLaunchBody: (
			<ol>
				<li>起一个名字。这就是你的全部身份——没有登录，没有邮箱，也没有密码。</li>
				<li>
					选一个文件夹，给它配一段路径。你就有了一个形如 <code>yourname.stolnk.com/clients</code>{" "}
					的地址。
				</li>
				<li>把地址发给任何人，或者显示成二维码。发到这个地址的文件会落进那个文件夹。</li>
				<li>
					如果 iOS 询问本地网络权限，允许之后，同一 Wi-Fi 下的发送方可以直接连到你的 iPhone。不允许也照样能用。
				</li>
			</ol>
		),
		onYourPhone: "它在你 iPhone 上做什么",
		onYourPhoneBody: (
			<ul>
				<li>首次启动时在安全隔区里生成密钥。</li>
				<li>收到的文件保存在 App 自己的存储空间里，放在你建的文件夹中。</li>
				<li>你离线期间在等待的文件，下次打开时自动取回。</li>
				<li>没有广告，没有统计 SDK，没有追踪。</li>
				<li>可以在 App 内删除账号，以及我们为它保存的全部数据。</li>
			</ul>
		),
	},

	howItWorks: {
		title: "Stolnk 是怎么工作的",
		lede: "文件在发送方的浏览器里就已加密，只有你的 iPhone 能解开。我们读不到内容——传输中读不到，存着的时候也读不到。",
		body: (
			<>
				<h2>一个文件走过的路</h2>
				<p>
					别人打开你的链接时，他的浏览器只向我们的服务器要一样东西：你 iPhone 的公钥。浏览器为这个文件生成一把一次性密钥，用它加密文件，再把这把密钥包起来——只有你 iPhone 的私钥能解开。
				</p>
				<p>
					密文会在对象存储里短暂停留。你的 iPhone 取走它，确认收到之后，存储里那份副本立刻删除。如果你的 iPhone 离线或者没打开 Stolnk，密文就等着——最多 7 天——等下次上线时再送达。
				</p>

				<h2>在同一个 Wi-Fi 下</h2>
				<p>
					发送方和你的 iPhone 在同一个网络时，同样的密文会直接发到手机上。我们的服务器只负责让两边找到彼此，文件没有一个字节经过我们。走不走这条路由网络决定，其余一切不变。
				</p>

				<h2>密钥是什么</h2>
				<p>
					你的 iPhone 在首次启动时于<strong>安全隔区（Secure Enclave）</strong>内生成两对 P-256 密钥：一对用于向服务器证明身份，一对用于解开文件密钥。私钥那一半从不离开安全隔区，也无法导出——我们不能，App 不能，能接触到这台手机存储的人也不能。
				</p>
				<p>
					由此直接带来的后果，说白了就是：<strong>密钥没法迁移到新 iPhone。</strong>
					换新手机意味着一套新密钥，还在等旧手机的文件会变得无法解密。所以换机之前，先在旧手机上打开 Stolnk 把文件收完。
				</p>

				<h2>我们能看到什么</h2>
				<p>我们会存储、也能读到：</p>
				<ul>
					<li>每个文件的大小，以及发送时间。</li>
					<li>它发往哪个收件箱。</li>
					<li>你 iPhone 的公钥。</li>
				</ul>
				<p>我们读不到：</p>
				<ul>
					<li>文件内容。</li>
					<li>
						文件名——它同样是加密的，不过从密文长度可以推断出名字的<em>长度</em>。
					</li>
					<li>文件落在 App 里的哪个文件夹。</li>
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
				</ul>
				<p>
					这些都没有把局限变成保证，只是把它收窄了。如果某个文件绝对不能被除你之外的任何人读到，那它应该在进入任何浏览器之前就已经加密。
				</p>

				<h2>还有两条路不走浏览器端加密</h2>
				<p>
					收件地址同时也能在终端里用——
					<code>curl -F &quot;file=@photo.jpg&quot; ryan.stolnk.com/client-a</code>
					——因为脚本、构建任务和 AI agent 跑不了浏览器跑的那套加密。
					<strong>走这条路时，文件是以明文到达我们服务器的，再由我们的服务器用你 iPhone 的公钥封装。</strong>{" "}
					你的 iPhone 分辨不出这两者，也不需要分辨：它收到的、并且只有它能打开的那份东西，两条路完全一样。
				</p>
				<p>
					从 iPhone 以下载链接向外分享文件是另一个刻意的例外。为了让任意浏览器都能下载，文件以明文存放；在链接过期、次数用完或被撤销之前，Stolnk 能够读取它。App 会在你创建链接时写明这一点。
				</p>
				<p>
					终端这条路不一样的是一次请求那么长的暴露窗口。字节以明文形式存在于我们服务器的内存里，直到加密完成为止，并且从不以那种形式写到任何地方。这是实打实的区别，不是脚注——所以写在这里，而不是留给人自己发现。如果某个文件在意这一点，那个文件就走页面发。
				</p>

				<h2>我们刻意不说的话</h2>
				<p>
					不说「零知识」——我们知道文件大小和时间。不说「你的文件从不经过我们的服务器」——密文确实经过，只是很短暂，而这恰恰是它能在你手机离线时照样送达的原因。不说「军用级加密」——这个词没有任何含义。
				</p>
			</>
		),
	},

	pricing: {
		title: "一个价格，只付一次。",
		lede: "Stolnk 是一位独立开发者在 App Store 上的付费下载应用。安装即享全部功能——没有内购，没有订阅，也没有会到期的套餐。",
		planName: "Stolnk iPhone 版",
		price: "$1.99",
		planNote: "在 App Store 付一次钱。下表所列全部包含在内。",
		cta: "在 App Store 下载",
		footnote: "美区价格。App Store 会显示你所在国家或地区的价格。",
		rows: [
			{ label: "收件地址", value: "不限个数" },
			{ label: "单文件上限", value: "20 GB" },
			{ label: "中转流量", value: "300 GB / 月" },
			{ label: "手机离线时的保留时长", value: "7 天" },
			{ label: "下载链接", value: "最多 100 个，每个最长 30 天" },
			{ label: "地址和链接设密码", value: "包含" },
			{ label: "版本更新", value: "全部 V1.x" },
		],
		body: (
			<>
				<h2>「买断」到底包含什么</h2>
				<p>
					把这件事说准，比听上去更要紧。一个兑现不了的永久承诺，比一个更小但能兑现的承诺更糟。所以全部内容如下：
				</p>
				<ul>
					<li>这个 App，可以装在你的 Apple 账户能下载到的 iPhone 上。</li>
					<li>全部 V1.x 更新。</li>
					<li>每月 300 GB 中转流量，只要 Stolnk 还在运行就一直有效。</li>
				</ul>
				<p>
					这里写的是一个具体数字而不是「无限」，是刻意的。中转按 GB 计算是真金白银的成本，而每月 300 GB 是一次性付款能够长期扛住的量。同一 Wi-Fi 下的传输直接到你的 iPhone，不计入额度。
				</p>

				<h2>额度用完之后</h2>
				<p>
					永远不会额外扣费，你的收件箱也不会下线。如果某个月的额度用完了，链接会停止接收新文件，等到下个月自然恢复。App 里没有内购，所以也没有什么可以向你追加推销的。
				</p>

				<h2>V1.x 内会做、且已包含</h2>
				<p>
					这些还没做出来，所以不属于上面那张表今天所承诺的内容。它们列在<a href="/#roadmap">路线图</a>里，将以普通更新的形式发布，而不是变成一个新档位。
				</p>

				<h2>退款与支持</h2>
				<p>
					付款和退款都由 App Store 处理：请在{" "}
					<a href="https://reportaproblem.apple.com">reportaproblem.apple.com</a>{" "}
					向 Apple 申请。支持走邮件 <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>
					，尽力而为：Stolnk 只有一个人，承诺得比这更多，就又是一件兑现不了的事。
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
