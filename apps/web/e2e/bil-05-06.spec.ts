/**
 * BIL-05 / BIL-06 critical flow (docs/32 §2):
 *  5. Billing of a service → UPI payment with UTR → day close with denomination counter →
 *     facility close (and UPI reconciliation by UTR).
 * plus the A5 receipt (DUPLICATE on reprint) and the late entry after a facility close.
 *
 * One database is shared by both projects and the facility can be closed for a day only once:
 * the desktop project closes today; the tablet project (which runs after it) finds today closed,
 * so its payments belong to the next business day, which is what it then asserts. The counter user
 * `e2e_counter` is used by nobody else, so its day-close figures are exact. Synthetic data only.
 */
import { expect, test, type Page } from '@playwright/test';
import { E2E_USERS } from './fixtures';
import { printedFrame, registerPatient, signInReady } from './helpers';

const stubPrint = `window.__printCalls = 0; window.print = () => { window.__printCalls++; };`;

/** Reception registers a patient, books Dr. Verma (₹500) and optionally adds an IUCD (₹1,500). */
async function bookBill(page: Page, p: { first: string; mobile: string; iucd: boolean }) {
  await registerPatient(page, { first: p.first, last: 'Closetest', age: '30', mobile: p.mobile });
  await page.getByRole('link', { name: 'New visit' }).click();
  await page.getByRole('button', { name: /Dr\. Sunita Verma/ }).click();
  await page.getByRole('button', { name: 'Save visit' }).click();
  await page.getByTestId('visit-created').getByRole('link', { name: 'Open bill' }).click();
  if (p.iucd) {
    const add = page.getByRole('combobox', { name: 'Add service' });
    await add.fill('iucd ins');
    await expect(page.getByRole('option', { name: /IUCD insertion/ })).toBeVisible();
    await add.press('Enter');
    await expect(page.getByTestId('bill-net')).toHaveText('₹2,000.00');
  }
  await page.waitForURL(/\/billing\/bills\/[0-9a-f-]{36}$/);
  return new URL(page.url()).pathname;
}

async function switchUser(page: Page, user: { username: string }) {
  await page.context().clearCookies();
  await signInReady(page, user);
}

/** `₹3,851.00` → 385100 (paise). */
const paiseOf = (text: string) => Number(text.replace(/[^\d]/g, ''));
const rupeeText = (paise: number) =>
  `${Math.floor(paise / 100)}.${String(paise % 100).padStart(2, '0')}`;

