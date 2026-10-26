import type { OpsAlert } from '@hmis/shared';
import { createLogger } from '@hmis/shared/logger';
import { describe, expect, it, vi } from 'vitest';
import {
  AlertThrottle,
  alertSinksFromEnv,
  dispatchAlerts,
  formatAlertText,
  sendAlerts,
} from './alerts';

const logger = createLogger('test', 'silent');
const alert = (code: OpsAlert['code'], severity: OpsAlert['severity'] = 'warning'): OpsAlert => ({
  code,
  severity,
  message: `${code} message`,
});
const T0 = new Date('2026-10-26T06:00:00Z');
const after = (h: number) => new Date(T0.getTime() + h * 3_600_000);

describe('AlertThrottle', () => {
  it('sends once, repeats after the interval, and re-fires after a clear', () => {
    const th = new AlertThrottle(6 * 3_600_000);
    const a = [alert('disk.low')];
    expect(th.due(a, T0)).toEqual(a);
    th.markSent(a, T0);
    expect(th.due(a, after(1))).toEqual([]);
    expect(th.due(a, after(6))).toEqual(a);
    th.markSent(a, after(6));
    expect(th.due([], after(7))).toEqual([]); // cleared
    expect(th.due(a, after(7.5))).toEqual(a); // came back: immediate
  });
});

describe('sendAlerts', () => {
  const sinks = (over = {}) => ({
    ...alertSinksFromEnv({ OPS_ALERT_LABEL: 'pilot' }),
    webhookUrl: 'https://hooks.example/x',
    ...over,
  });

  it('posts to the webhook and Telegram', async () => {
    const f = vi.fn(() => Promise.resolve(new Response('ok')));
    const ok = await sendAlerts(
      [alert('backup.local_stale', 'critical')],
      sinks({ telegram: { token: 'TOKEN', chatId: '42' } }),
      logger,
      f as unknown as typeof fetch,
    );
    expect(ok).toBe(true);
    expect(f).toHaveBeenCalledTimes(2);
    const calls = f.mock.calls as unknown as [string, { body: string }][];
    expect(calls[0]![0]).toBe('https://hooks.example/x');
    expect(calls[1]![0]).toBe('https://api.telegram.org/botTOKEN/sendMessage');
    expect(JSON.parse(calls[1]![1].body)).toMatchObject({ chat_id: '42' });
    expect(calls[0]![1].body).toContain('CRITICAL [pilot]');
  });

  it('reports failure (offline) without throwing, so the alert is retried', async () => {
    const f = vi.fn(() => Promise.reject(new TypeError('fetch failed')));
    const ok = await sendAlerts([alert('disk.low')], sinks(), logger, f as unknown as typeof fetch);
    expect(ok).toBe(false);
  });

  it('counts as delivered when no sink is configured (logged only)', async () => {
    const f = vi.fn();
    const ok = await sendAlerts(
      [alert('disk.low')],
      alertSinksFromEnv({}),
      logger,
      f as unknown as typeof fetch,
    );
    expect(ok).toBe(true);
    expect(f).not.toHaveBeenCalled();
  });

  it('dispatchAlerts only marks delivered alerts as sent', async () => {
    const throttle = new AlertThrottle(3_600_000);
    const down = vi.fn(() => Promise.reject(new Error('offline')));
    const a = [alert('disk.low')];
    const base = { active: a, throttle, sinks: sinks(), logger, now: T0 };
    expect(await dispatchAlerts({ ...base, fetchImpl: down as unknown as typeof fetch })).toEqual(
      [],
    );
    const up = vi.fn(() => Promise.resolve(new Response('ok')));
    expect(await dispatchAlerts({ ...base, fetchImpl: up as unknown as typeof fetch })).toEqual(a);
    expect(await dispatchAlerts({ ...base, fetchImpl: up as unknown as typeof fetch })).toEqual([]);
  });
});

describe('formatAlertText', () => {
  it('marks the message critical when any alert is', () => {
    const text = formatAlertText('pilot', [alert('disk.low'), alert('db.down', 'critical')]);
    expect(text.split('\n')[0]).toBe('CRITICAL [pilot]');
    expect(text).toContain('db.down');
  });
});
