/**
 * Browser side of `/api/events` (docs/01 §2): keeps one EventSource open, calls `onChange` on
 * every server event, and reports whether the stream is live. While it is not, the screen polls
 * every `POLL_MS` (5 s) instead, and the connection is retried at the same pace. `EventSource`
 * never retries after an HTTP error (the 503 while the listener is down), so retries are ours.
 * Pure of React and of the DOM so it can be tested in Node with a fake source.
 */

export const POLL_MS = 5_000;
/** While the stream is live a slow poll still catches anything a dropped event missed. */
export const SAFETY_POLL_MS = 60_000;

export interface EventSourceLike {
  addEventListener(type: string, listener: () => void): void;
  close(): void;
  onerror: (() => void) | null;
}

export interface LiveOptions {
  open: () => EventSourceLike;
  onChange: () => void;
  onStatus: (live: boolean) => void;
  retryMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (id: unknown) => void;
}

/** Returns a `stop` function. */
export function startLiveEvents(opts: LiveOptions): () => void {
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((id) => clearTimeout(id as ReturnType<typeof setTimeout>));
  let source: EventSourceLike | null = null;
  let timer: unknown = null;
  let stopped = false;

  const connect = () => {
    timer = null;
    if (stopped) return;
    let es: EventSourceLike;
    try {
      es = opts.open();
    } catch {
      opts.onStatus(false);
      timer = setTimer(connect, opts.retryMs ?? POLL_MS);
      return;
    }
    source = es;
    es.addEventListener('ready', () => {
      opts.onStatus(true);
      // A gap before the stream opened may have hidden changes.
      opts.onChange();
    });
    es.addEventListener('change', () => opts.onChange());
    es.addEventListener('reset', () => opts.onChange());
    es.onerror = () => {
      if (source !== es) return;
      es.close();
      source = null;
      opts.onStatus(false);
      if (!stopped && timer === null) timer = setTimer(connect, opts.retryMs ?? POLL_MS);
    };
  };
  connect();

  return () => {
    stopped = true;
    if (timer !== null) clearTimer(timer);
    source?.close();
    source = null;
  };
}
