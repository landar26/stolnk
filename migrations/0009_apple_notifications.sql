-- Delivery receipts for App Store Server Notifications V2.
--
-- This table exists for one reason: a notification we did not answer 2xx for is
-- redelivered by Apple across a three-day window, and a refund applied twice
-- must cost nothing. Everything downstream of it is already idempotent — the
-- state written is absolute, re-queried from Apple, never incremental — so this
-- is a cost and noise guard rather than a correctness one. It is also the only
-- durable trace that a notification arrived at all: the payload itself is
-- unverified and deliberately not kept.
--
-- `process_status` is load-bearing, not bookkeeping. A dedupe that bailed on
-- the mere existence of a row would swallow Apple's retries of the very
-- notifications we failed to process — the retry would find the 'pending' or
-- 'error' row, call it a duplicate, answer 200, and the refund would be lost
-- precisely in the case the retry exists to rescue. Only 'ok' is a reason to
-- stop.
--
-- `payload_sha256` is the whole signedPayload, hashed. Stored instead of the
-- payload so that "was this the same notification, or a different one under a
-- reused uuid" stays answerable without keeping an unverified blob that a later
-- reader would be tempted to trust.
CREATE TABLE apple_notifications (
  notification_uuid       TEXT PRIMARY KEY,
  notification_type       TEXT NOT NULL,
  subtype                 TEXT,
  -- Taken from the unverified payload, for reconciliation only. Never read back
  -- as state; the row in apple_purchases is the account of record.
  original_transaction_id TEXT,
  payload_sha256          TEXT NOT NULL,
  received_at             INTEGER NOT NULL,
  processed_at            INTEGER,
  process_status          TEXT NOT NULL, -- pending | ok | error
  last_error              TEXT
);

-- The operational question this table gets asked: what failed, and when.
CREATE INDEX idx_apple_notifications_unfinished
  ON apple_notifications (process_status, received_at);
