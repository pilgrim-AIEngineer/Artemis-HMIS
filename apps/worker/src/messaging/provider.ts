/**
 * Messaging provider interface (MSG-01, docs/21 §1): one adapter is chosen by the
 * `whatsapp.provider` setting. The Meta Cloud API adapter is the first concrete one (Q13); the
 * fake adapter records messages for development and tests. Adapters never log a phone number or a
 * message body (AGENTS.md rule 15) and report errors as short codes.
 */

export class MessagingError extends Error {
  constructor(
    message: string,
    /** Temporary (network, 5xx, rate limit): the sender retries. Permanent ones fail at once. */
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'MessagingError';
  }
}

export interface TemplateRequest {
  /** `91XXXXXXXXXX` */
  to: string;
  templateName: string;
  language: 'en' | 'hi';
  /** Positional values for {{1}}, {{2}} … */
  params: string[];
  /** The outbox row id: the same key must never produce a second message. */
  idempotencyKey: string;
}

export interface DocumentRequest {
  to: string;
  bytes: Uint8Array;
  filename: string;
  mime: string;
  idempotencyKey: string;
}

export type DeliveryStatus = 'sent' | 'delivered' | 'read' | 'failed';

export interface WebhookEvents {
  statuses: { providerMessageId: string; status: DeliveryStatus }[];
  /** Mobiles (`91XXXXXXXXXX`) that replied STOP. */
  optOuts: string[];
}

export interface MessagingProvider {
  readonly name: string;
  /** Meta only delivers approved templates; the fake one does not care. */
  readonly requiresApprovedTemplates: boolean;
  sendTemplate(req: TemplateRequest): Promise<{ providerMessageId: string }>;
  sendDocument(req: DocumentRequest): Promise<{ providerMessageId: string }>;
  getStatus(providerMessageId: string): Promise<DeliveryStatus | 'unknown'>;
  parseWebhook(body: unknown): WebhookEvents;
}
