-- Visitors on a share link who left a name and phone number for WhatsApp
-- updates, the comments they wrote, and the traveller's own number.
CREATE TABLE "share_visitors" (
    "id" UUID NOT NULL,
    "tripId" UUID NOT NULL,
    "shareLinkId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "subscribed" BOOLEAN NOT NULL DEFAULT true,
    "token" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "share_visitors_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "share_visitors_token_key" ON "share_visitors"("token");
CREATE UNIQUE INDEX "share_visitors_tripId_phone_key" ON "share_visitors"("tripId", "phone");
CREATE INDEX "share_visitors_phone_idx" ON "share_visitors"("phone");

ALTER TABLE "share_visitors" ADD CONSTRAINT "share_visitors_tripId_fkey" FOREIGN KEY ("tripId") REFERENCES "trips"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "share_visitors" ADD CONSTRAINT "share_visitors_shareLinkId_fkey" FOREIGN KEY ("shareLinkId") REFERENCES "share_links"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "photo_comments" ADD COLUMN "visitorId" UUID;
ALTER TABLE "photo_comments" ADD CONSTRAINT "photo_comments_visitorId_fkey" FOREIGN KEY ("visitorId") REFERENCES "share_visitors"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "trips" ADD COLUMN "lastUpdateSentAt" TIMESTAMP(3);

ALTER TABLE "users" ADD COLUMN "notifyPhone" TEXT;
