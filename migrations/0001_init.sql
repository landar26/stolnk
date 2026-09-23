-- Stolnk schema, regenerated from scratch.
--
-- Timestamps are Unix milliseconds. Every enum-like TEXT column carries a CHECK
-- so a typo in a query fails loudly instead of writing a state nothing matches.
--
-- PRD 7.3 lists four things the server never stores: local paths, plaintext
-- filenames, file contents, and content hashes usable for tracking. The first
-- three hold. The fourth does not: `files.plain_sha256` is the SHA-256 of the
-- decrypted contents, kept because the receiving Mac verifies what it decrypted
-- against it (`StolnkCore/Receiver.swift`). That is disclosed on /privacy, and
-- it stays an open divergence until either the check moves or PRD 7.3 changes.

-- ─── Identity ────────────────────────────────────────────────────────────────

-- 6.1: `name` is a DNS label and the whole identity — a link lives at
-- <name>.stolnk.com. UNIQUE is the one-name-per-device rule itself. Renaming is
-- one UPDATE, and every link moves with it because no inbox stores the name.
--
-- 7.2: the private key lives in the Secure Enclave and cannot be exported, so a
-- lost Mac is a lost name.
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
  device_id   TEXT NOT NULL REFERENCES devices (device_id) ON DELETE CASCADE,
  expires_at  INTEGER NOT NULL
);
CREATE INDEX idx_challenges_expiry ON challenges (expires_at);

-- ─── Inbound: inboxes and transfers ─────────────────────────────────────────

