import { describe, expect, it } from 'vitest';
import { FORBIDDEN_TERMS } from './forbidden-terms';
import { usgProcedureInputSchema, serviceInputSchema } from '../masters';
import { patientRegistrationSchema } from '../patients';
import { reasonSchema } from '../auth';

// Terms come from the term list's own examples; never written literally (rule 7).
const ex = (id: string) => FORBIDDEN_TERMS.find((t) => t.id === id)!.examples[0]!;
const always = ex('pn01');
const strict = ex('pn15');

const messages = (r: { success: boolean; error?: { issues: { message: string }[] } }) =>
  r.error?.issues.map((i) => i.message) ?? [];

describe('runtime forbidden-term guard on inputs (issue #37, D-10)', () => {
  it('rejects forbidden wording in USG procedure name (strict tier)', () => {
    for (const name of [always, strict]) {
      const r = usgProcedureInputSchema.safeParse({ code: 'XS1', name, category: 'obstetric' });
      expect(r.success, name).toBe(false);
      expect(messages(r)).toContain('validation.forbiddenTerm');
    }
  });

  it('accepts an ordinary USG procedure', () => {
    expect(
      usgProcedureInputSchema.safeParse({
        code: 'OB1',
        name: 'Obstetric scan',
        category: 'obstetric',
      }).success,
    ).toBe(true);
  });

  it('rejects forbidden wording in general masters names (always tier)', () => {
    const r = serviceInputSchema.safeParse({ code: 'S1', name: always, category: 'misc' });
    expect(messages(r)).toContain('validation.forbiddenTerm');
  });

  it('rejects forbidden wording in patient free text, but keeps "sex" demographic wording', () => {
    const base = { firstName: 'Asha', sex: 'F', age: '25', mobile: '9876543210' };
    const bad = patientRegistrationSchema.safeParse({ ...base, referredBy: always });
    expect(messages(bad)).toContain('validation.forbiddenTerm');
    const ok = patientRegistrationSchema.safeParse({ ...base, referredBy: 'sex ratio camp' });
    expect(messages(ok)).not.toContain('validation.forbiddenTerm');
  });

  it('rejects forbidden wording in shared reason text', () => {
    expect(messages(reasonSchema.safeParse(always))).toContain('validation.forbiddenTerm');
  });
});
