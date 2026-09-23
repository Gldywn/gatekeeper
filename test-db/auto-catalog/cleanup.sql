-- Removes everything fixture.sql and negative.sql created. Synthetic test database only.
SET client_min_messages = warning;
BEGIN;
-- Refuses any database other than the synthetic one; the error aborts this transaction.
DO $$ BEGIN
  IF pg_catalog.current_database() <> 'gatekeeper_test' THEN
    RAISE EXCEPTION 'test-db/auto-catalog only applies to the synthetic gatekeeper_test database';
  END IF;
END $$;
DROP AGGREGATE IF EXISTS public.array_agg(TEXT);
DROP SCHEMA IF EXISTS payment_orchestrator CASCADE;
-- Everything else depends on gk_vector: its operators, cast, count aggregate and functions.
DROP TYPE IF EXISTS public.gk_vector CASCADE;
COMMIT;
