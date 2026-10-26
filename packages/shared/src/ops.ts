import { z } from 'zod';

/**
 * Operations monitoring (OPS-01, docs/31 §3 and §5): the shapes shared by the backup container
 * (writes `status.json`), the web `/api/health` endpoint and the worker `ops.*` jobs, plus the
 * pure rules that turn them into alerts. No I/O here; see `ops-node.ts` for the file/disk side.
 * Nothing in these shapes may carry patient data (AGENTS.md rule 15).
 */

export const BACKUP_TARGETS = ['local', 'usb', 's3'] as const;
export type BackupTarget = (typeof BACKUP_TARGETS)[number];

const nullableTime = z.iso.datetime().nullable();

/** One backup destination as recorded by `backup-run.sh` after every attempt. */
export const backupTargetStatusSchema = z.object({
  lastAttemptAt: nullableTime,
  /** Last time the database dump reached this target. */
  lastDbSuccessAt: nullableTime,
  /** Last time `/data/files` reached this target (nightly full runs only). */
  lastFilesSuccessAt: nullableTime,
  lastError: z.string().nullable(),
  snapshotId: z.string().nullable(),
  /** USB only: id of the disk currently plugged in (marker file written by `usb-init`). */
  diskId: z.string().nullable().optional(),
  /** USB only: when `diskId` first appeared; the weekly swap resets it. */
  diskSwappedAt: nullableTime.optional(),
});
export type BackupTargetStatus = z.infer<typeof backupTargetStatusSchema>;

export const backupStatusSchema = z.object({
  version: z.literal(1),
  updatedAt: z.iso.datetime(),
  targets: z.partialRecord(z.enum(BACKUP_TARGETS), backupTargetStatusSchema),
});
export type BackupStatus = z.infer<typeof backupStatusSchema>;

export const OPS_ALERT_CODES = [
  'db.down',
  'backup.missing',
  'backup.local_stale',
  'backup.files_stale',
  'backup.usb_stale',
  'backup.usb_not_rotated',
  'backup.cloud_lag',
  'disk.low',
  'queue.backlog',
] as const;
export type OpsAlertCode = (typeof OPS_ALERT_CODES)[number];

export const opsAlertSchema = z.object({
  code: z.enum(OPS_ALERT_CODES),
  severity: z.enum(['warning', 'critical']),
  /** English, vendor-facing, no patient data. */
  message: z.string(),
});
export type OpsAlert = z.infer<typeof opsAlertSchema>;

/** Defaults are the numbers in docs/31 §3 and §5; override with env (see `.env.example`). */
export interface OpsThresholds {
  /** Local database backup older than this is critical (docs/31 §5: 24 h). */
  backupMaxAgeHours: number;
  /** Nightly files backup; 24 h schedule + 12 h slack. */
  filesMaxAgeHours: number;
  /** Offsite copy lag (docs/31 §5: 48 h). */
  cloudMaxLagHours: number;
  /** USB disk not swapped (docs/31 §3: 8 days). */
  usbRotationDays: number;
  /** Disk more than this full is a warning (docs/31 §5: 80 %); critical at `diskCriticalUsedPct`. */
  diskWarnUsedPct: number;
  diskCriticalUsedPct: number;
  /** Outbox backlog (docs/31 §5: 500). */
  queueBacklogMax: number;
}

export const DEFAULT_OPS_THRESHOLDS: OpsThresholds = {
  backupMaxAgeHours: 24,
  filesMaxAgeHours: 36,
  cloudMaxLagHours: 48,
  usbRotationDays: 8,
  diskWarnUsedPct: 80,
  diskCriticalUsedPct: 90,
  queueBacklogMax: 500,
};

const HOUR_MS = 3_600_000;

function ageHours(iso: string | null | undefined, now: Date): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : Math.max(0, (now.getTime() - t) / HOUR_MS);
}

const round1 = (n: number | null) => (n === null ? null : Math.round(n * 10) / 10);

export interface BackupTargetCheck {
  name: BackupTarget;
  ok: boolean;
  dbAgeHours: number | null;
  filesAgeHours: number | null;
  lastError: string | null;
}

export interface BackupCheck {
  ok: boolean;
  /** `missing`: no status file yet (backup container never ran, or volume not mounted). */
  state: 'ok' | 'problem' | 'missing';
  /** Age of the freshest database backup on any target. */
  lastBackupAgeHours: number | null;
  targets: BackupTargetCheck[];
}

