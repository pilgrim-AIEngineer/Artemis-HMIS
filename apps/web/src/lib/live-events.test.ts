import { describe, expect, it } from 'vitest';
import { startLiveEvents, type EventSourceLike } from './live-events';

class FakeSource implements EventSourceLike {
  listeners = new Map<string, () => void>();
  onerror: (() => void) | null = null;
  closed = false;
  addEventListener(type: string, l: () => void) {
    this.listeners.set(type, l);
  }
  close() {
    this.closed = true;
  }
  emit(type: string) {
    this.listeners.get(type)?.();
  }
}

function harness() {
  const sources: FakeSource[] = [];
  const timers: { fn: () => void; ms: number; id: number }[] = [];
  const log = { changes: 0, status: [] as boolean[] };
  let next = 1;
  const stop = startLiveEvents({
    open: () => {
      const s = new FakeSource();
      sources.push(s);
      return s;
    },
    onChange: () => (log.changes += 1),
    onStatus: (v) => log.status.push(v),
    setTimer: (fn, ms) => {
      const id = next++;
      timers.push({ fn, ms, id });
      return id;
    },
    clearTimer: (id) => {
      const i = timers.findIndex((t) => t.id === id);
      if (i >= 0) timers.splice(i, 1);
    },
  });
  return { sources, timers, log, stop };
}

describe('live events', () => {
  it('goes live on ready, refreshes on every event', () => {
    const h = harness();
    h.sources[0]!.emit('ready');
    expect(h.log.status).toEqual([true]);
    expect(h.log.changes).toBe(1);
    h.sources[0]!.emit('change');
    h.sources[0]!.emit('reset');
    expect(h.log.changes).toBe(3);
  });

  it('falls back to polling on a stream error and retries every 5 s', () => {
    const h = harness();
    h.sources[0]!.emit('ready');
    h.sources[0]!.onerror!();
    expect(h.log.status).toEqual([true, false]);
    expect(h.sources[0]!.closed).toBe(true);
    expect(h.timers).toHaveLength(1);
    expect(h.timers[0]!.ms).toBe(5_000);
    h.timers.shift()!.fn();
    expect(h.sources).toHaveLength(2);
    h.sources[1]!.onerror!(); // 503 again
    h.sources[1]!.onerror!(); // duplicate error events schedule one retry only
    expect(h.timers).toHaveLength(1);
    h.timers.shift()!.fn();
    h.sources[2]!.emit('ready');
    expect(h.log.status.at(-1)).toBe(true);
  });

  it('stop closes the stream and cancels the retry', () => {
    const h = harness();
    h.sources[0]!.onerror!();
    h.stop();
    expect(h.timers).toHaveLength(0);
    const h2 = harness();
    h2.sources[0]!.emit('ready');
    h2.stop();
    expect(h2.sources[0]!.closed).toBe(true);
    h2.sources[0]!.onerror?.();
    expect(h2.timers).toHaveLength(0);
  });

  it('keeps retrying when opening the source throws', () => {
    let calls = 0;
    const timers: (() => void)[] = [];
    const status: boolean[] = [];
    startLiveEvents({
      open: () => {
        calls += 1;
        throw new Error('no EventSource');
      },
      onChange: () => {},
      onStatus: (v) => status.push(v),
      setTimer: (fn) => timers.push(fn),
    });
    timers.shift()!();
    expect(calls).toBe(2);
    expect(status).toEqual([false, false]);
  });
});
