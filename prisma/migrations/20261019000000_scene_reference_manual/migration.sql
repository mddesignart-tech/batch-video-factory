-- QĐ-140 MANUAL REFERENCE DECISIONS. Additive only: '{}' on every existing
-- scene = no hand-made decision recorded = the behaviour before.
ALTER TABLE "Scene" ADD COLUMN "referenceManualJson" TEXT NOT NULL DEFAULT '{}';
