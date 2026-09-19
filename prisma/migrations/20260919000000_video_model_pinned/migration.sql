-- Tell an operator's PIN apart from the router's own write-back.
--
-- `Scene.videoProvider` / `Scene.videoModel` carried both meanings at once:
-- what a person asked for before a run, and what was actually used after one.
-- The router read the second as if it were the first, which skipped the
-- LOW_AUTO gate, hid router-chosen clips from batch authorisation gate 2b, and
-- disabled the "free wins" rule on scenes that had already been paid for.
--
-- See QĐ-069.
-- AddColumn
ALTER TABLE "Scene" ADD COLUMN "videoModelPinned" BOOLEAN NOT NULL DEFAULT false;

-- Backfill: reconstruct the instruction from the evidence already in the row,
-- so no existing pin is lost and none is invented.
--
--   routingMode = 'MANUAL'   a person chose the model through the UI; this is
--                            what `regenerateSceneImageNow` and the scene form
--                            write when someone names one.
--   motionMode  = 'VIDEO_AI' the model came from an imported storyboard, where
--                            naming it IS the instruction (the importer never
--                            left routingMode behind to say so).
--
-- Everything else - a row whose videoModel is set but which was routed
-- automatically - is the write-back, and stays false. On this database that is
-- the four `Spill the beans` scenes and imported scene #3 pinned true, and the
-- two `Cold feet` batch scenes the router picked itself left false, which is
-- exactly how each of them was decided.
UPDATE "Scene"
SET "videoModelPinned" = true
WHERE "videoModel" IS NOT NULL
  AND "videoProvider" IS NOT NULL
  AND ("routingMode" = 'MANUAL' OR "motionMode" = 'VIDEO_AI');
