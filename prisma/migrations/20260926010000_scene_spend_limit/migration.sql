-- Hierarchical spend limits (V1.2 Phase 2, QĐ-108).
--
-- A scene may carry its own spend cap (storyboard scene `max_cost`). Null means
-- inherit: the Settings default for a VIDEO_AI scene, otherwise no scene cap.
-- The per-video cap already lives in Project.maxBudget.
--
-- Additive and nullable: every existing scene keeps "no scene cap".
--
-- AddColumn
ALTER TABLE "Scene" ADD COLUMN "maxCost" REAL;
