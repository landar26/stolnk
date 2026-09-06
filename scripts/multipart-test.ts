/**
 * Unit tests for the streaming multipart reader (src/worker/lib/multipart.ts).
 *
 *   npm run test:multipart
 *
 * These are separate from `npm run e2e` because they need no server, and
 * separate from the e2e suite's own checks because the thing being tested is a
 * byte-level state machine: the interesting cases are not "does an upload
 * work" but "what happens when a boundary is split across two reads", and the
 * only way to cover that is to drive the same body through every possible
 * chunking. A failure here is a silently corrupted file, so it is worth its own
 * file.
 */
import {
	MultipartError,
	MultipartReader,
	parseBoundary,
} from "../src/worker/lib/multipart.ts";

let passed = 0;
const failures: string[] = [];

function check(name: string, condition: unknown, detail = ""): void {
	if (condition) {
		passed += 1;
	} else {
		failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
		console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
	}
}

function section(title: string): void {
	console.log(`\n${title}`);
}

const BOUNDARY = "------------------------abc123def456";

function bytes(...pieces: Array<string | Uint8Array>): Uint8Array {
	const encoder = new TextEncoder();
	const parts = pieces.map((piece) =>
		typeof piece === "string" ? encoder.encode(piece) : piece,
	);
	const total = parts.reduce((sum, part) => sum + part.length, 0);
	const out = new Uint8Array(total);
	let at = 0;
	for (const part of parts) {
		out.set(part, at);
		at += part.length;
	}
	return out;
}

/** One file part, optionally preceded by form fields. Exactly curl's layout. */
function body(
	file: { name: string; filename: string; data: Uint8Array; type?: string },
	fields: Array<[string, string]> = [],
	options: { terminate?: boolean; trailingCrlf?: boolean } = {},
): Uint8Array {
	const pieces: Array<string | Uint8Array> = [];
	for (const [key, value] of fields) {
		pieces.push(
			`--${BOUNDARY}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`,
		);
	}
	pieces.push(
		`--${BOUNDARY}\r\n`,
		`Content-Disposition: form-data; name="${file.name}"; filename="${file.filename}"\r\n`,
		`Content-Type: ${file.type ?? "application/octet-stream"}\r\n\r\n`,
		file.data,
	);
	if (options.terminate !== false) {
		pieces.push(`\r\n--${BOUNDARY}--${options.trailingCrlf === false ? "" : "\r\n"}`);
	}
	return bytes(...pieces);
}

/** A stream that hands the body out in pieces of exactly `size` bytes. */
function streamOf(data: Uint8Array, size: number): ReadableStream<Uint8Array> {
	let at = 0;
	return new ReadableStream<Uint8Array>({
		pull(controller) {
			if (at >= data.length) {
				controller.close();
				return;
			}
			controller.enqueue(data.slice(at, Math.min(data.length, at + size)));
			at += size;
		},
	});
}

/** A stream split into exactly two pieces at `at`, the split-delimiter case. */
function splitAt(data: Uint8Array, at: number): ReadableStream<Uint8Array> {
	const pieces = [data.slice(0, at), data.slice(at)].filter((piece) => piece.length > 0);
	let index = 0;
	return new ReadableStream<Uint8Array>({
		pull(controller) {
			if (index >= pieces.length) {
				controller.close();
				return;
			}
			controller.enqueue(pieces[index++]);
		},
	});
}

async function drain(generator: AsyncGenerator<Uint8Array>): Promise<Uint8Array> {
	const pieces: Uint8Array[] = [];
	let total = 0;
	for await (const chunk of generator) {
		// The reader hands out views into its own buffer, which it reuses. A caller
		// that keeps them must copy — the upload path encrypts each chunk before
		// asking for the next, so it never has to.
		pieces.push(chunk.slice());
		total += chunk.length;
	}
	const out = new Uint8Array(total);
	let at = 0;
	for (const piece of pieces) {
		out.set(piece, at);
		at += piece.length;
	}
	return out;
}

function same(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
	return true;
}

section("parseBoundary");
check(
	"plain",
	parseBoundary(`multipart/form-data; boundary=${BOUNDARY}`) === BOUNDARY,
);
check(
	"quoted",
	parseBoundary(`multipart/form-data; boundary="${BOUNDARY}"`) === BOUNDARY,
);
check(
	"quoted with a semicolon inside",
	parseBoundary('multipart/form-data; boundary="a;b"') === "a;b",
);
check("case insensitive", parseBoundary(`MULTIPART/FORM-DATA; BOUNDARY=${BOUNDARY}`) === BOUNDARY);
check("charset ahead of boundary", parseBoundary(`multipart/form-data; charset=utf-8; boundary=x`) === "x");
check("not multipart", parseBoundary("application/json") === null);
check("multipart with no boundary", parseBoundary("multipart/form-data") === null);
check("absent", parseBoundary(null) === null);
check(
	"a type that merely starts the same way is not multipart/form-data",
	parseBoundary("multipart/form-data-x; boundary=x") === null,
);

