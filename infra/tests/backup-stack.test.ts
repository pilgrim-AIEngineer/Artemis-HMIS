import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { backupStatusSchema, evaluateBackup } from '../../packages/shared/src/ops';

/**
 * OPS-01 end to end against a throwaway stack: its own Docker network, its own Postgres and the
 * real backup image (random names, no published ports, everything removed afterwards).
 * backup-run.sh -> restic repos (local + USB dir) -> restore-drill.sh -> restore-db.sh (rollback).
 */

const INFRA = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PG_IMAGE = process.env.HMIS_TEST_PG_IMAGE ?? 'postgres:17';
const id = randomBytes(4).toString('hex');
const NET = `hmis-ops-test-${id}`;
const PG = `hmis-ops-test-pg-${id}`;
const IMAGE = `hmis-ops-test-backup:${id}`;
const PASS = randomBytes(12).toString('hex');
const PGPASS = randomBytes(12).toString('hex');
const uid = `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`;

let work: string;
let backupDir: string;
let filesDir: string;
let usbDir: string;

function docker(args: string[], opts: { env?: Record<string, string>; ok?: boolean } = {}) {
  const r = spawnSync('docker', args, {
    encoding: 'utf8',
    env: { ...process.env, ...opts.env },
    maxBuffer: 64 * 1024 * 1024,
  });
  const out = `${r.stdout}${r.stderr}`;
  if (opts.ok !== false && r.status !== 0)
    throw new Error(`docker ${args.join(' ')} failed:\n${out}`);
  return { code: r.status ?? -1, stdout: r.stdout, out };
}

const psql = (sql: string) =>
  docker(['exec', PG, 'psql', '-U', 'hmis', '-d', 'hmis', '-Atqc', sql]).stdout.trim();

/** Runs a script of the backup image against the test Postgres, as the host user. */
function inBackupImage(
  cmd: string[],
  env: Record<string, string> = {},
  extra: string[] = [],
  ok = false,
) {
  const envArgs = Object.entries({
    PGHOST: PG,
    PGUSER: 'hmis',
    PGPASSWORD: PGPASS,
    PGDATABASE: 'hmis',
    BACKUP_PASSPHRASE: PASS,
    ...env,
  }).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
  return docker(
    [
      'run',
      '--rm',
      '--network',
      NET,
      '--user',
      uid,
      ...envArgs,
      '-v',
      `${backupDir}:/backup`,
      '-v',
      `${filesDir}:/data/files:ro`,
      '-v',
      `${usbDir}:/usb`,
      ...extra,
      IMAGE,
      ...cmd,
    ],
    { ok },
  );
}

const status = () =>
  backupStatusSchema.parse(
    JSON.parse(readFileSync(path.join(backupDir, 'status/status.json'), 'utf8')),
  );

beforeAll(() => {
  work = mkdtempSync(path.join(tmpdir(), 'ops-stack-'));
  backupDir = path.join(work, 'backup');
  filesDir = path.join(work, 'files');
  usbDir = path.join(work, 'usb');
  for (const d of [backupDir, filesDir, usbDir]) mkdirSync(d, { recursive: true, mode: 0o777 });
  writeFileSync(path.join(filesDir, 'scan1.jpg'), 'not really a jpeg');
  mkdirSync(path.join(filesDir, 'f/2026/10'), { recursive: true });
  writeFileSync(path.join(filesDir, 'f/2026/10/rx.pdf'), 'pdf');
  writeFileSync(path.join(usbDir, '.hmis-backup-disk'), 'hmis-usb-test-disk-A\n');

  docker([
    'build',
    '-q',
    '-t',
    IMAGE,
    '--build-arg',
    `PG_IMAGE=${PG_IMAGE}`,
    path.join(INFRA, 'docker/backup'),
  ]);
  docker(['network', 'create', NET]);
  docker([
    'run',
    '-d',
    '--name',
    PG,
    '--network',
    NET,
    '-e',
    'POSTGRES_USER=hmis',
    '-e',
    `POSTGRES_PASSWORD=${PGPASS}`,
    '-e',
    'POSTGRES_DB=hmis',
    '-v',
    `${path.join(INFRA, 'docker/postgres/initdb')}:/docker-entrypoint-initdb.d:ro`,
    PG_IMAGE,
  ]);
  for (let i = 0; i < 60; i++) {
    const r = docker(['exec', PG, 'pg_isready', '-U', 'hmis', '-d', 'hmis'], { ok: false });
    // The entrypoint restarts the server once after init: wait for a real query.
    if (
      r.code === 0 &&
      docker(['exec', PG, 'psql', '-U', 'hmis', '-d', 'hmis', '-Atc', 'select 1'], { ok: false })
        .code === 0
    )
      break;
    spawnSync('sleep', ['1']);
  }
  psql(`create role hmis_app_login login password 'x'; create table patient (id int primary key, name text);
        create table bill (id int primary key, number text, created_at timestamptz default now());
        create table audit_log (id serial primary key, what text);
        insert into patient select g, 'synthetic ' || g from generate_series(1, 25) g;
        insert into bill select g, 'OB/26-27/' || lpad(g::text, 6, '0') from generate_series(1, 7) g;
        insert into audit_log (what) select 'x' from generate_series(1, 40);
        grant select on patient to hmis_app_login;`);
});

