-- V1.2 Phase 5 (QĐ-113): asset library, legacy backfill, render recipe.
-- Additive only: new nullable/defaulted columns. No row, ledger line or spend
-- figure is changed by this migration.
ALTER TABLE "Asset" ADD COLUMN "legacyState" TEXT;
ALTER TABLE "Asset" ADD COLUMN "inputsJson" TEXT NOT NULL DEFAULT '{}';
ALTER TABLE "Project" ADD COLUMN "renderRecipe" TEXT;
