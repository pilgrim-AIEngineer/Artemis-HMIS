import { renderToStaticMarkup } from 'react-dom/server';
import { PrintPage } from './components/print-page';
import type { PrintDocument } from './types';

const escapeHtml = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/**
 * Complete standalone HTML page for the worker (`pdf.render`): fonts inlined by the caller
 * (`fontCss` from `@hmis/print/node`), no network access needed.
 */
export function renderPrintHtml(doc: PrintDocument, fontCss: string): string {
  const title = `${doc.template.title.en} · ${doc.header.nameEn}`;
  return `<!doctype html>
<html lang="hi"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>${fontCss}
html, body { margin: 0; padding: 0; background: #fff; }
</style></head><body>${renderToStaticMarkup(<PrintPage doc={doc} />)}</body></html>`;
}
