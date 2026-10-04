import {
  Body,
  Controller,
  Get,
  Headers,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Throttle } from '@nestjs/throttler';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsString, IsUUID, MaxLength } from 'class-validator';
import type { Response as ExpressResponse } from 'express';
import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import type { JwtPayload } from '../auth/auth.service';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ImmichClientService } from '../immich/immich-client.service';
import { ImmichConnectionService } from '../immich/immich-connection.service';
import { GeotagResult, ImmichGeotagService } from '../immich/immich-geotag.service';
import { Candidate, ImmichSyncService, SyncResult } from '../immich/immich-sync.service';
import { PrismaService } from '../prisma/prisma.service';
import { TripsService } from '../trips/trips.service';
import { MediaItem, MediaService } from './media.service';

class RemoveMediaDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @IsUUID('all', { each: true })
  ids!: string[];
}

class RestoreMediaDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @IsString({ each: true })
  @MaxLength(200, { each: true })
  immichAssetIds!: string[];
}

class PickMediaDto {
  /** Into the trip. */
  @IsArray()
  @ArrayMaxSize(1000)
  @IsString({ each: true })
  @MaxLength(200, { each: true })
  add!: string[];

  /** Looked at and left out: listed as hidden from now on. */
  @IsArray()
  @ArrayMaxSize(1000)
  @IsString({ each: true })
  @MaxLength(200, { each: true })
  hide!: string[];
}

interface VideoTokenPayload {
  scope: 'media-video';
  mediaId: string;
}

@Controller()
@UseGuards(JwtAuthGuard)
export class MediaController {
  constructor(
    private readonly media: MediaService,
    private readonly trips: TripsService,
    private readonly sync: ImmichSyncService,
    private readonly geotag: ImmichGeotagService,
    private readonly connections: ImmichConnectionService,
    private readonly immich: ImmichClientService,
    private readonly jwt: JwtService,
  ) {}

