import type { OpsAlert } from '@hmis/shared';
import type { Logger } from '@hmis/shared/logger';

type Env = Record<string, string | undefined>;
type Fetch = typeof fetch;

/** Where vendor alerts go (docs/31 §5). Everything is optional: no sink = log only. */
export interface AlertSinks {
  /** Shown at the start of every message so the vendor knows which hospital it is. */
  label: string;
  webhookUrl: string | null;
  telegram: { token: string; chatId: string } | null;
  repeatMs: number;
}

export function alertSinksFromEnv(env: Env): AlertSinks {
  const token = env.OPS_TELEGRAM_BOT_TOKEN?.trim();
  const chatId = env.OPS_TELEGRAM_CHAT_ID?.trim();
  const repeatHours = Number(env.OPS_ALERT_REPEAT_HOURS);
  return {
    label: env.OPS_ALERT_LABEL?.trim() || env.HMIS_HOSTNAME?.trim() || 'hmis',
    webhookUrl: env.OPS_ALERT_WEBHOOK_URL?.trim() || null,
    telegram: token && chatId ? { token, chatId } : null,
    repeatMs: (Number.isFinite(repeatHours) && repeatHours > 0 ? repeatHours : 6) * 3_600_000,
  };
}

/**
 * Re-sends an open alert at most every `repeatMs`; an alert that clears is forgotten, so it
 * fires again at once if the problem comes back. In memory: a worker restart repeats alerts once.
 */
export class AlertThrottle {
  private readonly last = new Map<string, number>();
  constructor(private readonly repeatMs: number) {}

  /** `active` = every alert open right now; returns the ones that are due to be sent. */
  due(active: readonly OpsAlert[], now: Date): OpsAlert[] {
    const open = new Set(active.map((a) => a.code));
    for (const code of this.last.keys())
      if (!open.has(code as OpsAlert['code'])) this.last.delete(code);
    return active.filter((a) => {
      const at = this.last.get(a.code);
      return at === undefined || now.getTime() - at >= this.repeatMs;
    });
  }

  markSent(sent: readonly OpsAlert[], now: Date): void {
    for (const a of sent) this.last.set(a.code, now.getTime());
  }
}

export function formatAlertText(label: string, alerts: readonly OpsAlert[]): string {
  const critical = alerts.some((a) => a.severity === 'critical');
  return [
    `${critical ? 'CRITICAL' : 'WARNING'} [${label}]`,
    ...alerts.map((a) => `- (${a.severity}) ${a.code}: ${a.message}`),
  ].join('\n');
}

const SEND_TIMEOUT_MS = 10_000;

/**
 * Posts alerts to the configured sinks. Never throws and never waits long: the hospital may be
 * offline, in which case the alert is simply tried again at the next due time (rule 11).
 * Returns true when it counts as delivered (some sink accepted it, or none is configured).
 */
export async function sendAlerts(
  alerts: readonly OpsAlert[],
  sinks: AlertSinks,
  logger: Logger,
  fetchImpl: Fetch = fetch,
): Promise<boolean> {
  if (alerts.length === 0) return true;
  const text = formatAlertText(sinks.label, alerts);
  if (!sinks.webhookUrl && !sinks.telegram) {
    logger.warn({ alerts: alerts.map((a) => a.code) }, 'ops alert (no alert sink configured)');
    return true;
  }
  const post = async (url: string, body: unknown): Promise<boolean> => {
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });
      return res.ok;
    } catch {
      return false;
    }
  };
  const results: boolean[] = [];
  if (sinks.webhookUrl) {
    results.push(await post(sinks.webhookUrl, { text, label: sinks.label, alerts }));
  }
  if (sinks.telegram) {
    // The bot token is part of the URL: never log it.
    results.push(
      await post(`https://api.telegram.org/bot${sinks.telegram.token}/sendMessage`, {
        chat_id: sinks.telegram.chatId,
        text,
      }),
    );
  }
  const ok = results.some(Boolean);
  if (!ok)
    logger.warn({ alerts: alerts.map((a) => a.code) }, 'ops alert not delivered, will retry');
  return ok;
}

/** Throttle + send. Returns the alerts that were sent. */
export async function dispatchAlerts(opts: {
  active: readonly OpsAlert[];
  throttle: AlertThrottle;
  sinks: AlertSinks;
  logger: Logger;
  now: Date;
  fetchImpl?: Fetch;
}): Promise<OpsAlert[]> {
  const due = opts.throttle.due(opts.active, opts.now);
  if (due.length === 0) return [];
  const delivered = await sendAlerts(due, opts.sinks, opts.logger, opts.fetchImpl);
  if (!delivered) return [];
  opts.throttle.markSent(due, opts.now);
  return due;
}
