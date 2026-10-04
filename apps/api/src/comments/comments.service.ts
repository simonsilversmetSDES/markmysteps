import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { PhotoComment } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TripsService } from '../trips/trips.service';
import { CommentNotifierService } from '../whatsapp/comment-notifier.service';

/** A comment as the share page sees it: the words and a name, no account ids. */
export interface PublicPhotoComment {
  id: string;
  mediaId: string;
  authorName: string;
  body: string;
  createdAt: Date;
  /** Written by somebody on the trip rather than by a visitor. */
  traveller: boolean;
}

/** And as the app sees it, which also knows what it may take away. */
export interface PhotoCommentView extends PublicPhotoComment {
  canDelete: boolean;
}

@Injectable()
export class CommentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly trips: TripsService,
    private readonly notifier: CommentNotifierService,
  ) {}

  // ---- Share page: whoever holds the link, by the name they type ----

  async listPublic(tripId: string): Promise<PublicPhotoComment[]> {
    const rows = await this.prisma.photoComment.findMany({
      where: { tripId },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map(toPublic);
  }

  async addPublic(
    tripId: string,
    mediaId: string,
    name: string,
    body: string,
    visitorId?: string,
  ): Promise<PublicPhotoComment> {
    const authorName = clean(name);
    if (!authorName) throw new BadRequestException('A name is required');
    requireBody(body);
    await this.requireMedia(tripId, mediaId);
    const row = await this.prisma.photoComment.create({
      data: { tripId, mediaId, authorName, body: body.trim(), visitorId },
    });
    this.notifier.notify(row.id);
    return toPublic(row);
  }

  // ---- App: the people on the trip, under their own name ----

  async list(tripId: string, userId: string): Promise<PhotoCommentView[]> {
    const trip = await this.trips.getForMember(tripId, userId);
    const rows = await this.prisma.photoComment.findMany({
      where: { tripId },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((row) => toView(row, userId, trip.ownerId));
  }

  async add(
    tripId: string,
    userId: string,
    mediaId: string,
    body: string,
  ): Promise<PhotoCommentView> {
    requireBody(body);
    const trip = await this.trips.getForMember(tripId, userId);
    await this.requireMedia(tripId, mediaId);
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { displayName: true },
    });
    const row = await this.prisma.photoComment.create({
      data: { tripId, mediaId, userId, authorName: user.displayName, body: body.trim() },
    });
    this.notifier.notify(row.id);
    return toView(row, userId, trip.ownerId);
  }

  /**
   * The owner keeps the photos tidy and may take any comment away — a link
   * that has gone round is open to whoever got it. Everybody else on the trip
   * takes away only what they wrote themselves.
   */
  async remove(tripId: string, userId: string, commentId: string): Promise<void> {
    const trip = await this.trips.getForMember(tripId, userId);
    const row = await this.prisma.photoComment.findFirst({ where: { id: commentId, tripId } });
    if (!row) throw new NotFoundException('Comment not found');
    if (!mayDelete(row, userId, trip.ownerId)) {
      throw new ForbiddenException('Only the trip owner or the author can remove this');
    }
    await this.prisma.photoComment.delete({ where: { id: commentId } });
  }

  private async requireMedia(tripId: string, mediaId: string): Promise<void> {
    const count = await this.prisma.mediaRef.count({ where: { id: mediaId, tripId } });
    if (count === 0) throw new NotFoundException('Media not found');
  }
}

/** Runs of whitespace in a typed name collapse to one space. */
function clean(name: string): string {
  return name.trim().replace(/\s+/g, ' ');
}

/** Length checks pass a comment of only spaces; this does not. */
function requireBody(body: string): void {
  if (!body.trim()) throw new BadRequestException('A comment cannot be empty');
}

function mayDelete(row: PhotoComment, userId: string, ownerId: string): boolean {
  return userId === ownerId || (row.userId !== null && row.userId === userId);
}

function toPublic(row: PhotoComment): PublicPhotoComment {
  return {
    id: row.id,
    mediaId: row.mediaId,
    authorName: row.authorName,
    body: row.body,
    createdAt: row.createdAt,
    traveller: row.userId !== null,
  };
}

function toView(row: PhotoComment, userId: string, ownerId: string): PhotoCommentView {
  return { ...toPublic(row), canDelete: mayDelete(row, userId, ownerId) };
}
