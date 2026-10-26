import {
  MessagingError,
  type DeliveryStatus,
  type DocumentRequest,
  type MessagingProvider,
  type TemplateRequest,
  type WebhookEvents,
} from './provider';

export interface MetaConfig {
  phoneNumberId: string;
  accessToken: string;
  apiVersion?: string;
  /** For tests; defaults to the global fetch. */
  fetch?: typeof fetch;
  baseUrl?: string;
}

/** Reads the credentials from the server environment (never from the database or settings). */
export function metaConfigFromEnv(env: NodeJS.ProcessEnv = process.env): MetaConfig | null {
  const phoneNumberId = env.WHATSAPP_PHONE_NUMBER_ID;
  const accessToken = env.WHATSAPP_ACCESS_TOKEN;
  return phoneNumberId && accessToken ? { phoneNumberId, accessToken } : null;
}

const STATUS: Record<string, DeliveryStatus> = {
  sent: 'sent',
  delivered: 'delivered',
  read: 'read',
  failed: 'failed',
};

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

/** WhatsApp Business Cloud API (Graph API) adapter. */
export class MetaCloudProvider implements MessagingProvider {
  readonly name = 'meta';
  readonly requiresApprovedTemplates = true;
  private readonly base: string;
  private readonly doFetch: typeof fetch;

  constructor(private readonly cfg: MetaConfig) {
    this.base = `${cfg.baseUrl ?? 'https://graph.facebook.com'}/${cfg.apiVersion ?? 'v21.0'}`;
    this.doFetch = cfg.fetch ?? fetch;
  }

  private async call(path: string, init: RequestInit): Promise<Record<string, unknown>> {
    let res: Response;
    try {
      res = await this.doFetch(`${this.base}/${path}`, {
        ...init,
        headers: { authorization: `Bearer ${this.cfg.accessToken}`, ...init.headers },
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      // Offline, DNS, timeout: the counter is never blocked, the worker retries (rule 11).
      throw new MessagingError('meta:network', true);
    }
    const body = (await res.json().catch(() => null)) as unknown;
    if (!res.ok) {
      const raw = isObj(body) && isObj(body.error) ? body.error.code : null;
      const code = typeof raw === 'number' || typeof raw === 'string' ? String(raw) : '';
      // 429 and 5xx are temporary; anything else (bad number, template not approved) is not.
      throw new MessagingError(
        `meta:${res.status}${code ? `:${code}` : ''}`,
        res.status === 429 || res.status >= 500,
      );
    }
    return isObj(body) ? body : {};
  }

  private messageId(body: Record<string, unknown>): string {
    const list: unknown[] = Array.isArray(body.messages) ? body.messages : [];
    const m = list[0];
    if (!isObj(m) || typeof m.id !== 'string') throw new MessagingError('meta:no_message_id', true);
    return m.id;
  }

  async sendTemplate(req: TemplateRequest) {
    const body = await this.call(`${this.cfg.phoneNumberId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: req.to,
        type: 'template',
        template: {
          name: req.templateName,
          language: { code: req.language },
          components: [
            { type: 'body', parameters: req.params.map((text) => ({ type: 'text', text })) },
          ],
        },
      }),
    });
    return { providerMessageId: this.messageId(body) };
  }

  async sendDocument(req: DocumentRequest) {
    const form = new FormData();
    form.set('messaging_product', 'whatsapp');
    form.set('type', req.mime);
    form.set('file', new Blob([req.bytes as BlobPart], { type: req.mime }), req.filename);
    const media = await this.call(`${this.cfg.phoneNumberId}/media`, {
      method: 'POST',
      body: form,
    });
    if (typeof media.id !== 'string') throw new MessagingError('meta:no_media_id', true);
    const body = await this.call(`${this.cfg.phoneNumberId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: req.to,
        type: 'document',
        document: { id: media.id, filename: req.filename },
      }),
    });
    return { providerMessageId: this.messageId(body) };
  }

  /** Meta reports status by webhook only; without one the status stays `unknown`. */
  getStatus(): Promise<DeliveryStatus | 'unknown'> {
    return Promise.resolve('unknown');
  }

  parseWebhook(payload: unknown): WebhookEvents {
    const out: WebhookEvents = { statuses: [], optOuts: [] };
    if (!isObj(payload) || !Array.isArray(payload.entry)) return out;
    for (const entry of payload.entry) {
      if (!isObj(entry) || !Array.isArray(entry.changes)) continue;
      for (const change of entry.changes) {
        const value = isObj(change) ? change.value : null;
        if (!isObj(value)) continue;
        for (const s of Array.isArray(value.statuses) ? value.statuses : []) {
          if (
            isObj(s) &&
            typeof s.id === 'string' &&
            typeof s.status === 'string' &&
            STATUS[s.status]
          ) {
            out.statuses.push({ providerMessageId: s.id, status: STATUS[s.status]! });
          }
        }
        for (const m of Array.isArray(value.messages) ? value.messages : []) {
          const text = isObj(m) && isObj(m.text) ? m.text.body : null;
          if (isObj(m) && typeof m.from === 'string' && typeof text === 'string') {
            if (text.trim().toUpperCase() === 'STOP') out.optOuts.push(m.from);
          }
        }
      }
    }
    return out;
  }
}
