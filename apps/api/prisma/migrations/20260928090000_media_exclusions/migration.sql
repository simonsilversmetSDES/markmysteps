-- Photos taken out of a trip by hand. Immich keeps them; the trip stops
-- showing them, and the sync skips them instead of bringing them straight
-- back. Keyed on the Immich asset because the media_refs row is deleted the
-- moment the photo is taken out.
CREATE TABLE "media_exclusions" (
    "tripId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "immichAssetId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "media_exclusions_pkey" PRIMARY KEY ("tripId","userId","immichAssetId")
);

ALTER TABLE "media_exclusions" ADD CONSTRAINT "media_exclusions_tripId_fkey" FOREIGN KEY ("tripId") REFERENCES "trips"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "media_exclusions" ADD CONSTRAINT "media_exclusions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
