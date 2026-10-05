import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { TripsService } from '../trips/trips.service';

/** The five a photo can get. The page maps each to its emoji. */
export const REACTION_KINDS = ['heart', 'laugh', 'wow', 'love', 'clap'] as const;
export type ReactionKind = (typeof REACTION_KINDS)[number];

export interface ReactionsView {
  /** Per photo, how many of each. */
  counts: { mediaId: string; kind: string; count: number }[];
  /** Per photo, the caller's own pick. */
  mine: Record<string, string>;
  /** Per photo, who reacted, when known — only for the people on the trip. */
  names?: Record<string, { kind: string; name: string }[]>;
}

@Injectable()
export class ReactionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly trips: TripsService,
  ) {}

  /** Visitors on the share page, by their browser key. */
  async listPublic(tripId: string, reactorKey: string | undefined): Promise<ReactionsView> {
    return this.view(tripId, reactorKey, false);
  }

  async setPublic(
    tripId: string,
    mediaId: string,
    reactorKey: string,
    kind: string | null,
    name: string | null,
  ): Promise<void> {
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(reactorKey)) {
      throw new BadRequestException('Invalid reactor key');
    }
    await this.set(tripId, mediaId, reactorKey, kind, name);
  }

  /** The people on the trip, under their own account. */
  async list(tripId: string, userId: string): Promise<ReactionsView> {
    await this.trips.getForMember(tripId, userId);
    return this.view(tripId, `user:${userId}`, true);
  }

  async setMine(
    tripId: string,
    userId: string,
    mediaId: string,
    kind: string | null,
  ): Promise<void> {
    await this.trips.getForMember(tripId, userId);
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { displayName: true },
    });
    await this.set(tripId, mediaId, `user:${userId}`, kind, user.displayName);
  }

  /** Picking one swaps it, picking none takes it away. */
  private async set(
    tripId: string,
    mediaId: string,
    reactorKey: string,
    kind: string | null,
    name: string | null,
  ): Promise<void> {
    const count = await this.prisma.mediaRef.count({ where: { id: mediaId, tripId } });
    if (count === 0) throw new NotFoundException('Media not found');
    if (kind === null) {
      await this.prisma.photoReaction.deleteMany({ where: { mediaId, reactorKey } });
      return;
    }
    if (!(REACTION_KINDS as readonly string[]).includes(kind)) {
      throw new BadRequestException('Unknown reaction');
    }
    await this.prisma.photoReaction.upsert({
      where: { mediaId_reactorKey: { mediaId, reactorKey } },
      create: { tripId, mediaId, reactorKey, kind, name },
      update: { kind, ...(name ? { name } : {}) },
    });
  }

  private async view(
    tripId: string,
    reactorKey: string | undefined,
    withNames: boolean,
  ): Promise<ReactionsView> {
    const [counts, mine, named] = await Promise.all([
      this.prisma.photoReaction.groupBy({
        by: ['mediaId', 'kind'],
        where: { tripId },
        _count: { _all: true },
      }),
      reactorKey
        ? this.prisma.photoReaction.findMany({
            where: { tripId, reactorKey },
            select: { mediaId: true, kind: true },
          })
        : Promise.resolve([]),
      withNames
        ? this.prisma.photoReaction.findMany({
            where: { tripId, name: { not: null } },
            orderBy: { createdAt: 'asc' },
            select: { mediaId: true, kind: true, name: true },
          })
        : Promise.resolve([]),
    ]);
    const view: ReactionsView = {
      counts: counts.map((c) => ({ mediaId: c.mediaId, kind: c.kind, count: c._count._all })),
      mine: Object.fromEntries(mine.map((m) => [m.mediaId, m.kind])),
    };
    if (withNames) {
      const names: NonNullable<ReactionsView['names']> = {};
      for (const r of named) (names[r.mediaId] ??= []).push({ kind: r.kind, name: r.name! });
      view.names = names;
    }
    return view;
  }
}