afterAll(() => {
  docker(['rm', '-f', PG], { ok: false });
  docker(['network', 'rm', NET], { ok: false });
  docker(['rmi', '-f', IMAGE], { ok: false });
  // Repos are written as the host user, so plain removal works.
  rmSync(work, { recursive: true, force: true });
});

describe('backup-run.sh', () => {
  it('refuses to run without a passphrase', () => {
    const r = inBackupImage(['backup-run.sh'], { BACKUP_PASSPHRASE: '' });
    expect(r.code).toBe(1);
    expect(r.out).toContain('refusing to create unencrypted backups');
  });

  it('full run: dump + files to the local repo and the USB disk, status is valid and healthy', () => {
    const r = inBackupImage(['backup-run.sh', '--kind', 'full', '--save-as', 'pre-update'], {
      BACKUP_USB_ENABLED: '1',
    });
    expect(r.code, r.out).toBe(0);
    const st = status();
    expect(st.targets.local?.lastDbSuccessAt).toBeTruthy();
    expect(st.targets.local?.lastFilesSuccessAt).toBeTruthy();
    expect(st.targets.usb).toMatchObject({ diskId: 'hmis-usb-test-disk-A', lastError: null });
    expect(st.targets.usb?.diskSwappedAt).toBeTruthy();
    // The TS evaluator agrees the freshly written status is healthy.
    const ev = evaluateBackup(st, new Date());
    expect(ev.alerts).toEqual([]);
    // Encrypted at rest: neither the data nor the passphrase is readable in the repository.
    const grep = spawnSync(
      'grep',
      ['-rla', 'synthetic 7', path.join(backupDir, 'restic'), path.join(usbDir, 'restic')],
      { encoding: 'utf8' },
    );
    expect(grep.stdout.trim()).toBe('');
    expect(existsSync(path.join(backupDir, 'pre-update/hmis.dump'))).toBe(true);
    const manifest = JSON.parse(
      readFileSync(path.join(backupDir, 'staging/manifest.json'), 'utf8'),
    ) as {
      lastBillNumber: string;
      tables: Record<string, { before: number; after: number }>;
    };
    expect(manifest.lastBillNumber).toBe('OB/26-27/000007');
    expect(manifest.tables.patient).toEqual({ before: 25, after: 25 });
  });

  it('db-only run keeps files out of the snapshot and does not refresh the files timestamp', () => {
    const before = status().targets.local?.lastFilesSuccessAt;
    psql(`insert into patient select g, 'later ' || g from generate_series(26, 30) g`);
    const r = inBackupImage(['backup-run.sh', '--kind', 'db'], { BACKUP_USB_ENABLED: '1' });
    expect(r.code, r.out).toBe(0);
    expect(status().targets.local?.lastFilesSuccessAt).toBe(before);
  });

  it('records a failing cloud target without failing the local backup (exit 2)', () => {
    const r = inBackupImage(['backup-run.sh', '--kind', 'db'], {
      BACKUP_S3_REPOSITORY: 's3:http://127.0.0.1:1/nobucket/hmis',
      BACKUP_PROBE_TIMEOUT: '8',
      AWS_ACCESS_KEY_ID: 'test',
      AWS_SECRET_ACCESS_KEY: 'test',
    });
    expect(r.code, r.out).toBe(2);
    const st = status();
    expect(st.targets.s3?.lastError).toBeTruthy();
    expect(st.targets.s3?.lastError).not.toContain('http');
    expect(st.targets.s3?.lastDbSuccessAt).toBeNull();
    expect(st.targets.local?.lastError).toBeNull();
    // The shared evaluator turns it into a cloud warning only.
    const codes = evaluateBackup(st, new Date()).alerts.map((a) => a.code);
    expect(codes).toContain('backup.cloud_lag');
    expect(codes).not.toContain('backup.local_stale');
  });

  it('flags a missing USB disk, and a swapped disk resets the rotation clock', () => {
    rmSync(path.join(usbDir, '.hmis-backup-disk'));
    let r = inBackupImage(['backup-run.sh', '--kind', 'db'], { BACKUP_USB_ENABLED: '1' });
    expect(r.code).toBe(2);
    expect(status().targets.usb?.lastError).toBe('usb backup disk not mounted');

    const swappedBefore = status().targets.usb?.diskSwappedAt;
    writeFileSync(path.join(usbDir, '.hmis-backup-disk'), 'hmis-usb-test-disk-B\n');
    r = inBackupImage(['backup-run.sh', '--kind', 'db'], { BACKUP_USB_ENABLED: '1' });
    expect(r.code, r.out).toBe(0);
    const usb = status().targets.usb;
    expect(usb?.diskId).toBe('hmis-usb-test-disk-B');
    expect(usb?.diskSwappedAt).not.toBe(swappedBefore);
    expect(usb?.lastFilesSuccessAt).toBeNull(); // new disk has no files until the nightly full run
  });

  it('a failing dump marks every target failed and exits 1', () => {
    const r = inBackupImage(['backup-run.sh', '--kind', 'db'], { PGDATABASE: 'does_not_exist' });
    expect(r.code).toBe(1);
    expect(status().targets.local?.lastError).toContain('pg_dump failed');
  });
});

