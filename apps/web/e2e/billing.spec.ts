/**
 * BIL-01 / BIL-02 critical flows (docs/32 §2):
 *  1. New patient → visit → cash payment → token + receipt + OPD sheet print.
 *  2. Returning patient (family by mobile) → free follow-up visit → token at once.
 * plus the bill screen: add a service (round-off), part payment, split cash + UPI with UTR.
 * Desktop uses the keyboard (F8, Enter); the tablet project taps. Each project uses its own
 * mobile numbers because both share one database. Synthetic data only.
 */
import { expect, test, type Page } from '@playwright/test';
import { E2E_USERS } from './fixtures';
import { signInReady } from './helpers';

const stubPrint = `window.__printCalls = 0; window.print = () => { window.__printCalls++; };`;

async function register(
  page: Page,
  p: { first: string; last: string; age: string; mobile: string; male?: boolean },
) {
  await page.goto('/reception/patients/new');
  await page.getByLabel('First name').fill(p.first);
  await page.getByLabel('Surname').fill(p.last);
  await page.getByText(p.male ? 'Male' : 'Female', { exact: true }).click();
  await page.getByLabel('Age', { exact: true }).fill(p.age);
  await page.getByLabel('Mobile number', { exact: true }).fill(p.mobile);
  // Family members on one mobile differ in name and age, so no duplicate question appears.
  await page.getByRole('button', { name: 'Save patient' }).click();
  await expect(page).toHaveURL(/\/reception\/patients\/[0-9a-f-]{36}\?registered=/);
}

/** The hidden print frame holds `template` copy `copy`, and the browser print was invoked. */
async function printed(page: Page, template: string, copy: number) {
  const frame = page.frameLocator('iframe[aria-hidden="true"]');
  await expect(frame.locator('.print-root')).toHaveAttribute('data-template', template);
  await expect(frame.locator('.print-root')).toHaveAttribute('data-copy', String(copy));
  return frame;
}

