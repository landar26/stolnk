import { fromBase64Url, toHex } from "../../shared/envelope.ts";

export interface InboxInfo {
	inbox_id: string;
	/** The subdomain this inbox lives on. */
	name: string;
	/** The path under it. Every link has one. */
	slug: string;
	url: string;
	display_name: string;
	paused: boolean;
	online: boolean;
	kex_pub: string;
	max_file_size: number;
	part_size: number;
	chunk_size: number;
	ttl_hours: number;
	password: { required: boolean; salt?: string | null; iterations?: number };
}

export interface ResolveResult {
	inbox?: InboxInfo;
	error?: string;
}

export class ApiError extends Error {
	constructor(
		public status: number,
		public code: string,
		message: string,
	) {
		super(message);
	}
}

interface WireError {
	error?: string;
	message?: string;
}

async function parse<T>(response: Response): Promise<T> {
	const text = await response.text();
	let body: unknown = null;
	try {
		body = text ? JSON.parse(text) : null;
	} catch {
		body = text;
	}
	if (!response.ok) {
		const failure = (body ?? {}) as WireError;
		throw new ApiError(
			response.status,
			failure.error ?? `http_${response.status}`,
			failure.message ?? "Something went wrong.",
		);
	}
	return body as T;
}

/**
 * Only the slug travels. The name is the host this page was served from, so the
 * request carries it on its own and the client cannot ask about someone else's
 * inbox by editing a parameter.
 */
export async function resolveInbox(slug: string): Promise<ResolveResult> {
	const response = await fetch(`/api/v1/resolve?slug=${encodeURIComponent(slug)}`);
	if (response.status === 404) return { error: "not_found" };
	return { inbox: await parse<InboxInfo>(response) };
}

/**
 * The password never leaves the browser. What travels is a PBKDF2 verifier over
 * a public per-inbox salt, and the server only ever stores a hash of that
 * (PRD 18).
 */
export async function deriveVerifier(
	password: string,
	salt: string,
	iterations: number,
): Promise<string> {
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(password),
		"PBKDF2",
		false,
		["deriveBits"],
	);
	const bits = await crypto.subtle.deriveBits(
		{ name: "PBKDF2", hash: "SHA-256", salt: fromBase64Url(salt) as BufferSource, iterations },
		key,
		256,
	);
	return toHex(new Uint8Array(bits));
}

export interface TransferHandle {
	transfer_id: string;
	sender_session: string;
	token: string;
	expires_at: number;
	part_size: number;
	files: Array<{ file_id: string; part_size: number; part_count: number }>;
}

export async function createTransfer(body: unknown): Promise<TransferHandle> {
	return parse<TransferHandle>(
		await fetch("/api/v1/transfers", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		}),
	);
}

export async function uploadPart(
	transferId: string,
	fileId: string,
	partNumber: number,
	token: string,
	blob: Blob,
	signal?: AbortSignal,
): Promise<{ etag: string; skipped: boolean }> {
	return parse<{ etag: string; skipped: boolean }>(
		await fetch(`/api/v1/transfers/${transferId}/files/${fileId}/parts/${partNumber}`, {
			method: "PUT",
			headers: {
				authorization: `Bearer ${token}`,
				"content-type": "application/octet-stream",
			},
			body: blob,
			signal,
		}),
	);
}

export async function completeFile(
	transferId: string,
	fileId: string,
	token: string,
	plainSha256: string,
): Promise<void> {
	await parse(
		await fetch(`/api/v1/transfers/${transferId}/files/${fileId}/complete`, {
			method: "POST",
			headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
			body: JSON.stringify({ plain_sha256: plainSha256 }),
		}),
	);
}

export interface TransferStatus {
	transfer_id: string;
	state: string;
	expires_at: number;
	files: Array<{
		file_id: string;
		size: number;
		state: string;
		part_count: number;
		completed_parts: number[];
	}>;
}

export async function transferStatus(
	transferId: string,
	token: string,
): Promise<TransferStatus> {
	return parse<TransferStatus>(
		await fetch(`/api/v1/transfers/${transferId}`, {
			headers: { authorization: `Bearer ${token}` },
		}),
	);
}

export async function abortTransfer(transferId: string, token: string): Promise<void> {
	await parse(
		await fetch(`/api/v1/transfers/${transferId}/abort`, {
			method: "POST",
			headers: { authorization: `Bearer ${token}` },
		}),
	);
}

/** Live delivery status, so the page can say "Delivered" rather than "Uploaded". */
export function watchTransfer(
	token: string,
	onEvent: (event: { type: string; [key: string]: unknown }) => void,
): () => void {
	const protocol = location.protocol === "https:" ? "wss:" : "ws:";
	let socket: WebSocket | null = null;
	let closed = false;

	try {
		socket = new WebSocket(`${protocol}//${location.host}/api/v1/ws/sender?token=${token}`);
		socket.addEventListener("message", (event) => {
			try {
				onEvent(JSON.parse(event.data));
			} catch {
				// Ignore anything that is not our JSON.
			}
		});
	} catch {
		// The socket is an optimisation; the page still works without it.
	}

	return () => {
		closed = true;
		if (socket && !closed) return;
		socket?.close();
	};
}
