import { COMPANY_EN, COMPANY_ZH, SUPPORT_EMAIL } from "./contact.ts";

/**
 * The privacy policy and the terms of service.
 *
 * These are the two pages on the site that are *operative* rather than
 * persuasive: what the privacy policy says we store is a promise about the
 * schema in `migrations/`, and what the terms say is included is a promise
 * about `lib/entitlement.ts`. Both were written by reading those files, and
 * both have to be re-read when either changes.
 *
 * Four places where that produced a less comfortable sentence than the
 * boilerplate would have:
 *
 *  1. **Metadata rows outlive the file, but no longer indefinitely.** The R2
 *     object is deleted on ACK, and PRD 8.5 makes a lot of that — correctly.
 *     The `files` row used to survive until the inbox did, which is what an
 *     earlier draft of this policy had to admit. `TRANSFER_RECORD_TTL_MS` in
 *     `worker/limits.ts` is now the period stated below, and the number here
 *     and the number there have to move together.
 *  2. **`files.plain_sha256` is a hash of the plaintext.** The Mac needs it to
 *     verify what it decrypted. It is nonetheless a content hash, and
 *     `migrations/0001_init.sql` now records that divergence from PRD 7.3
 *     openly. The policy describes what the code does.
 *  3. **The sender session id is a pseudonymous identifier.** Random and
 *     per-tab, but stored against transfers and remembered senders, so it is
 *     disclosed rather than filed under "technical necessity".
 *  4. **Everything is processed outside mainland China.** Cloudflare and Creem
 *     both are. For a PRC-registered controller that is a cross-border transfer
 *     with its own notice and consent requirements, so it gets its own section
 *     instead of a line in a vendor list.
 *
 * NOT LEGAL ADVICE, and not reviewed by a qualified lawyer. The clauses that
 * depend on facts only the operator can confirm — registered address, VAT and
 * tax registration, whether an EU Article 27 representative has been appointed
 * — are marked in the review notes that accompany this file rather than
 * guessed at in the prose.
 */

const UPDATED_EN = "4 September 2026";
const UPDATED_ZH = "2026 年 9 月 4 日";

