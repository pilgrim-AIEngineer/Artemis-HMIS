/**
 * Permission keys (docs/03 §2) and default role keys (docs/03 §1). The keys are the contract
 * between `requirePermission('module.action')`, role seeds and `restricted.*` RLS; add new keys
 * here first. Role -> permission bundles are seeded by the db package, not defined here.
 */

export const PERMISSIONS = [
  'admin.users.manage',
  'admin.roles.manage',
  'admin.settings.manage',
  'admin.masters.manage',
  'admin.tariff.manage',
  'admin.audit.view',
  'admin.import.run',
  'patient.create',
  'patient.update',
  'patient.merge',
  'patient.view',
  'patient.view.restricted',
  'visit.create',
  'visit.cancel',
  'queue.manage',
  'queue.call',
  'queue.display.manage',
  'vitals.record',
  'rx.transcribe',
  'rx.verify',
  'rx.view',
  'order.create',
  'order.cancel',
  'clinical.anc.edit',
  'clinical.paeds.edit',
  'clinical.note.edit',
  'billing.bill.create',
  'billing.bill.finalize',
  'billing.bill.cancel',
  'billing.payment.collect',
  'billing.refund.create',
  'billing.discount.apply',
  'billing.discount.approve',
  'billing.dayclose.own',
  'billing.dayclose.facility',
  'billing.deposit.collect',
  'billing.package.apply',
  'billing.ipd.final',
  'usg.report.edit',
  'usg.report.sign',
  'pcpndt.formf.edit',
  'pcpndt.formf.sign',
  'pcpndt.reports.view',
  'mtp.register.view',
  'mtp.register.edit',
  'mtp.reports.view',
  'mtp.audit.view',
  'pharmacy.sale',
  'pharmacy.return',
  'pharmacy.purchase',
  'pharmacy.stock.adjust',
  'pharmacy.h1.view',
  'inventory.transfer',
  'inventory.indent',
  'inventory.consignment',
  'lab.sample.collect',
  'lab.result.enter',
  'lab.result.verify',
  'ipd.admit',
  'ipd.transfer',
  'ipd.discharge',
  'ipd.order.write',
  'ipd.note.write',
  'nursing.chart',
  'nursing.mar',
  'ot.schedule',
  'ot.note.write',
  'lr.note.write',
  'newborn.register',
  'registers.birth.view',
  'discharge.write',
  'discharge.sign',
  'reports.collection',
  'reports.clinical',
  'reports.financial',
  'reports.owner_dashboard',
  'payer.pmjay.manage',
  'payer.tpa.manage',
  'payer.corporate.manage',
  'cardiology.report.edit',
  'icu.chart',
  'cathlab.report.edit',
  'implants.manage',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

/** `module` part of a key (`billing.bill.create` -> `billing`). */
export type PermissionModule<P extends string = Permission> = P extends `${infer M}.${string}`
  ? M
  : never;

const PERMISSION_SET: ReadonlySet<string> = new Set(PERMISSIONS);

export const isPermission = (v: unknown): v is Permission =>
  typeof v === 'string' && PERMISSION_SET.has(v);

/**
 * Typed helper so call sites cannot misspell a key:
 * `requirePermission(perm('billing.discount.approve'))`.
 */
export const perm = <P extends Permission>(key: P): P => key;

/** Keys that are never part of a default bundle (docs/03 §2, §5): restricted MTP data. */
export const RESTRICTED_PERMISSIONS = [
  'patient.view.restricted',
  'mtp.register.view',
  'mtp.register.edit',
  'mtp.reports.view',
  'mtp.audit.view',
] as const satisfies readonly Permission[];

export const ROLE_KEYS = [
  'owner',
  'admin',
  'doctor',
  'doctor_assistant',
  'reception',
  'cashier',
  'nurse',
  'pharmacist',
  'lab_tech',
  'pathologist',
  'usg_doctor',
  'usg_assistant',
  'mtp_doctor',
  'store_keeper',
  'pmjay_desk',
  'auditor',
] as const;

export type RoleKey = (typeof ROLE_KEYS)[number];
