import { Injectable, Logger } from '@nestjs/common';
import { chatIdFor } from './phone';

export type WhatsappState =
  | 'DISABLED'
  | 'UNREACHABLE'
  | 'STOPPED'
  | 'STARTING'
  | 'SCAN_QR_CODE'
  | 'WORKING'
  | 'FAILED';

export interface WhatsappStatus {
  state: WhatsappState;
  /** The number messages go out from, once linked. */
  number: string | null;
}

/** Between two messages: a burst of identical texts is what gets a number banned. */
const SEND_GAP_MS = 2500;

/**
 * Talks to WAHA, the WhatsApp Web bridge running next to the API, which sends
 * as an ordinary WhatsApp account linked by QR code.
 *
 * Nothing here ever fails the request that caused a message: a comment is
 * saved whether or not WhatsApp is linked, up, or in a mood. Messages go into
 * a queue and leave one at a time.
 */
@Injectable()
export class WhatsappService {
  private readonly logger = new Logger(WhatsappService.name);
  private readonly baseUrl = process.env.WAHA_URL?.replace(/\/$/, '') ?? '';
  private readonly apiKey = process.env.WAHA_API_KEY ?? '';
  private readonly session = process.env.WAHA_SESSION || 'default';
  private queue: Promise<void> = Promise.resolve();

  get enabled(): boolean {
    return Boolean(this.baseUrl && this.apiKey);
  }

  /** Queue a text; returns at once. */
  send(phone: string, text: string): void {
    if (!this.enabled) {
      this.logger.debug(`WhatsApp not configured; not sending to ${phone}`);
      return;
    }
    this.queue = this.queue.then(async () => {
      try {
        await this.request('POST', '/api/sendText', {
          session: this.session,
          chatId: chatIdFor(phone),
          text,
        });
      } catch (err) {
        this.logger.warn(
          `WhatsApp to ${phone} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, SEND_GAP_MS));
    });
  }

  /** Send to a chat as it came in (a reply to an incoming message). */
  sendToChat(chatId: string, text: string): void {
    if (!this.enabled) return;
    this.queue = this.queue.then(async () => {
      try {
        await this.request('POST', '/api/sendText', { session: this.session, chatId, text });
      } catch (err) {
        this.logger.warn(`WhatsApp reply failed: ${err instanceof Error ? err.message : err}`);
      }
    });
  }

  async status(): Promise<WhatsappStatus> {
    if (!this.enabled) return { state: 'DISABLED', number: null };
    try {
      const res = await this.raw('GET', `/api/sessions/${this.session}`);
      if (res.status === 404) return { state: 'STOPPED', number: null };
      if (!res.ok) return { state: 'UNREACHABLE', number: null };
      const body = (await res.json()) as { status?: string; me?: { id?: string } | null };
      const id = body.me?.id?.split('@')[0];
      return {
        state: (body.status as WhatsappState | undefined) ?? 'UNREACHABLE',
        number: id ? `+${id}` : null,
      };
    } catch {
      return { state: 'UNREACHABLE', number: null };
    }
  }

  /** Make sure the session exists and runs; it then asks for a QR scan. */
  async start(): Promise<void> {
    const res = await this.raw('POST', `/api/sessions/${this.session}/start`);
    if (res.status === 404) {
      await this.request('POST', '/api/sessions', { name: this.session, start: true });
    } else if (!res.ok && res.status !== 422) {
      throw new Error(`WAHA start: ${res.status}`);
    }
  }

  async qr(): Promise<Buffer> {
    const res = await this.raw('GET', `/api/${this.session}/auth/qr`, undefined, 'image/png');
    if (!res.ok) throw new Error(`WAHA qr: ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }

  async logout(): Promise<void> {
    await this.request('POST', `/api/sessions/${this.session}/logout`);
  }

  private async request(method: string, path: string, body?: unknown): Promise<void> {
    const res = await this.raw(method, path, body);
    if (!res.ok) throw new Error(`WAHA ${method} ${path}: ${res.status} ${await res.text()}`);
  }

  private raw(method: string, path: string, body?: unknown, accept = 'application/json') {
    return fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        'X-Api-Key': this.apiKey,
        accept,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
  }
}
