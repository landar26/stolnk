import type { Context } from "hono";
import { sha256 } from "@noble/hashes/sha2.js";
import {
	CHUNK_SIZE,
	chunkCountFor,
	encryptChunk,
	encryptName,
	fileIdBytes,
	fromBase64Url,
	newContentKey,
	sealContentKey,
	toHex,
} from "../../shared/envelope";
import {
	CURL_UPLOAD_OVERHEAD_SLACK,
	MAX_CURL_UPLOAD_BYTES,
	NOT_FOUND_DELAY_MS,
	PART_SIZE,
	RATE_MAX_CURL_UPLOADS,
	RATE_MAX_RESOLVES,
	cipherSizeFor,
} from "../limits";
import { randomId } from "../lib/bytes";
import { hubFor } from "../lib/deviceauth";
import { relayUsed, tierFor } from "../lib/entitlement";
import {
	badRequest,
	clientIp,
	fail,
	notFound,
	quotaExceeded,
	sleep,
	unauthorized,
	type AppEnv,
} from "../lib/http";
import { findInbox, requireSlug, type InboxRow } from "../lib/inbox";
import { MultipartError, MultipartReader, parseBoundary } from "../lib/multipart";
import { deriveVerifier, verifierMatches } from "../lib/password";
import { enforce } from "../lib/ratelimit";
import { abandonTransfer, finishFile, openTransfer, settleSize } from "../lib/relay";
import { inboxUrl, nameFromHost } from "../lib/site";

/**
 * The inbox address as an API.
 *
 * `ryan.stolnk.com/client-a` is a page for a person. This makes the same URL
 * answer a machine too: a capability document to anything that asks for JSON,
 * and a file to `curl -F "file=@…"`. The address is the whole interface — there
 * is nothing else to look up, register or read — which is what makes it usable
 * by a shell script or an agent that was handed one link and nothing else.
 *
 * **This path is not end-to-end encrypted in the sense the rest of the product
 * is.** curl cannot run P-256 ECDH and chunked AES-GCM, so the plaintext
 * arrives here and the Worker builds the envelope with the recipient Mac's
 * public key (`shared/envelope.ts`, the very same code the browser runs). The
 * Mac cannot tell the two apart and does not need to: what it receives is
 * byte-identical either way. What differs is that for the length of one request
 * the bytes exist in this isolate's memory in the clear. That is a real
 * weakening of the promise on the front page, so it is stated in the capability
 * document, in the send page's own terminal section, and on /privacy, rather
 * than left for someone to discover.
 */

/** Anything longer is not a name someone typed; the Mac sanitises too (PRD 12.2). */
const MAX_UPLOAD_FILENAME = 200;
/** Form fields other than the file. Only `password` is read; the cap is on all of them. */
const MAX_FIELD_BYTES = 1024;

interface Address {
	inbox: InboxRow;
	name: string;
	kexPub: string;
	url: string;
}

/**
 * Was this request asking for the capability document rather than the page?
 *
 * Deliberately an opt-in and never a guess. Under `run_worker_first` every
 * asset request reaches the same handler, and those carry `Accept: * / *`; a
 * looser test here would answer JSON to a `<script src>` and take the site
 * down.
 */
export function wantsCapabilities(c: Context<AppEnv>): boolean {
	if (c.req.query("format") === "json") return true;
	return c.req.header("accept")?.includes("application/json") ?? false;
}

/**
 * The address this request was sent to.
 *
 * Every miss answers identically after the same fixed delay, exactly as
 * `/api/v1/resolve` does: a malformed slug, an unknown name and a real inbox
 * that does not exist must not be distinguishable, or the 404 becomes a name
 * oracle (PRD 13.1).
 */
