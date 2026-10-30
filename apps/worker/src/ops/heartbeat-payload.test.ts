import type { OpsAlert } from '@hmis/shared';
import { describe, expect, it } from 'vitest';
import {
  HEARTBEAT_ALLOWED_KEYS,
  buildHeartbeatPayload,
  heartbeatPayloadSchema,
  installIdFromEnv,
} from './heartbeat-payload';

const now = new Date('2026-10-30T10:00:00Z');
const checks = {
  backup: { ok: true, state: 'ok' as const, lastBackupAgeHours: 1.5, targets: [] },
  disk: { ok: true, worst: { path: '/var/lib/postgresql', usedPct: 41.26, freeBytes: 1 } },
  queue: { ok: true, backlog: 3, oldestAgeSeconds: 120 },
};
const alert = (severity: OpsAlert['severity']): OpsAlert => ({
  code: 'disk.low',
  severity,
  message: 'Disk is almost full.',
});

describe('heartbeat payload', () => {
  it('allows only the reviewed keys (change this list only after privacy review)', () => {
    expect(HEARTBEAT_ALLOWED_KEYS).toEqual([
      'alerts',
      'at',
      'backupAgeMinutes',
      'diskUsedPct',
      'installId',
      'outboxBacklog',
      'queueLagSeconds',
      'status',
      'v',
    ]);
  });

  it('builds counts and codes only', () => {
    const p = buildHeartbeatPayload({
      installId: 'abcd1234',
      now,
      alerts: [alert('warning')],
      checks,
    });
    expect(p).toEqual({
      v: 1,
      installId: 'abcd1234',
      at: '2026-10-30T10:00:00.000Z',
      status: 'warn',
      alerts: ['disk.low'],
      backupAgeMinutes: 90,
      diskUsedPct: 41.3,
      outboxBacklog: 3,
      queueLagSeconds: 120,
    });
    expect(Object.keys(p).sort()).toEqual(HEARTBEAT_ALLOWED_KEYS);
  });

  it('is critical when any alert is critical, ok when none, and tolerates missing checks', () => {
    const base = { installId: 'abcd1234', now };
    expect(buildHeartbeatPayload({ ...base, alerts: [alert('critical')], checks }).status).toBe(
      'critical',
    );
    const empty = buildHeartbeatPayload({
      ...base,
      alerts: [],
      checks: {
        backup: { ...checks.backup, lastBackupAgeHours: null },
        disk: { ok: true, worst: null },
        queue: null,
      },
    });
    expect(empty).toMatchObject({
      status: 'ok',
      backupAgeMinutes: null,
      diskUsedPct: null,
      outboxBacklog: null,
    });
  });

  it('rejects an extra key, free text, or a hospital-name-like install id', () => {
    const good = buildHeartbeatPayload({ installId: 'abcd1234', now, alerts: [], checks });
    expect(heartbeatPayloadSchema.safeParse({ ...good, hospital: 'Some Hospital' }).success).toBe(
      false,
    );
    expect(heartbeatPayloadSchema.safeParse({ ...good, alerts: ['Ravi Kumar'] }).success).toBe(
      false,
    );
    expect(
      heartbeatPayloadSchema.safeParse({ ...good, installId: 'Sharma Nursing Home' }).success,
    ).toBe(false);
  });

  it('reads the install id from env, never from the alert label', () => {
    expect(installIdFromEnv({ HMIS_INSTALL_ID: 'a1b2c3d4e5' })).toBe('a1b2c3d4e5');
    expect(installIdFromEnv({ OPS_ALERT_LABEL: 'Sharma Hospital' })).toBe('unset-install');
    expect(installIdFromEnv({ HMIS_INSTALL_ID: 'has spaces!' })).toBe('unset-install');
  });
});