  /**
   * The <video> element cannot send an Authorization header, so playback
   * uses a short-lived token in the URL. This endpoint (JWT-guarded) hands
   * out that URL after the usual trip-membership check.
   */
  @Get('media/:id/video-url')
  async videoUrl(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<{ url: string }> {
    const media = await this.media.getForRequester(id, user.sub);
    const payload: VideoTokenPayload = { scope: 'media-video', mediaId: media.id };
    const token = await this.jwt.signAsync(payload, { expiresIn: '15m' });
    return { url: `/api/media/${media.id}/video?t=${token}` };
  }

  /** List trip media; `?users=id1,id2` filters by traveller. */
  @Get('trips/:tripId/media')
  list(
    @CurrentUser() user: JwtPayload,
    @Param('tripId', ParseUUIDPipe) tripId: string,
    @Query('users') users?: string,
  ): Promise<MediaItem[]> {
    const userIds = users
      ?.split(',')
      .map((id) => id.trim())
      .filter(Boolean);
    return this.media.listForTrip(tripId, user.sub, userIds);
  }

  /** Manually trigger an Immich sync for a trip (any traveller, not guests). */
  @Post('trips/:tripId/sync')
  @Throttle({ default: { ttl: 60_000, limit: 6 } })
  async triggerSync(
    @CurrentUser() user: JwtPayload,
    @Param('tripId', ParseUUIDPipe) tripId: string,
  ): Promise<SyncResult> {
    await this.trips.getForEditor(tripId, user.sub);
    return this.sync.syncTrip(tripId);
  }

  /**
   * Takes photos out of this trip. Immich is not touched: the photos stay in
   * the library, the trip stops showing them, and later syncs skip them.
   */
  @Post('trips/:tripId/media/remove')
  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  removeMedia(
    @CurrentUser() user: JwtPayload,
    @Param('tripId', ParseUUIDPipe) tripId: string,
    @Body() dto: RemoveMediaDto,
  ): Promise<{ removed: number; removedIds: string[] }> {
    return this.media.removeFromTrip(tripId, user.sub, dto.ids);
  }

  /** Undo for the above, and "show it after all" from the hidden list. */
  @Post('trips/:tripId/media/restore')
  @Throttle({ default: { ttl: 60_000, limit: 20 } })
  async restoreMedia(
    @CurrentUser() user: JwtPayload,
    @Param('tripId', ParseUUIDPipe) tripId: string,
    @Body() dto: RestoreMediaDto,
  ): Promise<{ restored: number }> {
    const hidden = await this.media.restorableExclusions(tripId, user.sub, dto.immichAssetIds);
    // Each photo comes back out of its own owner's library.
    const byUser = new Map<string, string[]>();
    for (const e of hidden) byUser.set(e.userId, [...(byUser.get(e.userId) ?? []), e.immichAssetId]);
    let restored = 0;
    for (const [userId, assetIds] of byUser) {
      restored += await this.sync.addAssets(tripId, userId, assetIds);
    }
    return { restored };
  }

  /**
   * The caller's own Immich photos for this trip's dates that the trip is not
   * showing, for the picker: new ones, and the ones hidden earlier.
   */
  @Get('trips/:tripId/media/candidates')
  @Throttle({ default: { ttl: 60_000, limit: 20 } })
  async candidates(
    @CurrentUser() user: JwtPayload,
    @Param('tripId', ParseUUIDPipe) tripId: string,
  ): Promise<Candidate[]> {
    await this.trips.getForEditor(tripId, user.sub);
    return this.sync.listCandidates(tripId, user.sub);
  }

  /** What came out of the picker: these in, those hidden. */
  @Post('trips/:tripId/media/pick')
  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  async pick(
    @CurrentUser() user: JwtPayload,
    @Param('tripId', ParseUUIDPipe) tripId: string,
    @Body() dto: PickMediaDto,
  ): Promise<{ added: number; hidden: number }> {
    await this.trips.getForEditor(tripId, user.sub);
    const hidden = await this.sync.hideAssets(tripId, user.sub, dto.hide);
    const added = await this.sync.addAssets(tripId, user.sub, dto.add);
    return { added, hidden };
  }

  /**
   * A picker thumbnail: a photo that is not in the trip yet, so there is no
   * media id to go through. Only ever out of the caller's own library, and
   * only once they are an editor of the trip.
   */
  @Get('trips/:tripId/media/candidates/:assetId/thumbnail')
  @Throttle({ default: { ttl: 60_000, limit: 1200 } })
  async candidateThumbnail(
    @CurrentUser() user: JwtPayload,
    @Param('tripId', ParseUUIDPipe) tripId: string,
    @Param('assetId', ParseUUIDPipe) assetId: string,
    @Query('size') size: string | undefined,
    @Res() res: ExpressResponse,
  ): Promise<void> {
    await this.trips.getForEditor(tripId, user.sub);
    const credentials = await this.connections.getCredentials(user.sub);
    if (!credentials) throw new NotFoundException('No Immich connection');
    const upstream = await this.immich.fetchThumbnail(
      credentials.serverUrl,
      credentials.apiKey,
      assetId,
      // The picker shows two across on a phone, where the small rendition is
      // a blur; it asks for the preview.
      size === 'preview' ? 'preview' : 'thumbnail',
    );
    res.setHeader('Content-Type', upstream.headers.get('content-type') ?? 'image/jpeg');
    res.setHeader('Cache-Control', 'private, max-age=86400');
    if (upstream.body) {
      Readable.fromWeb(upstream.body as NodeReadableStream).pipe(res);
    } else {
      res.end();
    }
  }

  /**
   * Places the trip's position-less photos from its tracked route, without
   * pulling Immich again. A sync does this by itself; this is the button for
   * a trip that finished long ago, or one whose track arrived after its
   * photos did.
   */
  @Post('trips/:tripId/geotag')
  @Throttle({ default: { ttl: 60_000, limit: 6 } })
  async geotagTrip(
    @CurrentUser() user: JwtPayload,
    @Param('tripId', ParseUUIDPipe) tripId: string,
  ): Promise<GeotagResult> {
    await this.trips.getForEditor(tripId, user.sub);
    return this.geotag.geotagTrip(tripId);
  }

  /**
   * Thumbnail proxy: streams the rendition straight from the owner's Immich
   * server using their (decrypted, in-memory) API key. Nothing is written
   * to disk. Higher rate limit — photo grids fire many of these.
   *
   * `?size=thumbnail` asks for Immich's small grid rendition instead of the
   * full-screen preview: a timeline of two hundred photos then costs a few
   * megabytes rather than a few dozen.
   */
  @Get('media/:id/thumbnail')
  @Throttle({ default: { ttl: 60_000, limit: 600 } })
  async thumbnail(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('size') size: string | undefined,
    @Res() res: ExpressResponse,
  ): Promise<void> {
    const media = await this.media.getForRequester(id, user.sub);

    const credentials = await this.connections.getCredentials(media.userId);
    if (!credentials) {
      throw new NotFoundException('The owner of this photo has no Immich connection');
    }

    // `?size=original` is the download: the file as it was uploaded, not a
    // rendition of it. Everything else on the page asks for a rendition.
    let upstream: Awaited<ReturnType<typeof this.immich.fetchThumbnail>>;
    try {
      upstream =
        size === 'original'
          ? await this.immich.fetchOriginal(
              credentials.serverUrl,
              credentials.apiKey,
              media.immichAssetId,
            )
          : await this.immich.fetchThumbnail(
              credentials.serverUrl,
              credentials.apiKey,
              media.immichAssetId,
              size === 'thumbnail' ? 'thumbnail' : 'preview',
            );
    } catch (err) {
      // Gone from Immich: forget it here too, rather than serving a hole in
      // the page on every visit until the next sync. A cover that pointed at
      // it goes back to being unset, so the trip picks a photo again.
      if (err instanceof NotFoundException) await this.media.forgetMissing(id);
      throw err;
    }

    res.setHeader('Content-Type', upstream.headers.get('content-type') ?? 'image/jpeg');
    // The original keeps the name it was uploaded under, so what lands in the
    // downloads folder is the photo's own filename rather than a media id.
    const disposition = upstream.headers.get('content-disposition');
    if (disposition) res.setHeader('Content-Disposition', disposition);
    const length = upstream.headers.get('content-length');
    if (length) res.setHeader('Content-Length', length);
    // Private: responses are per-user authorized; never cache in shared proxies.
    res.setHeader('Cache-Control', 'private, max-age=86400');
    if (upstream.body) {
      Readable.fromWeb(upstream.body as NodeReadableStream).pipe(res);
    } else {
      res.end();
    }
  }
}

/**
 * Video playback proxy. Separate controller WITHOUT the JWT guard: the
 * <video> element cannot send headers, so authorization happens via the
 * short-lived token minted by GET /media/:id/video-url. Range requests are
 * passed through to Immich so seeking works.
 */
@Controller('media')
export class MediaVideoController {
  constructor(
    private readonly jwt: JwtService,
    private readonly media: MediaService,
    private readonly connections: ImmichConnectionService,
    private readonly immich: ImmichClientService,
    private readonly prisma: PrismaService,
  ) {}