async function resolveAddress(c: Context<AppEnv>): Promise<Address> {
	const miss = async (): Promise<never> => {
		await sleep(NOT_FOUND_DELAY_MS);
		return notFound("That inbox does not exist.");
	};

	const name = nameFromHost(c.req.url);
	if (!name) return miss();

	let slug: string;
	try {
		slug = requireSlug(decodeURIComponent(c.req.path).replace(/^\/+|\/+$/g, ""));
	} catch {
		return miss();
	}

	const inbox = await findInbox(c.env, name, slug);
	if (!inbox) return miss();

	const owner = await c.env.DB.prepare("SELECT pubkey_kex FROM devices WHERE device_id = ?")
		.bind(inbox.owner_device_id)
		.first<{ pubkey_kex: string }>();
	if (!owner) return miss();

	return { inbox, name, kexPub: owner.pubkey_kex, url: inboxUrl(name, inbox.path_slug) };
}

function curlCommand(url: string, passworded: boolean): string {
	const password = passworded ? '-F "password=<the password>" ' : "";
	return `curl --fail-with-body ${password}-F "file=@./path/to/file" "${url}"`;
}

/**
 * What a machine needs to use this address, including a command it can run
 * unmodified. Modelled on filego's `importCapabilities`.
 */
async function capabilities(c: Context<AppEnv>, address: Address) {
	const { inbox } = address;
	const tier = await tierFor(c.env, inbox.owner_device_id);
	const passworded = inbox.password_verifier_hash !== null;

	let online = false;
	try {
		online = await hubFor(c.env, inbox.owner_device_id).isOnline();
	} catch {
		// Presence is a nicety. In doubt, say offline — which still accepts files.
		online = false;
	}

	return {
		purpose: "Send a file to a folder on someone's Mac.",
		inbox: inbox.display_name,
		/** False while the owner is over their monthly relay allowance (PRD 16.2). */
		accepting:
			!inbox.paused && (await relayUsed(c.env, inbox.owner_device_id)) < tier.monthlyRelayBytes,
		/** The Mac being asleep is not a failure: the file waits and is delivered on wake. */
		recipientOnline: online,
		upload: {
			method: "POST",
			url: address.url,
			contentType: "multipart/form-data",
			fileField: "file",
			maxBytesPerRequest: MAX_CURL_UPLOAD_BYTES,
			/**
			 * One, and not a limit that could be raised by trying harder. The chunk
			 * AAD binds the total chunk count (docs/wire-format.md), so the length of
			 * a file has to be known before its first byte is encrypted — and in a
			 * streamed body only the last part's length can be derived. Send several
			 * files with several requests.
			 */
			maxFilesPerRequest: 1,
			...(passworded ? { passwordField: "password" } : {}),
			/** Fields must precede the file part, for the same reason. */
			fieldsBeforeFile: true,
		},
		heldForHours: tier.ttlHours,
		curl: curlCommand(address.url, passworded),
		encryption:
			"Files sent this way are encrypted on our server with the recipient's public key, not in your browser: the plaintext passes through us for the length of one request. Use the web page for browser-side encryption.",
		instruction:
			"AI agents should run the curl command directly rather than driving the web form. One file per request.",
	};
}

/** `GET <address>?format=json` and `OPTIONS <address>`. */
export async function inboxCapabilities(c: Context<AppEnv>): Promise<Response> {
	enforce(`resolve:${clientIp(c)}`, RATE_MAX_RESOLVES);
	const address = await resolveAddress(c);
	return c.json(await capabilities(c, address), 200, {
		"cache-control": "no-store",
		"accept-post": "multipart/form-data",
		// No `Access-Control-Allow-Origin`, deliberately, and this is the one place
		// filego is not copied. An inbox address is a capability (PRD 13.1) and the
		// uniform delayed 404 above exists to keep it from being enumerated; a
		// wildcard CORS header would let any page on the web probe for names and
		// read back the display name of every hit. `/api/v1/resolve` sets none
		// either. curl does not send an Origin and does not care.
		"x-robots-tag": "noindex, nofollow",
	});
}

/**
 * `POST <address>` with `multipart/form-data` — the curl path.
 *
 * The shape is dictated by one constraint. Every chunk's AAD binds the total
 * chunk count, so the plaintext length must be known before the first chunk is
 * encrypted; a streamed body does not offer that. It is recovered by
 * arithmetic instead — `Content-Length` minus everything the parser has already
 * passed over minus the closing boundary — which is exact as long as the file
 * is the last part in the body. That is verified against the bytes actually
 * read, so a body that breaks the assumption is a refusal and never a short
 * file.
 */