test('flow 5: UPI payment with UTR → counter close with denominations → facility close → late entry', async ({
  page,
}, info) => {
  const desktop = info.project.name === 'desktop';
  await page.addInitScript(stubPrint);

  // --- Reception books two bills: ₹2,000 (consultation + IUCD) and ₹500.
  await signInReady(page, E2E_USERS.reception);
  const firstBill = await bookBill(page, {
    first: desktop ? 'Kamla' : 'Sarita',
    mobile: desktop ? '9415300061' : '9415300062',
    iucd: true,
  });
  const lateBill = await bookBill(page, {
    first: desktop ? 'Vimla' : 'Anita',
    mobile: desktop ? '9415300063' : '9415300064',
    iucd: false,
  });

  // --- The counter user takes ₹500 cash + ₹1,500 UPI with a UTR on the first bill.
  await switchUser(page, E2E_USERS.counter);
  await page.goto(firstBill);
  await page.getByTestId('collect').click();
  const dialog = page.getByTestId('payment-dialog');
  await dialog.getByText('Split', { exact: true }).click();
  await dialog.getByLabel('Cash amount').fill('500');
  await dialog.getByLabel('UPI amount').fill('1500');
  await expect(dialog.getByTestId('split-remaining')).toHaveText('Still to split: ₹0.00');
  await dialog.getByLabel(/UTR/).fill('4321');
  await dialog.getByTestId('pay-submit').click();
  const confirm = page.getByTestId('confirm-money');
  await expect(confirm.getByTestId('confirm-amount')).toHaveText('₹2,000.00');
  await expect(confirm).toContainText('UTR 4321');
  await confirm.getByTestId('confirm-money-ok').click();
  await expect(page.getByTestId('payment-done')).toContainText('₹2,000.00 received');
  await printedFrame(page, 'receipt', 1);

  // A5 receipt (BIL-05): the roll was copy 1, so the A5 print is a DUPLICATE (shared counter).
  await page.getByRole('button', { name: 'Print A5 receipt' }).click();
  const a5 = await printedFrame(page, 'receipt-a5', 2);
  await expect(a5.getByTestId('duplicate-watermark')).toBeAttached();
  await expect(a5.getByTestId('receipt-items')).toContainText('IUCD insertion');
  await expect(a5.getByTestId('receipt')).toContainText('UTR 4321');
  await expect(a5.getByTestId('receipt-amount')).toHaveText('₹2,000.00');
  await expect(a5.getByTestId('receipt')).toContainText('दो हज़ार रुपये');
  await expect(a5.getByTestId('receipt')).toContainText('Receiver signature');
  if (desktop) {
    const frameUrl = new URL(
      page
        .frames()
        .find((f) => f.url().includes('/print/receipt-a5/'))!
        .url(),
    );
    const a5Page = await page.context().newPage();
    await a5Page.goto(`${frameUrl.pathname}?copy=2`);
    const sheet = a5Page.locator('.print-sheet');
    await expect(sheet).toBeVisible();
    await a5Page.evaluate(() => document.fonts.ready.then(() => undefined));
    const box = (await sheet.boundingBox())!;
    expect(box.width).toBeCloseTo((148 / 25.4) * 96, -1); // A5: 148 mm in CSS px
    await expect(sheet).toHaveScreenshot('receipt-a5.png', {
      mask: [
        a5Page.locator('.receipt-a5-grid'),
        a5Page.locator('.print-footer'),
        a5Page.locator('.print-header'),
        a5Page.locator('.receipt-a5-sign'),
      ],
      maxDiffPixelRatio: 0.02,
    });
    await a5Page.close();
  }

  // --- Day close of the counter: expected figures, denomination counter, variance, confirm.
  await page.goto('/billing/day-close');
  await expect(page.getByTestId('expected-cash')).toContainText('₹500.00');
  await expect(page.getByTestId('expected-upi')).toContainText('₹1,500.00');
  await expect(page.getByTestId('expected-card')).toContainText('₹0.00');
  await expect(page.getByTestId('expected-total')).toContainText('₹2,000.00');
  const businessDate = page.getByTestId('close-business-date');
  const closeDate = (await businessDate.getAttribute('data-date'))!;
  const nextDay = (await businessDate.getAttribute('data-next-day')) === 'true';
  // The tablet project runs after the desktop one closed today: its payments are for tomorrow.
  expect(nextDay).toBe(!desktop);

  // The first field has focus; Enter moves down the list (keyboard only on desktop).
  await expect(page.getByTestId('count-500')).toBeFocused();
  await page.getByTestId('count-500').fill('2');
  if (desktop) {
    await page.getByTestId('count-500').press('Enter');
    await expect(page.getByTestId('count-200')).toBeFocused();
  }
  await expect(page.getByTestId('counted-cash')).toHaveText('₹1,000.00');
  await expect(page.getByTestId('difference')).toContainText('+₹500.00');
  // A variance needs a reason: the close button waits for it.
  await expect(page.getByTestId('difference-reason')).toBeVisible();
  await expect(page.getByTestId('close-submit')).toBeDisabled();
  // Count again: one ₹500 note, and the reason box goes away.
  await page.getByTestId('count-500').fill('1');
  await expect(page.getByTestId('counted-cash')).toHaveText('₹500.00');
  await expect(page.getByTestId('difference')).toHaveText('₹0.00');
  await expect(page.getByTestId('difference-reason')).toHaveCount(0);
  await expect(page.getByTestId('close-submit')).toBeEnabled();

  await page.getByTestId('close-submit').click();
  await expect(confirm.getByTestId('confirm-amount')).toHaveText('₹500.00');
  await expect(confirm).toContainText('Five hundred rupees');
  await confirm.getByTestId('confirm-money-ok').click();
  const done = page.getByTestId('close-done');
  await expect(done).toContainText('Counter closed. Cash counted: ₹500.00.');
  await expect(page.getByTestId('done-difference')).toHaveText('₹0.00');

  // The slip prints by itself on the 80 mm roll, and again as a DUPLICATE.
  const slip = await printedFrame(page, 'day-close', 1);
  await expect(slip.locator('.print-title')).toContainText('Day close');
  await expect(slip.getByTestId('close-counted')).toHaveText('₹500.00');
  await expect(slip.getByTestId('close-difference')).toHaveText('₹0.00');
  await expect(slip.getByTestId('close-denominations')).toContainText('₹500');
  await expect(slip.getByTestId('day-close-slip')).toContainText('₹2,000.00'); // total collected
  await expect(slip.getByTestId('duplicate-watermark')).toHaveCount(0);
  if (desktop) {
    const frameUrl = new URL(
      page
        .frames()
        .find((f) => f.url().includes('/print/day-close/'))!
        .url(),
    );
    const slipPage = await page.context().newPage();
    await slipPage.goto(`${frameUrl.pathname}?copy=1`);
    const sheet = slipPage.locator('.print-sheet');
    await expect(sheet).toBeVisible();
    await slipPage.evaluate(() => document.fonts.ready.then(() => undefined));
    const box = (await sheet.boundingBox())!;
    expect(box.width).toBeCloseTo((80 / 25.4) * 96, -1);
    await expect(sheet).toHaveScreenshot('day-close-thermal80.png', {
      mask: [
        slipPage.locator('.receipt > .receipt-row').first(),
        slipPage.locator('.receipt > .receipt-row').nth(1),
        slipPage.locator('.receipt > .receipt-row').nth(2),
        slipPage.locator('.print-footer'),
      ],
      maxDiffPixelRatio: 0.02,
    });
    await slipPage.close();
  }
  await done.getByRole('button', { name: 'Print slip' }).click();
  const again = await printedFrame(page, 'day-close', 2);
  await expect(again.getByTestId('duplicate-watermark')).toBeAttached();

  // The counter starts a new period at once.
  await page.goto('/billing/day-close');
  await expect(page.getByTestId('expected-cash')).toContainText('₹0.00');
  await expect(page.getByTestId('recent-closes').getByRole('listitem')).not.toHaveCount(0);

  // --- Admin: facility close. Counters that nobody closed are shown and need an acknowledgement.
  await switchUser(page, E2E_USERS.admin);
  await page.goto(`/billing/day-close/facility?date=${closeDate}`);
  if (!nextDay) {
    const row = page.getByTestId('user-close-row').filter({ hasText: 'E2E Counter' });
    await expect(row).toContainText('₹500.00');
    await expect(row.getByText('₹0.00')).toBeVisible();
    await expect(page.getByTestId('facility-closed')).toHaveCount(0);
    if (await page.getByTestId('pending-counters').isVisible()) {
      // Closing is refused until the owner confirms and says why.
      await expect(page.getByTestId('facility-close-submit')).toBeDisabled();
      await page.getByTestId('acknowledge-pending').check();
      await expect(page.getByTestId('facility-close-submit')).toBeDisabled();
      await page.getByTestId('pending-note').fill('Other counters left without closing');
    }
    await page.getByTestId('facility-close-submit').click();
    await expect(confirm.getByTestId('confirm-amount')).toBeVisible();
    await confirm.getByTestId('confirm-money-ok').click();
    await expect(page.getByTestId('facility-closed')).toContainText('Day closed at');
    const summary = await printedFrame(page, 'facility-close', 1);
    await expect(summary.getByTestId('facility-close-summary')).toContainText('E2E Counter');
    await expect(summary.getByTestId('facility-close-users')).toContainText('₹500.00');
    await expect(summary.getByTestId('facility-close-summary')).toContainText('Dr. Sunita Verma');
    // Closing again is refused: the day is closed.
    await expect(page.getByTestId('facility-close-submit')).toHaveCount(0);
  } else {
    // Today was closed by the desktop run. This run's close belongs to tomorrow, so the closed
    // day still lists only the desktop run's close of the counter (and its figures do not move).
    await page.goto('/billing/day-close/facility');
    await expect(page.getByTestId('facility-closed')).toBeVisible();
    await expect(page.getByTestId('user-close-row').filter({ hasText: 'E2E Counter' })).toHaveCount(
      1,
    );
  }

  // --- UPI reconciliation of the day the UPI payment belongs to: match by UTR, then complete.
  await page.goto(`/billing/upi-reconciliation?date=${closeDate}`);
  const mine = page
    .getByTestId('upi-row')
    .filter({ hasText: '…4321' })
    .filter({ hasText: '₹1,500.00' });
  await expect(mine.first()).toBeVisible();
  await expect(mine.first().getByRole('checkbox')).not.toBeChecked();
  await page
    .getByTestId('upi-paste')
    .fill('412345674321  1500.00\n999999990000  75.00\nnot a line');
  await page.getByTestId('upi-match').click();
  await expect(page.getByTestId('upi-match-result')).toContainText('1 matched by UTR');
  await expect(page.getByTestId('upi-match-result')).toContainText('1 line could not be read');
  await expect(mine.first().getByRole('checkbox')).toBeChecked();
  await expect(mine.first()).toContainText('412345674321');

  const systemPaise = paiseOf(await page.getByTestId('upi-system').innerText());
  if (desktop) {
    // The statement is ₹10 short of the system (bank charge): a reason is needed.
    await page.getByTestId('upi-statement').fill(rupeeText(systemPaise - 1000));
    await expect(page.getByTestId('upi-difference')).toContainText('−₹10.00');
    await expect(page.getByTestId('upi-complete')).toBeDisabled();
    await page.getByTestId('upi-reason').fill('Bank charge deducted');
    await page.getByTestId('upi-complete').click();
    await confirm.getByTestId('confirm-money-ok').click();
    await expect(page.getByTestId('upi-reconciled')).toContainText('Reconciled');
    await expect(page.getByTestId('upi-complete')).toHaveCount(0);
    await expect(mine.first().getByRole('checkbox')).toBeDisabled();
    await expect(mine.first().getByRole('checkbox')).toBeChecked();
    await page.goto(`/billing/day-close/facility?date=${closeDate}`);
    await expect(page.getByTestId('upi-status')).toContainText('Reconciled');
  } else {
    // This run's UPI payment belongs to tomorrow: its reconciliation can only be done then.
    await page.getByTestId('upi-statement').fill(rupeeText(systemPaise));
    await expect(page.getByTestId('upi-difference')).toHaveText('₹0.00');
    await expect(page.getByTestId('upi-reason')).toHaveCount(0);
    await page.getByTestId('upi-complete').click();
    await confirm.getByTestId('confirm-money-ok').click();
    await expect(confirm.getByRole('alert')).toContainText('has not happened yet');
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('upi-reconciled')).toHaveCount(0);
  }

  // --- Late entry: a payment after the close belongs to the next business day.
  await switchUser(page, E2E_USERS.counter);
  await page.goto(lateBill);
  await page.getByTestId('collect').click();
  await page.getByTestId('pay-submit').click();
  await page.getByTestId('confirm-money-ok').click();
  await expect(page.getByTestId('payment-done')).toContainText('₹500.00 received');
  await page.goto('/billing/day-close');
  await expect(page.getByTestId('close-business-date')).toHaveAttribute('data-next-day', 'true');
  await expect(page.getByTestId('close-business-date')).toContainText(
    'already closed for the hospital',
  );
  await expect(page.getByTestId('expected-cash')).toContainText('₹500.00');
  await page.getByTestId('count-500').fill('1');
  await page.getByTestId('close-submit').click();
  await confirm.getByTestId('confirm-money-ok').click();
  await expect(page.getByTestId('close-done')).toBeVisible();

  // --- Permissions: reception cannot open the facility screens (404), nor the cashier.
  if (desktop) {
    for (const user of [E2E_USERS.reception, E2E_USERS.cashier]) {
      await switchUser(page, user);
      for (const path of ['/billing/day-close/facility', '/billing/upi-reconciliation']) {
        const res = await page.goto(path);
        expect(res?.status()).toBe(404);
      }
    }
    // The admin holds the facility close but no counter of their own.
    await switchUser(page, E2E_USERS.admin);
    expect((await page.goto('/billing/day-close'))?.status()).toBe(404);
    await page.goto('/billing');
    await expect(page.getByTestId('link-facility-close')).toBeVisible();
    await expect(page.getByTestId('link-day-close')).toHaveCount(0);
  }
});
