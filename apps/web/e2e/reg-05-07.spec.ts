/**
 * REG-05 / REG-06 / REG-07: the waiting-hall TV (no login, key link, tokens only), the OPD sheet
 * printed from the vitals desk, the patient sticker and the UHID card. Screenshots of the three
 * prints run on desktop only; the tablet project walks the same flow by touch. No URL ever carries
 * patient data. Synthetic patients only.
 */
import { expect, test, type Browser, type Page, type Request } from '@playwright/test';
import { E2E_USERS } from './fixtures';
import { signInReady } from './helpers';

const stubPrint = `window.__printCalls = 0; window.print = () => { window.__printCalls++; };`;
const KEY_PARAM = /^[A-Za-z0-9_-]{43}$/;

/** Number of pages in a PDF (`/Type /Page`, not `/Pages`). */
const pdfPages = (pdf: Buffer) =>
  (pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length;
const mediaBox = (pdf: Buffer): [number, number] => {
  const m = /\/MediaBox\s*\[\s*0\s+0\s+([\d.]+)\s+([\d.]+)\s*\]/.exec(pdf.toString('latin1'));
  if (!m) throw new Error('no MediaBox');
  return [Number(m[1]), Number(m[2])];
};
const pt = (mm: number) => (mm / 25.4) * 72;

const ids = { patientId: '', encounterId: '' };
let sensitive: string[] = [];

/** Every URL the browser requests (pages, frames, XHR) must be free of patient data. */
function watchUrls(page: Page, seen: string[]) {
  page.on('request', (r: Request) => seen.push(r.url()));
}
function expectNoPatientData(urls: string[]) {
  expect(urls.length).toBeGreaterThan(10);
  for (const u of urls) {
    const decoded = decodeURIComponent(u).toLowerCase();
    for (const s of sensitive) expect(decoded, u).not.toContain(s.toLowerCase());
  }
}

async function register(page: Page, first: string, mobile: string) {
  await page.goto('/reception/patients/new');
  await page.getByLabel('First name').fill(first);
  await page.getByLabel('Surname').fill('Displaytest');
  await page.getByText('Female', { exact: true }).click();
  await page.getByLabel('Age', { exact: true }).fill('29');
  await page.getByLabel('Mobile number', { exact: true }).fill(mobile);
  await page.getByRole('button', { name: 'Save patient' }).click();
  await expect(page).toHaveURL(/\/reception\/patients\/[0-9a-f-]{36}\?registered=/);
  return /\/patients\/([0-9a-f-]{36})/.exec(page.url())![1]!;
}

async function printed(page: Page, template: string, copy: number) {
  const frame = page.frameLocator('iframe[aria-hidden="true"]');
  await expect(frame.locator('.print-root')).toHaveAttribute('data-template', template);
  await expect(frame.locator('.print-root')).toHaveAttribute('data-copy', String(copy));
  await expect
    .poll(() =>
      page
        .frames()
        .at(-1)
        ?.evaluate(() => (window as never as { __printCalls: number }).__printCalls),
    )
    .toBe(1);
}

async function newContextPage(browser: Browser, page: Page) {
  const ctx = await browser.newContext({
    viewport: page.viewportSize() ?? { width: 1366, height: 768 },
    timezoneId: 'Asia/Kolkata',
    locale: 'en-IN',
  });
  return { ctx, page: await ctx.newPage() };
}

test.describe.serial('TV display and registration prints', () => {
  test('TV link, OPD sheet at the vitals desk, and a live TV without patient data', async ({
    page,
    browser,
  }, info) => {
    test.setTimeout(120_000);
    const desktop = info.project.name === 'desktop';
    const first = desktop ? 'Lata' : 'Geeta';
    const mobile = desktop ? '9415300001' : '9415300002';
    sensitive = [first, 'Displaytest', mobile];
    const urls: string[] = [];

    // ---- the owner makes the TV link
    const owner = await newContextPage(browser, page);
    watchUrls(owner.page, urls);
    await signInReady(owner.page, E2E_USERS.owner);
    await owner.page.goto('/admin/display');
    await owner.page.getByRole('button', { name: /^(Make TV link|Make a new TV link)$/ }).click();
    // On the second project a link already exists: replacing it asks first.
    const confirmReplace = owner.page.getByRole('button', { name: 'Yes, switch off the old link' });
    if (await confirmReplace.isVisible()) await confirmReplace.click();
    const link = await owner.page.getByTestId('display-link').locator('input').inputValue();
    const tvUrl = new URL(link);
    expect(tvUrl.pathname).toBe('/display/queue');
    expect([...tvUrl.searchParams.keys()]).toEqual(['key']);
    expect(tvUrl.searchParams.get('key')).toMatch(KEY_PARAM);
    // Admins without queue.display.manage cannot open the page.
    const adminCtx = await newContextPage(browser, page);
    await signInReady(adminCtx.page, E2E_USERS.admin);
    expect((await adminCtx.page.goto('/admin/display'))?.status()).toBe(404);
    await adminCtx.ctx.close();

    // ---- the TV: no login, wrong or missing key is a 404
    const tv = await newContextPage(browser, page);
    watchUrls(tv.page, urls);
    expect((await tv.page.goto('/display/queue'))?.status()).toBe(404);
    expect((await tv.page.goto(`/display/queue?key=${'A'.repeat(43)}`))?.status()).toBe(404);
    await tv.page.goto(link);
    await expect(tv.page.getByTestId('queue-display')).toHaveAttribute('data-status', 'ok');
    expect(await tv.page.evaluate(() => document.referrer)).toBe('');

    // ---- reception: patient, visit, token
    await page.addInitScript(stubPrint);
    watchUrls(page, urls);
    await signInReady(page, E2E_USERS.reception);
    ids.patientId = await register(page, first, mobile);
    await page.getByRole('link', { name: 'New visit' }).click();
    await page.getByRole('button', { name: /Dr\. Sunita Verma/ }).click();
    await page.getByRole('button', { name: 'Save visit' }).click();
    const created = page.getByTestId('visit-created');
    await created.getByRole('button', { name: 'Fee collected: give token' }).click();
    const tokenText = await created
      .getByRole('status')
      .filter({ hasText: /Token\s*\d+/ })
      .textContent();
    const tokenNo = /Token\s*(\d+)/.exec(tokenText ?? '')![1]!;
    // Sheet prints at the vitals desk by default (Q11): nothing printed at reception.
    await expect(page.locator('iframe[aria-hidden="true"]')).toHaveCount(0);

    // The TV lists waiting tokens: numbers only.
    await expect(tv.page.getByTestId('display-next').first()).toBeVisible({ timeout: 6_000 });
    const tvText = await tv.page.locator('body').innerText();
    for (const s of sensitive) expect(tvText.toLowerCase()).not.toContain(s.toLowerCase());

    // ---- vitals desk: "Vitals done" prints the OPD sheet (copy 1) by itself
    await page.goto('/reception/queue');
    const card = page.getByRole('listitem').filter({ hasText: `${first} Displaytest` });
    await card.getByRole('button', { name: 'Vitals done' }).click();
    await expect(card).toHaveAttribute('data-state', 'vitals_done');
    await printed(page, 'opd-sheet', 1);
    const frameUrl = new URL(
      page
        .frames()
        .find((f) => f.url().includes('/print/opd-sheet/'))!
        .url(),
    );
    ids.encounterId = /\/print\/opd-sheet\/([0-9a-f-]{36})$/.exec(frameUrl.pathname)![1]!;
    expect(frameUrl.search).toBe('?copy=1&embed=1');

    // A reprint from the card is marked DUPLICATE (copy 2).
    await card.getByRole('button', { name: 'Print OPD sheet' }).click();
    await expect(
      page.frameLocator('iframe[aria-hidden="true"]').locator('.print-root'),
    ).toHaveAttribute('data-copy', '2');
    await expect(
      page.frameLocator('iframe[aria-hidden="true"]').getByTestId('duplicate-watermark'),
    ).toHaveCount(1);

    // ---- calling the patient shows "Now: <token>" on the TV within a few seconds
    await card.getByRole('button', { name: 'Send in' }).click();
    await expect(tv.page.getByTestId('display-now').filter({ hasText: tokenNo })).toBeVisible({
      timeout: 6_000,
    });
    const tvAfter = await tv.page.locator('body').innerText();
    for (const s of sensitive) expect(tvAfter.toLowerCase()).not.toContain(s.toLowerCase());

    // ---- the TV keeps its board through a network blip and recovers by itself
    await tv.page.route('**/api/display/queue', (r) => r.abort());
    await expect(tv.page.getByTestId('display-status')).toBeVisible({ timeout: 10_000 });
    await expect(tv.page.getByTestId('display-now').filter({ hasText: tokenNo })).toBeVisible();
    await tv.page.unroute('**/api/display/queue');
    await expect(tv.page.getByTestId('queue-display')).toHaveAttribute('data-status', 'ok', {
      timeout: 8_000,
    });

    // ---- a new link switches the old TV off
    await owner.page.getByRole('button', { name: 'Make a new TV link' }).click();
    await owner.page.getByRole('button', { name: 'Yes, switch off the old link' }).click();
    await expect(tv.page.getByTestId('queue-display')).toHaveAttribute('data-status', 'invalid', {
      timeout: 8_000,
    });
    await expect(tv.page.getByTestId('display-now')).toHaveCount(0);

    // ---- no patient data in any URL the browsers asked for
    expectNoPatientData(urls);
    await tv.ctx.close();
    await owner.ctx.close();
  });

  test('patient sticker and UHID card print from the patient page', async ({ page }) => {
    await page.addInitScript(stubPrint);
    await signInReady(page, E2E_USERS.reception);
    await page.goto(`/reception/patients/${ids.patientId}`);
    await page.getByRole('button', { name: 'Print sticker' }).click();
    await printed(page, 'patient-sticker', 1);
    await page.getByRole('button', { name: 'Print sticker' }).click();
    // Reprints of stickers are not marked DUPLICATE (they are printed in numbers on purpose).
    await expect(
      page.frameLocator('iframe[aria-hidden="true"]').locator('.print-root'),
    ).toHaveAttribute('data-copy', '2');
    await expect(
      page.frameLocator('iframe[aria-hidden="true"]').getByTestId('duplicate-watermark'),
    ).toHaveCount(0);
  });

  test.describe('print layout (screenshots, paper size, one page)', () => {
    test.beforeEach(({ browserName: _b }, info) => {
      test.skip(info.project.name !== 'desktop', 'pixel checks run once, on desktop');
    });

    test('OPD sheet: A5, one page, QR holds the visit id only', async ({ page }) => {
      await signInReady(page, E2E_USERS.reception);
      await page.goto(`/print/opd-sheet/${ids.encounterId}?copy=1`); // the original, as printed at the vitals desk
      const sheet = page.locator('.print-sheet');
      await expect(sheet).toBeVisible();
      await page.evaluate(() => document.fonts.ready.then(() => undefined));
      // Time, UHID, token and the codes change from run to run.
      await expect(sheet).toHaveScreenshot('opd-sheet.png', {
        mask: [
          page.locator('.sheet-strip'),
          page.locator('.sheet-codes'),
          page.locator('.print-footer-text'),
        ],
        maxDiffPixelRatio: 0.02,
      });
      for (const label of ['Vitals', 'Complaints / Findings', 'Next visit', 'Admit', 'CBC']) {
        await expect(sheet).toContainText(label);
      }
      const pdf = await page.pdf({ preferCSSPageSize: true, printBackground: true });
      expect(pdfPages(pdf)).toBe(1);
      const [w, h] = mediaBox(pdf);
      expect(w).toBeCloseTo(pt(148), 0);
      expect(h).toBeCloseTo(pt(210), 0);
    });

    test('sticker: 50 × 25 mm, one label', async ({ page }) => {
      await signInReady(page, E2E_USERS.reception);
      await page.goto(`/print/patient-sticker/${ids.patientId}`);
      const sheet = page.locator('.print-sheet');
      await expect(sheet).toBeVisible();
      await page.evaluate(() => document.fonts.ready.then(() => undefined));
      await expect(sheet).toHaveScreenshot('patient-sticker.png', {
        mask: [page.locator('.sticker-uhid'), page.locator('.print-qr')],
        maxDiffPixelRatio: 0.02,
      });
      const pdf = await page.pdf({ preferCSSPageSize: true, printBackground: true });
      expect(pdfPages(pdf)).toBe(1);
      const [w, h] = mediaBox(pdf);
      expect(w).toBeCloseTo(pt(50), 0);
      expect(h).toBeCloseTo(pt(25), 0);
    });

    test('UHID card: front and back at 85.6 × 54 mm on one A5 sheet', async ({ page }) => {
      await signInReady(page, E2E_USERS.reception);
      await page.goto(`/print/uhid-card/${ids.patientId}`);
      const sheet = page.locator('.print-sheet');
      await expect(sheet).toBeVisible();
      await page.evaluate(() => document.fonts.ready.then(() => undefined));
      await expect(sheet).toHaveScreenshot('uhid-card.png', {
        mask: [page.locator('.card-uhid'), page.locator('.card-qr'), page.locator('.card-barcode')],
        maxDiffPixelRatio: 0.02,
      });
      const front = await page.getByTestId('uhid-card-front').boundingBox();
      const back = await page.getByTestId('uhid-card-back').boundingBox();
      const mm = (px: number) => (px / 96) * 25.4;
      expect(mm(front!.width)).toBeCloseTo(85.6, 0);
      expect(mm(front!.height)).toBeCloseTo(54, 0);
      expect(mm(back!.width)).toBeCloseTo(85.6, 0);
      const pdf = await page.pdf({ preferCSSPageSize: true, printBackground: true });
      expect(pdfPages(pdf)).toBe(1);
    });
  });
});
