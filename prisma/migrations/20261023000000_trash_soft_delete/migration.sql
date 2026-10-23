-- QĐ-152 TRASH (soft delete). Additive only: NULL on every existing row = not
-- deleted = exactly the behaviour before. Nothing is removed or rewritten.
ALTER TABLE "Project" ADD COLUMN "deletedAt" DATETIME;
ALTER TABLE "Scene" ADD COLUMN "deletedAt" DATETIME;
-- Where a deleted scene stood (1-based) when it went to the trash, for restore.
ALTER TABLE "Scene" ADD COLUMN "deletedFromNumber" INTEGER;
-- Whether the scene was already "skipped" before it was deleted (restore keeps that).
ALTER TABLE "Scene" ADD COLUMN "deletedWasSkipped" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Asset" ADD COLUMN "deletedAt" DATETIME;
CREATE INDEX "Project_deletedAt_idx" ON "Project"("deletedAt");
CREATE INDEX "Scene_deletedAt_idx" ON "Scene"("deletedAt");
CREATE INDEX "Asset_deletedAt_idx" ON "Asset"("deletedAt");
