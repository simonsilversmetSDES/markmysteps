import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { TripRole } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { TripsService } from '../trips/trips.service';
import { normalizePhone } from './phone';
import { WhatsappService, WhatsappStatus } from './whatsapp.service';

export interface VisitorView {
  id: string;
  name: string;
  phone: string;
  subscribed: boolean;
  createdAt: Date;
}

export interface VisitorsOverview {
  visitors: VisitorView[];
  /** Photos synced since the last update went out (all of them before the first). */
  newPhotos: number;
  lastUpdateSentAt: Date | null;
  whatsapp: WhatsappStatus;
}

/** The public origin links in a message point at. */
export function webOrigin(): string {
  return (process.env.WEB_ORIGIN?.split(',')[0] ?? '').replace(/\/$/, '');
}

/**
 * "Simon en Jozefien": the first names of the people travelling, as the page
 * and the messages say who the updates are from. Guests are only looking.
 */
export function hostNames(
  ownerId: string,
  members: { role: TripRole; userId: string; user: { displayName: string } }[],
): string {
  const travellers = [...members]
    .filter((m) => m.role !== TripRole.GUEST)
    // The owner first: it is their trip.
    .sort((a, b) => Number(b.userId === ownerId) - Number(a.userId === ownerId))
    .map((m) => m.user.displayName.trim().split(/\s+/)[0]!)
    .filter(Boolean);
  if (travellers.length <= 1) return travellers[0] ?? '';
  return `${travellers.slice(0, -1).join(', ')} en ${travellers[travellers.length - 1]}`;
}

@Injectable()
export class VisitorsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly trips: TripsService,
    private readonly whatsapp: WhatsappService,
  ) {}

  // ---- Share page ----

  /** Sign up (or sign up again) for a trip's updates. Same number, same visitor. */
  async register(
    slug: string,
    name: string,
    phoneInput: string,
  ): Promise<{ token: string; name: string; phone: string }> {
    const phone = normalizePhone(phoneInput);
    if (!phone) throw new BadRequestException('Dat lijkt geen geldig gsm-nummer');
    const cleanName = name.trim().replace(/\s+/g, ' ');
    if (!cleanName) throw new BadRequestException('A name is required');
    const link = await this.prisma.shareLink.findUniqueOrThrow({ where: { slug } });
    const visitor = await this.prisma.shareVisitor.upsert({
      where: { tripId_phone: { tripId: link.tripId, phone } },
      create: {
        tripId: link.tripId,
        shareLinkId: link.id,
        name: cleanName,
        phone,
        token: randomBytes(18).toString('base64url'),
      },
      update: { name: cleanName, shareLinkId: link.id, subscribed: true },
    });
    return { token: visitor.token, name: visitor.name, phone: visitor.phone };
  }

  /** Who a browser's stored token belongs to, on this trip. */
  async byToken(tripId: string, token: string | undefined) {
    if (!token) return null;
    return this.prisma.shareVisitor.findFirst({ where: { token, tripId } });
  }

  async unsubscribe(token: string): Promise<boolean> {
    const { count } = await this.prisma.shareVisitor.updateMany({
      where: { token },
      data: { subscribed: false },
    });
    return count > 0;
  }

  /** STOP from a number: off every trip it signed up for. */
  async unsubscribePhone(phone: string): Promise<number> {
    const { count } = await this.prisma.shareVisitor.updateMany({
      where: { phone },
      data: { subscribed: false },
    });
    return count;
  }

  // ---- App ----

  async overview(tripId: string, userId: string): Promise<VisitorsOverview> {
    const trip = await this.trips.getForEditor(tripId, userId);
    const [visitors, newPhotos, whatsapp] = await Promise.all([
      this.prisma.shareVisitor.findMany({
        where: { tripId },
        orderBy: { createdAt: 'asc' },
        select: { id: true, name: true, phone: true, subscribed: true, createdAt: true },
      }),
      this.newPhotoCount(tripId, trip.lastUpdateSentAt),
      this.whatsapp.status(),
    ]);
    return { visitors, newPhotos, lastUpdateSentAt: trip.lastUpdateSentAt, whatsapp };
  }

  async remove(tripId: string, userId: string, visitorId: string): Promise<void> {
    await this.trips.getForEditor(tripId, userId);
    const { count } = await this.prisma.shareVisitor.deleteMany({
      where: { id: visitorId, tripId },
    });
    if (count === 0) throw new NotFoundException('Visitor not found');
  }

  /**
   * The "new photos" message, sent when the travellers press the button —
   * never on its own, so a sync of three hundred photos is one message, when
   * they want it to be.
   */
  async sendUpdate(
    tripId: string,
    userId: string,
    message?: string,
  ): Promise<{ queued: number; newPhotos: number }> {
    const trip = await this.trips.getForEditor(tripId, userId);
    const visitors = await this.prisma.shareVisitor.findMany({
      where: { tripId, subscribed: true },
      include: { shareLink: { select: { slug: true } } },
    });
    const newPhotos = await this.newPhotoCount(tripId, trip.lastUpdateSentAt);
    const hosts = hostNames(trip.ownerId, trip.members) || 'De reizigers';
    const origin = webOrigin();
    const extra = message?.trim();

    for (const v of visitors) {
      const what =
        newPhotos > 0
          ? `${hosts} ${newPhotos === 1 ? 'heeft 1 nieuwe foto' : `hebben ${newPhotos} nieuwe foto's`} toegevoegd aan "${trip.title}".`
          : `${hosts} ${hosts.includes(' en ') ? 'hebben' : 'heeft'} nieuws over "${trip.title}".`;
      this.whatsapp.send(
        v.phone,
        [
          `Hallo ${v.name.split(' ')[0]}! 📸`,
          '',
          what,
          ...(extra ? ['', extra] : []),
          '',
          `Bekijk ze hier: ${origin}/s/${v.shareLink.slug}`,
          '',
          `Geen berichten meer? ${origin}/api/whatsapp/stop/${v.token}`,
        ].join('\n'),
      );
    }
    await this.prisma.trip.update({ where: { id: tripId }, data: { lastUpdateSentAt: new Date() } });
    return { queued: visitors.length, newPhotos };
  }

  private newPhotoCount(tripId: string, since: Date | null): Promise<number> {
    return this.prisma.mediaRef.count({
      where: { tripId, ...(since ? { createdAt: { gt: since } } : {}) },
    });
  }
}