export async function inboxUpload(c: Context<AppEnv>): Promise<Response> {
	enforce(`curl:${clientIp(c)}`, RATE_MAX_CURL_UPLOADS);

	const boundary = parseBoundary(c.req.header("content-type"));
	if (!boundary) {
		return badRequest(
			'Send multipart/form-data: curl --fail-with-body -F "file=@./path/to/file" <this url>',
		);
	}

	// Everything cheap happens before the body is touched, so a refusal does not
	// require the sender to push 95 MiB first.
	const declared = Number(c.req.header("content-length") ?? "-1");
	if (!Number.isInteger(declared) || declared < 0) {
		return badRequest(
			"A Content-Length is required. A streamed body (curl -F \"file=@-\") cannot be accepted; pass a real file path.",
		);
	}
	if (declared > MAX_CURL_UPLOAD_BYTES + CURL_UPLOAD_OVERHEAD_SLACK) {
		return quotaExceeded(
			`This way of uploading takes at most ${Math.floor(MAX_CURL_UPLOAD_BYTES / 1024 ** 2)} MiB per file. Larger files go through the web page.`,
		);
	}

	const address = await resolveAddress(c);
	if (address.inbox.paused) {
		return fail(423, "paused", "This inbox is not accepting files right now.");
	}

	const body = c.req.raw.body;
	if (!body) return badRequest("Empty body.");
	const reader = new MultipartReader(body, boundary);

	try {
		return await readAndRelay(c, address, reader, declared);
	} catch (error) {
		await reader.cancel();
		if (error instanceof MultipartError) return badRequest(error.message);
		throw error;
	}
}

