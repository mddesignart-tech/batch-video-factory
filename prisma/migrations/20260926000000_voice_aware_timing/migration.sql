-- Voice-aware scene timing (V1.2 Phase 1, QĐ-107).
--
-- `Scene.duration` keeps meaning what was PLANNED. The new columns record the
-- person's timing instruction (mode + optional bounds) and what the last render
-- decided (measured speech, final length, reason code).
--
-- Additive and defaulted/nullable: every existing scene becomes AUTO with no
-- bounds and no recorded render timing. Nothing is re-rendered by this.
--
-- AddColumn
ALTER TABLE "Scene" ADD COLUMN "durationMode" TEXT NOT NULL DEFAULT 'AUTO';
ALTER TABLE "Scene" ADD COLUMN "minDuration" REAL;
ALTER TABLE "Scene" ADD COLUMN "maxDuration" REAL;
ALTER TABLE "Scene" ADD COLUMN "voiceDurationActual" REAL;
ALTER TABLE "Scene" ADD COLUMN "finalDuration" REAL;
ALTER TABLE "Scene" ADD COLUMN "timingReason" TEXT;
