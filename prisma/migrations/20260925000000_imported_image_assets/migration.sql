-- Imported storyboard images as first-class assets.
--
-- A person can now supply every keyframe from outside (GPT, Gemini, Ideogram,
-- Photoshop). The stored file becomes an Asset with source IMPORTED and the
-- facts needed to trust it later: original name, sniffed mime type, pixel size
-- and a content hash. The scene points at the asset it is using.
--
-- Additive and nullable/defaulted: every existing row keeps its meaning - an
-- existing asset was GENERATED, and an existing scene has no imported asset.
--
-- AddColumn
ALTER TABLE "Asset" ADD COLUMN "source" TEXT NOT NULL DEFAULT 'GENERATED';
ALTER TABLE "Asset" ADD COLUMN "originalFilename" TEXT;
ALTER TABLE "Asset" ADD COLUMN "mimeType" TEXT;
ALTER TABLE "Asset" ADD COLUMN "width" INTEGER;
ALTER TABLE "Asset" ADD COLUMN "height" INTEGER;
ALTER TABLE "Asset" ADD COLUMN "sha256" TEXT;
ALTER TABLE "Scene" ADD COLUMN "imageAssetId" TEXT;
