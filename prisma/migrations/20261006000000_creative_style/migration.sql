-- QĐ-127 CREATIVE STYLE ENGINE. Additive only: one nullable column. NULL = the
-- content template's creative defaults; no script, scene, asset or ledger row changes.
ALTER TABLE "Project" ADD COLUMN "creativeStyleJson" TEXT;
