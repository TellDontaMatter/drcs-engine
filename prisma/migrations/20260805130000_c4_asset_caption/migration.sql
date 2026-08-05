-- C4 (Caption-First Resolution): add per-asset caption to the Asset Registry.
-- SQLite (dev/test) supports ADD COLUMN for a nullable column without a rewrite;
-- the identical statement applies under PostgreSQL in production.
ALTER TABLE "AssetRegistry" ADD COLUMN "caption" TEXT;
