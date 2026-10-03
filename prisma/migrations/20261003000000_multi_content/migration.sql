-- Multi-Content Video Engine. Additive only: nullable / defaulted columns.
-- No row, asset, ledger line or spend figure is changed. A project with a NULL
-- contentType is read as ENGLISH_IDIOM; every existing Idiom row gets the
-- ENGLISH_IDIOM collection by default.
ALTER TABLE "Idiom" ADD COLUMN "contentType" TEXT NOT NULL DEFAULT 'ENGLISH_IDIOM';
CREATE INDEX "Idiom_contentType_idx" ON "Idiom"("contentType");

ALTER TABLE "Project" ADD COLUMN "contentType" TEXT;
ALTER TABLE "Project" ADD COLUMN "contentTemplateId" TEXT;
ALTER TABLE "Project" ADD COLUMN "templateVersion" TEXT;
ALTER TABLE "Project" ADD COLUMN "contentSourceType" TEXT;
ALTER TABLE "Project" ADD COLUMN "sourceText" TEXT;
ALTER TABLE "Project" ADD COLUMN "sourceUrl" TEXT;
ALTER TABLE "Project" ADD COLUMN "audience" TEXT;
ALTER TABLE "Project" ADD COLUMN "tone" TEXT;
ALTER TABLE "Project" ADD COLUMN "voiceMode" TEXT;
ALTER TABLE "Project" ADD COLUMN "bilingualMode" TEXT;
ALTER TABLE "Project" ADD COLUMN "contentBriefJson" TEXT;
ALTER TABLE "Project" ADD COLUMN "backgroundMusicAssetId" TEXT;
ALTER TABLE "Project" ADD COLUMN "scriptApprovedAt" DATETIME;

ALTER TABLE "ModelRegistry" ADD COLUMN "capabilityProfileJson" TEXT;
