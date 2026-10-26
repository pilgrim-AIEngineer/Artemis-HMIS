import pg from 'pg';
import { z } from 'zod';

/** Postgres channel written by the `opd_token` trigger (migration 0013) and future producers. */
export const EVENTS_CHANNEL = 'hmis_events';

/** `{f: facility, t: topic, d: doctor}`: ids only, never patient data (AGENTS.md rule 15). */
const payloadSchema = z.object({
  f: z.uuid(),
  t: z.enum(['queue']),
  d: z.uuid().optional(),
});

export interface ChangeEvent {
  topic: 'queue';
  doctorId?: string;
}

export type HubSignal =
  | { kind: 'change'; event: ChangeEvent }
  /** The listener connection came back after a gap: events may have been missed, re-read. */
  | { kind: 'reset' }
  /** The listener connection is down: streams end so clients fall back to polling. */
  | { kind: 'down' };

export type HubListener = (signal: HubSignal) => void;

export interface HubOptions {
  connectionString: string;
  /** First and maximum reconnect delay in ms. */
  retryMinMs?: number;
  retryMaxMs?: number;
  log?: (msg: string) => void;
}

/**
 * One dedicated Postgres connection `LISTEN`ing on `hmis_events`, fanned out per facility to the
 * SSE streams of this process (docs/01 §2). It reconnects with backoff and tells listeners when
 * it was down, so no client ever waits on a silent stream: the stream ends and the client polls.
 */
export class EventHub {
  private readonly listeners = new Map<string, Set<HubListener>>();
  private client: pg.Client | null = null;
  private connecting = false;
  private stopped = false;
  private up = false;
  private hadOutage = false;
  private retryMs: number;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly opts: HubOptions) {
    this.retryMs = opts.retryMinMs ?? 1_000;
  }

  get isUp(): boolean {
    return this.up;
  }

  /** Starts connecting (idempotent). Resolves when the first attempt has finished. */
  async start(): Promise<void> {
    this.stopped = false;
    if (!this.client && !this.connecting) await this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const c = this.client;
    this.client = null;
    this.up = false;
    await c?.end().catch(() => undefined);
  }

  /** Subscribes to one facility's events. Returns the unsubscribe function. */
  subscribe(facilityId: string, listener: HubListener): () => void {
    let set = this.listeners.get(facilityId);
    if (!set) this.listeners.set(facilityId, (set = new Set()));
    set.add(listener);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(facilityId);
    };
  }

  private emit(facilityId: string | null, signal: HubSignal) {
    const targets =
      facilityId === null
        ? [...this.listeners.values()].flatMap((s) => [...s])
        : [...(this.listeners.get(facilityId) ?? [])];
    for (const l of targets) {
      try {
        l(signal);
      } catch {
        // A broken stream must not stop the others.
      }
    }
  }

  private async connect(): Promise<void> {
    this.connecting = true;
    const client = new pg.Client({
      connectionString: this.opts.connectionString,
      application_name: 'hmis-web-events',
      connectionTimeoutMillis: 5_000,
    });
    // Without a listener a dropped connection would crash the process (see createPool).
    client.on('error', (err: Error) => this.lost(client, err));
    client.on('end', () => this.lost(client));
    client.on('notification', (n) => {
      if (n.channel !== EVENTS_CHANNEL || !n.payload) return;
      let parsed: z.infer<typeof payloadSchema>;
      try {
        parsed = payloadSchema.parse(JSON.parse(n.payload));
      } catch {
        return;
      }
      this.emit(parsed.f, { kind: 'change', event: { topic: parsed.t, doctorId: parsed.d } });
    });
    try {
      await client.connect();
      await client.query(`LISTEN ${EVENTS_CHANNEL}`);
      if (this.stopped) {
        await client.end().catch(() => undefined);
        return;
      }
      this.client = client;
      this.up = true;
      this.retryMs = this.opts.retryMinMs ?? 1_000;
      if (this.hadOutage) this.emit(null, { kind: 'reset' });
      this.hadOutage = false;
    } catch (err) {
      await client.end().catch(() => undefined);
      this.scheduleRetry(err as Error);
    } finally {
      this.connecting = false;
    }
  }

  private lost(client: pg.Client, err?: Error) {
    if (this.client !== client) return;
    this.client = null;
    this.up = false;
    this.hadOutage = true;
    this.emit(null, { kind: 'down' });
    client.end().catch(() => undefined);
    this.scheduleRetry(err);
  }

  private scheduleRetry(err?: Error) {
    this.hadOutage = true;
    if (this.stopped || this.timer) return;
    this.opts.log?.(`events listener down${err ? `: ${err.message}` : ''}`);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.connect();
    }, this.retryMs);
    this.retryMs = Math.min(this.retryMs * 2, this.opts.retryMaxMs ?? 10_000);
  }
}