async function readAndRelay(
	c: Context<AppEnv>,
	address: Address,
	reader: MultipartReader,
	declared: number,
): Promise<Response> {
	// A header as well as a field, because a field only works if it precedes the
	// file — and "put your -F flags in this order" is a footgun to hand someone
	// whose upload otherwise fails after transferring the whole file.
	let password = c.req.header("x-stolnk-password") ?? null;

	let part = await reader.nextPart();
	while (part && part.filename === null) {
		const value = await reader.partText(MAX_FIELD_BYTES);
		if (part.name === "password" && password === null) password = value;
		part = await reader.nextPart();
	}
	if (!part) {
		return badRequest('No file in the request. Add -F "file=@./path/to/file".');
	}

	const inbox = address.inbox;
	if (inbox.password_verifier_hash) {
		if (!password) {
			return unauthorized(
				'This inbox has a password. Add -F "password=…" before the file, or send an X-Stolnk-Password header.',
			);
		}
		// The one place the server sees a password rather than a verifier. The
		// browser derives PBKDF2 locally and sends only the result (lib/password.ts);
		// curl cannot, so the derivation happens here. It is disclosed alongside the
		// rest of this path's tradeoff, and it is not a new class of exposure: this
		// request is already handing us the file itself.
		const verifier = await deriveVerifier(password, inbox.password_salt ?? "");
		if (!(await verifierMatches(verifier, inbox.password_verifier_hash))) {
			return unauthorized("Wrong password.");
		}
	}

	/*
	 * The payload length, from `Content-Length` minus what the parser has passed
	 * over minus the tail — with two bytes of slack, because the CRLF after the
	 * closing boundary is optional (RFC 2046) and clients disagree: curl writes
	 * it, Node's own `FormData` does not.
	 *
	 * Both candidates are carried rather than one being guessed at. The upper one
	 * is what gets booked, the real one is whatever arrives, and `settleSize`
	 * squares the two afterwards.
	 */
	const sizeMax = declared - reader.position - reader.closingLength;
	const sizeMin = Math.max(0, sizeMax - 2);
	if (sizeMax < 0) return badRequest("That request body does not add up.");
	if (sizeMax > MAX_CURL_UPLOAD_BYTES) {
		return quotaExceeded(
			`This way of uploading takes at most ${Math.floor(MAX_CURL_UPLOAD_BYTES / 1024 ** 2)} MiB per file. Larger files go through the web page.`,
		);
	}
	/*
	 * The one place the slack cannot be tolerated: the chunk count is bound into
	 * every chunk's AAD and has to be right before the first byte is encrypted.
	 * It only ever differs between the two candidates for a file whose length
	 * lands within two bytes of a 1 MiB boundary — about one in five hundred
	 * thousand — and for those the honest answer is to refuse rather than to
	 * upload the whole thing and fail the tag check at the far end.
	 */
	if (chunkCountFor(sizeMin) !== chunkCountFor(sizeMax)) {
		return badRequest(
			"This file's length lands exactly on a chunk boundary, where the request does not pin it down. Send this one through the web page.",
		);
	}

	const filename = (part.filename || "upload").slice(0, MAX_UPLOAD_FILENAME);
	const fileId = randomId();
	const contentKey = await newContentKey();
	const envelope = await sealContentKey(address.kexPub, contentKey);
	const encName = await encryptName(contentKey, filename);

	const opened = await openTransfer(c.env, {
		inbox,
		planned: [
			{
				file_id: fileId,
				enc_name: encName.enc_name,
				name_iv: encName.name_iv,
				size: sizeMax,
				cipher_size: cipherSizeFor(sizeMax),
				nonce_prefix: envelope.nonce_prefix,
				wrapped_key: envelope.wrapped_key,
				key_iv: envelope.key_iv,
				eph_pub: envelope.eph_pub,
			},
		],
		// Nothing here can claim to be the owner: there is no app-side flag to
		// forge, and PRD 15.1's signal must not be settable by a stranger.
		senderIsOwner: false,
		via: "curl",
	});
	const target = opened.files[0];

	let size = sizeMax;
	try {
		const written = await encryptToR2(c.env, {
			reader,
			target,
			contentKey,
			noncePrefix: fromBase64Url(envelope.nonce_prefix),
			fileId,
			sizeMin,
			sizeMax,
		});
		size = written.size;
		await settleSize(c.env, {
			transferId: opened.transferId,
			fileId,
			inboxId: inbox.inbox_id,
			ownerDeviceId: inbox.owner_device_id,
			bookedSize: sizeMax,
			actualSize: size,
			createdAt: opened.createdAt,
		});
		await finishFile(c.env, c.executionCtx, {
			transferId: opened.transferId,
			fileId,
			r2Key: target.r2_key,
			uploadId: target.upload_id,
			parts: written.parts,
			plainSha256: written.sha256,
			cipherSize: cipherSizeFor(size),
		});
	} catch (error) {
		// Booked bytes come back and the multipart upload is released, so a failure
		// half way through does not quietly eat the owner's month (PRD 16.1).
		await abandonTransfer(c.env, opened.transferId);
		throw error;
	}

	let online = false;
	try {
		online = await hubFor(c.env, inbox.owner_device_id).isOnline();
	} catch {
		online = false;
	}
	const heldForHours = Math.round((opened.expiresAt - Date.now()) / (60 * 60 * 1000));

	// 202, not 200: the file is accepted, not delivered. PRD 11.2 — a Mac that is
	// asleep is not a failure, so this reads as a success either way.
	return c.json(
		{
			accepted: true,
			inbox: inbox.display_name,
			file: { name: filename, size, id: fileId },
			transfer_id: opened.transferId,
			recipientOnline: online,
			expires_at: opened.expiresAt,
			// Accepted, not delivered — the Mac being online means it is about to
			// collect the file, not that it has. `GET /api/v1/transfers/<id>` with
			// the token is where "delivered" is answered, and this response has no
			// token to give: a curl caller is not a session.
			message: online
				? `Accepted. ${inbox.display_name} is online and is collecting it now.`
				: `Accepted. It will be delivered when ${inbox.display_name} next wakes up, and is held for ${heldForHours} hours.`,
		},
		202,
	);
}

