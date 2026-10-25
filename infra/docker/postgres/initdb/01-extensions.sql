-- Required extensions (AGENTS.md §2). Runs once, on a fresh data directory, as the superuser.
-- Also used by the test harness (packages/db/testing) so tests and production match.
-- Installed in template1 too, so databases created later (training DB, test DBs) inherit them.

CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS unaccent;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

\connect template1

CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS unaccent;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
