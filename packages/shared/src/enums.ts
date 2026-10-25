/**
 * Text enums backing DB CHECK constraints (docs/04 intro). Add values additively; removing one
 * needs a data migration first.
 */

export const USER_LOCALES = ['en', 'hi'] as const;

export const DOCUMENT_KINDS = [
  'rx_scan',
  'form_f_signed',
  'consent',
  'report_pdf',
  'photo',
  'ecg',
  'other',
] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

export const RECORD_STATUSES = ['active', 'cancelled'] as const;

export const AUDIT_ACTIONS = ['I', 'U', 'D'] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export const INTEGRATION_SYSTEMS = ['abdm', 'nhcx', 'lab_analyser'] as const;
export const INTEGRATION_DIRECTIONS = ['inbound', 'outbound'] as const;
export const INTEGRATION_EVENT_STATUSES = [
  'pending',
  'processing',
  'done',
  'failed',
  'cancelled',
] as const;
