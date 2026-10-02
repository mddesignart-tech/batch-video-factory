-- QĐ-121: per-project output profile (platform / frame size / fps / fit / subtitle position).
-- Additive only: one nullable column. No row, asset, ledger line or spend figure is
-- changed; a NULL profile is inferred from the existing aspectRatio.
ALTER TABLE "Project" ADD COLUMN "outputProfileJson" TEXT;