test('flow 1: new patient → visit → cash payment → token, receipt and OPD sheet', async ({
  page,
}, info) => {
  const desktop = info.project.name === 'desktop';
  const first = desktop ? 'Lata' : 'Rekha';
  const mobile = desktop ? '9415300001' : '9415300002';
  await page.addInitScript(stubPrint);
  await signInReady(page, E2E_USERS.reception);
  await register(page, { first, last: 'Billtest', age: '27', mobile });

  await page.getByRole('link', { name: 'New visit' }).click();
  await page.getByRole('button', { name: /Dr\. Sunita Verma/ }).click();
  await expect(page.getByTestId('visit-fee')).toHaveText('₹500.00');
  await page.getByRole('button', { name: 'Save visit' }).click();
  const created = page.getByTestId('visit-created');
  await expect(created).toContainText('Collect ₹500.00, then give the token.');

  // F8 opens the payment dialog (desktop); the tablet taps the green button.
  await expect(created.getByTestId('visit-collect')).toHaveText(/Collect ₹500\.00/);
  if (desktop) await page.keyboard.press('F8');
  else await created.getByTestId('visit-collect').click();
  const dialog = page.getByTestId('payment-dialog');
  await expect(dialog.getByTestId('amount-due')).toHaveText('₹500.00');
  await expect(dialog).toContainText('Five hundred rupees');
  await expect(dialog.getByRole('radio', { name: 'Cash' })).toBeChecked();
  await expect(dialog.getByLabel('Amount received now')).toBeFocused();

  // Cash given ₹2,000 → change ₹1,500 shown; more than due is refused before any request.
  await dialog.getByLabel('Amount received now').fill('600');
  await dialog.getByTestId('pay-submit').click();
  await expect(dialog.getByRole('alert')).toContainText('more than the amount due');
  await dialog.getByLabel('Amount received now').fill('500');
  await dialog.getByLabel('Cash given by patient').fill('2000');
  await expect(dialog.getByTestId('cash-change')).toHaveText('Return ₹1,500.00');
  await expect(dialog.getByLabel('Cash given by patient')).toHaveValue('2,000');

  if (desktop) await dialog.getByLabel('Cash given by patient').press('Enter');
  else await dialog.getByTestId('pay-submit').click();
  const confirm = page.getByTestId('confirm-money');
  await expect(confirm.getByTestId('confirm-amount')).toHaveText('₹500.00');
  await expect(confirm).toContainText('Five hundred rupees');
  await expect(confirm).toContainText('Return ₹1,500.00');
  // Enter confirms on desktop (the confirm button has focus); a double tap sends one payment.
  if (desktop) await page.keyboard.press('Enter');
  else await confirm.getByTestId('confirm-money-ok').dblclick();

  const paid = created.getByTestId('visit-paid');
  await expect(paid).toContainText(/₹500\.00 received\. Receipt RC\/\d\d-\d\d\/\d{6}\./);
  await expect(paid.getByRole('status').filter({ hasText: /Token\s*\d+/ })).toBeVisible();
  await expect(created.getByTestId('visit-collect')).toHaveCount(0);

  // The receipt prints by itself on the 80 mm roll.
  const receipt = await printed(page, 'receipt', 1);
  await expect(receipt.getByTestId('receipt-amount')).toHaveText('₹500.00');
  await expect(receipt.getByTestId('receipt-balance')).toHaveText('₹0.00');
  await expect(receipt.getByTestId('receipt')).toContainText(`${first} Billtest`);
  await expect(receipt.getByTestId('receipt')).toContainText('पाँच सौ रुपये');
  await expect(receipt.getByTestId('receipt')).toContainText(/OB\/\d\d-\d\d\/\d{6}/);

  // Layout at its paper size, once (desktop): 80 mm wide roll, masked where data changes per run.
  if (desktop) {
    const frameUrl = new URL(
      page
        .frames()
        .find((f) => f.url().includes('/print/receipt/'))!
        .url(),
    );
    const receiptPage = await page.context().newPage();
    await receiptPage.goto(`${frameUrl.pathname}?copy=1`);
    const sheet = receiptPage.locator('.print-sheet');
    await expect(sheet).toBeVisible();
    await receiptPage.evaluate(() => document.fonts.ready.then(() => undefined));
    const box = (await sheet.boundingBox())!;
    expect(box.width).toBeCloseTo((80 / 25.4) * 96, -1); // 80 mm in CSS px
    await expect(sheet).toHaveScreenshot('receipt-thermal80.png', {
      mask: [
        receiptPage.locator('.receipt > .receipt-row').first(),
        receiptPage.locator('.receipt > .receipt-row').nth(1),
        receiptPage.locator('.receipt-patient'),
        receiptPage.locator('.print-footer'),
        receiptPage.locator('.receipt > .receipt-row').last(),
      ],
      maxDiffPixelRatio: 0.02,
    });
    await receiptPage.close();
  }

  // OPD sheet from the same panel.
  await created.getByRole('button', { name: 'Print OPD sheet' }).click();
  await printed(page, 'opd-sheet', 1);

  // The bill is final, paid once (the double tap did not make a second receipt).
  await created.getByRole('link', { name: 'Open bill' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText(/Bill OB\//);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Final');
  await expect(page.getByTestId('bill-balance')).toHaveText('₹0.00');
  await expect(page.getByRole('heading', { name: 'Payments' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Print receipt' })).toHaveCount(1);
  await expect(page.getByTestId('collect')).toHaveCount(0);
});

test('flow 2: returning patient found by family mobile → free follow-up → token', async ({
  page,
}, info) => {
  const desktop = info.project.name === 'desktop';
  const mobile = desktop ? '9415300011' : '9415300012';
  const child = desktop ? 'Aarav' : 'Kabir';
  await signInReady(page, E2E_USERS.reception);
  await register(page, { first: 'Seema', last: 'Familybill', age: '31', mobile });
  await register(page, { first: child, last: 'Familybill', age: '3', mobile, male: true });

  // First visit with the paediatrician: ₹400, paid in cash.
  await page.getByRole('link', { name: 'New visit' }).click();
  await page.getByRole('button', { name: /Dr\. Rakesh Gupta/ }).click();
  await expect(page.getByTestId('visit-fee')).toHaveText('₹400.00');
  await page.getByRole('button', { name: 'Save visit' }).click();
  await page.getByTestId('visit-collect').click();
  await page.getByTestId('pay-submit').click();
  await page.getByTestId('confirm-money-ok').click();
  await expect(page.getByTestId('visit-paid')).toBeVisible();

  // Back later: the mobile number lists the family; pick the child.
  await page.goto('/reception');
  await page.getByRole('combobox', { name: 'Find patient' }).fill(mobile);
  await expect(page.getByText(`Family on mobile ending ${mobile.slice(-4)}`)).toBeVisible();
  await expect(page.getByRole('option')).toHaveCount(2);
  await page.getByRole('option', { name: new RegExp(`${child} Familybill`) }).click();
  await page.getByRole('link', { name: 'New visit' }).click();
  await page.getByRole('button', { name: /Dr\. Rakesh Gupta/ }).click();
  await expect(page.getByRole('radio', { name: /^Follow-up/ })).toBeChecked();
  await expect(page.getByTestId('visit-fee')).toHaveText('No fee');
  await page.getByRole('button', { name: 'Save visit' }).click();
  await page.getByRole('button', { name: 'Yes, make another visit today' }).click();
  await page.getByRole('button', { name: 'Save visit' }).click();

  // Free follow-up: the token is given at once, nothing to collect.
  const created = page.getByTestId('visit-created');
  await expect(created.getByRole('status').filter({ hasText: /Token\s*\d+/ })).toBeVisible();
  await expect(created.getByTestId('visit-collect')).toHaveCount(0);
});

test('bill screen: add a service, part payment, then split cash + UPI with UTR', async ({
  page,
}, info) => {
  const desktop = info.project.name === 'desktop';
  const first = desktop ? 'Usha' : 'Geeta';
  const mobile = desktop ? '9415300021' : '9415300022';
  await page.addInitScript(stubPrint);
  await signInReady(page, E2E_USERS.reception);
  await register(page, { first, last: 'Splittest', age: '35', mobile });
  await page.getByRole('link', { name: 'New visit' }).click();
  await page.getByRole('button', { name: /Dr\. Sunita Verma/ }).click();
  await page.getByRole('button', { name: 'Save visit' }).click();
  await page.getByTestId('visit-created').getByRole('link', { name: 'Open bill' }).click();

  await expect(page.getByRole('heading', { level: 1 })).toContainText('Draft bill');
  await expect(page.getByTestId('bill-line')).toHaveCount(1);

  // Add a suture removal (₹350.50) from the keyboard: type, Enter. ₹850.50 rounds to ₹851.
  const add = page.getByRole('combobox', { name: 'Add service' });
  await add.fill('suture');
  await expect(page.getByRole('option', { name: /Suture removal/ })).toBeVisible();
  await add.press('Enter');
  await expect(page.getByTestId('bill-line')).toHaveCount(2);
  await expect(page.getByTestId('bill-net')).toHaveText('₹851.00');
  await expect(page.getByText('Round off')).toBeVisible();

  // Remove it again and re-add (draft lines can change).
  await page.getByRole('button', { name: 'Remove Suture removal' }).click();
  await expect(page.getByTestId('bill-line')).toHaveCount(1);
  await add.fill('suture');
  await expect(page.getByRole('option', { name: /Suture removal/ })).toBeVisible();
  await add.press('Enter');
  await expect(page.getByTestId('bill-net')).toHaveText('₹851.00');

  // Part payment ₹300 in cash: the bill stays a draft with ₹551 due, and no token yet.
  await expect(page.getByTestId('collect')).toBeVisible();
  if (desktop) await page.keyboard.press('F8');
  else await page.getByTestId('collect').click();
  let dialog = page.getByTestId('payment-dialog');
  await dialog.getByLabel('Amount received now').fill('300');
  await expect(dialog).toContainText('Part payment: ₹551.00 will remain due.');
  await dialog.getByTestId('pay-submit').click();
  await page.getByTestId('confirm-money-ok').click();
  await expect(page.getByTestId('payment-done')).toContainText('₹300.00 received');
  await expect(page.getByTestId('bill-balance')).toHaveText('₹551.00');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Draft');
  await printed(page, 'receipt', 1);

  // The rest split: ₹200 cash + ₹351 UPI with UTR. The bill becomes final and gives the token.
  await page.getByTestId('collect').click();
  dialog = page.getByTestId('payment-dialog');
  await dialog.getByText('Split', { exact: true }).click();
  await dialog.getByLabel('Cash amount').fill('200');
  await expect(dialog.getByTestId('split-remaining')).toHaveText('Still to split: ₹351.00');
  await dialog.getByLabel('UPI amount').fill('351');
  await expect(dialog.getByTestId('split-remaining')).toHaveText('Still to split: ₹0.00');
  await dialog.getByLabel(/UTR/).fill('123456');
  await dialog.getByTestId('pay-submit').click();
  const confirm = page.getByTestId('confirm-money');
  await expect(confirm.getByTestId('confirm-amount')).toHaveText('₹551.00');
  await expect(confirm).toContainText('UTR …3456');
  await confirm.getByTestId('confirm-money-ok').click();

  await expect(page.getByTestId('payment-done')).toContainText('₹551.00 received');
  await expect(page.getByTestId('payment-done')).toContainText(/Token\s*\d+/);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Final');
  await expect(page.getByTestId('bill-balance')).toHaveText('₹0.00');
  await expect(page.getByText(/UPI ₹351\.00 \(UTR …3456\)/)).toBeVisible();
  const receipt = await printed(page, 'receipt', 1);
  await expect(receipt.getByTestId('receipt')).toContainText('UTR …3456');
  await expect(receipt.getByTestId('receipt-balance')).toHaveText('₹0.00');
  // Final bills are read-only: no service search, no remove buttons.
  await expect(page.getByRole('combobox', { name: 'Add service' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Remove / })).toHaveCount(0);

  // The desk no longer lists the settled bill.
  await page.goto('/billing');
  await expect(page.getByRole('combobox', { name: 'Find bill' })).toBeFocused();
  await page.getByRole('combobox', { name: 'Find bill' }).fill(mobile);
  await expect(page.getByText('No unpaid bill matches this search.')).toBeVisible();
});
