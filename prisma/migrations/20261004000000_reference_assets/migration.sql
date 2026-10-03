-- Universal Reference Asset System (QĐ-124). Additive only: one new table and
-- nullable / defaulted columns. No existing row, asset, ledger line or spend
-- figure changes; every existing scene gets "[]" (no new references).
CREATE TABLE "ReferenceAsset" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT,
    "referenceType" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "assetId" TEXT,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "priority" TEXT NOT NULL DEFAULT 'IMPORTANT',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "useThroughout" BOOLEAN NOT NULL DEFAULT false,
    "characterId" TEXT,
    "tagsJson" TEXT NOT NULL DEFAULT '[]',
    "notes" TEXT NOT NULL DEFAULT '',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
CREATE INDEX "ReferenceAsset_projectId_referenceType_idx" ON "ReferenceAsset"("projectId", "referenceType");

ALTER TABLE "Asset" ADD COLUMN "referenceAssetId" TEXT;
CREATE INDEX "Asset_referenceAssetId_idx" ON "Asset"("referenceAssetId");

ALTER TABLE "Scene" ADD COLUMN "referenceIdsJson" TEXT NOT NULL DEFAULT '[]';
ALTER TABLE "Scene" ADD COLUMN "referenceOverride" TEXT;
