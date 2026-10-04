import { Injectable, Logger } from '@nestjs/common';
import { TripRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { webOrigin } from './visitors.service';
import { WhatsappService } from './whatsapp.service';

/** A comment quoted in a message is cut short; the link has the rest. */
const QUOTE_MAX = 300;

const quote = (body: string) =>
  `"${body.length > QUOTE_MAX ? `${body.slice(0, QUOTE_MAX).trimEnd()}…` : body}"`;

/**
 * Who hears about a comment on WhatsApp.
 *
 * A visitor writes → the travellers who set a WhatsApp number in the app.
 * A traveller answers → the visitors who commented on that same photo and
 * left a number, so it reads as a conversation rather than a broadcast.
 */
@Injectable()
export class CommentNotifierService {
  private readonly logger = new Logger(CommentNotifierService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly whatsapp: WhatsappService,
  ) {}

  /** Never throws: the comment is saved either way. */
  notify(commentId: string): void {
    if (!this.whatsapp.enabled) return;
    this.run(commentId).catch((err) =>
      this.logger.warn(`Comment notification failed: ${err instanceof Error ? err.message : err}`),
    );
  }

  private async run(commentId: string): Promise<void> {
    const comment = await this.prisma.photoComment.findUnique({
      where: { id: commentId },
      include: { trip: { select: { id: true, title: true } } },
    });
    if (!comment) return;
    const origin = webOrigin();

    if (comment.userId === null) {
      // From the share page: tell the people on the trip.
      const members = await this.prisma.tripMember.findMany({
        where: {
          tripId: comment.tripId,
          role: { not: TripRole.GUEST },
          user: { notifyPhone: { not: null } },
        },
        select: { user: { select: { notifyPhone: true } } },
      });
      const text = [
        `💬 ${comment.authorName} reageerde op een foto in "${comment.trip.title}":`,
        '',
        quote(comment.body),
        '',
        `Bekijk en antwoord: ${origin}/trips/${comment.tripId}?foto=${comment.mediaId}`,
      ].join('\n');
      for (const m of members) this.whatsapp.send(m.user.notifyPhone!, text);
      return;
    }

    // From the app: tell the visitors talking about this photo.
    const visitors = await this.prisma.shareVisitor.findMany({
      where: {
        tripId: comment.tripId,
        subscribed: true,
        comments: { some: { mediaId: comment.mediaId } },
      },
      include: { shareLink: { select: { slug: true } } },
    });
    for (const v of visitors) {
      this.whatsapp.send(
        v.phone,
        [
          `💬 ${comment.authorName} antwoordde op een foto in "${comment.trip.title}":`,
          '',
          quote(comment.body),
          '',
          `Bekijk het gesprek: ${origin}/s/${v.shareLink.slug}?foto=${comment.mediaId}`,
          '',
          `Geen berichten meer? ${origin}/api/whatsapp/stop/${v.token}`,
        ].join('\n'),
      );
    }
  }
}
