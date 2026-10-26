import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setupPlatformDb, type PlatformTestDb } from '@hmis/db/testing/platform';
import { createLogger } from '@hmis/shared/logger';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';
import { JOBS } from './index';
import { opsBackupCheckJob } from './ops-backup-check';
import { opsHealthPingJob } from './ops-health-ping';

let t: PlatformTestDb;
let dir: string;
const logger = createLogger('test', 'silent');
const ctx = () => ({ logger, db: t.app, filesDir: '/nonexistent', jobId: 'j1' });

beforeAll(async () => {
  t = await setupPlatformDb(inject('testPgAdminUrl'));
  dir = await mkdtemp(path.join(tmpdir(), 'ops-job-'));
});
afterAll(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await rm(dir, { recursive: true, force: true });
  await t.close();
});

describe('ops jobs', () => {
  it('are registered', () => {
    const names = JOBS.map((j) => j.name);
    expect(names).toContain('ops.backupCheck');
    expect(names).toContain('ops.healthPing');
  });

  it('ops.backupCheck reports a missing backup and a stale local backup', async () => {
    vi.stubEnv('HMIS_BACKUP_STATUS_FILE', path.join(dir, 'missing.json'));
    const missing = await opsBackupCheckJob.handle({}, ctx());
    expect(missing).toMatchObject({ state: 'missing', alerts: ['backup.missing'] });

    const file = path.join(dir, 'status.json');
    const old = new Date(Date.now() - 30 * 3_600_000).toISOString();
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        updatedAt: old,
        targets: {
          local: {
            lastAttemptAt: old,
            lastDbSuccessAt: old,
            lastFilesSuccessAt: old,
            lastError: null,
            snapshotId: 'x',
          },
        },
      }),
    );
    vi.stubEnv('HMIS_BACKUP_STATUS_FILE', file);
    const stale = await opsBackupCheckJob.handle({}, ctx());
    expect(stale).toMatchObject({ state: 'problem' });
  });

  it('ops.healthPing pings the monitor, and /fail on a critical alert', async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        urls.push(url);
        return Promise.resolve(new Response('OK'));
      }),
    );
    vi.stubEnv('HEALTHCHECK_PING_URL', 'https://hc.example/ping/uuid');
    vi.stubEnv('HMIS_DISK_PATHS', dir);
    vi.stubEnv('OPS_DISK_WARN_USED_PCT', '99.999');

    // Fresh backup => healthy ping.
    const now = new Date().toISOString();
    const file = path.join(dir, 'fresh.json');
    const target = {
      lastAttemptAt: now,
      lastDbSuccessAt: now,
      lastFilesSuccessAt: now,
      lastError: null,
      snapshotId: 'x',
    };
    await writeFile(
      file,
      JSON.stringify({ version: 1, updatedAt: now, targets: { local: target } }),
    );
    vi.stubEnv('HMIS_BACKUP_STATUS_FILE', file);
    expect(await opsHealthPingJob.handle({}, ctx())).toMatchObject({ pinged: true, alerts: [] });
    expect(urls.at(-1)).toBe('https://hc.example/ping/uuid');

    // Missing backup => critical => /fail.
    vi.stubEnv('HMIS_BACKUP_STATUS_FILE', path.join(dir, 'gone.json'));
    await opsHealthPingJob.handle({}, ctx());
    expect(urls.at(-1)).toBe('https://hc.example/ping/uuid/fail');
  });

  it('ops.healthPing does not throw when offline or without a URL', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('offline'))),
    );
    vi.stubEnv('HEALTHCHECK_PING_URL', 'https://hc.example/ping/uuid');
    expect(await opsHealthPingJob.handle({}, ctx())).toMatchObject({ pinged: false });
    vi.stubEnv('HEALTHCHECK_PING_URL', '');
    expect(await opsHealthPingJob.handle({}, ctx())).toMatchObject({ pinged: false });
  });
});
