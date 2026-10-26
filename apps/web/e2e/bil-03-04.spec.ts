/**
 * BIL-03 / BIL-04 critical flow (docs/32 §2):
 *  6. Bill cancellation with credit note and refund approval by PIN.
 * plus the discount limit: reception needs a supervisor's PIN for any discount.
 * One database is shared by both projects, so each project uses its own patients.
 * Synthetic data only.
 */
import { expect, test, type Page } from '@playwright/test';
import { E2E_USERS } from './fixtures';
import { printedFrame, registerPatient, signInReady } from './helpers';

const stubPrint = `window.__printCalls = 0; window.print = () => { window.__printCalls++; };`;

/** Reception registers a patient, opens the visit's bill and adds an IUCD insertion (₹1,500). */
async function billOf2000(page: Page, p: { first: string; mobile: string }) {
  await signInReady(page, E2E_USERS.reception);
  await registerPatient(page, { first: p.first, last: 'Adjusttest', age: '33', mobile: p.mobile });
  await page.getByRole('link', { name: 'New visit' }).click();
  await page.getByRole('button', { name: /Dr\. Sunita Verma/ }).click();
  await page.getByRole('button', { name: 'Save visit' }).click();
  await page.getByTestId('visit-created').getByRole('link', { name: 'Open bill' }).click();
  const add = page.getByRole('combobox', { name: 'Add service' });
  await add.fill('iucd ins');
  await expect(page.getByRole('option', { name: /IUCD insertion/ })).toBeVisible();
  await add.press('Enter');
  await expect(page.getByTestId('bill-net')).toHaveText('₹2,000.00');
}

test('discount: reception needs a supervisor PIN; the approval is recorded on the bill', async ({
  page,
}, info) => {
  const desktop = info.project.name === 'desktop';
  await billOf2000(page, {
    first: desktop ? 'Meena' : 'Pooja',
    mobile: desktop ? '9415300041' : '9415300042',
  });

  await page.getByTestId('discount-open').click();
  const dialog = page.getByTestId('discount-dialog');
  await expect(dialog).toContainText('cannot give a discount without a supervisor');
  await dialog.getByLabel('Percent (%)').fill('5');
  // No reason yet: refused before any request.
  await dialog.getByTestId('discount-submit').click();
  await expect(dialog.getByRole('alert')).toContainText('Choose a reason');
  await dialog.getByTestId('discount-reason').selectOption({ label: 'Poor patient' });
  await dialog.getByTestId('discount-submit').click();

  // Above the limit (reception: none): the supervisor types username and PIN on this screen.
  const approver = dialog.getByTestId('approver-fields');
  await expect(approver).toBeVisible();
  await expect(approver).toContainText('A supervisor must approve it');
  await approver.getByLabel('Supervisor username').fill(E2E_USERS.admin.username);
  await approver.getByLabel('Supervisor PIN').fill('9999');
  await dialog.getByTestId('discount-submit').click();
  await expect(dialog.getByRole('alert')).toContainText('The username or PIN is not correct');
  await approver.getByLabel('Supervisor PIN').fill(E2E_USERS.admin.pin);
  await dialog.getByTestId('discount-submit').click();

  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId('bill-net')).toHaveText('₹1,900.00');
  await expect(page.getByTestId('discount-list')).toContainText(
    'Whole bill: ₹100.00 · Poor patient',
  );
  await expect(page.getByTestId('discount-list')).toContainText('approved by E2E Admin');
  await expect(page.getByTestId('line-discount').first()).toBeVisible();

  // Removing a discount needs no approval.
  await page.getByRole('button', { name: 'Remove discount' }).click();
  await expect(page.getByTestId('bill-net')).toHaveText('₹2,000.00');
  await expect(page.getByTestId('discount-list')).toHaveCount(0);
});

