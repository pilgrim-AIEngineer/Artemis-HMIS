/**
 * Vitest global setup for the worker: makes headless Chromium launchable without root.
 * On a Linux box that lacks Chromium's shared libraries (a fresh server or CI image without
 * `playwright install --with-deps`), the missing .deb packages are downloaded with
 * `apt-get download` into a user cache and unpacked there; `LD_LIBRARY_PATH` then points at it
 * (inherited by the test workers and by Chromium). Nothing outside the cache is touched.
 * If libraries are still missing, the error says how to install them properly.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

// Ubuntu 24.04 package names for the libraries `chrome-headless-shell` links against.
const PACKAGES = [
  'libatk1.0-0t64',
  'libatk-bridge2.0-0t64',
  'libatspi2.0-0t64',
  'libxcomposite1',
  'libxdamage1',
  'libxfixes3',
  'libxrandr2',
  'libxrender1',
  'libxi6',
  'libgbm1',
  'libasound2t64',
  'libcups2t64',
  'libcairo2',
  'libpango-1.0-0',
  'libpangocairo-1.0-0',
  'libpangoft2-1.0-0',
  'libpixman-1-0',
  'libxcb-render0',
  'libxcb-shm0',
  'libfribidi0',
  'libthai0',
  'libdatrie1',
  'libharfbuzz0b',
  'libgraphite2-3',
  'libavahi-client3',
  'libavahi-common3',
  'libcairo-gobject2',
];

const INSTALL_HINT =
  'Install Chromium once with: pnpm --filter @hmis/web exec playwright install --with-deps chromium';

function missingLibs(exe: string, ldPath: string): string[] {
  try {
    const out = execFileSync('ldd', [exe], {
      encoding: 'utf8',
      env: { ...process.env, LD_LIBRARY_PATH: ldPath },
    });
    return out.split('\n').filter((l) => l.includes('not found'));
  } catch {
    return []; // no ldd: let the real launch report any problem
  }
}

export default function setup(): void {
  if (process.platform !== 'linux') return;
  let exe: string;
  try {
    exe = chromium.executablePath();
  } catch {
    throw new Error(`Chromium is not installed. ${INSTALL_HINT}`);
  }
  if (!existsSync(exe)) throw new Error(`Chromium is not installed. ${INSTALL_HINT}`);

  const base = process.env.LD_LIBRARY_PATH ?? '';
  if (missingLibs(exe, base).length === 0) return;

  const cache =
    process.env.HMIS_CHROMIUM_LIBS_DIR ?? join(homedir(), '.cache', 'hmis-chromium-libs');
  const root = join(cache, 'root');
  const libDir = join(root, 'usr/lib/x86_64-linux-gnu');
  const withCache = [libDir, base].filter(Boolean).join(':');
  if (missingLibs(exe, withCache).length > 0) {
    const debs = join(cache, 'debs');
    mkdirSync(debs, { recursive: true });
    mkdirSync(root, { recursive: true });
    try {
      execFileSync('apt-get', ['download', ...PACKAGES], { cwd: debs, stdio: 'pipe' });
      for (const f of readdirSync(debs).filter((n) => n.endsWith('.deb'))) {
        execFileSync('dpkg-deb', ['-x', join(debs, f), root], { stdio: 'pipe' });
      }
    } catch (err) {
      throw new Error(
        `Chromium's system libraries are missing and could not be fetched. ${INSTALL_HINT}`,
        {
          cause: err,
        },
      );
    }
  }
  const still = missingLibs(exe, withCache);
  if (still.length > 0) {
    throw new Error(`Chromium libraries still missing:\n${still.join('\n')}\n${INSTALL_HINT}`);
  }
  process.env.LD_LIBRARY_PATH = withCache;
}
