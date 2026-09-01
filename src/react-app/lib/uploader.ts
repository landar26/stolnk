import { sha256 } from "@noble/hashes/sha2.js";
import {
	CHUNK_SIZE,
	chunkCountFor,
	encryptChunk,
	encryptName,
	fileIdBytes,
	fromBase64Url,
	importContentKey,
	newContentKey,
	sealContentKey,
	toBase64Url,
	toHex,
} from "../../shared/envelope.ts";
import {
	completeFile,
	createTransfer,
	transferStatus,
	uploadPart,
	type InboxInfo,
} from "./api.ts";
import { clearResume, saveResume, type ResumeRecord } from "./resume.ts";

export type UploadPhase = "queued" | "encrypting" | "uploading" | "done" | "delivered" | "failed";

export interface UploadProgress {
	fileId: string | null;
	name: string;
	size: number;
	sent: number;
	phase: UploadPhase;
	error?: string;
}

export interface UploadCallbacks {
	onProgress: (progress: UploadProgress) => void;
	onTransferCreated: (transferId: string, token: string) => void;
}

/**
 * Encrypts and uploads one file.
 *
 * Memory is bounded regardless of file size (PRD 9.2): the file is read through
 * `File.slice()` a chunk at a time, and at most one 64 MiB part is held before
 * being handed to `fetch` as a Blob.
 *
 * The part has to be materialised rather than streamed because Safari does not
 * support request bodies backed by a ReadableStream, so a 20 GB file still only
 * ever costs ~64 MiB of memory.
 */
export async function uploadFile(
	file: File,
	inbox: InboxInfo,
	options: {
		password?: string;
		senderSession?: string;
		via?: string;
		resume?: ResumeRecord;
		signal?: AbortSignal;
	},
	callbacks: UploadCallbacks,
): Promise<{ transferId: string; token: string; fileId: string }> {
	const report = (progress: Partial<UploadProgress>) =>
		callbacks.onProgress({
			fileId: null,
			name: file.name,
			size: file.size,
			sent: 0,
			phase: "encrypting",
			...progress,
		} as UploadProgress);

	let contentKey: CryptoKey;
	let noncePrefix: Uint8Array;
	let transferId: string;
	let token: string;
	let fileId: string;
	let completedParts = new Set<number>();

	if (options.resume) {
		// Re-encrypting with the same key, nonce prefix and file id reproduces the
		// original ciphertext byte for byte, so parts that already landed can
		// simply be skipped.
		contentKey = await importContentKey(fromBase64Url(options.resume.content_key));
		noncePrefix = fromBase64Url(options.resume.nonce_prefix);
		transferId = options.resume.transfer_id;
		token = options.resume.token;
		fileId = options.resume.file_id;
		callbacks.onTransferCreated(transferId, token);

		const status = await transferStatus(transferId, token);
		const entry = status.files.find((candidate) => candidate.file_id === fileId);
		completedParts = new Set(entry?.completed_parts ?? []);
	} else {
		contentKey = await newContentKey();
		const envelope = await sealContentKey(inbox.kex_pub, contentKey);
		const encName = await encryptName(contentKey, file.name);
		noncePrefix = fromBase64Url(envelope.nonce_prefix);

		const handle = await createTransfer({
			inbox_id: inbox.inbox_id,
			password: options.password,
			sender_session: options.senderSession,
			via: options.via,
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
		transferId = handle.transfer_id;
		token = handle.token;
		fileId = handle.files[0].file_id;
		callbacks.onTransferCreated(transferId, token);

		await saveResume({
			transfer_id: transferId,
			file_id: fileId,
			token,
			inbox_slug: inbox.slug,
			inbox_name: inbox.display_name,
			file_name: file.name,
			file_size: file.size,
			file_modified: file.lastModified,
			content_key: toBase64Url(new Uint8Array(await crypto.subtle.exportKey("raw", contentKey))),
			nonce_prefix: envelope.nonce_prefix,
			created_at: Date.now(),
		});
	}

	const partSize = inbox.part_size;
	const totalChunks = chunkCountFor(file.size);
	const idBytes = fileIdBytes(fileId);
	const hasher = sha256.create();

	let partNumber = 1;
	let pending: Uint8Array[] = [];
	let pendingBytes = 0;
	let sent = 0;

	const flush = async (): Promise<void> => {
		if (pendingBytes === 0) return;
		const current = partNumber;
		const blob = new Blob(pending as BlobPart[]);
		pending = [];
		pendingBytes = 0;
		partNumber += 1;

		if (!completedParts.has(current)) {
			await uploadPart(transferId, fileId, current, token, blob, options.signal);
		}
		sent = Math.min(file.size, sent + blob.size);
		report({ fileId, sent, phase: "uploading" });
	};

	for (let index = 0; index < totalChunks; index++) {
		options.signal?.throwIfAborted();

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

		// A chunk straddling a part boundary is split; parts are byte ranges of
		// the ciphertext stream and have no relationship to chunk boundaries.
		let offset = 0;
		while (offset < ciphertext.length) {
			const room = partSize - pendingBytes;
			const take = Math.min(room, ciphertext.length - offset);
			pending.push(ciphertext.subarray(offset, offset + take));
			pendingBytes += take;
			offset += take;
			if (pendingBytes === partSize) await flush();
		}
	}

	await flush();
	await completeFile(transferId, fileId, token, toHex(hasher.digest()));
	await clearResume(fileId);

	report({ fileId, sent: file.size, phase: "done" });
	return { transferId, token, fileId };
}
