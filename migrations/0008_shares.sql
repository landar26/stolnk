-- Outbound share links.
--
-- This is the deliberate plaintext exception to Stolnk's encrypted inbox
-- path. `filename` is readable in D1 and the object at `r2_key` is readable in
-- R2: arbitrary browsers need to be able to download it without possessing a
-- key from the owner's Secure Enclave. The public link is therefore the
-- credential, and its 80-bit random code must remain unguessable.
--
-- Plaintext shares also have a real GB-month storage cost, unlike inbox relay
-- objects whose normal lifetime ends as soon as the Mac acknowledges them.
-- Limits and expiry are enforced in the Worker rather than left as UI policy.
CREATE TABLE shares (
  share_id               TEXT PRIMARY KEY,
  owner_device_id        TEXT NOT NULL,
  code                    TEXT NOT NULL,
  r2_key                  TEXT NOT NULL,
  upload_id               TEXT,
  filename                TEXT NOT NULL,
  size                    INTEGER NOT NULL,
  sha256                  TEXT NOT NULL DEFAULT '',
  password_salt           TEXT,
  password_verifier_hash  TEXT,
  max_downloads           INTEGER,
  downloads               INTEGER NOT NULL DEFAULT 0,
  state                   TEXT NOT NULL, -- uploading | ready | spent | revoked | expired | aborted
  paused                  INTEGER NOT NULL DEFAULT 0,
  created_at              INTEGER NOT NULL,
  expires_at              INTEGER NOT NULL,
  revoked_at              INTEGER,
  last_download_at        INTEGER,
  FOREIGN KEY (owner_device_id) REFERENCES devices (device_id) ON DELETE CASCADE
);

-- Device names are globally unique, so (owner, code) is equivalent to the
-- public (name, code) pair without storing a second, stale copy of the name.
CREATE UNIQUE INDEX idx_shares_code ON shares (owner_device_id, code);
CREATE INDEX idx_shares_owner ON shares (owner_device_id, created_at);
CREATE INDEX idx_shares_sweep ON shares (state, expires_at);

-- Mirrors file_parts: recorded etags make an interrupted Mac upload resumable.
CREATE TABLE share_parts (
  share_id     TEXT NOT NULL,
  part_number  INTEGER NOT NULL,
  etag         TEXT NOT NULL,
  size         INTEGER NOT NULL,
  PRIMARY KEY (share_id, part_number),
  FOREIGN KEY (share_id) REFERENCES shares (share_id) ON DELETE CASCADE
);
