-- Auto mode real-catalog negative variants. Apply after fixture.sql to the synthetic
-- gatekeeper_test database only, capture the catalog rows again, then run cleanup.sql.
-- Each object below must make the matching acceptance query stay manual.
SET client_min_messages = warning;
BEGIN;
-- Refuses any database other than the synthetic one; the error aborts this transaction.
DO $$ BEGIN
  IF pg_catalog.current_database() <> 'gatekeeper_test' THEN
    RAISE EXCEPTION 'test-db/auto-catalog only applies to the synthetic gatekeeper_test database';
  END IF;
END $$;

-- The attempts query concatenates text: a user array_agg(text) is an exact match and wins.
CREATE AGGREGATE public.array_agg(TEXT) (SFUNC = pg_catalog.array_append, STYPE = TEXT[]);

-- The status count reads a table protected by row level security, a hidden dependency.
ALTER TABLE payment_orchestrator.payment_intent ENABLE ROW LEVEL SECURITY;

COMMIT;
