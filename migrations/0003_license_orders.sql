-- What a refund has to be able to find (PRD 16.5).
--
-- 0002 stores only the SHA-256 of the licence key, and lib/entitlement.ts
-- explains why that is worth keeping. The cost of it surfaces here: Creem's
-- `refund.created` and `dispute.created` payloads carry a refund, a
-- transaction, a checkout, an order and a customer -- and no licence key. There
-- is nothing in a refund event that the licences table can be looked up by, and
-- no way to derive one, because the key is unrecoverable by design.
--
-- So the join has to be recorded at purchase, when `checkout.completed` does
-- carry both the key and the order it was sold under. These three columns are
-- that record and nothing else: they are written by the checkout webhook and
-- read by the refund webhook.
--
-- creem_customer_id is stored for support ("which orders does this person
-- have?") and is deliberately NOT a revocation key. One customer can hold
-- several licences; refunding one of them must not revoke the rest.
ALTER TABLE licenses ADD COLUMN creem_order_id TEXT;
ALTER TABLE licenses ADD COLUMN creem_checkout_id TEXT;
ALTER TABLE licenses ADD COLUMN creem_customer_id TEXT;

-- Both are lookup paths on the refund route, one per event shape. Not unique:
-- a re-delivered webhook writes the same pair back, and a NULL from a row that
-- predates this migration must not collide with the next one.
CREATE INDEX idx_licenses_order ON licenses (creem_order_id);
CREATE INDEX idx_licenses_checkout ON licenses (creem_checkout_id);

-- Rows written before this migration have all three NULL, and a refund against
-- one of them still cannot be matched. It is recorded as an unmatched
-- revocation rather than passing silently. There are no such rows in production
-- today; if a live purchase ever precedes this migration, its mapping has to be
-- back-filled from Creem's order list by hand.