export const legalEn = {
	privacy: {
		title: "Privacy",
		updated: `Last updated ${UPDATED_EN}`,
		lede: "What Stolnk stores, what it cannot read, where it goes and how long each of those lasts. It is written against the actual database schema rather than around it.",
		body: (
			<>
				<h2>Who this is</h2>
				<p>
					Stolnk is operated by <strong>{COMPANY_EN}</strong> ({COMPANY_ZH}), registered in
					Ningbo, People's Republic of China. We are the controller of the personal
					information described here.
				</p>
				<p>
					Privacy questions, requests and complaints all go to{" "}
					<a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>, which reaches the person
					responsible for personal information protection. We answer within 30 days.
				</p>

				<h2>What happens before anything reaches us</h2>
				<p>
					A file is encrypted in the sender's browser with a one-time key, wrapped so that
					only the receiving Mac can unwrap it. The filename is encrypted with it. What
					arrives at our servers is ciphertext, and we hold no key that opens it.{" "}
					<a href="/how-it-works">How that works, including its limits</a>.
				</p>

				<h2>What we process, why, and on what basis</h2>
				<div className="table-scroll">
					<table className="compare">
						<thead>
							<tr>
								<th>What</th>
								<th>Why</th>
								<th>Basis and how long</th>
							</tr>
						</thead>
						<tbody>
							<tr>
								<th scope="row">
									Device id, the name you chose, two public keys, first and last seen
								</th>
								<td>It is how a link resolves to your Mac at all</td>
								<td>
									Necessary to provide the service you asked for. Kept until you remove
									the device
								</td>
							</tr>
							<tr>
								<th scope="row">
									Inbox path, display name, size limit, paused state
								</th>
								<td>The address half of every link</td>
								<td>
									Necessary to provide the service. Kept until you delete the inbox
								</td>
							</tr>
							<tr>
								<th scope="row">
									Transfer size, timestamps, target inbox, encrypted filename, wrapped
									key, plaintext SHA-256
								</th>
								<td>Delivering the file, and letting your Mac verify it</td>
								<td>
									Necessary to provide the service. See “How long” below — this is the
									one that outlives the file
								</td>
							</tr>
							<tr>
								<th scope="row">A random sender session id</th>
								<td>Remembering “always accept from this person” for one inbox</td>
								<td>
									Necessary to provide the service. Discarded by the browser when the
									tab closes; our copy goes with the transfer record, and a remembered
									“always accept” decision is deleted after 30 days
								</td>
							</tr>
							<tr>
								<th scope="row">Licence key hash, Creem order and customer ids, seats</th>
								<td>Making a purchase real, and making a refund findable</td>
								<td>
									Performance of our contract with you, and our legal obligation to keep
									transaction records. Kept while the licence is valid
								</td>
							</tr>
							<tr>
								<th scope="row">IP address</th>
								<td>Rate limiting, so one client cannot flood the service</td>
								<td>
									Our legitimate interest in keeping the service up. Held in memory for
									about a minute and written nowhere by us
								</td>
							</tr>
						</tbody>
					</table>
				</div>
				<p>
					There is no advertising, no profiling, no automated decision-making that produces
					legal or similarly significant effects, and nothing is sold or shared with data
					brokers. There are none to share with.
				</p>

				<h2>What we cannot read, at all</h2>
				<ul>
					<li>File contents.</li>
					<li>
						Filenames. They are encrypted, though their <em>length</em> can be inferred
						from the ciphertext.
					</li>
					<li>The folder on your Mac a file lands in. We are never told your local paths.</li>
					<li>Anything on a Mac other than what its own app sends us.</li>
				</ul>

				<h2>The one hash we should point at</h2>
				<p>
					Among the transfer fields above is a <strong>SHA-256 of the file's unencrypted
					contents</strong>. Your Mac needs it to verify that what it decrypted is what was
					sent.
				</p>
				<p>
					We are naming it separately because it is a content hash, and a content hash has a
					property worth understanding: it reveals nothing about what a file contains, but
					anyone who already holds a copy of a particular file could use it to test whether
					that same file passed through here. We would rather you learn that from us than
					from the schema.
				</p>

				<h2>How long</h2>
				<p>
					<strong>The encrypted file is deleted the moment your Mac confirms it landed</strong>{" "}
					— not on a schedule, immediately. A file your Mac never collects is deleted when
					the hold expires: 24 hours on Free, 7 days on Pro.
				</p>
				<p>
					<strong>The metadata row outlives the file, by 30 days.</strong> After a transfer
					finishes, the row holding its size, timestamps, encrypted name, wrapped key and
					plaintext hash is kept for 30 days and then deleted automatically. Nothing in
					Stolnk reads those rows once the transfer is over — there is no history feature —
					so the window exists only so that a sender whose page is still open sees
					“delivered” rather than an error, and so that a support question about last week
					is still answerable.
				</p>
				<p>
					You do not have to wait for it. <strong>Clear Records</strong> in the Mac app
					forgets an inbox's finished transfers immediately and keeps the inbox and its
					address; deleting an inbox or removing the device does the same thing and takes
					the address with it. Both cascade.
				</p>
				<p>
					Purchase records are kept while the licence is valid, and for as long afterwards
					as accounting and tax law requires us to keep transaction records.
				</p>

				<h2>Where it goes</h2>
				<p>
					<strong>
						Stolnk runs on infrastructure outside mainland China, so using it means your
						information is transferred and processed abroad.
					</strong>{" "}
					This is not incidental — it is how the service is built, and you should decide
					with it in view.
				</p>
				<ul>
					<li>
						<strong>Cloudflare, Inc.</strong> (United States, with a global edge network)
						provides the servers, the database and the object storage. Everything in the
						table above except the purchase records lives there, and traffic to stolnk.com
						passes through their network.
					</li>
					<li>
						<strong>Creem</strong> processes payments and issues licence keys, and is the
						merchant of record for every purchase. Your payment details go to them and
						never to us.
					</li>
					<li>
						<strong>Apple</strong> notarises the Mac app. That check happens between your
						Mac and Apple; we are not part of it and are not told the outcome.
					</li>
				</ul>
				<p>
					We use each of them under their own terms and data protection commitments,
					including standard contractual clauses where those apply. If you are in the
					European Economic Area, the United Kingdom or Switzerland, transfers rely on those
					clauses. If you are in mainland China, installing and using Stolnk is your
					separate consent to this cross-border transfer for the purposes listed above; you
					can withdraw it at any time by removing your device, which stops the transfer for
					the future.
				</p>

				<h2>Your rights</h2>
				<p>
					Wherever you are, you can ask us to show you what we hold, correct it, delete it,
					give you a portable copy, restrict what we do with it, or object to it. Where we
					rely on consent you can withdraw it, and withdrawing does not make what came
					before unlawful.
				</p>
				<p>
					Email <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>. The practical limit
					is that we cannot identify you from a licence key hash alone, so tell us the order
					number or the device name — we will not ask for more identification than the
					request needs.
				</p>
				<p>
					If we get it wrong you can complain to your data protection authority: the
					supervisory authority in your country in the EEA or the UK, or the Cyberspace
					Administration of China and its local counterparts in mainland China. We would
					rather you told us first, but that is your call, not a precondition.
				</p>

				<h2>Security, and what happens if it fails</h2>
				<p>
					Files are encrypted before they reach us, connections are TLS-only with HSTS, the
					site runs under a strict Content Security Policy, and licence keys are stored only
					as hashes. None of that is a guarantee.
				</p>
				<p>
					If a breach happens that is likely to affect you, we will tell you and the
					relevant authority without undue delay — within 72 hours of becoming aware where
					the law sets that deadline — and we will say what happened rather than what sounds
					best.
				</p>

				<h2>Cookies</h2>
				<p>
					None. There is no analytics script, no tracking pixel and no consent banner,
					because there is nothing to consent to.
				</p>
				<p>Three things are stored in your own browser and never sent to us:</p>
				<ul>
					<li>Which language you chose for this site.</li>
					<li>A random per-tab session id on a send page, cleared when the tab closes.</li>
					<li>
						While an upload is in flight, enough to resume it — including that file's
						one-time key. It is deleted when the transfer completes, and it never leaves
						the browser.
					</li>
				</ul>

				<h2>Children</h2>
				<p>
					Stolnk is not intended for children. Do not use it if you are under 14 in mainland
					China, under 16 in the European Economic Area, or under 13 anywhere else. We do
					not knowingly collect information from them, and if we learn we have, we delete
					it.
				</p>

				<h2>Changes</h2>
				<p>
					If this changes materially the date at the top changes, and where the law requires
					it we will tell you before the change takes effect. We are not going to silently
					widen what we collect.
				</p>
			</>
		),
	},

	terms: {
		title: "Terms of Service",
		updated: `Last updated ${UPDATED_EN}`,
		lede: "The agreement between you and us. It is short because the product is, and it does not promise anything the software cannot do.",
		body: (
			<>
				<h2>The agreement</h2>
				<p>
					These terms are between you and <strong>{COMPANY_EN}</strong> ({COMPANY_ZH}).
					Downloading, installing or using Stolnk means you accept them. If you do not, do
					not use it — and if you have paid, ask for a refund.
				</p>
				<p>
					You need to be old enough to enter a contract where you live to buy a licence. If
					you are buying for a company, you are confirming you may bind it.
				</p>

				<h2>What you get</h2>
				<p>
					Stolnk is a one-time purchase, not a subscription. Buying Pro gives you a
					permanent, worldwide, non-exclusive, non-transferable licence to use the software
					on up to three Macs at a time, together with:
				</p>
				<ul>
					<li>Every V1.x update.</li>
					<li>300 GB of relayed files per month, for as long as we run the service.</li>
				</ul>
				<p>
					The word "unlimited" is deliberately absent, and{" "}
					<a href="/pricing">the pricing page</a> explains why at length. If a V2 with
					genuinely new capabilities ever exists it will be a separate paid upgrade, and
					your V1 licence keeps working whether or not you take it.
				</p>
				<p>
					Free use is the same software with a smaller allowance. It is not a trial and does
					not expire.
				</p>
				<p>
					<strong>The roadmap is not part of this agreement.</strong> Features described as
					coming in V1.x are our intention, not a commitment you are paying for, and what
					you have bought is the software as it is today plus whatever V1.x actually ships.
				</p>

				<h2>Your files stay yours</h2>
				<p>
					We claim no ownership of and no licence to anything sent through Stolnk. We could
					not use it if we wanted to: it arrives encrypted and we hold no key.
				</p>
				<p>
					You are responsible for what you send and for what you invite others to send you,
					and you confirm you have the right to send it.
				</p>

				<h2>What you may not do</h2>
				<ul>
					<li>Resell, sublicense or redistribute the software itself.</li>
					<li>Share a licence key beyond the seats it covers.</li>
					<li>
						Use Stolnk to distribute malware, material that infringes someone's rights,
						child sexual abuse material, or anything else illegal where you or the
						recipient are.
					</li>
					<li>
						Attempt to break the service's limits, other people's inboxes, or the
						infrastructure the two run on.
					</li>
					<li>
						Use it in breach of export control or sanctions law, or from a country subject
						to comprehensive sanctions.
					</li>
				</ul>
				<p>
					Reading, auditing and discussing the code is explicitly fine, and is the reason
					the sending half of it is published.
				</p>

				<h2>Reporting abuse</h2>
				<p>
					Report anything on that list to{" "}
					<a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>.
				</p>
				<p>
					The honest limit is worth stating: we cannot read what passes through, so we
					cannot search for infringing material and we cannot verify a claim by looking. We
					can disable an inbox, a link or an account, and we will where a report is credible
					or an order requires it. Tell us the link, when, and what the problem is.
				</p>

				<h2>What is on your side of the line</h2>
				<p>
					You choose which folders Stolnk writes to, and you decide who gets a link. A link
					is a capability: anyone holding it can send you files. Treat it accordingly.
				</p>
				<p>
					Received files are marked with <code>com.apple.quarantine</code> exactly as a
					browser download would be, but that is a warning mechanism, not a scanner.
				</p>
				<p>
					<strong>Keys cannot move to a new Mac.</strong> They are generated in the Secure
					Enclave and cannot be exported, by us or by anyone. A new machine means a new
					address, and anything still queued for the old one cannot be decrypted by
					anything, including us. This is a property of the design and not a fault we can
					repair after the fact.
				</p>

				<h2>Availability</h2>
				<p>
					Stolnk is built and run by one person. We do not offer an uptime guarantee,
					because we could not honour one. What we do commit to is that a month's allowance
					running out pauses new uploads rather than deleting anything, and that nothing is
					ever billed on top of the purchase price — there is no mechanism in Stolnk that
					could produce an invoice.
				</p>

				<h2>If we ever stop</h2>
				<p>
					A perpetual licence that depends on a hosted relay has to say what happens if the
					relay goes away, so: if we decide to discontinue the service we will give at least
					<strong> 90 days' notice</strong> by email and on this site, keep the relay running
					through that period, and publish a final build that continues to work for anything
					that does not need our servers. If we stop within <strong>12 months</strong> of
					your purchase, you get a refund of what you paid.
				</p>
				<p>
					We may transfer this agreement to whoever acquires the business, on the same
					terms. You will be told before that happens.
				</p>

				<h2>Price, tax and payment</h2>
				<p>
					Creem is the merchant of record. Your contract of sale is with them as well as
					this licence with us, their terms apply to the payment itself, and any VAT, GST or
					sales tax is handled by them and may be added at checkout depending on where you
					are.
				</p>
				<p>
					We may change the price of new purchases at any time. It never changes what you
					already bought.
				</p>

				<h2>Refunds</h2>
				<p>
					14 days, no questions. Email{" "}
					<a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a> and it is done. A refund
					returns that Mac to Free and pauses any inbox beyond the first. Nothing is deleted,
					and buying again restores it as it was.
				</p>
				<p>
					If you are a consumer with a statutory right of withdrawal — in the EU or the UK,
					for instance — this does not replace it. Where our 14 days and your statutory
					rights differ, whichever is better for you is the one that applies.
				</p>

				<h2>Support</h2>
				<p>
					Email only, and best-effort. Promising a response time we could not keep would be
					another thing this page should not say.
				</p>

				<h2>Suspension and ending it</h2>
				<p>
					You can stop using Stolnk at any time; deleting the app and its inboxes removes
					your data as described in the <a href="/privacy">privacy policy</a>.
				</p>
				<p>
					We may suspend or terminate a licence for a serious or repeated breach of the
					list above. Except where the breach is severe or the law requires immediate
					action, we will describe the problem and give you a reasonable chance to fix it
					first. If we terminate a paid licence for a breach that turns out not to be yours,
					we reinstate it.
				</p>

				<h2>Warranty, and your rights as a consumer</h2>
				<p>
					Except as this section says, the software is provided as it is, without warranties
					of any kind.
				</p>
				<p>
					<strong>
						If you are a consumer, that exclusion does not take away any right you have by
						law
					</strong>{" "}
					— including rights that digital content be as described, fit for purpose and of
					satisfactory quality, and any statutory remedy for it not being so. Those rights
					stand whatever the rest of this page says.
				</p>

				<h2>Liability</h2>
				<p>
					To the extent the law allows, our total liability arising out of Stolnk is limited
					to the greater of what you paid for it and USD 50, and we are not liable for
					indirect or consequential loss, lost data or lost profit.
				</p>
				<p>
					Nothing here limits liability for fraud or fraudulent misrepresentation, for death
					or personal injury caused by negligence, for gross negligence or wilful
					misconduct, or for anything else that cannot lawfully be limited — including,
					where you are a consumer, liability under the mandatory consumer law of your
					country.
				</p>

				<h2>Changes to these terms</h2>
				<p>
					If they change materially, the date at the top changes and we will tell you before
					the change takes effect where we can reach you. Continuing to use Stolnk
					afterwards means accepting the new version. If you would rather not, stop using it
					— and if you are inside the refund window, the refund still stands.
				</p>

				<h2>Law and disputes</h2>
				<p>
					These terms are governed by the laws of the People's Republic of China, and
					disputes go to the courts with jurisdiction over our registered address in Ningbo.
				</p>
				<p>
					<strong>If you are a consumer, that does not move you.</strong> You keep the
					protection of the mandatory law of the country you live in, and you can bring a
					claim in your own local courts if the law there says you can.
				</p>

				<h2>The rest</h2>
				<ul>
					<li>
						If a clause turns out to be unenforceable, the rest still stands and that clause
						is read as narrowly as it needs to be to work.
					</li>
					<li>
						Not enforcing something once is not giving it up.
					</li>
					<li>
						These terms and the privacy policy are the whole agreement about Stolnk, and
						replace anything said earlier.
					</li>
					<li>
						This page exists in English and Chinese. Both are written to say the same thing;
						if they ever conflict, the Chinese version governs.
					</li>
				</ul>

				<h2>Contact</h2>
				<p>
					{COMPANY_EN} · <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>
				</p>
			</>
		),
	},
};

