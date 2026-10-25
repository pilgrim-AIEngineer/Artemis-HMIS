import { z } from 'zod';

/**
 * Facility profile (docs/04 §1: `facility`), edited in Admin → Facility profile and printed in
 * every document header (docs/05 §6). Blank optional fields are stored as NULL. Messages are i18n
 * keys (`validation.*`).
 */

const optionalText = (max: number, message = 'validation.invalid') =>
  z
    .string()
    .trim()
    .max(max, message)
    .optional()
    .transform((v) => (v ? v : null));

const optionalPattern = (re: RegExp, message: string, upper = false) =>
  z
    .string()
    .trim()
    .optional()
    .transform((v) => (v ? (upper ? v.toUpperCase() : v) : null))
    .refine((v) => v === null || re.test(v), message);

export const facilityProfileSchema = z.object({
  name: z.string().trim().min(2, 'validation.required').max(120, 'validation.invalid'),
  shortName: optionalText(40),
  address: optionalText(300),
  district: optionalText(80),
  state: optionalText(80),
  pincode: optionalPattern(/^[1-9][0-9]{5}$/, 'validation.pincode'),
  phone: optionalPattern(/^[0-9+][0-9 +()-]{5,19}$/, 'validation.phone'),
  email: z
    .string()
    .trim()
    .optional()
    .transform((v) => (v ? v : null))
    .refine((v) => v === null || z.email().safeParse(v).success, 'validation.email'),
  gstin: optionalPattern(/^[0-9]{2}[A-Z0-9]{13}$/, 'validation.gstin', true),
  clinicalEstablishmentRegNo: optionalText(60),
  pcpndtRegNo: optionalText(60),
  mtpApprovalNo: optionalText(60),
  drugLicenceNos: z
    .array(z.string().trim().min(1, 'validation.required').max(60, 'validation.invalid'))
    .max(10, 'validation.invalid')
    .default([]),
  hfrId: optionalText(40),
});

/** What the form submits (before blank → null). */
export type FacilityProfileInput = z.input<typeof facilityProfileSchema>;
export type FacilityProfile = z.output<typeof facilityProfileSchema>;
