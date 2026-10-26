import { readFile, statfs } from 'node:fs/promises';
import {
  backupStatusSchema,
  DEFAULT_OPS_THRESHOLDS,
  evaluateBackup,
  evaluateDisk,
  evaluateQueue,
  type BackupCheck,
  type BackupStatus,
  type DiskCheck,
  type DiskSample,
  type OpsAlert,
  type OpsThresholds,
  type QueueCheck,
  type QueueStats,
} from './ops';

/** Node-only side of OPS-01 monitoring: reads the backup status file and samples disks. */

export const DEFAULT_BACKUP_STATUS_FILE = '/backup/status/status.json';
export const DEFAULT_DISK_PATHS = ['/data/files', '/backup'];

type Env = Record<string, string | undefined>;

function num(env: Env, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function opsThresholdsFromEnv(env: Env): OpsThresholds {
  const d = DEFAULT_OPS_THRESHOLDS;
  return {
    backupMaxAgeHours: num(env, 'OPS_BACKUP_MAX_AGE_HOURS', d.backupMaxAgeHours),
    filesMaxAgeHours: num(env, 'OPS_FILES_MAX_AGE_HOURS', d.filesMaxAgeHours),
    cloudMaxLagHours: num(env, 'OPS_CLOUD_MAX_LAG_HOURS', d.cloudMaxLagHours),
    usbRotationDays: num(env, 'OPS_USB_ROTATION_DAYS', d.usbRotationDays),
    diskWarnUsedPct: num(env, 'OPS_DISK_WARN_USED_PCT', d.diskWarnUsedPct),
    diskCriticalUsedPct: num(env, 'OPS_DISK_CRITICAL_USED_PCT', d.diskCriticalUsedPct),
    queueBacklogMax: num(env, 'OPS_QUEUE_BACKLOG_MAX', d.queueBacklogMax),
  };
}

/** Missing, unreadable or malformed file all read as `null` (= "no backup known"). */
export async function readBackupStatus(file: string): Promise<BackupStatus | null> {
  try {
    const parsed = backupStatusSchema.safeParse(JSON.parse(await readFile(file, 'utf8')));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Volumes that do not exist in this container (e.g. dev without a backup volume) are skipped. */
export async function sampleDisks(paths: readonly string[]): Promise<DiskSample[]> {
  const out: DiskSample[] = [];
  for (const path of paths) {
    try {
      const s = await statfs(path);
      out.push({ path, totalBytes: s.blocks * s.bsize, freeBytes: s.bavail * s.bsize });
    } catch {
      // not mounted here
    }
  }
  return out;
}

export interface OpsChecks {
  backup: BackupCheck;
  disk: DiskCheck;
  queue: QueueCheck | null;
  alerts: OpsAlert[];
}

/** Backup + disk + queue in one go. `queue` returns null when the database is unreachable. */
export async function collectOpsChecks(opts: {
  env: Env;
  now: Date;
  queue: () => Promise<QueueStats | null>;
}): Promise<OpsChecks> {
  const t = opsThresholdsFromEnv(opts.env);
  const statusFile = opts.env.HMIS_BACKUP_STATUS_FILE || DEFAULT_BACKUP_STATUS_FILE;
  const diskPaths = opts.env.HMIS_DISK_PATHS
    ? opts.env.HMIS_DISK_PATHS.split(',')
        .map((p) => p.trim())
        .filter(Boolean)
    : DEFAULT_DISK_PATHS;

  const [status, samples, queueStats] = await Promise.all([
    readBackupStatus(statusFile),
    sampleDisks(diskPaths),
    opts.queue().catch(() => null),
  ]);
  const backup = evaluateBackup(status, opts.now, t);
  const disk = evaluateDisk(samples, t);
  const queue = queueStats ? evaluateQueue(queueStats, t) : null;
  return {
    backup: backup.check,
    disk: disk.check,
    queue: queue?.check ?? null,
    alerts: [...backup.alerts, ...disk.alerts, ...(queue?.alerts ?? [])],
  };
}