  @Get(':id/video')
  @Throttle({ default: { ttl: 60_000, limit: 120 } })
  async video(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('t') token: string | undefined,
    @Headers('range') range: string | undefined,
    @Res() res: ExpressResponse,
  ): Promise<void> {
    if (!token) throw new UnauthorizedException('Missing video token');
    let payload: VideoTokenPayload;
    try {
      payload = await this.jwt.verifyAsync<VideoTokenPayload>(token);
    } catch {
      throw new UnauthorizedException('Invalid or expired video token');
    }
    if (payload.scope !== 'media-video' || payload.mediaId !== id) {
      throw new UnauthorizedException('Invalid video token');
    }

    const media = await this.prisma.mediaRef.findUnique({ where: { id } });
    if (!media) throw new NotFoundException('Media not found');
    const credentials = await this.connections.getCredentials(media.userId);
    if (!credentials) throw new NotFoundException('Media unavailable');

    const upstream = await this.immich.fetchVideo(
      credentials.serverUrl,
      credentials.apiKey,
      media.immichAssetId,
      range,
    );

    res.status(upstream.status);
    for (const header of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
      const value = upstream.headers.get(header);
      if (value) res.setHeader(header, value);
    }
    res.setHeader('Cache-Control', 'private, no-store');
    if (upstream.body) {
      Readable.fromWeb(upstream.body as NodeReadableStream).pipe(res);
    } else {
      res.end();
    }
  }
}
