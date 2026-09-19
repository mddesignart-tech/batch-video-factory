-- The Character Bible: give the lock clause values to lock.
--
-- `LOCKED_ATTRIBUTES` has told every image prompt that "apparent age" and "skin
-- tone" must not change since the character system was written, and the
-- `Character` row had no column for either. A lock on an unstated value locks
-- whatever the model improvised on the first frame, which is a different answer
-- per project and the reason a name like "Max" was never enough on its own.
--
-- All five are additive with empty defaults, so every existing character keeps
-- the exact canonical description it had - including the byte-for-byte string
-- that is hashed into the master-image idempotency key. An empty field is
-- skipped by `buildCanonicalDescription`, so no existing hash moves and no
-- image is re-bought. See QĐ-070.
--
-- AddColumn
ALTER TABLE "Character" ADD COLUMN "presentation" TEXT NOT NULL DEFAULT '';
ALTER TABLE "Character" ADD COLUMN "approximateAge" TEXT NOT NULL DEFAULT '';
ALTER TABLE "Character" ADD COLUMN "skinTone" TEXT NOT NULL DEFAULT '';
ALTER TABLE "Character" ADD COLUMN "distinguishingFeatures" TEXT NOT NULL DEFAULT '';
ALTER TABLE "Character" ADD COLUMN "negativeIdentity" TEXT NOT NULL DEFAULT '';