-- 6.2: a link is always <name>.stolnk.com/<path_slug>. Uniqueness per owning
-- device is the same statement as "(name, path) is globally unique" because
-- device names are unique.
CREATE TABLE inboxes (
  inbox_id               TEXT PRIMARY KEY,
  owner_device_id        TEXT NOT NULL REFERENCES devices (device_id) ON DELETE CASCADE,
  path_slug              TEXT NOT NULL,
  display_name           TEXT NOT NULL,
  password_salt          TEXT,
  password_verifier_hash TEXT,
  size_limit             INTEGER NOT NULL,
  paused                 INTEGER NOT NULL DEFAULT 0,
  created_at             INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_inboxes_path ON inboxes (owner_device_id, path_slug);

-- One transfer == one batch of files dropped by one sender.
--
-- `transport` decides relay accounting: a LAN transfer books no monthly relay
-- bytes (PRD 16.2), so abandoning one must not refund any either.
CREATE TABLE transfers (
  transfer_id     TEXT PRIMARY KEY,
  inbox_id        TEXT NOT NULL REFERENCES inboxes (inbox_id) ON DELETE CASCADE,
  state           TEXT NOT NULL
                  CHECK (state IN ('uploading', 'ready', 'delivered', 'expired', 'aborted')),
  transport       TEXT NOT NULL DEFAULT 'relay' CHECK (transport IN ('relay', 'lan')),
  total_bytes     INTEGER NOT NULL DEFAULT 0,
  sender_is_owner INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL,
  expires_at      INTEGER NOT NULL
);
CREATE INDEX idx_transfers_inbox ON transfers (inbox_id);
CREATE INDEX idx_transfers_expiry ON transfers (expires_at);
-- The retention sweep (index.ts `forgetOldRecords`) filters on state + age.
CREATE INDEX idx_transfers_retention ON transfers (state, created_at);

-- enc_name is the AES-GCM ciphertext of the filename: the server cannot read it.
CREATE TABLE files (
  file_id      TEXT PRIMARY KEY,
  transfer_id  TEXT NOT NULL REFERENCES transfers (transfer_id) ON DELETE CASCADE,
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
  plain_sha256 TEXT NOT NULL,         -- see the header comment
  state        TEXT NOT NULL
               CHECK (state IN ('uploading', 'ready', 'delivered', 'expired', 'aborted')),
  created_at   INTEGER NOT NULL,
  delivered_at INTEGER
);
CREATE INDEX idx_files_transfer ON files (transfer_id);
CREATE INDEX idx_files_state ON files (state);

-- Recorded part etags are what make resume work (8.3 #2).
CREATE TABLE file_parts (
  file_id     TEXT NOT NULL REFERENCES files (file_id) ON DELETE CASCADE,
  part_number INTEGER NOT NULL,
  etag        TEXT NOT NULL,
  size        INTEGER NOT NULL,
  PRIMARY KEY (file_id, part_number)
);

-- ─── Outbound: share links ──────────────────────────────────────────────────

-- The deliberate plaintext exception: `filename` is readable here and the object
-- at `r2_key` is readable in R2, because arbitrary browsers must download it
-- without a key. The 80-bit random code is the credential.
--
-- `sha256` is NULL until the upload completes.
CREATE TABLE shares (
  share_id               TEXT PRIMARY KEY,
  owner_device_id        TEXT NOT NULL REFERENCES devices (device_id) ON DELETE CASCADE,
  code                   TEXT NOT NULL,
  r2_key                 TEXT NOT NULL,
  upload_id              TEXT,
  filename               TEXT NOT NULL,
  size                   INTEGER NOT NULL,
  sha256                 TEXT,
  password_salt          TEXT,
  password_verifier_hash TEXT,
  max_downloads          INTEGER,
  downloads              INTEGER NOT NULL DEFAULT 0,
  state                  TEXT NOT NULL
                         CHECK (state IN ('uploading', 'ready', 'spent', 'revoked', 'expired', 'aborted')),
  paused                 INTEGER NOT NULL DEFAULT 0,
  created_at             INTEGER NOT NULL,
  expires_at             INTEGER NOT NULL,
  revoked_at             INTEGER,
  last_download_at       INTEGER
);
CREATE UNIQUE INDEX idx_shares_code ON shares (owner_device_id, code);
CREATE INDEX idx_shares_owner ON shares (owner_device_id, created_at);
CREATE INDEX idx_shares_sweep ON shares (state, expires_at);

CREATE TABLE share_parts (
  share_id    TEXT NOT NULL REFERENCES shares (share_id) ON DELETE CASCADE,
  part_number INTEGER NOT NULL,
  etag        TEXT NOT NULL,
  size        INTEGER NOT NULL,
  PRIMARY KEY (share_id, part_number)
);

-- ─── Usage accounting ───────────────────────────────────────────────────────

-- 13.3: per-inbox daily counters (abuse control on one link), bucketed by UTC
-- day. No foreign key on purpose: the operator's usage chart keeps the history
-- of inboxes that have since been deleted.
CREATE TABLE usage_daily (
  inbox_id TEXT NOT NULL,
  day      TEXT NOT NULL,             -- UTC 'YYYY-MM-DD'
  files    INTEGER NOT NULL DEFAULT 0,
  bytes    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (inbox_id, day)
);

-- 16.1: the per-device monthly relay allowance — the paid boundary. Bytes are
-- booked when a relay transfer opens and returned if it is aborted or expires.
-- No reset job: the month is part of the key.
CREATE TABLE usage_monthly (
  device_id   TEXT NOT NULL REFERENCES devices (device_id) ON DELETE CASCADE,
  month       TEXT NOT NULL,          -- UTC 'YYYY-MM'
  relay_bytes INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (device_id, month)
);

-- ─── Commerce ───────────────────────────────────────────────────────────────
--
-- One model for every way a device can become Pro, whoever took the money:
--
--   purchases          one row per source of entitlement (a Creem licence, an
--                      App Store purchase, a grant from the operator console)
--   purchase_devices   which devices each source covers
--   payment_events     receipts for every provider's webhooks
--
-- A device is Pro exactly when it is bound to at least one `active` purchase.
-- Adding a payment provider is a new `provider` value and a route that writes
-- these tables — never a new table and never a change to how the tier is read.
--
-- Revocation changes `purchases.status`. Bindings to an unlimited purchase stay,
-- so a reversed refund restores Pro without re-linking anything; a seated
-- licence's bindings are dropped, because its seats go back to the pool.
-- Nothing on the request path ever calls a provider (lib/entitlement.ts).

CREATE TABLE purchases (
  purchase_id   TEXT PRIMARY KEY,
  provider      TEXT NOT NULL CHECK (provider IN ('creem', 'apple', 'admin')),
  -- The provider's own identity for this purchase:
  --   creem: SHA-256 of the licence key (the key itself is never stored — a
  --          leaked database must not be a pile of working keys)
  --   apple: original_transaction_id (not a secret; always re-verified with Apple)
  --   admin: the device_id the grant was made to
  external_id   TEXT NOT NULL,
  product_id    TEXT,
  plan          TEXT NOT NULL DEFAULT 'pro' CHECK (plan IN ('pro')),
  -- 16.4: a paid V2 upgrade has to tell V1 purchases apart. Unrecoverable later.
  major_version INTEGER NOT NULL DEFAULT 1,
  status        TEXT NOT NULL CHECK (status IN ('active', 'refunded', 'disabled', 'revoked')),
  -- Device limit. NULL means unlimited (App Store, admin). Non-NULL is a seat
  -- count the provider enforces, and is what makes /licenses/status report a
  -- `license` block with seats to release.
  seats         INTEGER,
  environment   TEXT,                 -- apple: 'Sandbox' | 'Production'
  -- Refund lookup paths. A Creem refund carries no licence key, so the order and
  -- checkout it was sold under are recorded at purchase and matched later.
  order_ref     TEXT,                 -- creem order id | apple latest transaction_id
  checkout_ref  TEXT,                 -- creem checkout id
  -- Support only, deliberately never a revocation key: one customer may hold
  -- several purchases, and refunding one must not revoke the rest.
  customer_ref  TEXT,
  -- Why, in the operator's words. Required for admin grants (enforced in code).
  note          TEXT,
  -- Provider-specific fields nothing queries on (creem licence id, apple
  -- revocation date, ...), as JSON.
  metadata      TEXT NOT NULL DEFAULT '{}',
  purchased_at  INTEGER NOT NULL,
  verified_at   INTEGER NOT NULL,     -- when the provider last confirmed this row
  revoked_at    INTEGER,
  UNIQUE (provider, external_id)
);
CREATE INDEX idx_purchases_order ON purchases (provider, order_ref)
  WHERE order_ref IS NOT NULL;
CREATE INDEX idx_purchases_checkout ON purchases (provider, checkout_ref)
  WHERE checkout_ref IS NOT NULL;

-- A device may hold several sources at once (bought a licence, then was also
-- granted Pro by hand); losing one leaves it Pro if another is still active.
--
-- `instance_ref` is the provider's handle for this activation (Creem instance
-- id) and the only way to release the seat later. 7.2 makes that matter: a dead
-- Mac can never authenticate again, so release must work for whoever holds the
-- key, from any machine.
CREATE TABLE purchase_devices (
  purchase_id  TEXT NOT NULL REFERENCES purchases (purchase_id) ON DELETE CASCADE,
  device_id    TEXT NOT NULL REFERENCES devices (device_id) ON DELETE CASCADE,
  instance_ref TEXT,
  activated_at INTEGER NOT NULL,
  PRIMARY KEY (purchase_id, device_id)
);
CREATE INDEX idx_purchase_devices_device ON purchase_devices (device_id);

-- Webhook receipts, for every provider. Providers redeliver anything that did
-- not get a 2xx, so this is the dedupe — and the only durable trace that a
-- notification arrived at all. The payload is not kept, only its hash.
--
-- `status` is load-bearing: only 'ok' is a reason to skip a redelivery. A
-- dedupe that bailed on the mere existence of a row would swallow the retry of
-- the very notification that failed, and the refund would be lost precisely in
-- the case the retry exists for.
CREATE TABLE payment_events (
  provider       TEXT NOT NULL CHECK (provider IN ('creem', 'apple')),
  event_id       TEXT NOT NULL,       -- apple notificationUUID | creem event id
  event_type     TEXT NOT NULL,
  subtype        TEXT,
  -- From the unverified payload, for reconciliation only. Never read back as
  -- state; `purchases` is the account of record.
  external_ref   TEXT,
  payload_sha256 TEXT NOT NULL,
  status         TEXT NOT NULL CHECK (status IN ('pending', 'ok', 'error')),
  outcome        TEXT,
  last_error     TEXT,
  received_at    INTEGER NOT NULL,
  processed_at   INTEGER,
  PRIMARY KEY (provider, event_id)
);
-- What the operator asks of this table: what failed, and when.
CREATE INDEX idx_payment_events_unfinished ON payment_events (status, received_at);

-- ─── Marketing ──────────────────────────────────────────────────────────────

-- "Tell me when Windows ships". Joined to nothing, on purpose: an address given
-- for one announcement is not a customer record. Email as the key makes a second
-- submission collide, so the endpoint answers identically either way and cannot
-- be used to test whether someone signed up.
CREATE TABLE waitlist (
  email      TEXT PRIMARY KEY,
  platform   TEXT NOT NULL,
  locale     TEXT,
  created_at INTEGER NOT NULL
);
