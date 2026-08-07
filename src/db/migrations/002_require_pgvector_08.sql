-- 002_require_pgvector_08.sql — make the extension version a boot-time contract.
--
-- `searchSemantic` sets `hnsw.iterative_scan`, which pgvector only understands from
-- 0.8 (DD-046). Below that the GUC is an unrecognized parameter, which aborts the
-- transaction and turns *every* semantic recall into an opaque DB_QUERY_FAILED —
-- recall silently loses its semantic arm and keeps answering from lexical alone.
--
-- Pinning the image is not enough. `create extension if not exists` in 001 never
-- upgrades an extension that is already installed, so a volume created under an
-- older image keeps its old version no matter which image mounts it next. This
-- migration upgrades it, and refuses to boot if the result is still too old —
-- a server that cannot start is far cheaper to diagnose than a search that
-- quietly stopped working.

alter extension vector update;

do $$
declare
  installed text;
begin
  select extversion into installed from pg_extension where extname = 'vector';
  if string_to_array(installed, '.')::int[] < array[0, 8] then
    raise exception
      'pgvector % is too old: hnsw.iterative_scan needs 0.8 (DD-046). '
      'Run this against an image carrying 0.8 or newer.', installed;
  end if;
end $$;
