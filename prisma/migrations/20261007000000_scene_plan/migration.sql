-- QĐ-128 SCENE MOTION / MULTI-LAYER / CAMERA DIRECTOR. Additive only: one nullable
-- column. NULL = a scene from before: it renders exactly as before (one picture, slow push-in).
ALTER TABLE "Scene" ADD COLUMN "scenePlanJson" TEXT;
