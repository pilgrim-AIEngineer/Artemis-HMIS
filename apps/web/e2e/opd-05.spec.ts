/**
 * OPD-05 / flow 7 (docs/32 §1): ANC. Open a pregnancy from the LMP → vitals feed the visit row →
 * a raised BP raises the risk flag → re-date by a scan → tick the Td dose → print the ANC card
 * (A5, bilingual). Desktop and tablet projects share one database, so each registers its own
 * patient. Synthetic data only.
 */
import { expect, test, type Browser, type Page } from '@playwright/test';
import { E2E_USERS } from './fixtures';
import { payVisitInCash, printedFrame, signInReady } from './helpers';

const stubPrint = `window.__printCalls = 0; window.print = () => { window.__printCalls++; };`;

/** The IST calendar day `offset` days from today, as YYYY-MM-DD (the app counts days in IST). */
const istDay = (offset: number) =>
  new Date(Date.now() + offset * 86_400_000).toLocaleDateString('en-CA', {
    timeZone: 'Asia/Kolkata',
  });

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

test.describe.serial('ANC card (OPD-05)', () => {
  const ids = { pregnancyId: '', patientId: '', first: '' };

  test('flow 7: pregnancy from LMP, vitals, raised BP flag, scan re-dating, Td, ANC card print', async ({
    page,
    browser,
  }, info) => {
    test.setTimeout(240_000);
    const desktop = info.project.name === 'desktop';
    const first = desktop ? 'Anamika' : 'Bhavna';
    const mobile = desktop ? '9415500001' : '9415500002';
    ids.first = first;

    // ---- reception: patient, paid visit with a token
    await page.addInitScript(stubPrint);
    await signInReady(page, E2E_USERS.reception);
    await page.goto('/reception/patients/new');
    await page.getByLabel('First name').fill(first);
    await page.getByLabel('Surname').fill('Anctest');
    await page.getByText('Female', { exact: true }).click();
    await page.getByLabel('Age', { exact: true }).fill('28');
    await page.getByLabel('Mobile number', { exact: true }).fill(mobile);
    await page.getByRole('button', { name: 'Save patient' }).click();
    await expect(page).toHaveURL(/\/reception\/patients\/[0-9a-f-]{36}\?registered=/);
    ids.patientId = /patients\/([0-9a-f-]{36})/.exec(page.url())![1]!;
    await page.getByRole('link', { name: 'New visit' }).click();
    await page.getByRole('button', { name: /Dr\. Sunita Verma/ }).click();
    await page.getByRole('button', { name: 'Save visit' }).click();
    await payVisitInCash(page);

    // ---- assistant: find her on the ANC desk with the keyboard, open the pregnancy record
    const { ctx, page: desk } = await assistantPage(browser, page);
    await desk.goto('/assistant');
    await desk.getByRole('link', { name: 'ANC cards' }).click();
    await expect(
      desk.getByRole('heading', { level: 1, name: 'Antenatal care (ANC)' }),
    ).toBeVisible();
    await expect(desk.getByTestId('anc-pending-signoff')).toContainText(
      'Pending gynaecologist sign-off',
    );
    await field(desk, 'Find a woman').fill(`${first} Anctest`);
    await expect(desk.getByTestId('anc-search-results')).toContainText(`${first} Anctest`);
    await field(desk, 'Find a woman').press('Enter');
    await expect(desk).toHaveURL(/\/assistant\/anc\/[0-9a-f-]{36}$/);

    // LMP 98 days ago = 14w 0d today. A future date is refused with a plain message.
    const create = desk.getByTestId('anc-create');
    await field(desk, 'LMP').fill(istDay(1));
    await create.getByRole('button', { name: 'Open pregnancy record' }).click();
    await expect(create).toContainText('The LMP cannot be in the future.');
    await field(desk, 'LMP').fill(istDay(-98));
    await create.getByLabel('Blood group').selectOption('O-');
    await create.getByRole('button', { name: 'Open pregnancy record' }).click();

    await expect(desk.getByTestId('anc-ga')).toHaveText('14w 0d');
    await expect(desk.getByTestId('anc-summary')).toContainText('G1 P0 A0 L0');
    // Rh negative is an automatic risk flag; nothing else yet.
    await expect(desk.getByTestId('anc-summary').getByTestId('anc-risks')).toContainText(
      'Rh negative',
    );
    await expect(desk.getByTestId('anc-summary').getByTestId('anc-risks')).not.toContainText(
      'Raised BP',
    );

    // ---- vitals desk: the pregnant form is the default now; BP 150/95
    await desk.goto('/nursing/vitals');
    await desk
      .getByTestId('vitals-waiting')
      .getByRole('listitem')
      .filter({ hasText: `${first} Anctest` })
      .getByRole('link', { name: 'Enter vitals' })
      .click();
    await expect(desk.getByRole('button', { name: 'Pregnant', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await field(desk, 'Upper (systolic)').fill('150');
    await field(desk, 'Lower (diastolic)').fill('95');
    await field(desk, 'Weight').fill('58.5');
    await field(desk, 'Fundal height').fill('14');
    await field(desk, 'Heart rate of the baby (FHR)').fill('148');
    await desk.getByRole('button', { name: 'Save vitals' }).click();
    await expect(desk.getByTestId('vitals-saved')).toContainText('Vitals saved for token');

    // ---- back on the card: the reading is in today's row and the risk flag is up
    await desk.goto(`/assistant/anc/${ids.patientId}`);
    const visits = desk.getByTestId('anc-visits');
    await expect(visits.getByTestId('anc-visit-table')).toContainText('150/95');
    await expect(visits.getByTestId('anc-visit-table')).toContainText('58.5');
    await expect(desk.getByTestId('anc-summary').getByTestId('anc-risks')).toContainText(
      'Raised BP (150/95)',
    );
    await expect(desk.getByText('High-risk pregnancy').first()).toBeVisible();

    // The assistant adds what vitals do not have: presentation, Hb, a remark.
    await visits.getByRole('button', { name: /Edit the visit of/ }).click();
    await expect(field(desk, 'BP upper (mmHg)')).toHaveValue('150');
    await visits.getByLabel('Presentation').selectOption('cephalic');
    await visits.getByLabel('Hb (g/dL)').fill('10.2');
    await visits.getByLabel('Remarks').fill('Iron tablets given');
    await visits.getByRole('button', { name: 'Save visit' }).click();
    await expect(visits.getByText('Visit saved.')).toBeVisible();
    await expect(visits.getByTestId('anc-visit-table')).toContainText('Iron tablets given');
    await expect(desk.getByTestId('anc-summary').getByTestId('anc-risks')).toContainText('Anaemia');

    // ---- re-date by a scan: 56 days ago the scan found 5w0d, the LMP said 6w0d → 7 days apart
    const dating = desk.getByTestId('anc-dating');
    await dating.getByLabel('Scan date').fill(istDay(-56));
    await dating.getByLabel('GA at scan: weeks').fill('5');
    await dating.getByLabel('days', { exact: true }).fill('0');
    const assessment = dating.getByTestId('anc-redating-assessment');
    await expect(assessment).toContainText('differ by 7 days (limit at this GA: 5 days)');
    await expect(assessment.getByTestId('anc-redating-suggestion')).toHaveText(
      'Suggested: use the scan EDD.',
    );
    await assessment.getByRole('button', { name: 'Use scan EDD' }).click();
    await expect(dating.getByTestId('anc-redating-decision')).toHaveText(
      'The EDD was changed to the scan EDD.',
    );
    await expect(desk.getByTestId('anc-ga')).toHaveText('13w 0d');
    await expect(desk.getByTestId('anc-visit-table')).toContainText('13w 0d');

    // ---- schedule: the dating scan is overdue? (13w0d: no) — Td-1 is due from booking; tick it
    const td1 = desk.getByTestId('anc-schedule-list').locator('[data-code="td_1"]');
    await expect(td1).toHaveAttribute('data-state', 'due');
    await td1.getByRole('button', { name: /Mark .* as done/ }).click();
    await expect(td1).toHaveAttribute('data-state', 'done');
    await expect(
      desk.getByTestId('anc-schedule-list').locator('[data-code="td_2"]'),
    ).toHaveAttribute('data-state', 'upcoming');
    await expect(
      desk.getByTestId('anc-schedule-list').locator('[data-code="coombs_anti_d"]'),
    ).toHaveAttribute('data-state', 'upcoming'); // Rh-negative → anti-D applies, from 28 weeks

    // ---- the OPD sheet carries the pregnancy block
    // ---- print the ANC card: A5, both languages, no DUPLICATE mark
    await desk
      .getByTestId('anc-summary')
      .getByRole('button', { name: /Print ANC card/ })
      .click();
    const frame = await printedFrame(desk, 'anc-card', 1);
    await expect(frame.getByTestId('anc-booking')).toContainText('G1 P0 A0 L0');
    await expect(frame.getByTestId('anc-booking')).toContainText('13w 0d');
    await expect(frame.getByTestId('anc-risks')).toContainText('Raised BP');
    await expect(frame.getByTestId('anc-risks')).toContainText('उच्च रक्तचाप');
    await expect(frame.getByTestId('anc-risks')).toContainText('Anaemia');
    await expect(frame.getByTestId('anc-visit-table')).toContainText('150/95');
    await expect(frame.getByTestId('anc-schedule')).toContainText('Td-1');
    await expect(frame.getByTestId('anc-next')).toContainText('(');
    await expect(frame.getByTestId('duplicate-watermark')).toHaveCount(0);
    const printed = desk.frames().find((f) => f.url().includes('/print/anc-card/'))!;
    ids.pregnancyId = /\/print\/anc-card\/([0-9a-f-]{36})/.exec(
      new URL(printed.url()).pathname,
    )![1]!;

    // ---- reception (no ANC edit permission) reads the card but cannot change it
    await page.goto(`/assistant/anc/${ids.patientId}`);
    await expect(page.getByTestId('anc-ga')).toHaveText('13w 0d');
    await expect(page.getByTestId('anc-visit-table')).toContainText('150/95');
    await expect(page.getByRole('button', { name: 'Save visit' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Close this pregnancy…' })).toHaveCount(0);
    await ctx.close();
  });

  test('a delivery closes the record and the next pregnancy carries the history', async ({
    page,
    browser,
  }) => {
    test.setTimeout(90_000);
    const { ctx, page: desk } = await assistantPage(browser, page);
    await desk.goto(`/assistant/anc/${ids.patientId}`);
    // Close it as a delivery; the form wants the mode.
    await desk.getByRole('button', { name: 'Close this pregnancy…' }).click();
    await desk.getByLabel('Outcome').selectOption('delivered');
    await desk.getByLabel('Mode of delivery').selectOption('lscs');
    await desk.getByRole('button', { name: 'Close pregnancy' }).click();
    await expect(desk.getByTestId('anc-past-list')).toContainText('Delivered');
    // The next pregnancy starts with a previous caesarean on its history.
    await field(desk, 'LMP').fill(istDay(-30));
    await desk
      .getByTestId('anc-create')
      .getByRole('button', { name: 'Open pregnancy record' })
      .click();
    await expect(desk.getByTestId('anc-gpal')).toContainText('G2 P1 A0 L1');
    await expect(desk.getByTestId('anc-summary').getByTestId('anc-risks')).toContainText(
      'Previous caesarean',
    );
    await ctx.close();
  });

  test.describe('print layout (screenshot, paper size)', () => {
    test.beforeEach(({ browserName: _b }, info) => {
      test.skip(info.project.name !== 'desktop', 'pixel checks run once, on desktop');
    });

    test('ANC card: A5, one page', async ({ browser, page }) => {
      const { ctx, page: desk } = await assistantPage(browser, page);
      await desk.goto(`/print/anc-card/${ids.pregnancyId}?copy=1`);
      const card = desk.locator('.print-sheet');
      await expect(card).toBeVisible();
      await expect(desk.getByTestId('anc-visit-table')).toContainText('150/95');
      await desk.evaluate(() => document.fonts.ready.then(() => undefined));
      // The visit table must stay inside the A5 sheet.
      const sheetBox = (await card.boundingBox())!;
      const tableBox = (await desk.getByTestId('anc-visit-table').boundingBox())!;
      expect(tableBox.x + tableBox.width).toBeLessThanOrEqual(sheetBox.x + sheetBox.width + 1);
      await expect(card).toHaveScreenshot('anc-card.png', {
        mask: [
          desk.locator('.anc-patient'),
          desk.locator('.anc-visits'),
          desk.locator('.anc-next'),
          desk.locator('.print-footer-text'),
          desk.locator('.print-qr'),
        ],
        maxDiffPixelRatio: 0.02,
      });
      const pdf = await desk.pdf({ preferCSSPageSize: true, printBackground: true });
      expect((pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length).toBe(1);
      await ctx.close();
    });
  });
});
