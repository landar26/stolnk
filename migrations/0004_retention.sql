-- Retention (index.ts `forgetOldRecords`).
--
-- The sweep looks for terminal transfers older than the retention window, every
-- 30 minutes, forever. Neither existing index helps: idx_transfers_inbox is
-- keyed by inbox and idx_transfers_expiry by expires_at, and this filter is
-- state plus created_at. Without this it is a full scan of the one table that
-- grows with every file anyone has ever sent.
--
-- state first because it is the selective half — after the sweep has caught up,
-- almost every row in the table matches it and the range on created_at is what
-- narrows the result.
CREATE INDEX idx_transfers_retention ON transfers (state, created_at);

-- Same sweep, second statement: trusted_senders has no index at all beyond its
-- (inbox_id, sender_session) primary key, and the retention pass filters on
-- created_at.
CREATE INDEX idx_trusted_senders_created ON trusted_senders (created_at);
