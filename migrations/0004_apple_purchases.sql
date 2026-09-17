-- App Store non-consumable purchases for the iOS app.
--
-- Apple owns the purchase, while Stolnk owns the service entitlement. A restored
-- purchase may legitimately appear on more than one iPhone, so the purchase and
-- its attached devices are separate rows. The transaction id is not a bearer
-- secret; it is always revalidated against the App Store Server API before a row
-- is created or changed.
CREATE TABLE apple_purchases (
  original_transaction_id TEXT PRIMARY KEY,
  transaction_id          TEXT NOT NULL,
  product_id              TEXT NOT NULL,
  environment             TEXT NOT NULL,
  status                  TEXT NOT NULL, -- active | refunded
  purchased_at            INTEGER NOT NULL,
  revocation_date         INTEGER,
  last_verified_at        INTEGER NOT NULL
);

CREATE TABLE apple_purchase_devices (
  device_id               TEXT PRIMARY KEY,
  original_transaction_id TEXT NOT NULL,
  activated_at            INTEGER NOT NULL,
  FOREIGN KEY (device_id) REFERENCES devices (device_id) ON DELETE CASCADE,
  FOREIGN KEY (original_transaction_id)
    REFERENCES apple_purchases (original_transaction_id) ON DELETE CASCADE
);

CREATE INDEX idx_apple_purchase_devices_transaction
  ON apple_purchase_devices (original_transaction_id);
