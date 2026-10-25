import { PAPER_SIZES, type PaperSize } from '../paper';
import { L } from '../labels';
import type { PrintTemplateMeta } from '../types';

/** `sample-a4`, `sample-thermal80`, …: one sample template per paper size (FND-06). */
export const sampleTemplateKey = (paper: PaperSize) => `sample-${paper}`;

const SAMPLE_METAS = (Object.keys(PAPER_SIZES) as PaperSize[]).map((paper): PrintTemplateMeta => ({
  key: sampleTemplateKey(paper),
  paper,
  entity: 'facility',
  permission: 'admin.settings.manage',
  title: L.sampleTitle,
}));

/** All print templates, client-safe. Add real templates here and in `server.tsx`. */
export const PRINT_TEMPLATE_METAS: readonly PrintTemplateMeta[] = SAMPLE_METAS;

export const findTemplateMeta = (key: string): PrintTemplateMeta | undefined =>
  PRINT_TEMPLATE_METAS.find((t) => t.key === key);
