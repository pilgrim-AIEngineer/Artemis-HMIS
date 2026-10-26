import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { collectOpsChecks, opsThresholdsFromEnv, readBackupStatus } from './ops-node';

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'ops-node-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

describe('readBackupStatus', () => {
  it('returns null for missing and malformed files', async () => {
    expect(await readBackupStatus(path.join(dir, 'nope.json'))).toBeNull();
    const bad = path.join(dir, 'bad.json');
    await writeFile(bad, '{not json');
    expect(await readBackupStatus(bad)).toBeNull();
    await writeFile(bad, JSON.stringify({ version: 2 }));
    expect(await readBackupStatus(bad)).toBeNull();
  });
});

describe('opsThresholdsFromEnv', () => {
  it('uses defaults and ignores junk values', () => {
    expect(
      opsThresholdsFromEnv({ OPS_BACKUP_MAX_AGE_HOURS: '12', OPS_QUEUE_BACKLOG_MAX: 'x' }),
    ).toMatchObject({
      backupMaxAgeHours: 12,
      queueBacklogMax: 500,
      cloudMaxLagHours: 48,
    });
  });
});

describe('collectOpsChecks', () => {
  it('combines backup, disk and queue alerts', async () => {
    const file = path.join(dir, 'status.json');
    const t = {
      lastAttemptAt: iso(0),
      lastDbSuccessAt: iso(1000),
      lastFilesSuccessAt: iso(1000),
      lastError: null,
      snapshotId: 's',
    };
    await writeFile(file, JSON.stringify({ version: 1, updatedAt: iso(0), targets: { local: t } }));
    const res = await collectOpsChecks({
      env: { HMIS_BACKUP_STATUS_FILE: file, HMIS_DISK_PATHS: dir, OPS_DISK_WARN_USED_PCT: '0.001' },
      now: new Date(),
      queue: () => Promise.resolve({ backlog: 900, oldestAgeSeconds: 5 }),
    });
    expect(res.backup.state).toBe('ok');
    expect(res.alerts.map((a) => a.code).sort()).toEqual(['disk.low', 'queue.backlog']);
    expect(res.queue).toMatchObject({ ok: false, backlog: 900 });
  });

  it('survives a failing queue lookup and missing paths', async () => {
    const res = await collectOpsChecks({
      env: {
        HMIS_BACKUP_STATUS_FILE: path.join(dir, 'none.json'),
        HMIS_DISK_PATHS: '/nonexistent-x',
      },
      now: new Date(),
      queue: () => Promise.reject(new Error('db down')),
    });
    expect(res.queue).toBeNull();
    expect(res.disk.worst).toBeNull();
    expect(res.alerts.map((a) => a.code)).toEqual(['backup.missing']);
  });
});
