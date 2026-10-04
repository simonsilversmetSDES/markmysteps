import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  Res,
  UnauthorizedException,
  UseGuards,
  BadRequestException,
} from '@nestjs/common';
import { SkipThrottle, Throttle } from '@nestjs/throttler';
import type { Response as ExpressResponse } from 'express';
import { IsOptional, IsString, MaxLength, ValidateIf } from 'class-validator';
import { timingSafeEqual } from 'node:crypto';
import { AdminGuard } from '../admin/admin.guard';
import type { JwtPayload } from '../auth/auth.service';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PrismaService } from '../prisma/prisma.service';
import { normalizePhone, phoneFromChatId } from './phone';
import { VisitorsOverview, VisitorsService } from './visitors.service';
import { WhatsappService, WhatsappStatus } from './whatsapp.service';

class SendUpdateDto {
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  message?: string;
}

class NotifyPhoneDto {
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(30)
  phone: string | null;
}

/** The trip's visitors and the "new photos" button, for the people on the trip. */
@Controller('trips/:tripId/visitors')
@UseGuards(JwtAuthGuard)
export class VisitorsController {
  constructor(private readonly visitors: VisitorsService) {}

  @Get()
  overview(
    @CurrentUser() user: JwtPayload,
    @Param('tripId', ParseUUIDPipe) tripId: string,
  ): Promise<VisitorsOverview> {
    return this.visitors.overview(tripId, user.sub);
  }

  @Delete(':visitorId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @CurrentUser() user: JwtPayload,
    @Param('tripId', ParseUUIDPipe) tripId: string,
    @Param('visitorId', ParseUUIDPipe) visitorId: string,
  ): Promise<void> {
    await this.visitors.remove(tripId, user.sub, visitorId);
  }

  @Post('update')
  @Throttle({ default: { ttl: 60_000, limit: 3 } })
  sendUpdate(
    @CurrentUser() user: JwtPayload,
    @Param('tripId', ParseUUIDPipe) tripId: string,
    @Body() dto: SendUpdateDto,
  ) {
    return this.visitors.sendUpdate(tripId, user.sub, dto.message);
  }
}

@Controller('whatsapp')
export class WhatsappController {
  constructor(
    private readonly whatsapp: WhatsappService,
    private readonly visitors: VisitorsService,
    private readonly prisma: PrismaService,
  ) {}

  // ---- Your own number, for comments on your trips ----

  @Get('me')
  @UseGuards(JwtAuthGuard)
  async me(@CurrentUser() user: JwtPayload): Promise<{ phone: string | null; available: boolean }> {
    const row = await this.prisma.user.findUniqueOrThrow({
      where: { id: user.sub },
      select: { notifyPhone: true },
    });
    return { phone: row.notifyPhone, available: this.whatsapp.enabled };
  }

  @Put('me')
  @UseGuards(JwtAuthGuard)
  async setMine(
    @CurrentUser() user: JwtPayload,
    @Body() dto: NotifyPhoneDto,
  ): Promise<{ phone: string | null; available: boolean }> {
    let phone: string | null = null;
    if (dto.phone !== null && dto.phone.trim() !== '') {
      phone = normalizePhone(dto.phone);
      if (!phone) throw new BadRequestException('Dat lijkt geen geldig gsm-nummer');
    }
    await this.prisma.user.update({ where: { id: user.sub }, data: { notifyPhone: phone } });
    return { phone, available: this.whatsapp.enabled };
  }

  // ---- Linking the sending number (admin) ----

  @Get('admin')
  @UseGuards(JwtAuthGuard, AdminGuard)
  status(): Promise<WhatsappStatus> {
    return this.whatsapp.status();
  }

  @Post('admin/start')
  @UseGuards(JwtAuthGuard, AdminGuard)
  async start(): Promise<WhatsappStatus> {
    await this.whatsapp.start();
    return this.whatsapp.status();
  }

  @Get('admin/qr')
  @UseGuards(JwtAuthGuard, AdminGuard)
  async qr(@Res() res: ExpressResponse): Promise<void> {
    const png = await this.whatsapp.qr();
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'no-store');
    res.end(png);
  }

  @Post('admin/logout')
  @UseGuards(JwtAuthGuard, AdminGuard)
  async logout(): Promise<WhatsappStatus> {
    await this.whatsapp.logout();
    return this.whatsapp.status();
  }

  @Post('admin/test')
  @UseGuards(JwtAuthGuard, AdminGuard)
  @Throttle({ default: { ttl: 60_000, limit: 3 } })
  async test(@CurrentUser() user: JwtPayload): Promise<{ sentTo: string }> {
    const row = await this.prisma.user.findUniqueOrThrow({
      where: { id: user.sub },
      select: { notifyPhone: true },
    });
    if (!row.notifyPhone) throw new BadRequestException('Stel eerst je eigen WhatsApp-nummer in');
    this.whatsapp.send(row.notifyPhone, '✅ MarkMySteps kan je berichten sturen via WhatsApp.');
    return { sentTo: row.notifyPhone };
  }

  // ---- Leaving: the link in every message, and STOP ----

  @Get('stop/:token')
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  async stop(@Param('token') token: string, @Res() res: ExpressResponse): Promise<void> {
    const done = await this.visitors.unsubscribe(token);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(
      page(
        done ? 'Je bent afgemeld' : 'Link niet gevonden',
        done
          ? 'Je krijgt geen WhatsApp-berichten meer over deze reis. Wil je toch weer updates? Vul je nummer opnieuw in op de reispagina.'
          : 'Deze afmeldlink bestaat niet (meer). Misschien ben je al afgemeld.',
      ),
    );
  }

  /**
   * Incoming messages, from WAHA on the internal network. Only STOP means
   * anything; everything else is ignored.
   */
  @Post('webhook')
  @SkipThrottle()
  @HttpCode(HttpStatus.NO_CONTENT)
  async webhook(
    @Query('secret') secret: string | undefined,
    @Body()
    body: { event?: string; payload?: { from?: string; body?: string; fromMe?: boolean } },
  ): Promise<void> {
    const expected = process.env.WHATSAPP_WEBHOOK_SECRET ?? '';
    if (!expected || !secret || !safeEqual(secret, expected)) {
      throw new UnauthorizedException();
    }
    const msg = body.payload;
    if (body.event !== 'message' || !msg || msg.fromMe || !msg.from) return;
    const text = (msg.body ?? '').trim().toUpperCase();
    if (!['STOP', 'STOPPEN', 'AFMELDEN', 'UITSCHRIJVEN'].includes(text)) return;
    const phone = phoneFromChatId(msg.from);
    const count = phone ? await this.visitors.unsubscribePhone(phone) : 0;
    this.whatsapp.sendToChat(
      msg.from,
      count > 0
        ? 'Je bent afgemeld. Je krijgt geen berichten meer over deze reis.'
        : 'We konden je nummer niet terugvinden. Gebruik de afmeldlink onderaan een bericht.',
    );
  }
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function page(title: string, text: string): string {
  return `<!doctype html><html lang="nl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} · MarkMySteps</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#faf6ef;color:#1e2a35;font:16px/1.5 system-ui,sans-serif;padding:16px}main{max-width:420px;background:#fff;border-radius:16px;padding:28px;box-shadow:0 6px 30px rgb(0 0 0/.08)}h1{margin:0 0 8px;font-size:1.3rem}p{margin:0;color:#51616f}@media (prefers-color-scheme:dark){body{background:#14181d;color:#eef1f4}main{background:#1d242c}p{color:#a7b2bd}}</style></head><body><main><h1>${title}</h1><p>${text}</p></main></body></html>`;
}
