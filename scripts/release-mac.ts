/**
 * Publishes a macOS build to R2, where the Worker's /download routes find it.
 *
 *   node --experimental-strip-types scripts/release-mac.ts <dmg> [--local] [--force]
 *   npm run release:mac -- ../stolnk_mac/build/Stolnk-1.0.0-universal.dmg
 *   npm run release:mac -- --local --fake       seed local dev, no Apple account
 *
 * The dmg comes from `cd stolnk_mac && make release`, which signs, notarises and
 * staples it. Nothing here checks that — a notarised dmg and an unsigned one are
 * the same bytes to R2 — so publishing something `make dmg` produced will hand
 * strangers an installer Gatekeeper refuses. `make release` is the gate.
 *
 * Two objects go up, in this order:
 *
 *   mac/Stolnk-<version>-universal.dmg   immutable, cached for a year
 *   mac/latest.json                      the manifest, cached for a minute
 *
 * The order matters: the manifest is what makes a version visible, so a crash
 * between the two leaves the site on the previous release rather than pointing
 * at an object that is not there.
 */
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { MacRelease } from "../src/shared/release.ts";

const BUCKET = "stolnk-releases";
const PREFIX = "mac/";
const MANIFEST_KEY = `${PREFIX}latest.json`;
/** Must agree with DMG_RE in src/worker/routes/releases.ts. */
const DMG_RE = /^Stolnk-([0-9A-Za-z.+-]{1,32})-universal\.dmg$/;
/** Package.swift's `.macOS(.v13)` and bundle.sh's LSMinimumSystemVersion. */
const MIN_MACOS = "13.0";

const HERE = dirname(fileURLToPath(import.meta.url));
const MAC_REPO = resolve(HERE, "../../stolnk_mac");

const args = process.argv.slice(2);
const local = args.includes("--local");
const force = args.includes("--force");
const fake = args.includes("--fake");
const positional = args.filter((a) => !a.startsWith("--"));
// Never inferred. Wrangler documents neither as the default, so both are passed
// explicitly and a typo cannot quietly publish to production.
const WHERE = local ? "--local" : "--remote";

function die(message: string): never {
	console.error(`error: ${message}`);
	process.exit(1);
}

/** Runs wrangler and resolves with its stdout, or rejects with the exit code. */
function wrangler(argv: string[], stdin?: Buffer | string): Promise<string> {
	return new Promise((ok, no) => {
		const child = spawn("npx", ["wrangler", ...argv], {
			cwd: resolve(HERE, ".."),
			stdio: [stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
		});
		let out = "";
		let err = "";
		child.stdout.on("data", (d) => (out += d));
		child.stderr.on("data", (d) => (err += d));
		if (stdin !== undefined) child.stdin!.end(stdin);
		child.on("close", (code) => (code === 0 ? ok(out) : no(new Error(err || out))));
	});
}

function git(argv: string[]): Promise<string> {
	return new Promise((ok, no) => {
		const child = spawn("git", ["-C", MAC_REPO, ...argv], { stdio: ["ignore", "pipe", "ignore"] });
		let out = "";
		child.stdout.on("data", (d) => (out += d));
		child.on("close", (code) => (code === 0 ? ok(out.trim()) : no(new Error("git failed"))));
	});
}

async function sha256(path: string): Promise<string> {
	// Streamed, not readFileSync: the dmg has no business being resident whole.
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(path)) hash.update(chunk);
	return hash.digest("hex");
}

/** The version stolnk_mac says it is. The only mechanical link between repos. */
async function declaredVersion(): Promise<string> {
	const { readFile } = await import("node:fs/promises");
	return (await readFile(resolve(MAC_REPO, "VERSION"), "utf8")).trim();
}

async function makeFakeDmg(): Promise<string> {
	if (!local) die("--fake only ever publishes locally. Add --local, or drop --fake.");
	const { writeFile, mkdtemp } = await import("node:fs/promises");
	const { tmpdir } = await import("node:os");
	const version = await declaredVersion();
	const dir = await mkdtemp(resolve(tmpdir(), "stolnk-fake-"));
	const path = resolve(dir, `Stolnk-${version}-universal.dmg`);
	// Not a dmg, and deliberately not pretending to be one. It exists so the
	// download page and the e2e checks have bytes to serve without an Apple
	// account or a real build — the same reason scripts/fake-mac.ts exists.
	await writeFile(path, randomBytes(64 * 1024));
	console.log(`fake build: ${path}`);
	return path;
}

