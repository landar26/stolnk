-- Stolnk licensing and monthly relay accounting (PRD 16).
--
-- V1 shipped with `tierForDevice()` returning PRO unconditionally, so every
-- paywall in the code was inert and `monthlyRelayBytes` -- the one number the
-- whole purchase argument rests on -- was never read. These three tables are
-- what make the price list in PRD 16.1 real.

-- One licence == one purchase. Only the hash of the key is stored: a leaked
-- database is not a pile of working licence keys.
--
-- The key itself is issued by Creem, which is also the authority on seat
-- counts. What lives here is a cache of that authority, refreshed on activation
-- and by webhook, so that tier resolution on the request path is a single local
-- read and never a call to a third party (PRD 8.6: bounded marginal cost, and
-- an outage at Creem must not downgrade a paying user).
--
-- revalidated_at is when Creem last confirmed this row. Storing only the hash
-- means there is no way to re-ask Creem later -- see lib/entitlement.ts -- so
-- this column exists to make stale rows findable, not to drive a sweep.
CREATE TABLE licenses (
  key_hash         TEXT PRIMARY KEY,   -- SHA-256 of the licence key, hex
  creem_license_id TEXT,
  status           TEXT NOT NULL,      -- active | refunded | disabled
  -- 16.4 -- the paid-upgrade path at V2 has to be able to tell V1 licences
  -- apart from V2 ones. Recorded now because it cannot be recovered later.
  major_version    INTEGER NOT NULL DEFAULT 1,
  seats            INTEGER NOT NULL DEFAULT 3,
  purchased_at     INTEGER NOT NULL,
  revalidated_at   INTEGER NOT NULL
);

-- A seat. device_id is the primary key, not part of a composite: one Mac is
-- covered by exactly one licence, which is what makes tier resolution a single
-- lookup keyed by the thing every request already knows.
--
-- instance_id is Creem's handle for this activation and the only way to release
-- the seat later. 7.2 makes that release matter more than it looks: the device
-- key cannot leave the Secure Enclave, so a dead Mac can never authenticate to
-- give its own seat back -- releasing it has to be possible for whoever holds
-- the key, from any machine.
CREATE TABLE license_devices (
  device_id    TEXT PRIMARY KEY,
  key_hash     TEXT NOT NULL,
  instance_id  TEXT NOT NULL,
  activated_at INTEGER NOT NULL,
  FOREIGN KEY (device_id) REFERENCES devices (device_id) ON DELETE CASCADE,
  FOREIGN KEY (key_hash) REFERENCES licenses (key_hash) ON DELETE CASCADE
);
CREATE INDEX idx_license_devices_key ON license_devices (key_hash);

-- 16.1 -- the relay allowance is per person, so this is keyed by device where
-- usage_daily is keyed by inbox. They are not the same ceiling and neither
-- subsumes the other: the daily one is abuse control on a single link, this one
-- is the paid boundary.
--
-- Bytes are booked when a transfer is created and returned when it is aborted
-- or expires, so parking bytes that never reach the Mac cannot silently consume
-- someone's month. There is no reset job -- the month is derived from the
-- timestamp, and stale rows fall to the existing sweep.
CREATE TABLE usage_monthly (
  device_id   TEXT NOT NULL,
  month       TEXT NOT NULL,          -- UTC 'YYYY-MM'
  relay_bytes INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (device_id, month)
);
