-- V1.2 Phase 6 (QĐ-114): daily production workflow, output layout, presets.
-- Additive only: new nullable/defaulted columns. No row, ledger line or spend
-- figure is changed by this migration.
ALTER TABLE "Project" ADD COLUMN "outputSlug" TEXT;
ALTER TABLE "Project" ADD COLUMN "outputDir" TEXT;
ALTER TABLE "Project" ADD COLUMN "socialMetaJson" TEXT;
ALTER TABLE "Project" ADD COLUMN "thumbnailChoiceJson" TEXT;
ALTER TABLE "Project" ADD COLUMN "exportReadyJson" TEXT;
ALTER TABLE "Project" ADD COLUMN "runStartedAt" DATETIME;
ALTER TABLE "Project" ADD COLUMN "runFinishedAt" DATETIME;
ALTER TABLE "Project" ADD COLUMN "currentStep" TEXT;
ALTER TABLE "Project" ADD COLUMN "queueOrder" INTEGER;
ALTER TABLE "Batch" ADD COLUMN "slug" TEXT;
ALTER TABLE "Batch" ADD COLUMN "batchMode" TEXT NOT NULL DEFAULT 'PARTIAL';
ALTER TABLE "Batch" ADD COLUMN "outputPresetId" TEXT NOT NULL DEFAULT '';
