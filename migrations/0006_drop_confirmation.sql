-- The first-receive confirmation prompt is gone (it was PRD 13.2). Files now
-- land on the Mac without anyone being asked, so nothing computes
-- `needs_confirmation` any more and nothing remembers an "always accept from
-- this link" decision.
--
-- Dropped rather than left in place and ignored: a column the code no longer
-- reads is a claim about behaviour that is no longer true, and the next person
-- to read the schema would believe it.
--
-- `transfers.sender_session` deliberately survives. It exists only to key this
-- table, so it is now vestigial -- but it is NOT NULL, dropping it means
-- rebuilding the one table that grows with every file anyone has ever sent, and
-- the row is filled with a random id either way.
--
-- `'declined'` also survives as a value of `files.state` / `transfers.state`.
-- Nothing writes it any more, but rows written before this migration still
-- carry it, and the retention sweep has to keep matching them or they are never
-- collected.
DROP INDEX IF EXISTS idx_trusted_senders_created;
DROP TABLE IF EXISTS trusted_senders;
ALTER TABLE inboxes DROP COLUMN confirm_first;
