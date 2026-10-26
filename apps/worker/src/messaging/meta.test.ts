import { describe, expect, it } from 'vitest';
import { MetaCloudProvider } from './meta';
import { MessagingError } from './provider';

const mock = (respond: (url: string, init: RequestInit) => Response | Promise<Response>) => {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchFn = ((url: string, init: RequestInit) => {
    calls.push({ url, init });
    return Promise.resolve(respond(url, init));
  }) as typeof fetch;
  return {
    calls,
    provider: new MetaCloudProvider({ phoneNumberId: '123', accessToken: 'tok', fetch: fetchFn }),
  };
};
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const req = {
  to: '919876543210',
  templateName: 'hmis_receipt_hi',
  language: 'hi' as const,
  params: ['City Hospital', '₹500.00'],
  idempotencyKey: 'k',
};

describe('Meta Cloud API adapter', () => {
  it('posts a template message with positional body parameters', async () => {
    const { calls, provider } = mock(() => json(200, { messages: [{ id: 'wamid.X' }] }));
    await expect(provider.sendTemplate(req)).resolves.toEqual({ providerMessageId: 'wamid.X' });
    expect(calls[0]!.url).toBe('https://graph.facebook.com/v21.0/123/messages');
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer tok');
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      messaging_product: 'whatsapp',
      to: '919876543210',
      type: 'template',
      template: {
        name: 'hmis_receipt_hi',
        language: { code: 'hi' },
        components: [
          {
            type: 'body',
            parameters: [
              { type: 'text', text: 'City Hospital' },
              { type: 'text', text: '₹500.00' },
            ],
          },
        ],
      },
    });
  });

  it('treats rate limits, server errors and a dead network as temporary', async () => {
    for (const status of [429, 500, 503]) {
      const { provider } = mock(() => json(status, { error: { code: 4 } }));
      const e = (await provider.sendTemplate(req).catch((x: unknown) => x)) as MessagingError;
      expect(e).toBeInstanceOf(MessagingError);
      expect(e.retryable).toBe(true);
    }
    const offline = new MetaCloudProvider({
      phoneNumberId: '1',
      accessToken: 't',
      fetch: () => Promise.reject(new TypeError('fetch failed')),
    });
    const e = (await offline.sendTemplate(req).catch((x: unknown) => x)) as MessagingError;
    expect(e).toMatchObject({ message: 'meta:network', retryable: true });
  });

  it('treats a rejected number or template as permanent, keeping only codes in the message', async () => {
    const { provider } = mock(() =>
      json(400, { error: { code: 131026, message: 'Message undeliverable to 919876543210' } }),
    );
    const e = (await provider.sendTemplate(req).catch((x: unknown) => x)) as MessagingError;
    expect(e.retryable).toBe(false);
    expect(e.message).toBe('meta:400:131026');
    expect(e.message).not.toContain('9198');
  });

  it('uploads a document, then sends it by media id', async () => {
    const { calls, provider } = mock((url) =>
      url.endsWith('/media')
        ? json(200, { id: 'media1' })
        : json(200, { messages: [{ id: 'wamid.D' }] }),
    );
    const out = await provider.sendDocument({
      to: '919876543210',
      bytes: new Uint8Array([37, 80, 68, 70]),
      filename: 'receipt.pdf',
      mime: 'application/pdf',
      idempotencyKey: 'k',
    });
    expect(out.providerMessageId).toBe('wamid.D');
    expect(calls.map((c) => c.url.split('/').pop())).toEqual(['media', 'messages']);
    expect((JSON.parse(calls[1]!.init.body as string) as { document: unknown }).document).toEqual({
      id: 'media1',
      filename: 'receipt.pdf',
    });
  });

  it('reads delivery statuses and STOP replies from a webhook', () => {
    const { provider } = mock(() => json(200, {}));
    const events = provider.parseWebhook({
      entry: [
        {
          changes: [
            {
              value: {
                statuses: [
                  { id: 'wamid.A', status: 'delivered' },
                  { id: 'wamid.B', status: 'read' },
                  { id: 'wamid.C', status: 'weird' },
                ],
                messages: [
                  { from: '919876543210', text: { body: ' stop ' } },
                  { from: '919876543211', text: { body: 'thanks' } },
                ],
              },
            },
          ],
        },
      ],
    });
    expect(events.statuses).toEqual([
      { providerMessageId: 'wamid.A', status: 'delivered' },
      { providerMessageId: 'wamid.B', status: 'read' },
    ]);
    expect(events.optOuts).toEqual(['919876543210']);
    expect(provider.parseWebhook('junk')).toEqual({ statuses: [], optOuts: [] });
  });
});