section("One file part");
{
	const data = new TextEncoder().encode("客户素材 ✅ hello world");
	const raw = body({ name: "file", filename: "报告 final.txt", data });
	const reader = new MultipartReader(streamOf(raw, 7), BOUNDARY);
	const part = await reader.nextPart();
	check("field name", part?.name === "file", String(part?.name));
	check("filename survives UTF-8", part?.filename === "报告 final.txt", String(part?.filename));
	check("content type", part?.contentType === "application/octet-stream");

	// The arithmetic the upload path depends on: everything but the payload is
	// accounted for, so the payload length is known before a byte is encrypted.
	const derived = raw.length - reader.position - reader.closingLength - 2;
	check("payload length derives from content-length", derived === data.length, `${derived}`);

	const out = await drain(reader.partBody());
	check("payload round-trips", same(out, data));
	check("no further parts", (await reader.nextPart()) === null);
}

section("Fields before the file");
{
	const data = new TextEncoder().encode("payload");
	const raw = body({ name: "file", filename: "a.bin", data }, [
		["password", "hunter2"],
		["note", "hello"],
	]);
	const reader = new MultipartReader(streamOf(raw, 5), BOUNDARY);

	const first = await reader.nextPart();
	check("first part is a field", first?.name === "password" && first.filename === null);
	check("field value", (await reader.partText(1024)) === "hunter2");

	const second = await reader.nextPart();
	check("second part is a field", second?.name === "note");
	check("second value", (await reader.partText(1024)) === "hello");

	const third = await reader.nextPart();
	check("third part is the file", third?.filename === "a.bin");
	const derived = raw.length - reader.position - reader.closingLength - 2;
	check("payload length still derives", derived === data.length, `${derived}`);
	check("payload round-trips after fields", same(await drain(reader.partBody()), data));
}

section("Payload that looks like framing");
{
	// Every near-miss that must pass through untouched: the boundary with
	// something other than CRLF in front of it, a delimiter one character short,
	// bare CR and LF, and the closing form.
	//
	// What is deliberately absent is `\r\n--BOUNDARY` itself. A payload cannot
	// contain that — it *is* the end of the part, by definition — which is the
	// whole reason a boundary is a long random string.
	const data = bytes(
		`X--${BOUNDARY}\r\n`,
		"\r\n--not-the-boundary\r\n",
		`\r\n--${BOUNDARY.slice(0, -1)}`,
		"\r",
		"\n",
		"\r\n\r\nZ",
		`--${BOUNDARY}--`,
	);
	const raw = body({ name: "file", filename: "tricky.bin", data });
	for (const size of [1, 2, 3, 17, 64, 1024]) {
		const reader = new MultipartReader(streamOf(raw, size), BOUNDARY);
		await reader.nextPart();
		const derived = raw.length - reader.position - reader.closingLength - 2;
		const out = await drain(reader.partBody());
		check(`boundary-shaped payload survives, ${size}-byte reads`, same(out, data));
		check(`derived length correct, ${size}-byte reads`, derived === data.length, `${derived}`);
	}
}

section("Every possible split of the stream");
{
	const data = bytes("head", `\r\n--${BOUNDARY.slice(0, 20)}`, "tail\r\n");
	const raw = body({ name: "file", filename: "s.bin", data });
	let worst = "";
	let ok = 0;
	for (let at = 0; at <= raw.length; at++) {
		const reader = new MultipartReader(splitAt(raw, at), BOUNDARY);
		const part = await reader.nextPart();
		const derived = raw.length - reader.position - reader.closingLength - 2;
		const out = await drain(reader.partBody());
		if (part?.filename === "s.bin" && derived === data.length && same(out, data)) ok += 1;
		else if (!worst) worst = `split at ${at}`;
	}
	check(`all ${raw.length + 1} split points parse identically`, ok === raw.length + 1, worst);
}

section("Empty and single-byte payloads");
for (const length of [0, 1]) {
	const data = new Uint8Array(length).fill(0x41);
	const raw = body({ name: "file", filename: "e.bin", data });
	const reader = new MultipartReader(streamOf(raw, 3), BOUNDARY);
	await reader.nextPart();
	const derived = raw.length - reader.position - reader.closingLength - 2;
	check(`${length}-byte payload derives`, derived === length, `${derived}`);
	check(`${length}-byte payload round-trips`, same(await drain(reader.partBody()), data));
}

