import { Injectable, NotFoundException } from '@nestjs/common';
import { MediaRef } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TripsService } from '../trips/trips.service';
import { coverSuccessor } from './cover-succession';

export type MediaItem = Pick<
  MediaRef,
  | 'id'
  | 'userId'
  | 'immichAssetId'
  | 'assetType'
  | 'takenAt'
  | 'latitude'
  | 'longitude'
  | 'width'
  | 'height'
>;

@Injectable()
export class MediaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly trips: TripsService,
  ) {}

  /**
   * Lists a trip's media, ordered by capture time.
   * `userIds` narrows to specific travellers (map person-filter).
   */
  async listForTrip(tripId: string, requesterId: string, userIds?: string[]): Promise<MediaItem[]> {
    await this.trips.getForMember(tripId, requesterId); // membership check

    return this.prisma.mediaRef.findMany({
      where: {
        tripId,
        ...(userIds && userIds.length > 0 ? { userId: { in: userIds } } : {}),
      },
      orderBy: { takenAt: 'asc' },
      select: {
        id: true,
        userId: true,
        immichAssetId: true,
        assetType: true,
        takenAt: true,
        latitude: true,
        longitude: true,
        width: true,
        height: true,
      },
    });
  }

  /** Returns the MediaRef if the requester shares the trip; 404 otherwise. */
  /**
   * Drops a reference to a photo Immich no longer has, and anything pointing
   * at it.
   *
   * A cover is stored as a plain media id rather than a relation, so a photo
   * deleted in Immich left the trip (or the stop) fronted by a picture nobody
   * can fetch: a white rectangle that never finished loading, and no way back
   * to a working cover short of picking a new one by hand. The next sync would
   * drop the reference anyway; this does it the moment the gap is discovered,
   * so the cover moves on to the replacement photo, or failing that falls back
   * to the trip's own first photo, straight away.
   */
  async forgetMissing(mediaRefId: string): Promise<void> {
    const dead = await this.prisma.mediaRef.findUnique({ where: { id: mediaRefId } });
    if (!dead) return;
    // A photo that was re-edited and re-added is the same photograph under a
    // new id, and a cover that pointed at the old one follows it there.
    const heir = await coverSuccessor(this.prisma, dead);
    await this.prisma.$transaction([
      this.prisma.trip.updateMany({
        where: { coverMediaId: mediaRefId },
        data: { coverMediaId: heir },
      }),
      this.prisma.stop.updateMany({
        where: { coverMediaId: mediaRefId },
        data: { coverMediaId: heir },
      }),
      this.prisma.mediaRef.deleteMany({ where: { id: mediaRefId } }),
    ]);
  }

  /**
   * Takes photos out of a trip without touching Immich.
   *
   * The reference goes and an exclusion takes its place, so the next sync
   * leaves the photo where it is instead of pulling it straight back in. The
   * trip's owner may take out anybody's; a travel companion only their own,
   * because the photos are theirs to show and not to hide for somebody else.
   * Ids that are not in this trip, or not the caller's to remove, are left out
   * of the count rather than failing the whole batch.
   */
  async removeFromTrip(
    tripId: string,
    requesterId: string,
    mediaRefIds: string[],
  ): Promise<{ removed: number; removedIds: string[] }> {
    const trip = await this.trips.getForEditor(tripId, requesterId);
    const refs = await this.prisma.mediaRef.findMany({
      where: {
        id: { in: mediaRefIds },
        tripId,
        ...(trip.ownerId === requesterId ? {} : { userId: requesterId }),
      },
      select: { id: true, userId: true, immichAssetId: true },
    });
    if (refs.length === 0) return { removed: 0, removedIds: [] };
    const ids = refs.map((r) => r.id);

    await this.prisma.$transaction([
      this.prisma.mediaExclusion.createMany({
        data: refs.map((r) => ({ tripId, userId: r.userId, immichAssetId: r.immichAssetId })),
        skipDuplicates: true,
      }),
      // A cover on a photo that is no longer in the trip falls back to the
      // trip's own pick, the same as a cover that was never chosen.
      this.prisma.trip.updateMany({
        where: { id: tripId, coverMediaId: { in: ids } },
        data: { coverMediaId: null },
      }),
      this.prisma.stop.updateMany({
        where: { tripId, coverMediaId: { in: ids } },
        data: { coverMediaId: null },
      }),
      this.prisma.mediaRef.deleteMany({ where: { id: { in: ids } } }),
    ]);
    return { removed: ids.length, removedIds: ids };
  }

  /**
   * Puts photos back that were taken out: the exclusions go, and the caller
   * runs a sync to bring the references back. Same rule as taking them out.
   */
  async clearExclusions(
    tripId: string,
    requesterId: string,
    immichAssetIds: string[],
  ): Promise<number> {
    const trip = await this.trips.getForEditor(tripId, requesterId);
    const { count } = await this.prisma.mediaExclusion.deleteMany({
      where: {
        tripId,
        immichAssetId: { in: immichAssetIds },
        ...(trip.ownerId === requesterId ? {} : { userId: requesterId }),
      },
    });
    return count;
  }

  async getForRequester(mediaRefId: string, requesterId: string): Promise<MediaRef> {
    const media = await this.prisma.mediaRef.findFirst({
      where: {
        id: mediaRefId,
        trip: { members: { some: { userId: requesterId } } },
      },
    });
    if (!media) {
      throw new NotFoundException('Media not found');
    }
    return media;
  }
}
