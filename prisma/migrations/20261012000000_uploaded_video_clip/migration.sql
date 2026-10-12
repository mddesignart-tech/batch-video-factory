-- UPLOADED VIDEO CLIP INPUT. Additive only: every column has a default or is
-- nullable. videoSource = 'GENERATED' on every existing scene = V1 behaviour.
ALTER TABLE "Scene" ADD COLUMN "videoSource" TEXT NOT NULL DEFAULT 'GENERATED';
ALTER TABLE "Scene" ADD COLUMN "videoAssetId" TEXT;
ALTER TABLE "Scene" ADD COLUMN "clipStartSec" REAL;
ALTER TABLE "Scene" ADD COLUMN "clipEndSec" REAL;
ALTER TABLE "Scene" ADD COLUMN "clipAudio" TEXT NOT NULL DEFAULT 'OFF';
ALTER TABLE "Scene" ADD COLUMN "clipAudioGain" REAL NOT NULL DEFAULT 0.5;
ALTER TABLE "Scene" ADD COLUMN "clipShortMode" TEXT NOT NULL DEFAULT 'AUTO';
ALTER TABLE "Scene" ADD COLUMN "clipFrame" TEXT NOT NULL DEFAULT 'AUTO';
ALTER TABLE "Asset" ADD COLUMN "mediaInfoJson" TEXT NOT NULL DEFAULT '{}';