/**
 * The encrypting half: plaintext in from the multipart reader, ciphertext out
 * to R2, in the exact framing of docs/wire-format.md.
 *
 * Memory is one 64 MiB part plus one 1 MiB chunk regardless of file size, which
 * is the whole reason the body is streamed rather than handed to `formData()`.
 * Both buffers are reused across iterations; every `await` that hands one to
 * WebCrypto or R2 completes before the buffer is written to again.
 */
async function encryptToR2(
	env: Env,
	options: {
		reader: MultipartReader;
		target: { r2_key: string; upload_id: string };
		contentKey: CryptoKey;
		noncePrefix: Uint8Array;
		fileId: string;
		/** The two candidate lengths; the real one is whichever arrives. */
		sizeMin: number;
		sizeMax: number;
	},
): Promise<{ parts: Array<{ partNumber: number; etag: string }>; sha256: string; size: number }> {
	const { reader, target, contentKey, noncePrefix, sizeMin, sizeMax } = options;
	// Equal for both candidates — the caller refused the case where they differ.
	const totalChunks = chunkCountFor(sizeMax);
	const idBytes = fileIdBytes(options.fileId);
	const hasher = sha256.create();
	const upload = env.RELAY.resumeMultipartUpload(target.r2_key, target.upload_id);

	const parts: Array<{ partNumber: number; etag: string }> = [];
	const plainBuffer = new Uint8Array(CHUNK_SIZE);
	const partBuffer = new Uint8Array(PART_SIZE);
	let plainLength = 0;
	let partLength = 0;
	let partNumber = 1;
	let chunkIndex = 0;
	let received = 0;

	const flushPart = async (): Promise<void> => {
		if (partLength === 0) return;
		const uploaded = await upload.uploadPart(partNumber, partBuffer.subarray(0, partLength));
		parts.push({ partNumber, etag: uploaded.etag });
		partNumber += 1;
		partLength = 0;
	};

	// Chunk boundaries and part boundaries are unrelated (docs/wire-format.md):
	// a chunk routinely straddles two parts, so ciphertext is appended by byte
	// count and not by chunk.
	const appendCipher = async (cipher: Uint8Array): Promise<void> => {
		let offset = 0;
		while (offset < cipher.length) {
			const take = Math.min(PART_SIZE - partLength, cipher.length - offset);
			partBuffer.set(cipher.subarray(offset, offset + take), partLength);
			partLength += take;
			offset += take;
			if (partLength === PART_SIZE) await flushPart();
		}
	};

	const emitChunk = async (): Promise<void> => {
		const plaintext = plainBuffer.subarray(0, plainLength);
		hasher.update(plaintext);
		const cipher = await encryptChunk(contentKey, {
			noncePrefix,
			fileIdBytes: idBytes,
			index: chunkIndex,
			total: totalChunks,
			plaintext,
		});
		chunkIndex += 1;
		plainLength = 0;
		await appendCipher(cipher);
	};

	for await (const chunk of reader.partBody()) {
		received += chunk.length;
		// More bytes than the request could possibly have carried as one file: the
		// arithmetic assumed the file was the last part and something followed it.
		// Refuse rather than land a file whose chunk count is not its own.
		if (received > sizeMax) return badRequest(sizeMismatch(sizeMax));

		let offset = 0;
		while (offset < chunk.length) {
			const take = Math.min(CHUNK_SIZE - plainLength, chunk.length - offset);
			plainBuffer.set(chunk.subarray(offset, offset + take), plainLength);
			plainLength += take;
			offset += take;
			if (plainLength === CHUNK_SIZE) await emitChunk();
		}
	}

	// Fewer than even the shorter candidate: same conclusion, other direction.
	if (received < sizeMin) return badRequest(sizeMismatch(sizeMax));
	// A zero-byte file is one empty chunk, not none — `chunkCountFor` says so and
	// the receiver derives its boundaries from the same function.
	if (plainLength > 0 || chunkIndex === 0) await emitChunk();
	await flushPart();

	return { parts, sha256: toHex(hasher.digest()), size: received };
}

function sizeMismatch(size: number): string {
	return `The file did not match the ${size} bytes the request declared. Send exactly one file, as the last -F flag, from a real path.`;
}
