/**
 * Remembers in-flight uploads so a killed tab can pick one back up.
 *
 * The honest limits, both surfaced in the UI rather than papered over:
 *
 * - A browser cannot hold on to a `File` across a reload, so resuming needs the
 *   user to pick the same file again. The page says so instead of pretending it
 *   can restart on its own.
 * - The content key is stored here, in this browser only, until the upload
 *   finishes. Without it a resumed upload could not produce bytes the Mac can
 *   decrypt. The record is deleted the moment the transfer completes.
 */

const DB_NAME = "stolnk";
const STORE = "uploads";
const VERSION = 2;

export interface ResumeRecord {
	transfer_id: string;
	file_id: string;
	token: string;
	inbox_slug: string;
	inbox_name: string;
	file_name: string;
	file_size: number;
	file_modified: number;
	content_key: string;
	nonce_prefix: string;
	created_at: number;
}

function open(): Promise<IDBDatabase | null> {
	return new Promise((resolve) => {
		let request: IDBOpenDBRequest;
		try {
			request = indexedDB.open(DB_NAME, VERSION);
		} catch {
			// Private windows and locked-down browsers: resume is simply unavailable.
			resolve(null);
			return;
		}
		request.onupgradeneeded = () => {
			const db = request.result;
			// v2 keys records by slug rather than by the old name+path string. A v1
			// record can never match again, so the upgrade drops the store rather
			// than leaving rows that quietly never resume.
			if (db.objectStoreNames.contains(STORE)) db.deleteObjectStore(STORE);
			db.createObjectStore(STORE, { keyPath: "file_id" });
		};
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => resolve(null);
	});
}

async function withStore<T>(
	mode: IDBTransactionMode,
	body: (store: IDBObjectStore) => IDBRequest,
): Promise<T | null> {
	const db = await open();
	if (!db) return null;
	return new Promise((resolve) => {
		try {
			const request = body(db.transaction(STORE, mode).objectStore(STORE));
			request.onsuccess = () => resolve(request.result as T);
			request.onerror = () => resolve(null);
		} catch {
			resolve(null);
		}
	});
}

export async function saveResume(record: ResumeRecord): Promise<void> {
	await withStore("readwrite", (store) => store.put(record));
}

export async function clearResume(fileId: string): Promise<void> {
	await withStore("readwrite", (store) => store.delete(fileId));
}

export async function listResumable(inboxSlug: string): Promise<ResumeRecord[]> {
	const all = (await withStore<ResumeRecord[]>("readonly", (store) => store.getAll())) ?? [];
	const cutoff = Date.now() - 24 * 60 * 60 * 1000;
	const live = all.filter((record) => record.created_at > cutoff);

	// Expired records are useless — the relay has dropped the parts by now.
	for (const stale of all.filter((record) => record.created_at <= cutoff)) {
		await clearResume(stale.file_id);
	}
	return live.filter((record) => record.inbox_slug === inboxSlug);
}

/** Matches a re-picked file against a saved record. */
export function matches(record: ResumeRecord, file: File): boolean {
	return (
		record.file_name === file.name &&
		record.file_size === file.size &&
		record.file_modified === file.lastModified
	);
}
