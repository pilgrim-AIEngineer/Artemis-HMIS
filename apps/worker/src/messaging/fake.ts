import { randomUUID } from 'node:crypto';
import {
  MessagingError,
  type DeliveryStatus,
  type DocumentRequest,
  type MessagingProvider,
  type TemplateRequest,
  type WebhookEvents,
} from './provider';

export interface FakeSent {
  kind: 'template' | 'document';
  to: string;
  providerMessageId: string;
  templateName?: string;
  language?: string;
  params?: string[];
  filename?: string;
}

/**
 * In-memory provider for development and tests. Sending twice with the same idempotency key
 * returns the first message id and records nothing new. `failNext` scripts errors.
 */
export class FakeProvider implements MessagingProvider {
  readonly name = 'fake';
  readonly requiresApprovedTemplates: boolean = false;
  readonly sent: FakeSent[] = [];
  /** Every call, including ones that failed or were deduplicated. */
  calls = 0;
  private readonly byKey = new Map<string, string>();
  private failures: MessagingError[] = [];

  /** The next `times` calls throw. */
  failNext(times: number, retryable = true, message = 'fake:unavailable'): this {
    this.failures = Array.from({ length: times }, () => new MessagingError(message, retryable));
    return this;
  }

  /** Every call throws until `failNext(0)`. */
  failForever(retryable = true): this {
    this.failures = Array.from(
      { length: 10_000 },
      () => new MessagingError('fake:down', retryable),
    );
    return this;
  }

  private record(key: string, entry: Omit<FakeSent, 'providerMessageId'>) {
    this.calls += 1;
    const failure = this.failures.shift();
    if (failure) throw failure;
    const known = this.byKey.get(key);
    if (known) return { providerMessageId: known };
    const providerMessageId = `fake.${randomUUID()}`;
    this.byKey.set(key, providerMessageId);
    this.sent.push({ ...entry, providerMessageId });
    return { providerMessageId };
  }

  sendTemplate(req: TemplateRequest) {
    return Promise.resolve(
      this.record(req.idempotencyKey, {
        kind: 'template',
        to: req.to,
        templateName: req.templateName,
        language: req.language,
        params: req.params,
      }),
    );
  }

  sendDocument(req: DocumentRequest) {
    return Promise.resolve(
      this.record(`doc:${req.idempotencyKey}`, {
        kind: 'document',
        to: req.to,
        filename: req.filename,
      }),
    );
  }

  getStatus(providerMessageId: string): Promise<DeliveryStatus | 'unknown'> {
    return Promise.resolve(
      this.sent.some((s) => s.providerMessageId === providerMessageId) ? 'delivered' : 'unknown',
    );
  }

  parseWebhook(): WebhookEvents {
    return { statuses: [], optOuts: [] };
  }
}
