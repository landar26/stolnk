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
} from "../../shared/envelope.ts";
import { createTransfer, type InboxInfo } from "./api.ts";
import type { UploadCallbacks } from "./uploader.ts";

/**
 * PRD 8.2 — sending one file straight to the Mac over an open DataChannel.
 *
 * The encryption here is deliberately, exactly the encryption in
 * `uploader.ts`: same content key, same nonce prefix, same AAD, same 1 MiB
 * chunks. LAN is a second pipe onto the same byte stream, not a second format,
 * which is what lets the Mac feed it into the identical `DecryptingSink` and
 * lets `testdata/vectors.json` cover both paths at once.
 *
 * What differs is only how the stream is cut up on the way out. The relay packs
 * it into 64 MiB parts because R2 bills per write (PRD 8.6 #2); a DataChannel
 * has no such economics and a hard message ceiling instead, so it goes out in
 * 64 KiB frames. The receiver does not care where the cuts fall.
 */

/**
 * SCTP will not carry an arbitrarily large message. libwebrtc advertises
 * `max-message-size:262144` and Chrome *closes the channel* rather than
 * erroring when that is exceeded — a failure that would look like a network
 * problem and not like a bug. 64 KiB is far enough under every browser's limit
 * to never be the thing that breaks, and large enough that per-message overhead
 * is noise at LAN speeds.
 */
const FRAME_SIZE = 64 * 1024;

/**
 * Send-side flow control. Without it a fast disk feeds the channel faster than
 * the network drains it and the buffer grows to the size of the file — the one
 * thing the chunked design exists to prevent (PRD 9.2).
 */
const BUFFER_HIGH = 8 * 1024 * 1024;
const BUFFER_LOW = 1024 * 1024;

/**
 * How long to wait for the Mac to say it is ready for a file, and afterwards to
 * confirm the one it has received. The first is a local round trip plus one
 * request to the Worker; the second is a digest check and a rename.
 */
const READY_TIMEOUT_MS = 15_000;
const CONFIRM_TIMEOUT_MS = 30_000;

export class LanTransferError extends Error {}

function assertOpen(channel: RTCDataChannel): void {
	if (channel.readyState !== "open") {
		throw new LanTransferError("The direct connection dropped.");
	}
}

async function drain(channel: RTCDataChannel): Promise<void> {
	if (channel.bufferedAmount <= BUFFER_HIGH) return;
	channel.bufferedAmountLowThreshold = BUFFER_LOW;
	await new Promise<void>((resolve) => {
		const settle = () => {
			channel.removeEventListener("bufferedamountlow", settle);
			channel.removeEventListener("close", settle);
			resolve();
		};
		channel.addEventListener("bufferedamountlow", settle);
		channel.addEventListener("close", settle);
	});
	assertOpen(channel);
}

/**
 * Waits for one control message about this file.
 *
 * Two are awaited over a transfer: `file.ready` before any byte goes out, and
 * `file.ok` at the end.
 */
function awaitControl(
	channel: RTCDataChannel,
	fileId: string,
	settleOn: string,
	timeoutMs: number,
): Promise<void> {
	return new Promise((resolve, reject) => {
		const stop = () => {
			clearTimeout(timer);
			channel.removeEventListener("message", onMessage);
			channel.removeEventListener("close", onClose);
		};
		const onMessage = (event: MessageEvent) => {
			if (typeof event.data !== "string") return;
			let message: { type?: string; file_id?: string; message?: string };
			try {
				message = JSON.parse(event.data);
			} catch {
				return;
			}
			if (message.file_id !== fileId) return;
			if (message.type === settleOn) {
				stop();
				resolve();
			} else if (message.type === "file.error") {
				stop();
				reject(new LanTransferError(message.message ?? "The Mac could not accept the file."));
			}
		};
		const onClose = () => {
			stop();
			reject(new LanTransferError("The direct connection dropped."));
		};
		const timer = setTimeout(() => {
			stop();
			reject(new LanTransferError("The Mac did not answer."));
		}, timeoutMs);
		channel.addEventListener("message", onMessage);
		channel.addEventListener("close", onClose);
	});
}

