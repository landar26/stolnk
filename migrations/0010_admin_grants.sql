-- Pro handed out by hand, from the operator console.
--
-- A third source of entitlement beside the two that involve money — a Creem
-- licence and an App Store purchase — and deliberately its own table rather
-- than a synthetic row in `licenses`. Two reasons, and the second is the one
-- that matters: a fake licence row would have to carry a fake `key_hash`, which
-- an activation could then collide with; and "how many licences did we sell"
-- is a question the operator will ask of that table, so anything in it that was
-- never bought makes the answer wrong.
--
-- Shaped like the other two so `tierFor` can read it the same way: one row per
-- device, keyed on the device, carrying a status rather than being deleted. A
-- revoked grant keeps its row so the console can still show that it happened
-- and why — which is the whole reason `note` is NOT NULL.
--
-- There is no separate audit ledger. Every grant and revoke emits an
-- `admin.grant` line (lib/metrics.ts) into Workers observability, which is
-- append-only, timestamped and already where this codebase keeps the record of
-- money moving. A second D1 table would be a worse copy of it.
CREATE TABLE admin_grants (
  device_id   TEXT PRIMARY KEY,
  status      TEXT NOT NULL, -- active | revoked
  -- Why, in the operator's own words. Required because the one question asked
  -- of this table six months later is "why does this device have Pro", and an
  -- empty string is not an answer.
  note        TEXT NOT NULL,
  granted_at  INTEGER NOT NULL,
  revoked_at  INTEGER,
  FOREIGN KEY (device_id) REFERENCES devices (device_id) ON DELETE CASCADE
);
