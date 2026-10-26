import { describe, expect, it } from 'vitest';
import {
  DEFAULT_OPS_THRESHOLDS,
  evaluateBackup,
  evaluateDisk,
  evaluateQueue,
  type BackupStatus,
  type BackupTargetStatus,
} from './ops';

const NOW = new Date('2026-10-26T06:00:00Z');
const ago = (hours: number) => new Date(NOW.getTime() - hours * 3_600_000).toISOString();

const target = (over: Partial<BackupTargetStatus> = {}): BackupTargetStatus => ({
  lastAttemptAt: ago(1),
  lastDbSuccessAt: ago(1),
  lastFilesSuccessAt: ago(5),
  lastError: null,
  snapshotId: 'abc123',
  ...over,
});

const status = (targets: BackupStatus['targets']): BackupStatus => ({
  version: 1,
  updatedAt: ago(0),
  targets,
});

const codes = (r: { alerts: { code: string }[] }) => r.alerts.map((a) => a.code);

describe('evaluateBackup', () => {
  it('is critical when no status file exists', () => {
    const r = evaluateBackup(null, NOW);
    expect(r.check.state).toBe('missing');
    expect(r.alerts).toMatchObject([{ code: 'backup.missing', severity: 'critical' }]);
  });

  it('is ok when every target is fresh', () => {
    const r = evaluateBackup(
      status({
        local: target(),
        usb: target({ diskId: 'A', diskSwappedAt: ago(48) }),
        s3: target({ lastDbSuccessAt: ago(20) }),
      }),
      NOW,
    );
    expect(r.alerts).toEqual([]);
    expect(r.check).toMatchObject({ ok: true, state: 'ok', lastBackupAgeHours: 1 });
    expect(r.check.targets.map((t) => t.name)).toEqual(['local', 'usb', 's3']);
  });

  it('alerts when the local database backup is older than 24 h (boundary)', () => {
    const atLimit = evaluateBackup(status({ local: target({ lastDbSuccessAt: ago(24) }) }), NOW);
    expect(atLimit.alerts).toEqual([]);
    const over = evaluateBackup(status({ local: target({ lastDbSuccessAt: ago(24.1) }) }), NOW);
    expect(over.alerts).toMatchObject([{ code: 'backup.local_stale', severity: 'critical' }]);
  });

  it('includes the last error in the message', () => {
    const r = evaluateBackup(
      status({ local: target({ lastDbSuccessAt: ago(30), lastError: 'pg_dump failed' }) }),
      NOW,
    );
    expect(r.alerts[0]?.message).toContain('pg_dump failed');
  });

  it('treats a target that never succeeded as stale', () => {
    const r = evaluateBackup(
      status({ local: target(), s3: target({ lastDbSuccessAt: null, lastFilesSuccessAt: null }) }),
      NOW,
    );
    expect(codes(r)).toContain('backup.cloud_lag');
  });

  it('flags cloud lag only after 48 h', () => {
    const ok = evaluateBackup(
      status({ local: target(), s3: target({ lastDbSuccessAt: ago(47) }) }),
      NOW,
    );
    expect(ok.alerts).toEqual([]);
    const lag = evaluateBackup(
      status({ local: target(), s3: target({ lastDbSuccessAt: ago(49) }) }),
      NOW,
    );
    expect(lag.alerts).toMatchObject([{ code: 'backup.cloud_lag', severity: 'warning' }]);
  });

  it('flags a USB disk that was not swapped for more than 8 days', () => {
    const fine = evaluateBackup(
      status({ local: target(), usb: target({ diskSwappedAt: ago(8 * 24) }) }),
      NOW,
    );
    expect(fine.alerts).toEqual([]);
    const stale = evaluateBackup(
      status({ local: target(), usb: target({ diskSwappedAt: ago(8 * 24 + 1) }) }),
      NOW,
    );
    expect(codes(stale)).toEqual(['backup.usb_not_rotated']);
  });

  it('flags an unplugged USB disk', () => {
    const r = evaluateBackup(
      status({
        local: target(),
        usb: target({ lastDbSuccessAt: ago(50), lastError: 'usb disk not mounted' }),
      }),
      NOW,
    );
    expect(codes(r)).toContain('backup.usb_stale');
  });

  it('flags stale files even when the database backup is fresh', () => {
    const r = evaluateBackup(status({ local: target({ lastFilesSuccessAt: ago(40) }) }), NOW);
    expect(r.alerts).toMatchObject([{ code: 'backup.files_stale', severity: 'critical' }]);
  });

  it('reports a missing local target', () => {
    const r = evaluateBackup(status({ s3: target() }), NOW);
    expect(codes(r)).toContain('backup.local_stale');
  });

  it('honours custom thresholds', () => {
    const r = evaluateBackup(status({ local: target({ lastDbSuccessAt: ago(3) }) }), NOW, {
      ...DEFAULT_OPS_THRESHOLDS,
      backupMaxAgeHours: 2,
    });
    expect(codes(r)).toEqual(['backup.local_stale']);
  });
});

describe('evaluateDisk', () => {
  const GB = 1e9;
  it('is fine at 80 % used and warns above', () => {
    expect(evaluateDisk([{ path: '/a', totalBytes: 100 * GB, freeBytes: 20 * GB }]).alerts).toEqual(
      [],
    );
    const r = evaluateDisk([{ path: '/a', totalBytes: 100 * GB, freeBytes: 19 * GB }]);
    expect(r.alerts).toMatchObject([{ code: 'disk.low', severity: 'warning' }]);
  });
  it('is critical above 90 % and reports the fullest volume', () => {
    const r = evaluateDisk([
      { path: '/ok', totalBytes: 100 * GB, freeBytes: 90 * GB },
      { path: '/full', totalBytes: 100 * GB, freeBytes: 5 * GB },
    ]);
    expect(r.check.worst).toMatchObject({ path: '/full', usedPct: 95 });
    expect(r.alerts[0]?.severity).toBe('critical');
  });
  it('has nothing to say without samples', () => {
    expect(evaluateDisk([])).toEqual({ check: { ok: true, worst: null }, alerts: [] });
  });
});

describe('evaluateQueue', () => {
  it('alerts above the backlog limit only', () => {
    expect(evaluateQueue({ backlog: 500, oldestAgeSeconds: 10 }).alerts).toEqual([]);
    expect(codes(evaluateQueue({ backlog: 501, oldestAgeSeconds: 10 }))).toEqual(['queue.backlog']);
  });
});