test('flow 6: bill cancellation with credit note and refund approval by PIN', async ({
  page,
}, info) => {
  const desktop = info.project.name === 'desktop';
  await page.addInitScript(stubPrint);
  await billOf2000(page, {
    first: desktop ? 'Radha' : 'Sunita',
    mobile: desktop ? '9415300051' : '9415300052',
  });
  const billUrl = new URL(page.url()).pathname;

  // Reception takes the full ₹2,000 in cash.
  await page.getByTestId('collect').click();
  await page.getByTestId('pay-submit').click();
  await page.getByTestId('confirm-money-ok').click();
  await expect(page.getByTestId('payment-done')).toContainText('₹2,000.00 received');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Final');
  const billNumber = (await page.getByRole('heading', { level: 1 }).innerText()).match(
    /OB\/\d\d-\d\d\/\d{6}/,
  )![0];
  // Reception cannot cancel a final bill.
  await expect(page.getByTestId('cancel-open')).toHaveCount(0);

  // The cashier cancels it.
  await page.context().clearCookies();
  await signInReady(page, E2E_USERS.cashier);
  await page.goto(billUrl);
  await page.getByTestId('cancel-open').click();
  const dialog = page.getByTestId('cancel-dialog');
  await expect(dialog.getByTestId('credit-amount')).toHaveText('₹2,000.00');
  await expect(dialog.getByTestId('refund-amount')).toHaveText('₹2,000.00');
  await expect(dialog).toContainText('Two thousand rupees');
  // ₹2,000 is above the ₹1,000 cancellation limit: the supervisor's PIN is asked for up front.
  const approver = dialog.getByTestId('approver-fields');
  await expect(approver).toBeVisible();

  // Reason is mandatory, so is the supervisor.
  await dialog.getByTestId('cancel-submit').click();
  await expect(dialog.getByRole('alert')).toContainText('Choose a reason');
  await dialog.getByTestId('cancel-reason').selectOption({ label: 'Patient request' });
  await dialog.getByTestId('cancel-submit').click();
  await expect(dialog.getByRole('alert')).toContainText('Supervisor username and PIN are needed');

  // A wrong PIN is refused at the confirmation; going back keeps everything typed.
  await approver.getByLabel('Supervisor username').fill(E2E_USERS.admin.username);
  await approver.getByLabel('Supervisor PIN').fill('9999');
  await dialog.getByTestId('cancel-submit').click();
  const confirm = page.getByTestId('confirm-money');
  await expect(confirm.getByTestId('confirm-amount')).toHaveText('₹2,000.00');
  await expect(confirm).toContainText('Two thousand rupees');
  await confirm.getByTestId('confirm-money-ok').click();
  await expect(confirm.getByRole('alert')).toContainText('The username or PIN is not correct');
  await confirm.getByRole('button', { name: 'Go back' }).click();
  await expect(page.getByTestId('cancel-dialog').getByLabel('Supervisor username')).toHaveValue(
    E2E_USERS.admin.username,
  );

  // Right PIN: credit note, refund in cash, voucher printed.
  await approver.getByLabel('Supervisor PIN').fill(E2E_USERS.admin.pin);
  await dialog.getByTestId('cancel-submit').click();
  await expect(confirm.getByTestId('confirm-amount')).toHaveText('₹2,000.00');
  await confirm.getByTestId('confirm-money-ok').click();

  const done = page.getByTestId('cancel-done');
  await expect(done).toContainText(
    /Credit note CN\/\d\d-\d\d\/\d{5} issued\. Refund ₹2,000\.00 given\./,
  );
  const voucher = await printedFrame(page, 'receipt', 1);
  await expect(voucher.getByTestId('receipt')).toContainText('Refund / Credit note');
  await expect(voucher.getByTestId('receipt-amount')).toHaveText('₹2,000.00');
  await expect(voucher.getByTestId('receipt')).toContainText('दो हज़ार रुपये');

  // The bill is cancelled but keeps its number; the money trail is on the page.
  await expect(page.getByRole('heading', { level: 1 })).toContainText(billNumber);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Cancelled');
  await expect(page.getByTestId('cancelled-banner')).toContainText('Patient request');
  await expect(page.getByTestId('bill-credited')).toHaveText('-₹2,000.00');
  await expect(page.getByTestId('bill-paid')).toHaveText('₹0.00');
  await expect(page.getByTestId('bill-balance')).toHaveText('₹0.00');
  await expect(page.getByTestId('credit-note-list')).toContainText('E2E Cashier');
  await expect(page.getByRole('button', { name: 'Print refund voucher' })).toBeVisible();
  await expect(page.getByTestId('cancel-open')).toHaveCount(0);
  await expect(page.getByTestId('collect')).toHaveCount(0);
});
