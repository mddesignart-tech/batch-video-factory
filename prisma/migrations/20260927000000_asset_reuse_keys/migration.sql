-- V1.2 Phase 4 (QĐ-112): asset reuse keys. Additive only: new nullable/defaulted
-- columns and indexes. No existing row, ledger line or spend figure changes.
ALTER TABLE "Asset" ADD COLUMN "reuseKey" TEXT;
ALTER TABLE "Asset" ADD COLUMN "reusedFromAssetId" TEXT;
ALTER TABLE "Asset" ADD COLUMN "durationSec" REAL;
ALTER TABLE "Asset" ADD COLUMN "validity" TEXT NOT NULL DEFAULT 'VALID';
ALTER TABLE "Asset" ADD COLUMN "validatedAt" DATETIME;
CREATE INDEX "Asset_reuseKey_idx" ON "Asset"("reuseKey");
CREATE INDEX "Asset_sha256_idx" ON "Asset"("sha256");
ALTER TABLE "ProviderJob" ADD COLUMN "reuseKey" TEXT;
CREATE INDEX "ProviderJob_reuseKey_idx" ON "ProviderJob"("reuseKey");
