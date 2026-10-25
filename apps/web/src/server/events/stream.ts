import type { EventHub } from './hub';

export interface StreamOptions {
  heartbeatMs?: number;
  /** Streams end after this long so the session is re-checked when the client reconnects. */
  maxAgeMs?: number;
  signal?: AbortSignal;
}

const enc = new TextEncoder();

/**
 * The SSE body for one browser: `ready` once, a `change` per event of the facility, `reset`
 * after a listener outage, a comment heartbeat so proxies keep the connection open, and an end
 * when the hub goes down or the stream is old. Clients poll while they have no stream.
 */
export function createEventStream(
  hub: EventHub,
  facilityId: string,
  opts: StreamOptions = {},
): ReadableStream<Uint8Array> {
  let cleanup = () => {};
  return new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const send = (chunk: string) => {
        if (!closed) controller.enqueue(enc.encode(chunk));
      };
      const close = () => {
        if (closed) return;
        closed = true;
        cleanup();
        try {
          controller.close();
        } catch {
          // already closed by the client
        }
      };
      const unsubscribe = hub.subscribe(facilityId, (signal) => {
        if (signal.kind === 'change') {
          send(
            `event: change\ndata: ${JSON.stringify({ t: signal.event.topic, d: signal.event.doctorId ?? null })}\n\n`,
          );
        } else if (signal.kind === 'reset') send('event: reset\ndata: {}\n\n');
        else close();
      });
      const beat = setInterval(() => send(': keep-alive\n\n'), opts.heartbeatMs ?? 15_000);
      const age = setTimeout(close, opts.maxAgeMs ?? 10 * 60_000);
      cleanup = () => {
        unsubscribe();
        clearInterval(beat);
        clearTimeout(age);
      };
      opts.signal?.addEventListener('abort', close, { once: true });
      send('retry: 3000\nevent: ready\ndata: {}\n\n');
    },
    cancel() {
      cleanup();
    },
  });
}