describe('restore-drill.sh', () => {
  // A final full run so the repository holds the newest data plus files.
  beforeAll(() => {
    const r = inBackupImage(['backup-run.sh', '--kind', 'full'], { BACKUP_USB_ENABLED: '1' });
    expect(r.code, r.out).toBe(0);
  });

  const drill = (repo: string, pass = PASS) => {
    const out = path.join(work, `drill-${randomBytes(3).toString('hex')}.json`);
    const r = spawnSync(
      'bash',
      [
        path.join(INFRA, 'scripts/restore-drill.sh'),
        '--repo',
        repo,
        '--image',
        IMAGE,
        '--out',
        out,
      ],
      {
        encoding: 'utf8',
        env: { PATH: process.env.PATH ?? '', HOME: work, BACKUP_PASSPHRASE: pass },
        maxBuffer: 64 * 1024 * 1024,
      },
    );
    const result = existsSync(out)
      ? (JSON.parse(readFileSync(out, 'utf8') || 'null') as DrillResult | null)
      : null;
    return { code: r.status ?? -1, out: `${r.stdout}${r.stderr}`, result };
  };

  interface DrillResult {
    ok: boolean;
    snapshot: { id: string };
    filesRestored: number;
    tables: Record<string, { before: number; after: number; restored: number }>;
    checks: { name: string; ok: boolean; detail: string }[];
  }

  it('restores the local repository into a throwaway server and passes every check', () => {
    const d = drill(path.join(backupDir, 'restic'));
    expect(d.code, d.out).toBe(0);
    expect(d.result?.ok).toBe(true);
    expect(d.result?.checks.map((c) => c.name)).toEqual(
      expect.arrayContaining([
        'snapshot',
        'restic_check',
        'restore',
        'files',
        'pg_restore',
        'row_counts',
        'last_bill',
      ]),
    );
    expect(d.result?.filesRestored).toBe(2);
    expect(d.result?.tables.patient).toMatchObject({ restored: 30 });
    expect(d.result?.tables.bill).toMatchObject({ restored: 7 });
  });

  it('also restores the USB repository', () => {
    const d = drill(path.join(usbDir, 'restic'));
    expect(d.code, d.out).toBe(0);
    expect(d.result?.ok).toBe(true);
  });

  it('fails clearly with a wrong passphrase and with an empty repository', () => {
    const bad = drill(path.join(backupDir, 'restic'), 'wrong-passphrase');
    expect(bad.code).not.toBe(0);
    expect(bad.result?.ok).toBe(false);

    const empty = path.join(work, 'empty-repo');
    mkdirSync(empty);
    const none = drill(empty);
    expect(none.code).not.toBe(0);
    expect(none.result?.ok).toBe(false);
  });

  it('does not touch the live database', () => {
    expect(psql('select count(*) from patient')).toBe('30');
    expect(psql(`select count(*) from pg_database where datname = 'hmis_drill'`)).toBe('0');
  });
});

