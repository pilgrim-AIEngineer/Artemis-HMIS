-- FND-07: trigram search support for master data.
-- pg_trgm is installed by the init script (superuser); this only asserts it for dev databases
-- that were created without it and fails loudly if the migration user may not create it.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint

-- Search text for generated `search_text` columns: lower-cased, punctuation folded to spaces,
-- Latin and Devanagari kept. Mirrors `searchQueryText` in @hmis/shared (masters.ts). IMMUTABLE
-- is required for generated columns and is true: no catalogue lookups, only text functions.
CREATE OR REPLACE FUNCTION public.hmis_search_text(a text, b text, c text, d text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path = pg_catalog
AS $$
  SELECT btrim(regexp_replace(
    lower(coalesce(a, '') || ' ' || coalesce(b, '') || ' ' || coalesce(c, '') || ' ' || coalesce(d, '')),
    '[^[:alnum:]ऀ-ॿ]+', ' ', 'g'))
$$;