export const legalZh: typeof legalEn = {
	privacy: {
		title: "隐私政策",
		updated: `最后更新于 ${UPDATED_ZH}`,
		lede: "Stolnk 存了什么、读不到什么、数据去了哪里，以及各自保留多久。它是照着真实的数据库结构写的，不是绕着它写的。",
		body: (
			<>
				<h2>我们是谁</h2>
				<p>
					Stolnk 由<strong>{COMPANY_ZH}</strong>运营，注册地为中华人民共和国宁波市。就本页所述个人信息而言，我们是个人信息处理者。
				</p>
				<p>
					隐私相关的问题、请求和投诉都发到{" "}
					<a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>
					，这个信箱直达个人信息保护负责人。我们在 30 天内答复。
				</p>

				<h2>在任何东西到达我们之前</h2>
				<p>
					文件在发送方的浏览器里就用一把一次性密钥加密，而这把密钥被包装成只有接收端那台 Mac 能解开的形式。文件名也用它加密。到达我们服务器的是密文，我们手里没有任何能打开它的密钥。
					<a href="/how-it-works">这套机制是怎么运作的，以及它的局限</a>。
				</p>

				<h2>我们处理什么、为什么、依据是什么</h2>
				<div className="table-scroll">
					<table className="compare">
						<thead>
							<tr>
								<th>处理什么</th>
								<th>为什么</th>
								<th>依据与期限</th>
							</tr>
						</thead>
						<tbody>
							<tr>
								<th scope="row">
									设备标识、你选的名字、两把公钥、首次与最后出现时间
								</th>
								<td>这是链接能指向你 Mac 的前提</td>
								<td>为提供你所要求的服务所必需。保留至你移除该设备</td>
							</tr>
							<tr>
								<th scope="row">收件箱路径、显示名、大小上限、是否暂停</th>
								<td>每条链接的地址部分</td>
								<td>为提供服务所必需。保留至你删除该收件箱</td>
							</tr>
							<tr>
								<th scope="row">
									传输大小、时间戳、目标收件箱、加密文件名、被包装的密钥、明文 SHA-256
								</th>
								<td>把文件送到，并让你的 Mac 能核对它</td>
								<td>为提供服务所必需。见下方「保留多久」——这一项比文件本身活得久</td>
							</tr>
							<tr>
								<th scope="row">一个随机的发送方会话标识</th>
								<td>在某个收件箱上记住「以后一直接收此人」</td>
								<td>
									为提供服务所必需。浏览器在关闭标签页时丢弃；我们这一份随传输记录一起处置，「以后一直接收此人」的决定在 30 天后删除
								</td>
							</tr>
							<tr>
								<th scope="row">授权码哈希、Creem 订单与客户标识、席位数</th>
								<td>让购买成立，也让退款能找到对应授权</td>
								<td>
									为履行与你的合同所必需，以及我们保存交易记录的法定义务。授权有效期内保留
								</td>
							</tr>
							<tr>
								<th scope="row">IP 地址</th>
								<td>限流，避免单个客户端把服务打满</td>
								<td>基于我们维持服务可用的正当利益。在内存中保留约一分钟，我们不写入任何地方</td>
							</tr>
						</tbody>
					</table>
				</div>
				<p>
					没有广告，没有用户画像，没有会产生法律效果或类似重大影响的自动化决策，也不出售或向数据经纪商共享任何数据——根本没有可共享的对象。
				</p>

				<h2>我们完全读不到的东西</h2>
				<ul>
					<li>文件内容。</li>
					<li>
						文件名。它是加密的，不过从密文长度可以推断出名字的<em>长度</em>。
					</li>
					<li>文件落在你 Mac 上的哪个文件夹。你的本地路径从来不会告诉我们。</li>
					<li>Mac 上除了它自己的 App 主动发给我们的之外的任何东西。</li>
				</ul>

				<h2>有一个哈希我们要单独点出来</h2>
				<p>
					上表的传输字段里有一项是<strong>文件未加密内容的 SHA-256</strong>
					。你的 Mac 需要用它核对解密出来的东西就是发出去的东西。
				</p>
				<p>
					之所以单独说，是因为它是一种内容哈希，而内容哈希有一个值得你知道的性质：它不会泄露文件里有什么，但任何手上已经有某个特定文件副本的人，都能用它来验证那个文件是否经过了这里。这件事我们宁愿你从我们这儿知道，而不是从数据库结构里发现。
				</p>

				<h2>保留多久</h2>
				<p>
					<strong>加密文件本身，在你的 Mac 确认落盘的那一刻就删除</strong>
					——不是按计划清理，是立刻。你的 Mac 一直没来取的文件，会在保留期到点时删除：免费版 24 小时，专业版 7 天。
				</p>
				<p>
					<strong>元数据记录比文件多活 30 天。</strong>
					一次传输结束后，记录它的大小、时间戳、加密文件名、被包装密钥和明文哈希的那一行会保留 30 天，然后被自动删除。传输结束后 Stolnk 里没有任何地方再读这些记录——产品里没有历史记录功能——所以这个窗口存在的理由只有两个：让页面还开着的发送方看到「已送达」而不是一个错误，以及让一周前的支持问题还答得上来。
				</p>
				<p>
					你不必等它。Mac App 里的<strong>「清除记录」</strong>会立即忘掉某个收件箱已完成的传输，并保留该收件箱和它的地址；删除收件箱或移除设备做的是同一件事，只是会连地址一起交出去。两者都是级联的。
				</p>
				<p>
					购买记录在授权有效期内保留，之后按会计和税务法规要求我们保存交易记录的年限继续保留。
				</p>

				<h2>数据去了哪里</h2>
				<p>
					<strong>
						Stolnk 运行在中国大陆境外的基础设施上，所以使用它意味着你的信息会被传输到境外并在境外处理。
					</strong>{" "}
					这不是附带说明——服务本身就是这么建的，你应当在知道这一点的前提下做决定。
				</p>
				<ul>
					<li>
						<strong>Cloudflare, Inc.</strong>（美国，全球边缘网络）提供服务器、数据库和对象存储。上表中除购买记录外的一切都在那里，发往 stolnk.com 的流量也经过他们的网络。
					</li>
					<li>
						<strong>Creem</strong> 处理支付并签发授权码，是每一笔购买的记录商户。你的支付信息进的是它那里，永远不会到我们这里。
					</li>
					<li>
						<strong>Apple</strong> 为 Mac App 做公证。这个校验发生在你的 Mac 和 Apple 之间，我们不参与，也不会被告知结果。
					</li>
				</ul>
				<p>
					我们按各方自己的条款和数据保护承诺使用它们，在适用的情形下包括标准合同条款。如果你在欧洲经济区、英国或瑞士，跨境传输依据的是那些条款。如果你在中国大陆，安装并使用 Stolnk 即构成你对上述目的下这一跨境传输的单独同意；你可以随时通过移除设备撤回同意，撤回后不再发生新的传输。
				</p>

				<h2>你的权利</h2>
				<p>
					无论你在哪里，你都可以要求我们出示所持有的数据、更正它、删除它、给你一份可携带的副本、限制我们的处理，或提出反对。凡是以同意为依据的，你可以撤回同意，撤回不影响此前处理的合法性。
				</p>
				<p>
					发邮件到 <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>
					。现实的限制是我们无法仅凭一个授权码哈希认出你，所以请附上订单号或设备名——我们不会索取超出该请求所需的身份材料。
				</p>
				<p>
					如果我们做错了，你可以向监管机构投诉：在欧洲经济区或英国是你所在国的监督机构，在中国大陆是国家网信部门及其地方机构。我们希望你先告诉我们，但那是你的选择，不是前置条件。
				</p>

				<h2>安全，以及万一失守</h2>
				<p>
					文件在到达我们之前就已加密，连接仅走 TLS 并启用 HSTS，站点运行在严格的内容安全策略之下，授权码只以哈希形式存储。这些都不构成保证。
				</p>
				<p>
					如果发生可能影响到你的数据泄露，我们会不迟延地通知你和相关主管部门——在法律设定该期限的情形下，自知悉起 72 小时内——并且会说清楚发生了什么，而不是说什么最好听。
				</p>

				<h2>Cookie</h2>
				<p>没有。没有统计脚本，没有追踪像素，也没有同意横幅——因为没有需要你同意的东西。</p>
				<p>有三样东西存在你自己的浏览器里，从不发给我们：</p>
				<ul>
					<li>你为本站选择的语言。</li>
					<li>发送页上一个随机的、每标签页独立的会话标识，关掉标签页就清除。</li>
					<li>
						上传进行中时，足以续传所需的信息——包括那个文件的一次性密钥。传输完成即删除，并且从不离开浏览器。
					</li>
				</ul>

				<h2>未成年人</h2>
				<p>
					Stolnk 不面向未成年人。中国大陆未满 14 周岁、欧洲经济区未满 16 周岁、其他地区未满 13 周岁的，请勿使用。我们不会在知情的情况下收集他们的信息；一旦发现已经收集，即予删除。
				</p>

				<h2>变更</h2>
				<p>
					如果本政策发生实质变更，顶部的日期会更新；在法律要求的情形下，我们会在变更生效前通知你。我们不会悄悄扩大收集范围。
				</p>
			</>
		),
	},

	terms: {
		title: "服务条款",
		updated: `最后更新于 ${UPDATED_ZH}`,
		lede: "你与我们之间的约定。它很短，因为产品本身就很短；而且它不承诺软件做不到的事。",
		body: (
			<>
				<h2>本协议</h2>
				<p>
					本条款是你与<strong>{COMPANY_ZH}</strong>之间的协议。下载、安装或使用 Stolnk 即表示你接受它。如果不接受，请不要使用——如果你已经付过款，请申请退款。
				</p>
				<p>
					购买授权需要你在所在地已达到可订立合同的年龄。如果你是代表公司购买，即表示你确认自己有权约束该公司。
				</p>

				<h2>你得到的是什么</h2>
				<p>
					Stolnk 是一次性买断，不是订阅。购买专业版即获得一份永久的、全球范围的、非独占的、不可转让的软件使用许可，最多同时在三台 Mac 上使用，并包含：
				</p>
				<ul>
					<li>全部 V1.x 更新。</li>
					<li>每月 300 GB 中转流量，只要我们还在运行该服务就一直有效。</li>
				</ul>
				<p>
					「无限」这个词是刻意不出现的，<a href="/pricing">定价页</a>
					用很长的篇幅解释了原因。如果将来真的出现能力上有实质变化的 V2，那会是一次独立的付费升级，而且不管你升不升，你的 V1 授权都继续有效。
				</p>
				<p>免费使用的是同一套软件，只是额度更小。它不是试用，也不会到期。</p>
				<p>
					<strong>路线图不属于本协议的一部分。</strong>
					标注为「V1.x 内会做」的功能是我们的意图，不是你为之付款的承诺；你买到的是今天这个样子的软件，加上 V1.x 实际发布出来的内容。
				</p>

				<h2>你的文件仍然是你的</h2>
				<p>
					我们不主张对经由 Stolnk 传输的任何内容拥有所有权或使用许可。就算想用也用不了：它到达时是密文，我们没有密钥。
				</p>
				<p>你对你发送的内容、以及你邀请别人发给你的内容负责，并确认你有权发送它们。</p>

				<h2>你不可以做的事</h2>
				<ul>
					<li>转售、再许可或再分发软件本身。</li>
					<li>把授权码分享到超出其席位数的范围。</li>
					<li>
						用 Stolnk 传播恶意软件、侵犯他人权利的材料、儿童性虐待材料，或在你或接收方所在地属于违法的任何其他内容。
					</li>
					<li>试图突破服务的限制、侵入他人的收件箱，或攻击支撑二者的基础设施。</li>
					<li>以违反出口管制或制裁法律的方式使用，或从受全面制裁的国家和地区使用。</li>
				</ul>
				<p>阅读、审计和公开讨论代码是明确允许的，发送端那一半代码之所以公开，正是为了这个。</p>

				<h2>举报滥用</h2>
				<p>
					上述任何一类情况，请举报至{" "}
					<a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>。
				</p>
				<p>
					有一条限制值得说明：我们读不到经过的内容，因此无法主动搜索侵权材料，也无法通过查看来核实一项举报。我们能做的是停用某个收件箱、某条链接或某个账户，并且在举报可信或有生效法律文书要求时会这么做。请告诉我们链接、时间和问题所在。
				</p>

				<h2>属于你这一侧的责任</h2>
				<p>
					由你决定 Stolnk 往哪些文件夹里写，也由你决定谁拿到链接。一条链接就是一份权限：任何持有它的人都能给你发文件，请照此对待。
				</p>
				<p>
					收到的文件会像浏览器下载一样被打上 <code>com.apple.quarantine</code>{" "}
					标记，但那是一种提示机制，不是杀毒扫描。
				</p>
				<p>
					<strong>密钥没法迁移到新 Mac。</strong>
					它们在 Secure Enclave 内生成且无法导出，我们不行，任何人都不行。换新机器意味着一个新地址，而还在等旧机器的文件，任何人——包括我们——都解不开。这是设计本身的性质，不是事后能修复的故障。
				</p>

				<h2>可用性</h2>
				<p>
					Stolnk 由一个人开发和运维。我们不提供可用性承诺，因为兑现不了。我们确实承诺的是：月度额度用完时会暂停新的上传，而不会删除任何东西；并且永远不会在购买价之外额外扣费——Stolnk 里不存在能生成账单的机制。
				</p>

				<h2>如果我们哪天停止运营</h2>
				<p>
					一份依赖托管中转服务的永久授权，必须说清楚中转没了会怎样。所以：如果我们决定停止该服务，会通过邮件和本站至少提前
					<strong>90 天</strong>
					告知，在此期间保持中转服务运行，并发布一个最终版本，使其中不依赖我们服务器的部分继续可用。如果我们在你购买后
					<strong>12 个月</strong>内停止服务，我们退还你已支付的款项。
				</p>
				<p>我们可能将本协议转让给业务受让方，条款不变。转让前会通知你。</p>

				<h2>价格、税费与支付</h2>
				<p>
					Creem 是记录商户。你的买卖合同同时是与它订立的，本许可才是与我们订立的；支付本身适用它们的条款，增值税、商品服务税或销售税由它们处理，并可能在结账时按你所在地加收。
				</p>
				<p>我们可能随时调整新购买的价格。这不会改变你已经买到的东西。</p>

				<h2>退款</h2>
				<p>
					14 天内无理由。发邮件到 <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>{" "}
					就办好。退款会把该 Mac 退回免费版，并暂停第一个之外的收件箱。什么都不会被删除，重新购买后一切照旧回来。
				</p>
				<p>
					如果你是享有法定解除权的消费者——例如在欧盟或英国——本条不取代它。我们的 14 天与你的法定权利有差异时，以对你更有利的一方为准。
				</p>

				<h2>支持</h2>
				<p>只走邮件，尽力而为。承诺一个我们做不到的响应时间，又会是这一页不该写的东西。</p>

				<h2>暂停与终止</h2>
				<p>
					你随时可以停止使用 Stolnk；删除 App 及其收件箱会按<a href="/privacy">隐私政策</a>
					所述清除你的数据。
				</p>
				<p>
					对于严重违反或反复违反上述禁止事项的行为，我们可能暂停或终止授权。除非情节严重或法律要求立即处置，我们会先说明问题并给你合理的改正机会。如果我们因某项事后证明不成立的违规而终止了一份付费授权，我们予以恢复。
				</p>

				<h2>保证，以及你作为消费者的权利</h2>
				<p>除本条另有规定外，本软件按其现状提供，不附带任何形式的保证。</p>
				<p>
					<strong>如果你是消费者，上述排除不剥夺你依法享有的任何权利</strong>
					——包括要求数字内容与描述相符、适于用途、质量合格的权利，以及在不符合时的法定救济。无论本页其余部分怎么写，这些权利都成立。
				</p>

				<h2>责任限制</h2>
				<p>
					在法律允许的范围内，我们因 Stolnk 产生的全部责任，以你为其支付的金额与 50 美元两者中的较高者为限；我们不对间接或后果性损失、数据丢失或利润损失承担责任。
				</p>
				<p>
					本条不限制因欺诈或欺诈性虚假陈述、因过失导致的人身伤亡、因重大过失或故意不当行为而产生的责任，以及其他依法不得限制的责任——包括在你是消费者时，你所在国强制性消费者法律下的责任。
				</p>

				<h2>条款变更</h2>
				<p>
					如发生实质变更，顶部的日期会更新，并且在能够联系到你的情况下，我们会在变更生效前告知。变更后继续使用 Stolnk 即表示接受新版本。如果你不愿意接受，请停止使用——若仍在退款期内，退款承诺依然有效。
				</p>

				<h2>适用法律与争议</h2>
				<p>
					本条款适用中华人民共和国法律，争议提交对我们宁波注册地址有管辖权的法院。
				</p>
				<p>
					<strong>如果你是消费者，这一条不会把你挪走。</strong>
					你仍然享有你居住国强制性法律的保护；若当地法律允许，你可以在自己所在地的法院提起诉讼。
				</p>

				<h2>其余约定</h2>
				<ul>
					<li>如果某一条被认定不可执行，其余条款继续有效，该条按其能够成立的最小范围解释。</li>
					<li>某一次没有主张权利，不等于放弃该权利。</li>
					<li>本条款与隐私政策构成关于 Stolnk 的完整协议，取代此前的任何表述。</li>
					<li>
						本页有中文和英文两个版本，两者力求表达同一含义；如有冲突，以中文版本为准。
					</li>
				</ul>

				<h2>联系方式</h2>
				<p>
					{COMPANY_ZH} · <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>
				</p>
			</>
		),
	},
};
