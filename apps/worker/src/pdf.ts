import { PAPER_SIZES, type PaperSize } from '@hmis/print';
import { chromium } from 'playwright-core';

const PX_PER_MM = 96 / 25.4;

/**
 * Renders print HTML (from `renderPrintHtml`, fonts inlined) to PDF with headless Chromium,
 * honouring the template's `@page` rules (docs/01 §2, §4). Thermal rolls have no fixed height, so
 * the page is cut to the measured content height.
 */
export async function renderPdf(html: string, paper: PaperSize): Promise<Uint8Array> {
  const spec = PAPER_SIZES[paper];
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
    // Containers running as a non-root user without user namespaces need this (worker image).
    args: process.env.HMIS_CHROMIUM_NO_SANDBOX === '1' ? ['--no-sandbox'] : [],
  });
  try {
    const page = await browser.newPage({
      viewport: { width: Math.round((spec.widthMm - 2 * spec.marginMm) * PX_PER_MM), height: 800 },
    });
    await page.emulateMedia({ media: 'print' });
    await page.setContent(html, { waitUntil: 'load' });
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    if (spec.heightMm === null) {
      const contentPx = await page.evaluate(
        () => document.querySelector('.print-sheet')?.getBoundingClientRect().height ?? 0,
      );
      const heightMm = Math.ceil(contentPx / PX_PER_MM + 2 * spec.marginMm + 1);
      await page.addStyleTag({
        content: `@page { size: ${spec.widthMm}mm ${heightMm}mm; margin: ${spec.marginMm}mm; }`,
      });
    }
    return await page.pdf({ preferCSSPageSize: true, printBackground: true });
  } finally {
    await browser.close();
  }
}

/** Number of pages in a PDF produced by Chromium (counts `/Type /Page` objects). */
export function countPdfPages(pdf: Uint8Array): number {
  const text = Buffer.from(pdf).toString('latin1');
  return (text.match(/\/Type\s*\/Page(?![a-zA-Z])/g) ?? []).length;
}
