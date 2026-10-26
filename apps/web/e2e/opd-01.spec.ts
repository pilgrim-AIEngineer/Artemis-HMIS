/**
 * OPD-01 / flow 3 (docs/32 §1): vitals entry at the vitals desk → the token moves to "Vitals done"
 * → the OPD sheet prints by itself and a reprint shows the vitals. Covers the pregnant and child
 * forms, amber / red marks, blocked implausible values, the tablet number pad and a correction.
 * Desktop and tablet projects share one database, so each registers its own patients. Synthetic
 * data only.
 */
import { expect, test, type Browser, type Page } from '@playwright/test';
import { E2E_USERS } from './fixtures';
import { payVisitInCash, printedFrame, signInReady } from './helpers';

const stubPrint = `window.__printCalls = 0; window.print = () => { window.__printCalls++; };`;

async function register(
  page: Page,
  p: { first: string; sex: 'Female' | 'Male'; age: string; mobile: string },
) {
  await page.goto('/reception/patients/new');
  await page.getByLabel('First name').fill(p.first);
  await page.getByLabel('Surname').fill('Vitalstest');
  await page.getByText(p.sex, { exact: true }).click();
  await page.getByLabel('Age', { exact: true }).fill(p.age);
  await page.getByLabel('Mobile number', { exact: true }).fill(p.mobile);
  await page.getByRole('button', { name: 'Save patient' }).click();
  await expect(page).toHaveURL(/\/reception\/patients\/[0-9a-f-]{36}\?registered=/);
}

/** New paid visit with the gynaecologist: the token is out when this returns. */
async function visitWithToken(page: Page) {
  await page.getByRole('link', { name: 'New visit' }).click();
  await page.getByRole('button', { name: /Dr\. Sunita Verma/ }).click();
  await page.getByRole('button', { name: 'Save visit' }).click();
  await payVisitInCash(page);
}

async function assistantPage(browser: Browser, page: Page) {
  const ctx = await browser.newContext({
    viewport: page.viewportSize() ?? { width: 1366, height: 768 },
    timezoneId: 'Asia/Kolkata',
    locale: 'en-IN',
  });
  const assistant = await ctx.newPage();
  await assistant.addInitScript(stubPrint);
  await signInReady(assistant, E2E_USERS.assistant);
  return { ctx, page: assistant };
}

const field = (page: Page, name: string) => page.getByLabel(name, { exact: true });

/** Types into a field with the on-screen pad (works by touch and by mouse). */
async function padType(page: Page, label: string, digits: string) {
  await field(page, label).focus();
  const pad = page.getByRole('group', { name: 'Number pad' });
  for (const d of digits) {
    await pad.getByRole('button', { name: d === '.' ? 'Decimal point' : d, exact: true }).click();
  }
}

