-- The "tell me when Windows ships" list (landing hero and /download).
--
-- Its own table, joined to nothing. An address given in exchange for one future
-- announcement is not a customer record and must not quietly become one: there
-- is no device id here, no licence, no order, and nothing that would let a row
-- be tied to anything else we hold. What can be answered from this table is
-- "how many people want Windows", and that is the whole of it.
--
-- The email is the primary key rather than a surrogate id, so a second
-- submission of the same address collides instead of writing a duplicate. That
-- is what lets the endpoint answer identically whether or not an address was
-- already on the list — otherwise the form doubles as a way to test whether a
-- given person signed up.
--
-- `platform` is here even though Windows is the only value the site offers,
-- because the alternative is a schema migration the first time someone asks for
-- Linux, and `locale` because the site is bilingual and the announcement has to
-- be written in a language the reader actually wanted.
CREATE TABLE waitlist (
	email      TEXT PRIMARY KEY,
	platform   TEXT NOT NULL,
	locale     TEXT,
	created_at INTEGER NOT NULL
);