/** Turns the backup container's status file into a health check and alerts. `null` = no file. */
export function evaluateBackup(
  status: BackupStatus | null,
  now: Date,
  t: OpsThresholds = DEFAULT_OPS_THRESHOLDS,
): { check: BackupCheck; alerts: OpsAlert[] } {
  if (!status) {
    return {
      check: { ok: false, state: 'missing', lastBackupAgeHours: null, targets: [] },
      alerts: [
        {
          code: 'backup.missing',
          severity: 'critical',
          message: 'No backup status found: the backup container has not completed a run.',
        },
      ],
    };
  }

  const alerts: OpsAlert[] = [];
  const targets: BackupTargetCheck[] = [];
  const reason = (e: string | null) => (e ? ` Last error: ${e}` : '');

  for (const name of BACKUP_TARGETS) {
    const s = status.targets[name];
    if (!s) continue;
    const db = ageHours(s.lastDbSuccessAt, now);
    const files = ageHours(s.lastFilesSuccessAt, now);
    let ok = true;
    const flag = (alert: OpsAlert) => {
      ok = false;
      alerts.push(alert);
    };
    const fmt = (h: number | null) => (h === null ? 'never' : `${Math.round(h)} h ago`);

    if (name === 'local') {
      if (db === null || db > t.backupMaxAgeHours) {
        flag({
          code: 'backup.local_stale',
          severity: 'critical',
          message: `Local database backup is stale (last success ${fmt(db)}, limit ${t.backupMaxAgeHours} h).${reason(s.lastError)}`,
        });
      }
    } else if (name === 'usb') {
      if (db === null || db > t.backupMaxAgeHours) {
        flag({
          code: 'backup.usb_stale',
          severity: 'warning',
          message: `USB backup disk is not receiving backups (last success ${fmt(db)}). Is the disk plugged in?${reason(s.lastError)}`,
        });
      }
      const swapped = ageHours(s.diskSwappedAt, now);
      if (swapped !== null && swapped > t.usbRotationDays * 24) {
        flag({
          code: 'backup.usb_not_rotated',
          severity: 'warning',
          message: `The USB backup disk has not been swapped for ${Math.floor(swapped / 24)} days (limit ${t.usbRotationDays}).`,
        });
      }
    } else if (db === null || db > t.cloudMaxLagHours) {
      flag({
        code: 'backup.cloud_lag',
        severity: 'warning',
        message: `Cloud backup lags (last success ${fmt(db)}, limit ${t.cloudMaxLagHours} h).${reason(s.lastError)}`,
      });
    }

    // Files are copied by the nightly full run; a target whose files are stale is not a good backup.
    if (name !== 'usb' || s.lastFilesSuccessAt) {
      if (files === null || files > t.filesMaxAgeHours) {
        flag({
          code: 'backup.files_stale',
          severity: name === 'local' ? 'critical' : 'warning',
          message: `Files backup to ${name} is stale (last success ${fmt(files)}, limit ${t.filesMaxAgeHours} h).${reason(s.lastError)}`,
        });
      }
    }

    targets.push({
      name,
      ok,
      dbAgeHours: round1(db),
      filesAgeHours: round1(files),
      lastError: s.lastError,
    });
  }

  if (!status.targets.local) {
    alerts.push({
      code: 'backup.local_stale',
      severity: 'critical',
      message: 'The local backup target is missing from the backup status.',
    });
  }

  const ages = targets.map((x) => x.dbAgeHours).filter((x): x is number => x !== null);
  return {
    check: {
      ok: alerts.length === 0,
      state: alerts.length === 0 ? 'ok' : 'problem',
      lastBackupAgeHours: ages.length ? Math.min(...ages) : null,
      targets,
    },
    alerts,
  };
}

export interface DiskSample {
  path: string;
  totalBytes: number;
  freeBytes: number;
}

export interface DiskCheck {
  ok: boolean;
  /** Worst (fullest) of the sampled volumes. */
  worst: { path: string; usedPct: number; freeBytes: number } | null;
}

export function evaluateDisk(
  samples: readonly DiskSample[],
  t: OpsThresholds = DEFAULT_OPS_THRESHOLDS,
): { check: DiskCheck; alerts: OpsAlert[] } {
  let worst: DiskCheck['worst'] = null;
  for (const s of samples) {
    if (s.totalBytes <= 0) continue;
    const usedPct = Math.round(((s.totalBytes - s.freeBytes) / s.totalBytes) * 1000) / 10;
    if (!worst || usedPct > worst.usedPct) {
      worst = { path: s.path, usedPct, freeBytes: s.freeBytes };
    }
  }
  const alerts: OpsAlert[] = [];
  if (worst && worst.usedPct > t.diskWarnUsedPct) {
    alerts.push({
      code: 'disk.low',
      severity: worst.usedPct > t.diskCriticalUsedPct ? 'critical' : 'warning',
      message: `Disk ${worst.path} is ${worst.usedPct}% full (${Math.round(worst.freeBytes / 1e9)} GB free).`,
    });
  }
  return { check: { ok: alerts.length === 0, worst }, alerts };
}

export interface QueueStats {
  /** Messages due to be sent and not yet sent. */
  backlog: number;
  /** Age of the oldest due message; null when nothing is waiting. */
  oldestAgeSeconds: number | null;
}

export interface QueueCheck extends QueueStats {
  ok: boolean;
}

export function evaluateQueue(
  stats: QueueStats,
  t: OpsThresholds = DEFAULT_OPS_THRESHOLDS,
): { check: QueueCheck; alerts: OpsAlert[] } {
  const alerts: OpsAlert[] = [];
  if (stats.backlog > t.queueBacklogMax) {
    alerts.push({
      code: 'queue.backlog',
      severity: 'warning',
      message: `Message outbox backlog is ${stats.backlog} (limit ${t.queueBacklogMax}).`,
    });
  }
  return { check: { ...stats, ok: alerts.length === 0 }, alerts };
}

/** Which jobs/endpoints own which alerts, so the two jobs never send the same alert twice. */
export const isBackupAlert = (a: OpsAlert) => a.code.startsWith('backup.');
