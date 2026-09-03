/**
 * What a published macOS build is, on the wire.
 *
 * Shared by the Worker (which writes the response) and the download page (which
 * renders it), for the same reason `site-origin.ts` is shared: two ends of one
 * contract that must not be able to drift apart. It is types only, so nothing
 * of this file survives compilation.
 *
 * The manifest lives as an R2 object rather than a D1 row. Publishing a build
 * is out of band from `npm run deploy`, and a D1 table would mean a migration
 * *and* a remote `d1 execute` in the publish script — two systems to keep in
 * step for one row that is, literally, metadata about an object in that bucket.
 */
export interface MacRelease {
	/** `CFBundleShortVersionString` — "1.0.0". */
	version: string;
	/** `CFBundleVersion`. Not rendered anywhere; carried for an update check. */
	build: string;
	/** "Stolnk-1.0.0-universal.dmg". */
	filename: string;
	/** Bytes, as the browser will download them. */
	size: number;
	/** Lowercase hex SHA-256 of the dmg, shown on the download page. */
	sha256: string;
	/** "13.0" — `Package.swift`'s `.macOS(.v13)` and `LSMinimumSystemVersion`. */
	min_macos: string;
	/** Epoch milliseconds, like every other timestamp in this codebase. */
	published_at: number;
	/** Path to the bytes. Always recomputed from `filename` before it is served. */
	url: string;
	/**
	 * `stolnk_mac` short SHA, present only when that tree was clean at publish
	 * time. A published binary is either traceable or honestly untraceable.
	 */
	commit?: string;
}