export async function sendFileOverLan(
	file: File,
	inbox: InboxInfo,
	channel: RTCDataChannel,
	options: { password?: string; via?: string; signal?: AbortSignal },
	callbacks: UploadCallbacks,
): Promise<{ transferId: string; token: string; fileId: string }> {
	assertOpen(channel);

	const contentKey = await newContentKey();
	const envelope = await sealContentKey(inbox.kex_pub, contentKey);
	const encName = await encryptName(contentKey, file.name);
	const noncePrefix = fromBase64Url(envelope.nonce_prefix);

	/*
	 * The transfer row is still created on the server, even though not one byte
	 * will pass through it. It is what carries the envelope, the size and — the
	 * part that cannot come over the wire — which inbox, and therefore which
	 * folder, this file belongs to. It is also where the password and the abuse
	 * ceilings are checked. `transport: "lan"` is what tells it to skip the
	 * relay: no multipart upload, and nothing booked against the owner's month.
	 */
	const handle = await createTransfer({
		inbox_id: inbox.inbox_id,
		password: options.password,
		via: options.via,
		transport: "lan",
		files: [
			{
				enc_name: encName.enc_name,
				name_iv: encName.name_iv,
				size: file.size,
				nonce_prefix: envelope.nonce_prefix,
				wrapped_key: envelope.wrapped_key,
				key_iv: envelope.key_iv,
				eph_pub: envelope.eph_pub,
			},
		],
	});
	const transferId = handle.transfer_id;
	const token = handle.token;
	const fileId = handle.files[0].file_id;
	callbacks.onTransferCreated(transferId, token);

	// No `saveResume` here, deliberately. Resume is a property of R2 parts; there
	// are none, and nothing on the far side to resume from. A LAN transfer that
	// breaks is restarted over the relay, which is cheap because it was local.

	const report = (sent: number, phase: "uploading" | "done") =>
		callbacks.onProgress({ fileId, name: file.name, size: file.size, sent, phase });

	/*
	 * `file.begin` then wait. The Mac has to fetch this file's envelope from the
	 * Worker before it can decrypt anything — which is a round trip — and a
	 * DataChannel has no backpressure that would hold the opening frames for it.
	 * Streaming immediately would simply lose them.
	 */
	const ready = awaitControl(channel, fileId, "file.ready", READY_TIMEOUT_MS);
	channel.send(JSON.stringify({ v: 1, type: "file.begin", transfer_id: transferId, file_id: fileId }));
	await ready;

	const settled = awaitControl(channel, fileId, "file.ok", CONFIRM_TIMEOUT_MS);

	const totalChunks = chunkCountFor(file.size);
	const idBytes = fileIdBytes(fileId);
	const hasher = sha256.create();
	let sent = 0;

	for (let index = 0; index < totalChunks; index++) {
		options.signal?.throwIfAborted();
		assertOpen(channel);

		const start = index * CHUNK_SIZE;
		const slice = file.slice(start, Math.min(file.size, start + CHUNK_SIZE));
		const plaintext = new Uint8Array(await slice.arrayBuffer());
		hasher.update(plaintext);

		const ciphertext = await encryptChunk(contentKey, {
			noncePrefix,
			fileIdBytes: idBytes,
			index,
			total: totalChunks,
			plaintext,
		});

		for (let offset = 0; offset < ciphertext.length; offset += FRAME_SIZE) {
			await drain(channel);
			// A copy, not a subarray view: `send` takes the underlying buffer, and a
			// view onto the chunk would hand it the whole chunk every time.
			channel.send(ciphertext.slice(offset, Math.min(ciphertext.length, offset + FRAME_SIZE)));
		}

		sent = Math.min(file.size, sent + plaintext.length);
		report(sent, "uploading");
	}

	/*
	 * The digest goes last because it is only known last — it is computed over
	 * the plaintext as it streams. The Mac verifies it against what it actually
	 * landed and reports it in its ACK, which is how the server's row gets a
	 * digest on a path where the sender never calls `complete`.
	 */
	assertOpen(channel);
	channel.send(JSON.stringify({ type: "file.end", file_id: fileId, plain_sha256: toHex(hasher.digest()) }));

	await settled;
	report(file.size, "done");
	return { transferId, token, fileId };
}
