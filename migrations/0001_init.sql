-- Stolnk V1 schema.
-- PRD 7.3: the server never stores local paths, plaintext filenames,
-- file contents, or content hashes usable for tracking.

-- 6.1: `name` is a DNS label and the whole identity — a link lives at
-- <name>.stolnk.com. UNIQUE is the one-name-per-device rule itself rather
-- than a convention the code has to keep: renaming is a single UPDATE here,
-- and every link the device owns moves with it because no inbox stores the
-- name. The old subdomain stops resolving the moment it commits; there is no
-- grace redirect and the freed name goes straight back into the pool.
--
-- 7.2: the flip side is that a name cannot outlive its device. The private
-- key lives in the Secure Enclave and cannot be exported, so a lost Mac is a
-- lost name — permanently held by a device that can never authenticate again.
CREATE TABLE devices (
  device_id   TEXT PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  pubkey_sig  TEXT NOT NULL,          -- P-256 ECDSA, raw uncompressed, base64url
  pubkey_kex  TEXT NOT NULL,          -- P-256 ECDH,  raw uncompressed, base64url
  created_at  INTEGER NOT NULL,
  last_seen   INTEGER NOT NULL
);

-- Challenge-response nonces for device auth (1.1). Short-lived, swept by cron.
CREATE TABLE challenges (
  nonce       TEXT PRIMARY KEY,
  device_id   TEXT NOT NULL,
  expires_at  INTEGER NOT NULL
);
CREATE INDEX idx_challenges_expiry ON challenges (expires_at);

-- 6.2: one row per inbox. path_slug is everything after the host, so a link is
-- always <name>.stolnk.com/<path_slug> -- there is no bare-subdomain address
-- and no privileged "root" row. The name says whose Mac it is; the path says
-- which folder, and every link has to answer both.
--
-- Uniqueness is per owning device. Because devices.name is unique, that is
-- exactly the same statement as "(name, path) is globally unique" -- and it
-- holds without a second copy of the name to keep in sync.
CREATE TABLE inboxes (
  inbox_id               TEXT PRIMARY KEY,
  owner_device_id        TEXT NOT NULL,
  path_slug              TEXT NOT NULL,
  display_name           TEXT NOT NULL,
  password_salt          TEXT,
  password_verifier_hash TEXT,
  size_limit             INTEGER NOT NULL,
  paused                 INTEGER NOT NULL DEFAULT 0,
  confirm_first          INTEGER NOT NULL DEFAULT 1,
  created_at             INTEGER NOT NULL,
  FOREIGN KEY (owner_device_id) REFERENCES devices (device_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX idx_inboxes_path ON inboxes (owner_device_id, path_slug);

-- One transfer == one sender session dropping a batch of files (13.2).
CREATE TABLE transfers (
  transfer_id    TEXT PRIMARY KEY,
  inbox_id       TEXT NOT NULL,
  sender_session TEXT NOT NULL,
  state          TEXT NOT NULL,       -- uploading | ready | delivered | declined | expired | aborted
  total_bytes    INTEGER NOT NULL DEFAULT 0,
  sender_is_owner INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL,
  expires_at     INTEGER NOT NULL,
  FOREIGN KEY (inbox_id) REFERENCES inboxes (inbox_id) ON DELETE CASCADE
);
CREATE INDEX idx_transfers_inbox ON transfers (inbox_id);
CREATE INDEX idx_transfers_expiry ON transfers (expires_at);

-- enc_name is the AES-GCM ciphertext of the filename: the server cannot read it.
CREATE TABLE files (
  file_id      TEXT PRIMARY KEY,
  transfer_id  TEXT NOT NULL,
  r2_key       TEXT NOT NULL,
  upload_id    TEXT,
  enc_name     TEXT NOT NULL,
  name_iv      TEXT NOT NULL,
  size         INTEGER NOT NULL,      -- plaintext bytes
  cipher_size  INTEGER NOT NULL,      -- size + 16 * ceil(size / CHUNK_SIZE)
  nonce_prefix TEXT NOT NULL,
  wrapped_key  TEXT NOT NULL,
  key_iv       TEXT NOT NULL,
  eph_pub      TEXT NOT NULL,
  plain_sha256 TEXT NOT NULL,
  state        TEXT NOT NULL,         -- uploading | ready | delivered | declined | expired | aborted
  created_at   INTEGER NOT NULL,
  delivered_at INTEGER,
  FOREIGN KEY (transfer_id) REFERENCES transfers (transfer_id) ON DELETE CASCADE
);
CREATE INDEX idx_files_transfer ON files (transfer_id);
CREATE INDEX idx_files_state ON files (state);

-- Recorded part etags are what make resume work (8.3 #2): re-uploading a part
-- that already has an etag is a no-op.
CREATE TABLE file_parts (
  file_id     TEXT NOT NULL,
  part_number INTEGER NOT NULL,
  etag        TEXT NOT NULL,
  size        INTEGER NOT NULL,
  PRIMARY KEY (file_id, part_number),
  FOREIGN KEY (file_id) REFERENCES files (file_id) ON DELETE CASCADE
);

-- 13.2: remembered "always accept from this link" decisions, per inbox.
CREATE TABLE trusted_senders (
  inbox_id       TEXT NOT NULL,
  sender_session TEXT NOT NULL,
  created_at     INTEGER NOT NULL,
  PRIMARY KEY (inbox_id, sender_session)
);

-- 13.3: per-inbox daily counters, bucketed by UTC day.
CREATE TABLE usage_daily (
  inbox_id TEXT NOT NULL,
  day      TEXT NOT NULL,
  files    INTEGER NOT NULL DEFAULT 0,
  bytes    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (inbox_id, day)
);
