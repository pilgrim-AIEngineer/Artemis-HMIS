/**
 * FND-06: print route, bundled fonts, print_log copies with the DUPLICATE mark, and the sample
 * template at every paper size (screenshots + real @page sizes via PDF). Desktop checks the
 * pixels; the tablet project taps through the same flow.
 */
import { expect, test } from '@playwright/test';
import { E2E_USERS } from './fixtures';
import { samplePrintHref, signInReady } from './helpers';

const PAPERS = ['thermal80', 'a5', 'a4', 'label50x25'] as const;
type Paper = (typeof PAPERS)[number];

/** `window.print()` is counted instead of opening a dialog (headless Chromium has none). */
const stubPrint = `window.__printCalls = 0; window.print = () => { window.__printCalls++; };`;

/** Page size in PDF points from `/MediaBox`. */
function mediaBox(pdf: Buffer): [number, number] {
  const m = /\/MediaBox\s*\[\s*0\s+0\s+([\d.]+)\s+([\d.]+)\s*\]/.exec(pdf.toString('latin1'));
  if (!m) throw new Error('no MediaBox');
  return [Number(m[1]), Number(m[2])];
}
const pt = (mm: number) => (mm / 25.4) * 72;
const SIZE_MM: Record<Paper, [number, number | null]> = {
  thermal80: [80, null],
  a5: [148, 210],
  a4: [210, 297],
  label50x25: [50, 25],
};

test.describe('sample template at each paper size', () => {
  test.beforeEach(({ browserName: _browserName }, info) => {
    test.skip(info.project.name !== 'desktop', 'pixel checks run once, on desktop');
  });

  for (const paper of PAPERS) {
    test(`${paper}: screenshot, @page size and bundled fonts`, async ({ page, baseURL }) => {
      const own = new URL(baseURL!).origin;
      const external: string[] = [];
      page.on('request', (r) => {
        const u = new URL(r.url());
        if (u.protocol.startsWith('http') && u.origin !== own) external.push(r.url());
      });
      await signInReady(page, E2E_USERS.admin);
      await page.goto(await samplePrintHref(page, paper));
      const sheet = page.locator('.print-sheet');
      await expect(sheet).toBeVisible();
      await page.evaluate(() => document.fonts.ready.then(() => undefined));

      // Noto Sans (Latin) and Noto Sans Devanagari (Hindi text) both load from our own server.
      const loaded = await page.evaluate(() =>
        [...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family),
      );
      if (paper !== 'label50x25') expect(loaded).toContain('Noto Sans Devanagari');
      expect(loaded.some((f) => f.includes('Noto Sans'))).toBe(true);
      expect(external).toEqual([]);

      // Time, QR (derived from the random facility id) and the label's id change per run.
      await expect(sheet).toHaveScreenshot(`sample-${paper}.png`, {
        mask: [
          page.locator('.print-footer-text'),
          page.locator('.print-qr'),
          page.locator('.print-label-text p:last-child'),
        ],
        maxDiffPixelRatio: 0.02,
      });

      // The @page rule really sets the paper (Chromium honours it for PDF output).
      const pdf = await page.pdf({ preferCSSPageSize: true, printBackground: true });
      const [w, h] = mediaBox(pdf);
      const [wantW, wantH] = SIZE_MM[paper];
      if (wantH !== null) {
        expect(w).toBeCloseTo(pt(wantW), 0);
        expect(h).toBeCloseTo(pt(wantH), 0);
      } else {
        // Rolls take their width from the printer driver; the worker's PDFs set it (worker test).
        const css = await page.evaluate(
          () => document.querySelector('.print-root style')?.textContent ?? '',
        );
        expect(css).toMatch(/@page\s*\{[^}]*margin: 3mm/);
        expect(/@page\s*\{[^}]*\bsize:/.test(css)).toBe(false);
      }
    });
  }
});

test('Print logs a copy; reprints say DUPLICATE; Ctrl+P cannot skip the log', async ({ page }) => {
  await page.addInitScript(stubPrint);
  await signInReady(page, E2E_USERS.admin);
  await page.goto(await samplePrintHref(page, 'a5'));
  const status = page.getByText(/This will be|Already printed before/);
  await expect(status).toBeVisible();
  const startCopy = /copy (\d+)/.exec((await status.textContent()) ?? '');
  const first = startCopy ? Number(startCopy[1]) : 1;

  // Click: print.begin runs, then a hidden frame loads that copy and opens the dialog.
  await page.getByRole('button', { name: /^Print/ }).click();
  const frame = page.frameLocator('iframe[aria-hidden="true"]');
  await expect(frame.locator('.print-root')).toHaveAttribute('data-copy', String(first));
  await expect
    .poll(async () =>
      page
        .frames()
        .at(-1)
        ?.evaluate(() => (window as never as { __printCalls: number }).__printCalls),
    )
    .toBe(1);

  // Ctrl+P is routed through the same log (the browser's own print would skip it).
  await page.keyboard.press('Control+p');
  await expect(frame.locator('.print-root')).toHaveAttribute('data-copy', String(first + 1));
  await expect(frame.getByTestId('duplicate-watermark')).toHaveCount(1);

  // Reloading the preview now offers a DUPLICATE; viewing it logs nothing.
  await page.reload();
  await expect(
    page.getByText(`This will be copy ${first + 2} and is marked DUPLICATE`, { exact: false }),
  ).toBeVisible();
  await expect(page.getByTestId('duplicate-watermark')).toHaveCount(1);
  await page.reload();
  await expect(page.getByText(`copy ${first + 2}`, { exact: false })).toBeVisible();

  // A logged copy renders as logged: copy 1 has no watermark when it was the original.
  const url = new URL(page.url());
  await page.goto(`${url.pathname}?copy=${first + 1}`);
  await expect(page.getByText(`Showing copy ${first + 1}.`)).toBeVisible();
  await expect(page.getByTestId('duplicate-watermark')).toHaveCount(1);
  await expect(page.locator('.print-duplicate-line')).toContainText(`#${first + 1}`);
  // A copy nobody printed cannot be invented through the URL.
  const missing = await page.goto(`${url.pathname}?copy=${first + 50}`);
  expect(missing?.status()).toBe(404);
});

test('the print page is closed to roles without the template permission', async ({
  page,
  browser,
}) => {
  await signInReady(page, E2E_USERS.admin);
  const href = await samplePrintHref(page, 'a4');
  const ctx = await browser.newContext();
  const other = await ctx.newPage();
  await signInReady(other, E2E_USERS.reception);
  const res = await other.goto(href);
  expect(res?.status()).toBe(404);
  await ctx.close();
});

test('the print page needs a signed-in user and speaks Hindi to Hindi users', async ({ page }) => {
  await signInReady(page, E2E_USERS.admin);
  const href = await samplePrintHref(page, 'a4');
  try {
    await page.getByRole('button', { name: 'हिन्दी' }).click();
    await expect(page.locator('html')).toHaveAttribute('lang', 'hi');
    await page.goto(href);
    await expect(page.getByRole('button', { name: /प्रिंट करें/ })).toBeVisible();
    await expect(page.locator('.print-title')).toContainText('नमूना दस्तावेज़');
  } finally {
    // The language is saved on the user: put it back for the other tests.
    await page.goto('/');
    await page.getByRole('button', { name: 'English' }).click();
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  }

  const anon = await page.context().browser()!.newContext();
  const anonPage = await anon.newPage();
  await anonPage.goto(href);
  await expect(anonPage).toHaveURL(/\/login/);
  await anon.close();
});