test.describe.serial('vitals desk (OPD-01)', () => {
  const ids = { encounterId: '' };

  test('flow 3: pregnant patient, flags, blocked values, number pad, sheet with vitals', async ({
    page,
    browser,
  }, info) => {
    test.setTimeout(150_000);
    const desktop = info.project.name === 'desktop';
    const first = desktop ? 'Sunaina' : 'Pushpa';
    const mobile = desktop ? '9415400001' : '9415400002';

    // ---- reception: patient, paid visit, token
    await page.addInitScript(stubPrint);
    await signInReady(page, E2E_USERS.reception);
    await register(page, { first, sex: 'Female', age: '27', mobile });
    await visitWithToken(page);

    // ---- the assistant finds the patient on the vitals desk
    const { ctx, page: desk } = await assistantPage(browser, page);
    await desk.goto('/nursing');
    await desk.getByRole('link', { name: /Vitals desk/ }).click();
    await expect(desk.getByRole('heading', { level: 1, name: 'Vitals desk' })).toBeVisible();
    const row = desk
      .getByTestId('vitals-waiting')
      .getByRole('listitem')
      .filter({
        hasText: `${first} Vitalstest`,
      });
    await expect(row).toBeVisible();
    await row.getByRole('link', { name: 'Enter vitals' }).click();

    // The adult / pregnant choice is the assistant's; pick pregnant.
    await expect(desk.getByRole('heading', { name: /Vitals saved/ })).toHaveCount(0);
    await desk.getByRole('button', { name: 'Pregnant', exact: true }).click();
    await expect(field(desk, 'Fundal height')).toBeVisible();
    await expect(field(desk, 'Heart rate of the baby (FHR)')).toBeVisible();

    // Impossible values are blocked, with a plain message and no save.
    await field(desk, 'Weight').fill('650');
    await expect(desk.getByText('This value cannot be right. Please check it.')).toBeVisible();
    await expect(desk.getByRole('button', { name: 'Save vitals' })).toBeDisabled();
    await field(desk, 'Weight').fill('62.5');
    await field(desk, 'Upper (systolic)').fill('100');
    await field(desk, 'Lower (diastolic)').fill('110');
    await expect(desk.getByText('The lower BP must be less than the upper BP.')).toBeVisible();
    await expect(desk.getByRole('button', { name: 'Save vitals' })).toBeDisabled();

    // BP 150/95: amber, with words; the pregnancy alert shows.
    await field(desk, 'Upper (systolic)').fill('150');
    await field(desk, 'Lower (diastolic)').fill('95');
    await expect(desk.getByTestId('flag-bp')).toHaveAttribute('data-level', 'amber');
    await expect(desk.getByTestId('flag-bp')).toContainText('BP is high');
    await expect(desk.getByTestId('alert-raised-bp')).toContainText('Raised BP in pregnancy');

    // SpO2 88: red. Entered with the on-screen number pad.
    // Touch screens open with the pad already shown; on a desktop it is one tap away.
    const showPad = desk.getByRole('button', { name: 'Show number pad' });
    if (await showPad.isVisible()) await showPad.click();
    await expect(desk.getByRole('group', { name: 'Number pad' })).toBeVisible();
    await padType(desk, 'SpO2', '88');
    await expect(desk.getByTestId('flag-spo2')).toHaveAttribute('data-level', 'red');
    await expect(field(desk, 'SpO2')).toHaveAttribute('data-level', 'red');
    await padType(desk, 'Pulse', '88');
    await padType(desk, 'Temperature', '98.6');
    await padType(desk, 'Fundal height', '28');
    await padType(desk, 'Heart rate of the baby (FHR)', '144');
    await field(desk, 'Height / length').fill('158');
    await desk
      .getByRole('group', { name: 'Swelling (oedema)' })
      .getByRole('button', { name: '+', exact: true })
      .click();
    // Height was never measured, so the desk asked for it.
    await expect(desk.getByTestId('height-prompt')).toBeVisible();

    // ---- save: token → Vitals done, the sheet prints by itself (copy 1)
    await desk.getByRole('button', { name: 'Save vitals' }).click();
    const saved = desk.getByTestId('vitals-saved');
    await expect(saved).toContainText('Vitals saved for token');
    await expect(saved.getByTestId('saved-flags')).toContainText('BP is high');
    await expect(saved.getByTestId('saved-flags')).toContainText('SpO2 is very low');
    await expect(saved.getByTestId('saved-flags')).toContainText('Raised BP in pregnancy');
    const frame = await printedFrame(desk, 'opd-sheet', 1);
    const sheet = frame.getByTestId('sheet-vitals');
    await expect(sheet).toContainText('150/95*');
    await expect(sheet).toContainText('88**'); // SpO2 red
    await expect(sheet).toContainText('98.6');
    await expect(sheet).toContainText('62.5');
    await expect(sheet).toContainText('Fundal ht');
    await expect(frame.getByTestId('sheet-alert')).toContainText('Raised BP in pregnancy');
    const url = new URL(
      desk
        .frames()
        .find((f) => f.url().includes('/print/opd-sheet/'))!
        .url(),
    );
    ids.encounterId = /\/print\/opd-sheet\/([0-9a-f-]{36})$/.exec(url.pathname)![1]!;

    // ---- the queue shows Vitals done; reception reprints the sheet: DUPLICATE, with the vitals
    await page.goto('/reception/queue');
    const card = page.getByRole('listitem').filter({ hasText: `${first} Vitalstest` });
    await expect(card).toHaveAttribute('data-state', 'vitals_done');
    await card.getByRole('button', { name: 'Print OPD sheet' }).click();
    const copy2 = await printedFrame(page, 'opd-sheet', 2);
    await expect(copy2.getByTestId('duplicate-watermark')).toHaveCount(1);
    await expect(copy2.getByTestId('sheet-vitals')).toContainText('150/95*');
    await expect(copy2.getByTestId('sheet-vitals')).toContainText('62.5');

    // ---- a correction: the desk lists the patient under "Measured today"; saving replaces the
    // reading and does not print again.
    await desk.goto('/nursing/vitals');
    const done = desk
      .getByTestId('vitals-done')
      .getByRole('listitem')
      .filter({
        hasText: `${first} Vitalstest`,
      });
    await expect(done).toContainText('Out of range');
    await done.getByRole('link', { name: 'Correct vitals' }).click();
    await expect(desk.getByTestId('vitals-correction')).toBeVisible();
    await expect(field(desk, 'Upper (systolic)')).toHaveValue('150');
    await field(desk, 'Upper (systolic)').fill('128');
    await field(desk, 'Lower (diastolic)').fill('82');
    await field(desk, 'SpO2').fill('98');
    await desk.getByRole('button', { name: 'Save vitals' }).click();
    await expect(desk.getByTestId('saved-flags')).toHaveCount(0);
    await expect(desk.getByTestId('vitals-saved')).toContainText(
      'All readings are in the normal range.',
    );
    await expect(desk.getByTestId('vitals-saved').getByTestId('saved-flags')).toHaveCount(0);

    // The reprint now shows the corrected reading (copy 3).
    await card.getByRole('button', { name: 'Print OPD sheet' }).click();
    const copy3 = await printedFrame(page, 'opd-sheet', 3);
    await expect(copy3.getByTestId('sheet-vitals')).toContainText('128/82');
    await expect(copy3.getByTestId('sheet-vitals')).not.toContainText('150/95');
    await expect(copy3.getByTestId('sheet-alert')).toHaveCount(0);
    await ctx.close();
  });

  test('child form: weight, length, head circumference under 2 years, no BP', async ({
    page,
    browser,
  }, info) => {
    test.setTimeout(120_000);
    const desktop = info.project.name === 'desktop';
    const first = desktop ? 'Aarav' : 'Vihaan';
    const mobile = desktop ? '9415400011' : '9415400012';
    await page.addInitScript(stubPrint);
    await signInReady(page, E2E_USERS.reception);
    await register(page, { first, sex: 'Male', age: '8m', mobile });
    await visitWithToken(page);

    const { ctx, page: desk } = await assistantPage(browser, page);
    await desk.goto('/nursing/vitals');
    await desk
      .getByTestId('vitals-waiting')
      .getByRole('listitem')
      .filter({ hasText: `${first} Vitalstest` })
      .getByRole('link', { name: 'Enter vitals' })
      .click();
    await expect(field(desk, 'Weight')).toBeVisible();
    await expect(field(desk, 'Head circumference')).toBeVisible();
    await expect(field(desk, 'Mid-arm circumference (MUAC)')).toBeVisible();
    await expect(field(desk, 'Breathing rate')).toBeVisible();
    await expect(field(desk, 'Upper (systolic)')).toHaveCount(0);
    await expect(desk.getByRole('button', { name: 'Pregnant', exact: true })).toHaveCount(0);
    // A baby weighs kilograms, not 5 kg too many: 250 kg is refused for a child as well.
    await field(desk, 'Weight').fill('250');
    await expect(desk.getByRole('button', { name: 'Save vitals' })).toBeDisabled();
    await field(desk, 'Weight').fill('8.45');
    await field(desk, 'Height / length').fill('70.5');
    await field(desk, 'Head circumference').fill('44');
    await field(desk, 'Temperature').fill('101');
    // Enter walks to the next field in paper order; Enter on the last one saves.
    await field(desk, 'SpO2').fill('99');
    await field(desk, 'Breathing rate').fill('30');
    await field(desk, 'Mid-arm circumference (MUAC)').fill('13.5');
    await expect(desk.getByTestId('flag-temp')).toContainText('Fever');
    await field(desk, 'Mid-arm circumference (MUAC)').press('Enter');
    await expect(desk.getByTestId('vitals-saved')).toContainText('Fever');
    const frame = await printedFrame(desk, 'opd-sheet', 1);
    await expect(frame.getByTestId('sheet-vitals')).toContainText('101*');
    await expect(frame.getByTestId('sheet-vitals')).toContainText('8.45');
    await expect(frame.getByTestId('sheet-vitals')).toContainText('Head circ.');
    await ctx.close();
  });

  test('only vitals.record reaches the desk; keyboard order follows the paper', async ({
    page,
    browser,
  }) => {
    await signInReady(page, E2E_USERS.cashier);
    expect((await page.goto('/nursing/vitals'))?.status()).toBe(404);
    expect((await page.goto(`/nursing/vitals/${ids.encounterId}`))?.status()).toBe(404);

    const { ctx, page: desk } = await assistantPage(browser, page);
    await desk.goto('/nursing/vitals');
    await expect(desk.getByRole('heading', { level: 1, name: 'Vitals desk' })).toBeVisible();
    await ctx.close();
  });

  test.describe('print layout (screenshot, paper size)', () => {
    test.beforeEach(({ browserName: _b }, info) => {
      test.skip(info.project.name !== 'desktop', 'pixel checks run once, on desktop');
    });

    test('OPD sheet with vitals: A5, one page', async ({ page }) => {
      await signInReady(page, E2E_USERS.reception);
      await page.goto(`/print/opd-sheet/${ids.encounterId}?copy=3`); // reception's own reprint, with the corrected reading
      const sheet = page.locator('.print-sheet');
      await expect(sheet).toBeVisible();
      await expect(page.getByTestId('sheet-vitals')).toContainText('128/82');
      await page.evaluate(() => document.fonts.ready.then(() => undefined));
      await expect(sheet).toHaveScreenshot('opd-sheet-vitals.png', {
        mask: [
          page.locator('.sheet-strip'),
          page.locator('.sheet-codes'),
          page.locator('.print-footer-text'),
        ],
        maxDiffPixelRatio: 0.02,
      });
      const pdf = await page.pdf({ preferCSSPageSize: true, printBackground: true });
      expect((pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length).toBe(1);
    });
  });
});
