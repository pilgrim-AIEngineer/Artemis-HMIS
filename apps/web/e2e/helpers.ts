import { expect, type Page } from '@playwright/test';
import { E2E_PASSWORD } from './fixtures';

/** Password sign-in through the login form (does not wait: callers may expect an error). */
export async function signIn(page: Page, user: { username: string }, password = E2E_PASSWORD) {
  await page.goto('/login');
  await page.getByLabel('Username').fill(user.username);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

/** Signs in and waits for the app shell. */
export async function signInReady(page: Page, user: { username: string }) {
  await signIn(page, user);
  await expect(page.getByTestId('current-user')).toBeVisible();
}

/** `/print/sample-<paper>/<facility id>` link as shown on Admin → Print header. */
export async function samplePrintHref(page: Page, paper: string): Promise<string> {
  await page.goto('/admin/print');
  const link = page.locator(`a[href^="/print/sample-${paper}/"]`).first();
  await expect(link).toBeVisible();
  const href = await link.getAttribute('href');
  if (!href) throw new Error(`no sample link for ${paper}`);
  return href;
}

/**
 * On the "visit created" panel: Collect → payment dialog (cash, full amount by default) → confirm
 * (BIL-02). Waits for the paid state, which shows the receipt number and the token.
 */
export async function payVisitInCash(page: Page) {
  const created = page.getByTestId('visit-created');
  await created.getByTestId('visit-collect').click();
  await page.getByTestId('payment-dialog').getByTestId('pay-submit').click();
  await page.getByTestId('confirm-money-ok').click();
  await expect(created.getByTestId('visit-paid')).toContainText(/Receipt RC\//);
}

/** Registers a patient from the reception form and waits for the patient page. */
export async function registerPatient(
  page: Page,
  p: { first: string; last: string; age: string; mobile: string },
) {
  await page.goto('/reception/patients/new');
  await page.getByLabel('First name').fill(p.first);
  await page.getByLabel('Surname').fill(p.last);
  await page.getByText('Female', { exact: true }).click();
  await page.getByLabel('Age', { exact: true }).fill(p.age);
  await page.getByLabel('Mobile number', { exact: true }).fill(p.mobile);
  await page.getByRole('button', { name: 'Save patient' }).click();
  await expect(page).toHaveURL(/\/reception\/patients\/[0-9a-f-]{36}\?registered=/);
}

/** The hidden print frame holds `template` copy `copy` (the browser print is stubbed). */
export async function printedFrame(page: Page, template: string, copy: number) {
  const frame = page.frameLocator('iframe[aria-hidden="true"]');
  await expect(frame.locator('.print-root')).toHaveAttribute('data-template', template);
  await expect(frame.locator('.print-root')).toHaveAttribute('data-copy', String(copy));
  return frame;
}
