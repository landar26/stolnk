/**
 * A streaming `multipart/form-data` reader, for the one caller that cannot use
 * `Request.formData()`: the curl upload path (routes/inbox-address.ts).
 *
 * `formData()` materialises the whole body in the isolate, and then
 * `File.arrayBuffer()` materialises it again — roughly twice the file size
 * against a 128 MB isolate. That is the reason filego's equivalent endpoint is
 * capped at 20 MiB. Reading the body as a stream instead moves the ceiling back
 * to the platform's own request-body limit, and holds memory to one R2 part.
 *
 * Deliberately not a general-purpose parser. It reads parts in order and hands
 * the body of each one out as a stream; it does not buffer parts, does not
 * support nested multipart, and treats a body it cannot make sense of as a
 * client error rather than trying to recover.
 *
 * The subtle part is the hold-back in `partBody`. A delimiter can be split
 * across two reads from the underlying stream, so the last `delimiter.length -
 * 1` bytes of the buffer are never emitted as content until more has arrived or
 * the stream has ended — otherwise a file whose last bytes happened to look
 * like the start of a boundary would have them silently truncated.
 */

const CRLF = new Uint8Array([0x0d, 0x0a]);
const CRLFCRLF = new Uint8Array([0x0d, 0x0a, 0x0d, 0x0a]);

/** How much of a part's headers we are willing to read before giving up. */
const MAX_PART_HEADER_BYTES = 8 * 1024;

export class MultipartError extends Error {}

function indexOf(haystack: Uint8Array, needle: Uint8Array, from = 0): number {
	const limit = haystack.length - needle.length;
	outer: for (let i = Math.max(0, from); i <= limit; i++) {
		for (let j = 0; j < needle.length; j++) {
			if (haystack[i + j] !== needle[j]) continue outer;
		}
		return i;
	}
	return -1;
}

/**
 * The boundary out of a `content-type`, or null when this is not a multipart
 * body at all.
 *
 * A regex rather than splitting on `;`, because RFC 2045 allows the boundary to
 * be a quoted string and a quoted string may contain a semicolon.
 */
export function parseBoundary(contentType: string | null | undefined): string | null {
	if (!contentType) return null;
	if (!/^\s*multipart\/form-data\s*(;|$)/i.test(contentType)) return null;
	const match = /;\s*boundary\s*=\s*(?:"([^"]*)"|([^;\s]+))/i.exec(contentType);
	const boundary = match?.[1] ?? match?.[2] ?? "";
	return boundary.length > 0 ? boundary : null;
}

export interface PartHeader {
	/** The form field name, or null when the part carries no name. */
	name: string | null;
	/** Present iff this part is a file. */
	filename: string | null;
	contentType: string | null;
}

/**
 * `form-data; name="file"; filename="holiday.jpg"`.
 *
 * `filename*` (RFC 5987) is read only when a plain `filename` is absent: curl
 * never sends it, but an agent using a richer HTTP client might.
 */
function parseDisposition(value: string): { name: string | null; filename: string | null } {
	const read = (key: string): string | null => {
		const match = new RegExp(`;\\s*${key}\\s*=\\s*(?:"([^"]*)"|([^;]+))`, "i").exec(value);
		const found = match?.[1] ?? match?.[2];
		return found === undefined ? null : found.trim();
	};

	let filename = read("filename");
	if (filename === null) {
		const extended = read("filename\\*");
		if (extended) {
			// `UTF-8''holiday%20snap.jpg`. Anything else is left as it arrived rather
			// than guessed at; the receiver sanitises names regardless (PRD 12.2).
			const encoded = /^utf-8''(.*)$/i.exec(extended);
			if (encoded) {
				try {
					filename = decodeURIComponent(encoded[1]);
				} catch {
					filename = encoded[1];
				}
			}
		}
	}
	return { name: read("name"), filename };
}

export class MultipartReader {
	/**
	 * Bytes of the request body that have been passed over — everything up to
	 * where the next read will resume.
	 *
	 * The curl path needs this exactly: the AAD of every chunk binds the total
	 * chunk count (docs/wire-format.md), so the plaintext length has to be known
	 * before the first chunk is encrypted, and it is recovered by subtracting
	 * this and the trailing boundary from `content-length`.
	 */
	position = 0;

	private reader: ReadableStreamDefaultReader<Uint8Array>;
	private buffer = new Uint8Array(0);
	private ended = false;
	/** `\r\n--boundary`, the delimiter that closes every part. */
	private delimiter: Uint8Array;
	private opening: Uint8Array;
	private started = false;
	private finished = false;
	private partOpen = false;

	constructor(body: ReadableStream<Uint8Array>, boundary: string) {
		this.reader = body.getReader();
		const bytes = new TextEncoder().encode(`--${boundary}`);
		this.opening = bytes;
		this.delimiter = new Uint8Array(2 + bytes.length);
		this.delimiter.set(CRLF, 0);
		this.delimiter.set(bytes, 2);
	}

