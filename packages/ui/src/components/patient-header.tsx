import type * as React from 'react';
import { cn } from '../lib/utils';

export interface PatientHeaderFlag {
  label: string;
  tone: 'ok' | 'warn' | 'danger' | 'muted';
}

/**
 * Sticky strip with the patient's identity on every patient screen, so the wrong patient is
 * noticed early (docs/05 §1.12). Presentational: the app passes already-translated text. The
 * mobile number shows its last four digits only.
 */
export function PatientHeader({
  name,
  nameHi,
  ageSex,
  uhid,
  mobileLast4,
  mobileLabel,
  flags = [],
  className,
}: {
  name: string;
  nameHi?: string | null;
  ageSex: string;
  uhid: string;
  mobileLast4?: string | null;
  mobileLabel: string;
  flags?: PatientHeaderFlag[];
  className?: string;
}) {
  return (
    <div
      role="group"
      aria-label={name}
      className={cn(
        'sticky top-0 z-10 flex flex-wrap items-center gap-x-6 gap-y-2 rounded-lg border-2 bg-card px-5 py-3',
        className,
      )}
    >
      <div className="min-w-0">
        <p className="truncate text-2xl font-semibold">{name}</p>
        {nameHi && <p className="truncate text-lg text-muted-foreground">{nameHi}</p>}
      </div>
      <p className="text-lg">{ageSex}</p>
      <p className="text-lg tabular-nums">
        <span className="text-muted-foreground">UHID</span> <strong>{uhid}</strong>
      </p>
      {mobileLast4 && (
        <p className="text-lg tabular-nums">
          <span className="text-muted-foreground">{mobileLabel}</span> ••••{mobileLast4}
        </p>
      )}
      {flags.map((f) => (
        <span
          key={f.label}
          className={cn(
            'inline-flex items-center rounded-full border-2 px-2.5 py-0.5 text-sm font-medium',
            f.tone === 'ok' && 'border-money text-money',
            f.tone === 'warn' && 'border-primary text-primary',
            f.tone === 'danger' && 'border-destructive text-destructive',
            f.tone === 'muted' && 'border-border text-muted-foreground',
          )}
        >
          {f.label}
        </span>
      ))}
    </div>
  );
}