section("A payload ending in a delimiter prefix (the hold-back)");
{
	// The last bytes of the file look like the start of the closing delimiter.
	// Without the hold-back these are emitted before the parser can know, and the
	// file lands short by however many bytes matched.
	const data = bytes("body", `\r\n--${BOUNDARY.slice(0, BOUNDARY.length - 1)}`);
	const raw = body({ name: "file", filename: "edge.bin", data });
	for (const size of [1, 5, 40, 4096]) {
		const reader = new MultipartReader(streamOf(raw, size), BOUNDARY);
		await reader.nextPart();
		check(
			`payload ending in a partial delimiter survives, ${size}-byte reads`,
			same(await drain(reader.partBody()), data),
		);
	}
}

section("A body with no trailing CRLF after the closing boundary");
{
	// Node's own `FormData` is one of them. `closingLength` is a lower bound on
	// the tail, so subtracting two more — curl's layout — comes out two short. The
	// upload path derives both candidates and settles which is real from the bytes
	// that arrive, so neither client has to know about the other.
	const data = new TextEncoder().encode("0123456789");
	const raw = body({ name: "file", filename: "a.bin", data }, [], { trailingCrlf: false });
	const reader = new MultipartReader(streamOf(raw, 8), BOUNDARY);
	await reader.nextPart();
	const derived = raw.length - reader.position - reader.closingLength - 2;
	check("the curl-shaped candidate is two short here", derived === data.length - 2, `${derived}`);
	check("and the other candidate is exact", derived + 2 === data.length);
	check("the payload itself still reads correctly", same(await drain(reader.partBody()), data));
}

section("Refusals");
{
	const raw = body(
		{ name: "file", filename: "a.bin", data: new TextEncoder().encode("x") },
		[],
		{ terminate: false },
	);
	const reader = new MultipartReader(streamOf(raw, 4), BOUNDARY);
	await reader.nextPart();
	let threw: unknown = null;
	try {
		await drain(reader.partBody());
	} catch (error) {
		threw = error;
	}
	check("an unterminated part is an error", threw instanceof MultipartError);
}
{
	const reader = new MultipartReader(streamOf(new TextEncoder().encode("no boundary here"), 4), BOUNDARY);
	let threw: unknown = null;
	try {
		await reader.nextPart();
	} catch (error) {
		threw = error;
	}
	check("a body with no boundary at all is an error", threw instanceof MultipartError);
}
{
	const raw = bytes(`--${BOUNDARY}\r\n`, `X-Pad: ${"a".repeat(9000)}\r\n\r\n`, "body", `\r\n--${BOUNDARY}--\r\n`);
	const reader = new MultipartReader(streamOf(raw, 512), BOUNDARY);
	let threw: unknown = null;
	try {
		await reader.nextPart();
	} catch (error) {
		threw = error;
	}
	check("oversized part headers are an error", threw instanceof MultipartError);
}
{
	const raw = body({ name: "file", filename: "a.bin", data: new TextEncoder().encode("0123456789") });
	const reader = new MultipartReader(streamOf(raw, 4), BOUNDARY);
	await reader.nextPart();
	let threw: unknown = null;
	try {
		await reader.partText(4);
	} catch (error) {
		threw = error;
	}
	check("partText refuses past its cap", threw instanceof MultipartError);
}
{
	const raw = body({ name: "file", filename: "a.bin", data: new TextEncoder().encode("abc") });
	const reader = new MultipartReader(streamOf(raw, 4), BOUNDARY);
	await reader.nextPart();
	let threw: unknown = null;
	try {
		await reader.nextPart();
	} catch (error) {
		threw = error;
	}
	check("skipping a part's body is refused", threw instanceof MultipartError);
}

section("A part with no filename is a field, not a file");
{
	const raw = bytes(
		`--${BOUNDARY}\r\nContent-Disposition: form-data; name="only"\r\n\r\nvalue\r\n--${BOUNDARY}--\r\n`,
	);
	const reader = new MultipartReader(streamOf(raw, 6), BOUNDARY);
	const part = await reader.nextPart();
	check("no filename", part?.filename === null && part?.name === "only");
	check("value reads", (await reader.partText(64)) === "value");
	check("then the body ends", (await reader.nextPart()) === null);
}

section("filename* (RFC 5987), for clients that are not curl");
{
	const raw = bytes(
		`--${BOUNDARY}\r\n`,
		`Content-Disposition: form-data; name="file"; filename*=UTF-8''holiday%20snap.jpg\r\n\r\n`,
		"x",
		`\r\n--${BOUNDARY}--\r\n`,
	);
	const reader = new MultipartReader(streamOf(raw, 9), BOUNDARY);
	const part = await reader.nextPart();
	check("percent-decoded", part?.filename === "holiday snap.jpg", String(part?.filename));
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
	for (const failure of failures) console.log(`  - ${failure}`);
	process.exit(1);
}
