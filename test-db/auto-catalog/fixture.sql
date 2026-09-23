-- Auto mode real-catalog fixture (PostgreSQL). Synthetic data only, never anything real.
-- Apply by hand to the gatekeeper_test database from `pnpm db:up`, never to a real database.
-- It adds one dedicated schema plus extension-like objects on their own type in public, the
-- way pgvector, PostGIS or hstore install operators and casts the proposals never touch.
SET client_min_messages = warning;
BEGIN;
-- Refuses any database other than the synthetic one; the error aborts this transaction.
DO $$ BEGIN
  IF pg_catalog.current_database() <> 'gatekeeper_test' THEN
    RAISE EXCEPTION 'test-db/auto-catalog only applies to the synthetic gatekeeper_test database';
  END IF;
END $$;

CREATE SCHEMA payment_orchestrator;
CREATE TYPE payment_orchestrator.intent_status AS ENUM ('REQUIRES_ACTION', 'AUTHORIZED', 'CAPTURED', 'FAILED');
CREATE TYPE payment_orchestrator.attempt_status AS ENUM ('PENDING', 'AUTHORIZED', 'CAPTURED', 'FAILED');
CREATE TYPE payment_orchestrator.method_kind AS ENUM ('CARD', 'SEPA_DEBIT', 'WALLET');

CREATE TABLE payment_orchestrator.payment_intent (
  id          TEXT PRIMARY KEY,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  metadata    JSONB NOT NULL DEFAULT '{}',
  status      payment_orchestrator.intent_status NOT NULL
);
CREATE TABLE payment_orchestrator.payment_attempt (
  id                    TEXT PRIMARY KEY,
  payment_intent_id     TEXT NOT NULL REFERENCES payment_orchestrator.payment_intent (id),
  payment_method_kind   payment_orchestrator.method_kind NOT NULL,
  status                payment_orchestrator.attempt_status NOT NULL,
  captured_amount_cents BIGINT NOT NULL DEFAULT 0
);

INSERT INTO payment_orchestrator.payment_intent VALUES
  ('pi_synthetic_1', '2026-01-02 10:00:00', '{"orderRef": "ORD-0001"}', 'AUTHORIZED'),
  ('pi_synthetic_2', '2026-01-03 11:00:00', '{"orderRef": "ORD-0002"}', 'AUTHORIZED'),
  ('pi_synthetic_3', '2026-01-04 12:00:00', '{"orderRef": "ORD-0003"}', 'FAILED');
INSERT INTO payment_orchestrator.payment_attempt VALUES
  ('pa_synthetic_1', 'pi_synthetic_1', 'CARD', 'CAPTURED', 1250),
  ('pa_synthetic_2', 'pi_synthetic_1', 'WALLET', 'FAILED', 0),
  ('pa_synthetic_3', 'pi_synthetic_2', 'SEPA_DEBIT', 'PENDING', 0),
  ('pa_synthetic_4', 'pi_synthetic_3', 'CARD', 'FAILED', 0);

-- Extension-like objects: visible on the default search path, on a type nothing here uses.
CREATE TYPE public.gk_vector AS (x FLOAT8, y FLOAT8);
CREATE FUNCTION public.gk_vector_eq(public.gk_vector, public.gk_vector) RETURNS BOOLEAN
  LANGUAGE sql IMMUTABLE AS 'SELECT $1.x = $2.x AND $1.y = $2.y';
CREATE FUNCTION public.gk_vector_lt(public.gk_vector, public.gk_vector) RETURNS BOOLEAN
  LANGUAGE sql IMMUTABLE AS 'SELECT $1.x < $2.x';
CREATE FUNCTION public.gk_vector_cat(public.gk_vector, public.gk_vector) RETURNS public.gk_vector
  LANGUAGE sql IMMUTABLE AS 'SELECT ROW($1.x + $2.x, $1.y + $2.y)::public.gk_vector';
CREATE FUNCTION public.gk_vector_in(TEXT) RETURNS public.gk_vector
  LANGUAGE sql IMMUTABLE AS 'SELECT ROW(0, 0)::public.gk_vector';
CREATE FUNCTION public.gk_vector_count(BIGINT, public.gk_vector) RETURNS BIGINT
  LANGUAGE sql IMMUTABLE AS 'SELECT $1 + 1';
CREATE OPERATOR public.= (LEFTARG = public.gk_vector, RIGHTARG = public.gk_vector, FUNCTION = public.gk_vector_eq);
CREATE OPERATOR public.< (LEFTARG = public.gk_vector, RIGHTARG = public.gk_vector, FUNCTION = public.gk_vector_lt);
CREATE OPERATOR public.|| (LEFTARG = public.gk_vector, RIGHTARG = public.gk_vector, FUNCTION = public.gk_vector_cat);
CREATE CAST (TEXT AS public.gk_vector) WITH FUNCTION public.gk_vector_in(TEXT) AS IMPLICIT;
CREATE AGGREGATE public.count(public.gk_vector) (SFUNC = public.gk_vector_count, STYPE = BIGINT, INITCOND = '0');

COMMIT;