async function main() {
	const dmg = fake ? await makeFakeDmg() : resolve(positional[0] ?? "");
	if (!positional[0] && !fake) {
		die("usage: release-mac.ts <dmg> [--local] [--force]   (or --local --fake)");
	}

	const info = await stat(dmg).catch(() => null);
	if (!info?.isFile()) die(`${dmg} is not a file`);
	if (info.size === 0) die(`${dmg} is empty`);

	const filename = dmg.split("/").pop()!;
	const match = DMG_RE.exec(filename);
	if (!match) die(`${filename} is not named Stolnk-<version>-universal.dmg`);
	const version = match[1];

	const declared = await declaredVersion().catch(() => null);
	if (declared === null) die(`cannot read ${MAC_REPO}/VERSION`);
	if (declared !== version) {
		die(
			`${filename} says ${version} but stolnk_mac/VERSION says ${declared}. ` +
				`One of them is stale — rebuild, or fix VERSION.`,
		);
	}

	const key = PREFIX + filename;

	if (!force) {
		const published = await wrangler(["r2", "object", "get", `${BUCKET}/${key}`, "--pipe", WHERE])
			.then(() => true)
			.catch(() => false);
		if (published) {
			die(
				`${key} is already published. Bump stolnk_mac/VERSION and rebuild, ` +
					`or pass --force to overwrite it.`,
			);
		}
	} else {
		console.warn(
			"warning: --force overwrites a published build. Those bytes are cached\n" +
				"         immutable for a year at the edge and in browsers, so this is\n" +
				"         only ever useful in the minutes after a bad publish.",
		);
	}

	const digest = await sha256(dmg);

	// Traceable, or honestly untraceable: a dirty tree means the SHA does not
	// describe what was built, so it is left out rather than guessed at.
	let commit: string | undefined;
	try {
		const dirty = (await git(["status", "--porcelain"])).length > 0;
		if (!dirty) commit = await git(["rev-parse", "--short", "HEAD"]);
	} catch {
		// No git, or not a repository. Not a reason to fail a release.
	}

	const manifest: MacRelease = {
		version,
		build: version,
		filename,
		size: info.size,
		sha256: digest,
		min_macos: MIN_MACOS,
		published_at: Date.now(),
		url: `/download/mac/${filename}`,
		...(commit ? { commit } : {}),
	};

	console.log(`publishing ${key} (${info.size} bytes) ${WHERE}`);
	await wrangler([
		"r2", "object", "put", `${BUCKET}/${key}`,
		"--file", dmg,
		WHERE,
		"--content-type", "application/x-apple-diskimage",
		"--content-disposition", `attachment; filename="${filename}"`,
		"--cache-control", "public, max-age=31536000, immutable",
	]);

	console.log(`publishing ${MANIFEST_KEY}`);
	await wrangler(
		[
			"r2", "object", "put", `${BUCKET}/${MANIFEST_KEY}`,
			"--pipe",
			WHERE,
			"--content-type", "application/json",
			"--cache-control", "public, max-age=60",
		],
		JSON.stringify(manifest, null, "\t"),
	);

	// Read it back rather than trusting the write. A manifest that does not
	// round-trip is a site pointing at a build nobody can verify.
	const readBack = await wrangler([
		"r2", "object", "get", `${BUCKET}/${MANIFEST_KEY}`, "--pipe", WHERE,
	]);
	const parsed = JSON.parse(readBack) as MacRelease;
	if (parsed.sha256 !== digest || parsed.filename !== filename) {
		die("the manifest read back does not match what was written");
	}

	console.log();
	console.log(`version   ${version}${commit ? ` (${commit})` : ""}`);
	console.log(`sha256    ${digest}`);
	console.log(`download  ${local ? "http://localhost:5173" : "https://stolnk.com"}/download/mac`);
	console.log(`manifest  ${local ? "http://localhost:5173" : "https://stolnk.com"}/api/v1/release/mac`);
}

await main();
