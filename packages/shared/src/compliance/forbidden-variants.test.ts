import { describe, expect, it } from 'vitest';
import { findForbiddenTerms } from './forbidden-terms';

// Terms are assembled from fragments so this file stays clean for `pnpm check:forbidden`.
const FE = 'fe';
const TUS = 'tus';
const SX = ['s', 'ex'].join('');
const GN = ['gen', 'der'].join('');
const BB = ['ba', 'by'].join('');
const ZW = '​';
const CYR_E = 'е';

const positives: readonly string[] = [
  `${FE}${TUS}_${SX}`,
  `${FE}${TUS} ${SX}`,
  `${FE}${TUS} ${SX}`.toUpperCase(),
  `${FE}${TUS} ${GN}`,
  `fo${FE}${TUS} ${GN}`,
  `${SX} of ${BB}`,
  `${GN} of ${BB}`,
  `${BB} ${SX}`,
  `${SX} of the un${'born'} child`,
  `${FE}${TUS}: ${['ma', 'le'].join('')}`,
  `M/F ${FE}${TUS}`,
  `${SX} determination`,
  `fetal${ZW}${SX}`,
  `f${CYR_E}tal ${SX}`,
  `fetal s3x`,
  `fœtal ${SX}`,
  `fetal­ ${SX}`,
  'बेटा',
  'बेटी',
  'पेट में बेटा',
  'लिंग निर्धारण',
  `garbh ka ${['li', 'ng'].join('')}`,
  `bhrun ka ${['li', 'ng'].join('')}`,
];

describe('forbidden-term variants (issue #13)', () => {
  it.each(positives)('flags %j in the always tier', (s) => {
    expect(findForbiddenTerms(s, { tier: 'always' }).length).toBeGreaterThan(0);
  });

  it.each([
    `l${'add'}ka`,
    `larka`,
    `larki`,
    `L${'add'}ki hai`,
  ])('flags %j in the strict tier', (s) => {
    expect(findForbiddenTerms(s, { tier: 'strict' }).length).toBeGreaterThan(0);
  });

  it.each([
    'patient sex',
    'sex of the living child',
    'fetal heart rate',
    'fetal presentation',
    'baby weight',
    'sexual history',
    'ladder',
    'genderless',
    'unborn',
  ])('does not flag %j', (s) => {
    expect(findForbiddenTerms(s, { tier: 'strict' })).toEqual([]);
  });
});
