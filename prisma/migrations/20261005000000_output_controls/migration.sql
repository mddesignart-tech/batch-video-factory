-- QĐ-125 VIDEO OUTPUT controls. Additive only: one nullable column. NULL = the
-- defaults; no row, asset, ledger line or spend figure changes.
ALTER TABLE "Project" ADD COLUMN "outputControlsJson" TEXT;