describe('restore-db.sh (update rollback)', () => {
  it('puts the database back to the pre-update state, including roles and grants', () => {
    // pre-update copy was taken in the first full run (25 patients, 7 bills).
    psql(`delete from patient; drop table audit_log; alter table bill add column boom int`);
    const r = inBackupImage([
      'restore-db.sh',
      '--dump',
      '/backup/pre-update/hmis.dump',
      '--globals',
      '/backup/pre-update/globals.sql',
    ]);
    expect(r.code, r.out).toBe(0);
    expect(psql('select count(*) from patient')).toBe('25');
    expect(psql('select count(*) from audit_log')).toBe('40');
    expect(
      psql(
        `select count(*) from information_schema.columns where table_name = 'bill' and column_name = 'boom'`,
      ),
    ).toBe('0');
    expect(psql(`select has_table_privilege('hmis_app_login', 'patient', 'select')`)).toBe('t');
  });
});

describe('backup-loop.sh', () => {
  it('runs a full backup right away when none exists, then stops cleanly', () => {
    const fresh = path.join(work, 'loop-backup');
    mkdirSync(fresh, { mode: 0o777 });
    const name = `${PG}-loop`;
    docker([
      'run',
      '-d',
      '--name',
      name,
      '--network',
      NET,
      '--user',
      uid,
      '-e',
      `PGHOST=${PG}`,
      '-e',
      'PGUSER=hmis',
      '-e',
      `PGPASSWORD=${PGPASS}`,
      '-e',
      'PGDATABASE=hmis',
      '-e',
      `BACKUP_PASSPHRASE=${PASS}`,
      '-v',
      `${fresh}:/backup`,
      '-v',
      `${filesDir}:/data/files:ro`,
      IMAGE,
    ]);
    try {
      const file = path.join(fresh, 'status/status.json');
      let ok = false;
      for (let i = 0; i < 90 && !ok; i++) {
        if (existsSync(file)) {
          try {
            ok = Boolean(
              backupStatusSchema.parse(JSON.parse(readFileSync(file, 'utf8'))).targets.local
                ?.lastFilesSuccessAt,
            );
          } catch {
            ok = false;
          }
        }
        if (!ok) spawnSync('sleep', ['1']);
      }
      expect(ok, docker(['logs', name], { ok: false }).out).toBe(true);
      const t0 = Date.now();
      docker(['stop', '-t', '10', name]);
      expect(Date.now() - t0).toBeLessThan(8_000); // reacts to SIGTERM, not killed after the timeout
    } finally {
      docker(['rm', '-f', name], { ok: false });
    }
  });

  it('refuses to start without a passphrase', () => {
    const r = docker(['run', '--rm', '-e', 'BACKUP_PASSPHRASE=', IMAGE], { ok: false });
    expect(r.code).toBe(1);
    expect(r.out).toContain('BACKUP_PASSPHRASE is not set');
  });
});
