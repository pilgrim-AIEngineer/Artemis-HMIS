import { execFile, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const SCRIPTS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../scripts');
const sh = (name: string) => path.join(SCRIPTS, name);

let tmp: string;
beforeAll(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'ops-scripts-'));
});
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function bash(args: string[], env: Record<string, string> = {}, cwd?: string) {
  const r = spawnSync('bash', args, {
    encoding: 'utf8',
    cwd,
    env: { PATH: process.env.PATH ?? '', HOME: tmp, ...env },
  });
  return { code: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
}

describe('syntax', () => {
  it.each([
    'lib.sh',
    'install.sh',
    'update.sh',
    'backup-check.sh',
    'restore-drill.sh',
    'usb-init.sh',
  ])('%s parses', (f) => {
    expect(bash(['-n', sh(f)]).code).toBe(0);
  });
});

describe('lib.sh env helpers', () => {
  it('reads, replaces and appends keys while keeping mode 600', () => {
    const f = path.join(tmp, 'lib.env');
    writeFileSync(f, 'A=1\nB=two words\n', { mode: 0o600 });
    const script = `. ${sh('lib.sh')}; env_set ${f} A 9; env_set ${f} C x=y; env_get ${f} A; env_get ${f} C; env_get ${f} B; stat -c %a ${f}`;
    const r = bash(['-c', script]);
    expect(r.out.trim().split('\n')).toEqual(['9', 'x=y', 'two words', '600']);
    expect(readFileSync(f, 'utf8')).toBe('A=9\nB=two words\nC=x=y\n');
  });
});

describe('install.sh', () => {
  const base = [
    '--hostname',
    'hmis.local',
    '--lan-cidr',
    '192.168.1.0/24',
    '--registry',
    'reg.example/hmis',
    '--version',
    'v2026.10.26.1',
  ];

  it('--dry-run walks every step without needing root and writes nothing', () => {
    const r = bash([
      sh('install.sh'),
      ...base,
      '--dry-run',
      '--tailscale',
      '--ups',
      'usbhid-ups',
      '--usb',
    ]);
    expect(r.code, r.out).toBe(0);
    for (const step of [
      '1/10',
      '2/10',
      '3/10',
      '4/10',
      '5/10',
      '6/10',
      '7/10',
      '8/10',
      '9/10',
      '10/10',
    ]) {
      expect(r.out).toContain(step);
    }
    expect(r.out).toContain('[dry-run] ufw allow from 192.168.1.0/24 to any port 443 proto tcp');
    expect(r.out).toContain('[dry-run] ufw --force enable');
    expect(r.out).toContain('migrate.mjs');
    expect(r.out).toContain('usbhid-ups');
  });

  it('dry-run output contains no generated secrets', () => {
    const r = bash([sh('install.sh'), ...base, '--dry-run']);
    expect(r.out).not.toMatch(/BACKUP PASSPHRASE \(shown once\)/);
    expect(r.out).not.toMatch(/[0-9a-f]{32,}/);
  });

  it.each([
    [['--lan-cidr', '192.168.1.0/24'], 'registry'],
    [['--registry', 'r', '--version', 'v2026.10.26.1'], 'lan-cidr'],
    [[...base, '--hostname', 'bad host;rm'], 'hostname'],
    [['--lan-cidr', 'x', '--build-local'], 'lan-cidr'],
    [['--lan-cidr', '10.0.0.0/8', '--registry', 'r', '--version', 'latest'], 'version'],
  ])('rejects bad arguments %j', (args, word) => {
    const r = bash([sh('install.sh'), '--dry-run', ...args]);
    expect(r.code).not.toBe(0);
    expect(r.out.toLowerCase()).toContain(word);
  });

  it('refuses to run without root outside --dry-run', () => {
    if (process.getuid?.() === 0) return;
    const r = bash([sh('install.sh'), ...base, '--skip-os-check']);
    expect(r.code).toBe(1);
    expect(r.out).toContain('run as root');
  });
});

// ---- update.sh with a stubbed docker/curl ------------------------------------------------------

interface Rig {
  dir: string;
  hmis: string;
  log: string;
  state: string;
  env: Record<string, string>;
}

function makeRig(version = 'v2026.10.01.1'): Rig {
  const dir = mkdtempSync(path.join(tmp, 'rig-'));
  const hmis = path.join(dir, 'hmis');
  const bin = path.join(dir, 'bin');
  const state = path.join(dir, 'state');
  mkdirSync(hmis, { recursive: true });
  mkdirSync(bin);
  mkdirSync(state);
  writeFileSync(
    path.join(hmis, '.env'),
    `HMIS_VERSION=${version}\nWEB_PORT=3999\nPOSTGRES_PASSWORD=secret\n`,
    { mode: 0o600 },
  );
  writeFileSync(path.join(state, 'running'), version);
  const log = path.join(dir, 'calls.log');
  // docker stub: logs "<HMIS_VERSION seen> <args>", fails when the args contain $STUB_FAIL, and
  // makes "up" switch the running version to whatever .env says.
  writeFileSync(
    path.join(bin, 'docker'),
    `#!/usr/bin/env bash
v="\${HMIS_VERSION:-}"
args="$*"
echo "$args" >>"${log}"
if [ -n "\${STUB_FAIL:-}" ] && [[ "$args" == *"$STUB_FAIL"* ]]; then
  # a failing backup uses exit code from STUB_FAIL_RC
  exit "\${STUB_FAIL_RC:-1}"
fi
if [[ "$args" == *" up -d"* ]]; then
  sed -n 's/^HMIS_VERSION=//p' .env | tail -n1 >"${state}/running"
fi
exit 0
`,
  );
  writeFileSync(
    path.join(bin, 'curl'),
    `#!/usr/bin/env bash
running=$(cat "${state}/running")
if [ -n "\${STUB_UNHEALTHY:-}" ] && [ "$running" = "$STUB_UNHEALTHY" ]; then exit 22; fi
printf '{"version":"%s","checks":{"db":{"ok":true}}}' "$running"
`,
  );
  chmodSync(path.join(bin, 'docker'), 0o755);
  chmodSync(path.join(bin, 'curl'), 0o755);
  return {
    dir,
    hmis,
    log,
    state,
    env: {
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      HMIS_DIR: hmis,
      HMIS_NOW_HOUR_IST: '20',
      HMIS_HEALTH_TIMEOUT: '3',
      HMIS_HEALTH_INTERVAL: '1',
    },
  };
}

const calls = (rig: Rig) =>
  existsSync(rig.log) ? readFileSync(rig.log, 'utf8').trim().split('\n') : [];
const idx = (list: string[], needle: string) => list.findIndex((l) => l.includes(needle));
const envVersion = (rig: Rig) =>
  /HMIS_VERSION=(.*)/.exec(readFileSync(path.join(rig.hmis, '.env'), 'utf8'))?.[1];

describe('update.sh', () => {
  let rig: Rig;
  beforeEach(() => {
    rig = makeRig();
  });

  it('rejects malformed versions', () => {
    for (const v of ['latest', 'v1', '2026.10.01.1']) {
      const r = bash([sh('update.sh'), v], rig.env);
      expect(r.code, v).toBe(64);
    }
  });

  it('is blocked during OPD hours unless --force, before touching anything', () => {
    const r = bash([sh('update.sh'), 'v2026.10.26.1'], { ...rig.env, HMIS_NOW_HOUR_IST: '09' });
    expect(r.code).toBe(3);
    expect(r.out).toContain('OPD hours');
    expect(calls(rig)).toEqual([]);
    for (const hour of ['08', '14']) {
      expect(
        bash([sh('update.sh'), 'v2026.10.26.1'], { ...rig.env, HMIS_NOW_HOUR_IST: hour }).code,
      ).toBe(3);
    }
    // 15:00 is outside the window; --force overrides inside it.
    expect(
      bash([sh('update.sh'), 'v2026.10.26.1'], { ...rig.env, HMIS_NOW_HOUR_IST: '15' }).code,
    ).toBe(0);
    const forced = bash([sh('update.sh'), 'v2026.10.27.1', '--force'], {
      ...rig.env,
      HMIS_NOW_HOUR_IST: '10',
    });
    expect(forced.code, forced.out).toBe(0);
  });

  it('backs up, pulls, migrates, starts, in that order, and records success', () => {
    const r = bash([sh('update.sh'), 'v2026.10.26.1'], rig.env);
    expect(r.code, r.out).toBe(0);
    const c = calls(rig);
    const order = [
      'backup-run.sh --kind full --tag pre-update',
      ' pull web worker backup',
      ' stop web worker',
      'migrate.mjs',
      ' up -d',
    ];
    const positions = order.map((o) => idx(c, o));
    expect(
      positions.every((p) => p >= 0),
      c.join('\n'),
    ).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(envVersion(rig)).toBe('v2026.10.26.1');
    expect(
      JSON.parse(readFileSync(path.join(rig.hmis, 'state/last-update.json'), 'utf8')),
    ).toMatchObject({
      from: 'v2026.10.01.1',
      to: 'v2026.10.26.1',
      result: 'ok',
    });
  });

  it('pulls with the NEW version but leaves .env alone until the switch', () => {
    bash([sh('update.sh'), 'v2026.10.26.1', '--dry-run'], rig.env);
    expect(envVersion(rig)).toBe('v2026.10.01.1');
  });

  it('aborts without changes when the pre-update backup fails', () => {
    const r = bash([sh('update.sh'), 'v2026.10.26.1'], {
      ...rig.env,
      STUB_FAIL: 'backup-run.sh',
      STUB_FAIL_RC: '1',
    });
    expect(r.code).not.toBe(0);
    expect(r.out).toContain('pre-update backup failed');
    expect(idx(calls(rig), 'pull')).toBe(-1);
    expect(envVersion(rig)).toBe('v2026.10.01.1');
  });

  it('continues when only the optional targets of the backup failed (exit 2)', () => {
    const r = bash([sh('update.sh'), 'v2026.10.26.1'], {
      ...rig.env,
      STUB_FAIL: 'backup-run.sh',
      STUB_FAIL_RC: '2',
    });
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain('not every target');
  });

  it('aborts without changes when the pull fails', () => {
    const r = bash([sh('update.sh'), 'v2026.10.26.1'], { ...rig.env, STUB_FAIL: ' pull ' });
    expect(r.code).toBe(1);
    expect(r.out).toContain('nothing changed');
    expect(idx(calls(rig), 'migrate.mjs')).toBe(-1);
    expect(idx(calls(rig), 'stop web')).toBe(-1);
    expect(envVersion(rig)).toBe('v2026.10.01.1');
  });

  it('restores the pre-update version AND database when the new version is unhealthy', () => {
    const r = bash([sh('update.sh'), 'v2026.10.26.1'], {
      ...rig.env,
      STUB_UNHEALTHY: 'v2026.10.26.1',
    });
    expect(r.code, r.out).toBe(1);
    expect(r.out).toContain('rolled back');
    const c = calls(rig);
    expect(
      idx(
        c,
        'restore-db.sh --dump /backup/pre-update/hmis.dump --globals /backup/pre-update/globals.sql',
      ),
    ).toBeGreaterThan(idx(c, 'migrate.mjs'));
    expect(envVersion(rig)).toBe('v2026.10.01.1');
    expect(readFileSync(path.join(rig.state, 'running'), 'utf8').trim()).toBe('v2026.10.01.1');
    expect(
      (
        JSON.parse(readFileSync(path.join(rig.hmis, 'state/last-update.json'), 'utf8')) as {
          result: string;
        }
      ).result,
    ).toBe('rolled_back');
  });

  it('restores the database when the migration itself fails', () => {
    const r = bash([sh('update.sh'), 'v2026.10.26.1'], { ...rig.env, STUB_FAIL: 'migrate.mjs' });
    expect(r.code).toBe(1);
    expect(idx(calls(rig), 'restore-db.sh')).toBeGreaterThan(-1);
    expect(envVersion(rig)).toBe('v2026.10.01.1');
  });

  it('reports exit 2 when the rollback fails too', () => {
    const r = bash([sh('update.sh'), 'v2026.10.26.1'], {
      ...rig.env,
      STUB_FAIL: 'restore-db.sh',
      STUB_UNHEALTHY: 'v2026.10.26.1',
    });
    expect(r.code, r.out).toBe(2);
    expect(r.out).toContain('manual recovery');
  });

  it('does not run two updates at once', () => {
    const lockHolder = spawnSync(
      'bash',
      [
        '-c',
        `mkdir -p ${rig.hmis}/state; exec 7>${rig.hmis}/state/update.lock; flock -n 7 && ${sh('update.sh')} v2026.10.26.1`,
      ],
      {
        encoding: 'utf8',
        env: { ...rig.env, HOME: tmp },
      },
    );
    // The holder itself locks the same file via a different fd of the same open file description? No:
    // a separate flock on a separate open of the same path conflicts, so the script must refuse.
    expect(lockHolder.status).not.toBe(0);
    expect(`${lockHolder.stderr}${lockHolder.stdout}`).toContain('another update is running');
  });
});

// ---- backup-check.sh against a real local HTTP server --------------------------------------------

describe('backup-check.sh', () => {
  let server: Server;
  let port: number;
  let payload: unknown;
  beforeAll(async () => {
    server = createServer((_req, res) => {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const addr = server.address();
    port = typeof addr === 'object' && addr ? addr.port : 0;
  });
  afterAll(() => {
    server.close();
  });

  // Async: the in-process HTTP server must keep answering while the script runs.
  const bashAsync = (args: string[]) =>
    new Promise<{ code: number; out: string }>((resolve) => {
      execFile(
        'bash',
        args,
        { env: { PATH: process.env.PATH ?? '', HOME: tmp } },
        (err, stdout, stderr) => {
          resolve({
            code: err ? (typeof err.code === 'number' ? err.code : -1) : 0,
            out: `${stdout}${stderr}`,
          });
        },
      );
    });
  const run = () =>
    bashAsync([sh('backup-check.sh'), '--url', `http://127.0.0.1:${port}/api/health`]);

  it('exits 0 and lists each target when all backups are fresh', async () => {
    payload = {
      checks: {
        backup: {
          ok: true,
          state: 'ok',
          lastBackupAgeHours: 1.5,
          targets: [
            { name: 'local', ok: true, dbAgeHours: 1.5, filesAgeHours: 6, lastError: null },
          ],
        },
      },
      alerts: [],
    };
    const r = await run();
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain('local: ok');
  });

  it('exits 1 and prints the alert when a backup is stale (even if the server answers 503)', async () => {
    payload = {
      checks: {
        backup: {
          ok: false,
          state: 'problem',
          lastBackupAgeHours: 30,
          targets: [
            {
              name: 'local',
              ok: false,
              dbAgeHours: 30,
              filesAgeHours: 30,
              lastError: 'pg_dump failed',
            },
          ],
        },
      },
      alerts: [
        {
          code: 'backup.local_stale',
          severity: 'critical',
          message: 'Local database backup is stale',
        },
      ],
    };
    const r = await run();
    expect(r.code).toBe(1);
    expect(r.out).toContain('PROBLEM');
    expect(r.out).toContain('pg_dump failed');
    expect(r.out).toContain('ALERT [critical]');
  });

  it('exits 2 when the server is unreachable', async () => {
    const r = await bashAsync([sh('backup-check.sh'), '--url', 'http://127.0.0.1:1/api/health']);
    expect(r.code).toBe(2);
  });
});