	/**
	 * Length of `\r\n--boundary--` — the shortest legal tail after the last part.
	 *
	 * RFC 2046 allows transport padding and a CRLF after the closing delimiter,
	 * and clients disagree: curl writes the CRLF, Node's own `FormData` does not.
	 * So this is a lower bound on the tail and an upper bound on the payload,
	 * and the caller resolves the two remaining bytes from what actually arrives.
	 */
	get closingLength(): number {
		return this.opening.length + 4;
	}

	async cancel(): Promise<void> {
		try {
			await this.reader.cancel();
		} catch {
			// The stream is already gone; there is nothing to release.
		}
	}

	/** Pulls one more chunk into the buffer. Returns false at end of stream. */
	private async pull(): Promise<boolean> {
		if (this.ended) return false;
		const { done, value } = await this.reader.read();
		if (done || !value) {
			this.ended = true;
			return false;
		}
		const merged = new Uint8Array(this.buffer.length + value.length);
		merged.set(this.buffer, 0);
		merged.set(value, this.buffer.length);
		this.buffer = merged;
		return true;
	}

	/** Drops `count` bytes off the front, counting them as passed over. */
	private advance(count: number): void {
		this.buffer = this.buffer.subarray(count);
		this.position += count;
	}

	/** Buffers until `needle` is present, or the stream ends. */
	private async findOrFill(needle: Uint8Array, from = 0): Promise<number> {
		for (;;) {
			const at = indexOf(this.buffer, needle, from);
			if (at >= 0) return at;
			if (!(await this.pull())) return -1;
		}
	}

	/**
	 * The next part's headers, or null once the final boundary has been read.
	 *
	 * The body of the previous part must have been read to completion first;
	 * calling this mid-part is a programming error, not a client one.
	 */
	async nextPart(): Promise<PartHeader | null> {
		if (this.finished) return null;
		if (this.partOpen) throw new MultipartError("The previous part was not read to the end.");

		if (!this.started) {
			// A preamble before the first boundary is legal and nothing sends one, so
			// this is a search rather than a match at offset zero.
			const at = await this.findOrFill(this.opening);
			if (at < 0) throw new MultipartError("No multipart boundary in the body.");
			this.advance(at + this.opening.length);
			this.started = true;
		}

		// Either `--` (this was the closing boundary) or optional whitespace and a
		// CRLF before the part's headers.
		while (this.buffer.length < 2 && (await this.pull())) {
			// Keep filling; two bytes is the most this decision needs.
		}
		if (this.buffer.length >= 2 && this.buffer[0] === 0x2d && this.buffer[1] === 0x2d) {
			this.finished = true;
			this.advance(2);
			return null;
		}

		const breakAt = await this.findOrFill(CRLFCRLF);
		if (breakAt < 0) throw new MultipartError("A part's headers are unterminated.");
		if (breakAt > MAX_PART_HEADER_BYTES) throw new MultipartError("A part's headers are too long.");

		const raw = new TextDecoder().decode(this.buffer.subarray(0, breakAt));
		this.advance(breakAt + CRLFCRLF.length);

		let name: string | null = null;
		let filename: string | null = null;
		let contentType: string | null = null;
		for (const line of raw.split("\r\n")) {
			const colon = line.indexOf(":");
			if (colon < 0) continue;
			const header = line.slice(0, colon).trim().toLowerCase();
			const value = line.slice(colon + 1).trim();
			if (header === "content-disposition") ({ name, filename } = parseDisposition(value));
			else if (header === "content-type") contentType = value;
		}

		this.partOpen = true;
		return { name, filename, contentType };
	}

	/**
	 * The current part's body, chunk by chunk. Ends when the closing delimiter is
	 * reached, leaving the reader positioned for `nextPart`.
	 */
	async *partBody(): AsyncGenerator<Uint8Array> {
		if (!this.partOpen) throw new MultipartError("No part is open.");
		// The most a partial delimiter can occupy at the tail of the buffer.
		const holdBack = this.delimiter.length - 1;

		for (;;) {
			const at = indexOf(this.buffer, this.delimiter);
			if (at >= 0) {
				if (at > 0) yield this.buffer.subarray(0, at);
				this.advance(at + this.delimiter.length);
				this.partOpen = false;
				return;
			}

			if (this.buffer.length > holdBack) {
				const safe = this.buffer.length - holdBack;
				const out = this.buffer.subarray(0, safe);
				this.advance(safe);
				yield out;
			}

			if (!(await this.pull())) {
				throw new MultipartError("The body ended before the closing boundary.");
			}
		}
	}

	/**
	 * The current part's body as text, refused past `maxBytes`.
	 *
	 * For form fields only — a file part must go through `partBody`, which is the
	 * whole reason this class exists.
	 */
	async partText(maxBytes: number): Promise<string> {
		const pieces: Uint8Array[] = [];
		let total = 0;
		for await (const chunk of this.partBody()) {
			total += chunk.length;
			if (total > maxBytes) throw new MultipartError("A form field is too long.");
			pieces.push(chunk);
		}
		const joined = new Uint8Array(total);
		let at = 0;
		for (const piece of pieces) {
			joined.set(piece, at);
			at += piece.length;
		}
		return new TextDecoder().decode(joined);
	}
}
