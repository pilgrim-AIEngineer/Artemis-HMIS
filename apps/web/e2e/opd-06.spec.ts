/**
 * OPD-06 / flow 8 (docs/32 §1): paediatrics. A newborn's vaccine is due → the assistant records
 * it with its batch → the next due date is worked out → the WhatsApp reminder is queued in the
 * outbox. Also growth with WHO z-scores and the printed vaccination card (A5, both languages).
 * Desktop and tablet projects share one database, so each registers its own child. Synthetic data.
 */
import { expect, test, type Browser, type Page } from '@playwright/test';
import { E2E_USERS } from './fixtures';
import { printedFrame, signInReady } from './helpers';

const stubPrint = `window.__printCalls = 0; window.print = () => { window.__printCalls++; };`;

/** The IST calendar day `offset` days from today, as YYYY-MM-DD (the app counts days in IST). */
const istDay = (offset: number) =>
  new Date(Date.now() + offset * 86_400_000).toLocaleDateString('en-CA', {
    timeZone: 'Asia/Kolkata',
  });
/** `21-Nov-2026`, the way the app shows a date. */
const shown = (iso: string) => {
  const [y, m, d] = iso.split('-') as [string, string, string];
  const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${d}-${mon[Number(m) - 1]}-${y}`;
};

async function assistantPage(browser: Browser, page: Page) {
  const ctx = await browser.newContext({
    viewport: page.viewportSize() ?? { width: 1366, height: 768 },
    timezoneId: 'Asia/Kolkata',
    locale: 'en-IN',
    hasTouch: page.viewportSize()?.width === 1280,
  });
  const assistant = await ctx.newPage();
  await assistant.addInitScript(stubPrint);
  await signInReady(assistant, E2E_USERS.assistant);
  return { ctx, page: assistant };
}

const field = (page: Page, name: string) => page.getByLabel(name, { exact: true });

test.describe.serial('Paediatrics: vaccines and growth (OPD-06)', () => {
  const ids = { patientId: '', first: '' };

  test('flow 8: vaccine due → given with batch → next due computed → reminder queued', async ({
    page,
    browser,
  }, info) => {
    test.setTimeout(240_000);
    const desktop = info.project.name === 'desktop';
    const first = desktop ? 'Kabir' : 'Myra';
    const mobile = desktop ? '9415600001' : '9415600002';
    ids.first = first;

    // ---- reception: a 14-day-old child
    await page.addInitScript(stubPrint);
    await signInReady(page, E2E_USERS.reception);
    await page.goto('/reception/patients/new');
    await page.getByLabel('First name').fill(first);
    await page.getByLabel('Surname').fill('Paedtest');
    await page.getByText(desktop ? 'Male' : 'Female', { exact: true }).click();
    await page.getByLabel('Age', { exact: true }).fill('14d');
    await page.getByLabel('Mobile number', { exact: true }).fill(mobile);
    await page.getByRole('button', { name: 'Save patient' }).click();
    await expect(page).toHaveURL(/\/reception\/patients\/[0-9a-f-]{36}\?registered=/);
    ids.patientId = /patients\/([0-9a-f-]{36})/.exec(page.url())![1]!;

    // ---- assistant: find the child on the paediatrics desk with the keyboard
    const { ctx, page: desk } = await assistantPage(browser, page);
    await desk.goto('/assistant');
    await desk.getByRole('link', { name: 'Vaccines and growth' }).click();
    await expect(
      desk.getByRole('heading', { level: 1, name: 'Paediatrics: vaccines and growth' }),
    ).toBeVisible();
    await expect(desk.getByTestId('paeds-pending-signoff')).toContainText(
      'Pending paediatrician sign-off',
    );
    await field(desk, 'Find a child').fill(`${first} Paedtest`);
    await expect(desk.getByTestId('paeds-search-results')).toContainText(`${first} Paedtest`);
    await field(desk, 'Find a child').press('Enter');
    await expect(desk).toHaveURL(/\/assistant\/paeds\/[0-9a-f-]{36}$/);

    // The IAP schedule is the default; the birth doses are overdue (14 days, grace 7).
    await expect(desk.getByTestId('paeds-schedule-table')).toBeVisible();
    const row = (code: string) =>
      desk.locator(`[data-testid="paeds-schedule-table"] [data-code="${code}"]`);
    await expect(row('BCG-1')).toHaveAttribute('data-status', 'overdue');
    await expect(row('DTP-1')).toHaveAttribute('data-status', 'upcoming');
    await expect(row('DTP-1')).toContainText(shown(istDay(28)));
    await expect(desk.getByTestId('paeds-next-due')).toHaveText(shown(istDay(-14)));

    // ---- the family agrees to WhatsApp reminders
    const consent = desk.getByRole('checkbox', { name: /The family agrees to WhatsApp reminders/ });
    await consent.click(); // saved on the server, so the box follows once it is
    await expect(consent).toBeChecked();
    await expect(desk.getByTestId('paeds-reminder')).toContainText('No reminder is queued');

    // ---- an early dose needs a person's confirmation
    await row('DTP-1')
      .getByRole('button', { name: /Record DTP-1/ })
      .click();
    const dialog = desk.getByTestId('dose-dialog');
    await expect(dialog.getByTestId('dose-warnings')).toContainText(
      'This is earlier than the schedule allows.',
    );
    await dialog.getByLabel('Batch number').fill('DTP-E2E');
    await dialog.getByLabel('Expiry date').fill(istDay(400));
    await expect(dialog.getByRole('button', { name: 'Save dose' })).toBeDisabled();
    await dialog.getByRole('checkbox', { name: /I have checked this/ }).check();
    await expect(dialog.getByRole('button', { name: 'Save dose' })).toBeEnabled();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(desk.getByTestId('paeds-given-empty')).toBeVisible();

    // ---- record the three birth doses with their batches
    for (const [code, name, batch] of [
      ['BCG-1', 'BCG', 'BCG-E2E-1'],
      ['OPV-1', 'OPV-0', 'OPV-E2E-1'],
      ['HEPB-1', 'Hep B-1', 'HEPB-E2E-1'],
    ] as const) {
      await row(code)
        .getByRole('button', { name: `Record ${name}` })
        .click();
      const d = desk.getByTestId('dose-dialog');
      await d.getByLabel('Brand (optional)').fill('Testvax');
      await d.getByLabel('Batch number').fill(batch);
      await d.getByLabel('Expiry date').fill(istDay(400));
      await expect(d.getByTestId('dose-warnings')).toHaveCount(0);
      await d.getByRole('button', { name: 'Save dose' }).click();
      await expect(d).toHaveCount(0);
      await expect(desk.getByTestId('paeds-given-table')).toContainText(batch);
    }
    // Oral vaccine went in by mouth (the form starts with that), BCG into the skin.
    await expect(
      desk.locator('[data-testid="paeds-given-table"] [data-code="OPV-1"]'),
    ).toContainText('Oral');
    await expect(
      desk.locator('[data-testid="paeds-given-table"] [data-code="BCG-1"]'),
    ).toContainText('Left arm (skin)');

    // ---- the next due date is the 6-week visit, and the reminder is queued in the outbox
    await expect(desk.getByTestId('paeds-next-due')).toHaveText(shown(istDay(28)));
    const queued = desk.getByTestId('paeds-reminder-queued');
    await expect(queued).toContainText('Reminder queued');
    await expect(queued).toContainText('DTP-1');
    await expect(queued).toContainText('Rotavirus-1');
    await expect(queued).toContainText(shown(istDay(28)));
    await expect(queued).toContainText(shown(istDay(26))); // goes out 2 days before

    // Withdrawing consent cancels the queued message; agreeing again queues it once more.
    await consent.click();
    await expect(consent).not.toBeChecked();
    await expect(desk.getByTestId('paeds-reminder-queued')).toHaveCount(0);
    await consent.click();
    await expect(consent).toBeChecked();
    await expect(desk.getByTestId('paeds-reminder-queued')).toHaveCount(1);

    // ---- a mistaken entry is cancelled with a reason, never deleted
    await desk
      .locator('[data-testid="paeds-given-table"] [data-code="HEPB-1"]')
      .getByRole('button', { name: /Cancel Hep B-1/ })
      .click();
    await field(desk, 'Reason for cancelling').fill('Entered on the wrong child');
    await desk.getByRole('button', { name: 'Cancel this entry' }).click();
    await expect(desk.getByTestId('paeds-given-table')).not.toContainText('HEPB-E2E-1');
    await expect(row('HEPB-1')).toHaveAttribute('data-status', 'overdue');
    await row('HEPB-1').getByRole('button', { name: 'Record Hep B-1' }).click();
    const again = desk.getByTestId('dose-dialog');
    await again.getByLabel('Batch number').fill('HEPB-E2E-2');
    await again.getByLabel('Expiry date').fill(istDay(400));
    await again.getByRole('button', { name: 'Save dose' }).click();
    await expect(desk.getByTestId('paeds-given-table')).toContainText('HEPB-E2E-2');
    await expect(desk.getByTestId('paeds-reminder-queued')).toHaveCount(1);

    // ---- print the vaccination card: A5, both languages, batches, what is still due
    await desk.getByRole('button', { name: 'Print vaccination card' }).click();
    const frame = await printedFrame(desk, 'vaccination-card', 1);
    await expect(frame.getByTestId('vax-given')).toContainText('BCG-E2E-1');
    await expect(frame.getByTestId('vax-given')).toContainText('HEPB-E2E-2');
    await expect(frame.getByTestId('vax-pending')).toContainText('DTP-1');
    await expect(frame.getByTestId('vax-pending')).not.toContainText('BCG');
    await expect(frame.getByTestId('vax-next')).toContainText(shown(istDay(28)));
    await expect(frame.locator('.vax-title')).toContainText('टीकाकरण कार्ड');
    await expect(frame.getByTestId('duplicate-watermark')).toHaveCount(0);

    // ---- reception (no paediatrics edit permission) reads the card but cannot change it
    await page.goto(`/assistant/paeds/${ids.patientId}`);
    await expect(page.getByTestId('paeds-next-due')).toHaveText(shown(istDay(28)));
    await expect(page.getByRole('button', { name: /^Record / })).toHaveCount(0);
    await expect(page.getByRole('checkbox', { name: /WhatsApp reminders/ })).toHaveCount(0);
    await ctx.close();
  });

  test("growth: WHO z-scores, charts with the child's points, values only for an older child", async ({
    page,
    browser,
  }) => {
    test.setTimeout(120_000);
    const { ctx, page: desk } = await assistantPage(browser, page);
    await desk.goto(`/assistant/paeds/${ids.patientId}`);
    const growth = desk.getByTestId('paeds-growth');
    await expect(growth.getByTestId('paeds-growth-empty')).toBeVisible();

    // A weight alone is not enough to save.
    await expect(growth.getByRole('button', { name: 'Save measurement' })).toBeDisabled();
    await field(desk, 'Weight (kg)').fill('3.9');
    await field(desk, 'Length / height (cm)').fill('53');
    await field(desk, 'Head circumference (cm)').fill('36');
    await growth.getByRole('button', { name: 'Save measurement' }).click();
    const table = growth.getByTestId('paeds-growth-table');
    await expect(table).toContainText('3.9');
    await expect(table.getByTestId('paeds-z-wfa')).toBeVisible();
    await expect(table.getByTestId('paeds-z-lhfa')).toBeVisible();
    await expect(table.getByTestId('paeds-z-hcfa')).toBeVisible();
    await expect(table.getByTestId('paeds-z-wfh')).toBeVisible();
    // Four WHO charts, each with this child's point.
    for (const ind of ['wfa', 'lhfa', 'hcfa', 'wfh']) {
      const chart = growth.getByTestId(`growth-chart-${ind}`);
      await expect(chart).toBeVisible();
      await expect(chart.getByTestId('growth-point')).toHaveCount(1);
    }

    // A mistaken value is cancelled and replaced.
    await growth.getByRole('button', { name: /Cancel the measurement of/ }).click();
    await field(desk, 'Reason for cancelling').fill('Wrong child');
    await desk.getByRole('button', { name: 'Cancel this entry' }).click();
    await expect(growth.getByTestId('paeds-growth-empty')).toBeVisible();

    // The print has the charts and the table.
    await field(desk, 'Weight (kg)').fill('4.1');
    await growth.getByRole('button', { name: 'Save measurement' }).click();
    await expect(growth.getByTestId('paeds-growth-table')).toContainText('4.1');
    await desk.getByRole('button', { name: 'Print growth chart' }).click();
    const frame = await printedFrame(desk, 'growth-chart', 1);
    await expect(frame.getByTestId('growth-chart-wfa')).toHaveCount(1);
    await expect(frame.getByTestId('growth-table')).toContainText('4.1');
    await ctx.close();
  });

  test.describe('print layout (screenshot, paper size)', () => {
    test.beforeEach(({ browserName: _b }, info) => {
      test.skip(info.project.name !== 'desktop', 'pixel checks run once, on desktop');
    });

    test('vaccination card: A5, one page', async ({ browser, page }) => {
      const { ctx, page: desk } = await assistantPage(browser, page);
      await desk.goto(`/print/vaccination-card/${ids.patientId}?copy=1`);
      const card = desk.locator('.print-sheet');
      await expect(card).toBeVisible();
      await expect(desk.getByTestId('vax-given')).toContainText('BCG-E2E-1');
      await desk.evaluate(() => document.fonts.ready.then(() => undefined));
      const sheetBox = (await card.boundingBox())!;
      const tableBox = (await desk.getByTestId('vax-given').boundingBox())!;
      expect(tableBox.x + tableBox.width).toBeLessThanOrEqual(sheetBox.x + sheetBox.width + 1);
      await expect(card).toHaveScreenshot('vaccination-card.png', {
        mask: [
          desk.locator('.vax-patient'),
          desk.getByTestId('vax-given'),
          desk.locator('.vax-pending'),
          desk.locator('.vax-next'),
          desk.locator('.print-footer-text'),
          desk.locator('.print-qr'),
        ],
        maxDiffPixelRatio: 0.02,
      });
      const pdf = await desk.pdf({ preferCSSPageSize: true, printBackground: true });
      expect((pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length).toBe(1);
      await ctx.close();
    });

    test('growth chart: A4, charts inside the page', async ({ browser, page }) => {
      const { ctx, page: desk } = await assistantPage(browser, page);
      await desk.goto(`/print/growth-chart/${ids.patientId}?copy=1`);
      const sheet = desk.locator('.print-sheet');
      await expect(desk.getByTestId('growth-chart-wfa')).toBeVisible();
      await desk.evaluate(() => document.fonts.ready.then(() => undefined));
      const sheetBox = (await sheet.boundingBox())!;
      for (const ind of ['wfa', 'lhfa', 'hcfa', 'wfh']) {
        const b = (await desk.getByTestId(`growth-chart-${ind}`).boundingBox())!;
        expect(b.x + b.width).toBeLessThanOrEqual(sheetBox.x + sheetBox.width + 1);
      }
      const pdf = await desk.pdf({ preferCSSPageSize: true, printBackground: true });
      expect((pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length).toBe(1);
      await ctx.close();
    });
  });
});
