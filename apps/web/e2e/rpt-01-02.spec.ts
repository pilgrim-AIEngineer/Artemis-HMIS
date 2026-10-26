/**
 * RPT-01 / RPT-02: a cash receipt taken at the counter shows up in the daily collection report
 * (and its CSV), the report prints without its controls on A4, the other reports open for the
 * admin, the front desk is turned away, and the owner's phone dashboard fits a phone screen.
 * Other specs also take money today, so figures are checked by the receipt this test creates
 * and by internal agreement (tile = total row), not by absolute amounts. Synthetic data only.
 */
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { E2E_USERS } from './fixtures';
import { payVisitInCash, registerPatient, signInReady } from './helpers';

test('collection report shows the receipt, exports CSV and prints without controls', async ({
  page,
}, info) => {
  const desktop = info.project.name === 'desktop';
  await signInReady(page, E2E_USERS.reception);
  await registerPatient(page, {
    first: desktop ? 'Rekha' : 'Mina',
    last: 'Reporttest',
    age: '29',
    mobile: desktop ? '9415300071' : '9415300072',
  });
  await page.getByRole('link', { name: 'New visit' }).click();
  await page.getByRole('button', { name: /Dr\. Sunita Verma/ }).click();
  await page.getByRole('button', { name: 'Save visit' }).click();
  await payVisitInCash(page);
  const receipt = /RC\/\d{2}-\d{2}\/\d+/.exec(await page.getByTestId('visit-paid').innerText())![0];

  // The front desk has no reports.
  await page.goto('/reports/collection');
  await expect(page.getByTestId('report-subtitle')).toHaveCount(0);

  await page.context().clearCookies();
  await signInReady(page, E2E_USERS.admin);
  await page.goto('/reports/collection');
  await expect(page.getByTestId('tile-net')).toBeVisible();
  const receipts = page.getByTestId('collection-receipts');
  await expect(receipts).toContainText(receipt);
  await expect(receipts).toContainText('Reporttest');

  // The net tile equals the total row of the by-user table.
  const net = await page.getByTestId('tile-net').locator('p').nth(1).innerText();
  await expect(page.getByTestId('collection-byUser-total')).toContainText(net);

  // CSV: exactly what is on screen, UTF-8 with a BOM, rupees as plain decimals.
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('export-csv').click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/^daily-collection-\d{4}-\d{2}-\d{2}\.csv$/);
  const csv = readFileSync(await download.path(), 'utf8');
  expect(csv.charCodeAt(0)).toBe(0xfeff);
  expect(csv).toContain(receipt);
  expect(csv).toContain('All receipts');
  expect(csv).not.toMatch(/₹/);

  // Print: A4 media hides the controls and the app header, and prints a heading with the range.
  await page.setViewportSize({ width: 794, height: 1123 });
  await page.emulateMedia({ media: 'print' });
  await expect(page.getByTestId('export-csv')).toBeHidden();
  await expect(page.getByTestId('range-filter')).toBeHidden();
  await expect(page.locator('header')).toBeHidden();
  await expect(page.getByRole('heading', { name: 'Daily collection' })).toBeVisible();
  await expect(page.getByText(/^Printed /)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.emulateMedia({ media: 'screen' });
});

test('the other reports open for the admin and a wrong range gives a plain message', async ({
  page,
}) => {
  await signInReady(page, E2E_USERS.admin);
  await page.goto('/reports');
  for (const name of [
    'Daily collection',
    'OPD counts',
    'ANC register',
    'Vaccines due',
    'Discounts and cancellations',
  ]) {
    await expect(page.getByRole('link', { name: new RegExp(name) })).toBeVisible();
  }

  await page.goto('/reports/opd');
  await expect(page.getByTestId('tile-visits')).toBeVisible();
  await expect(page.getByTestId('opd-doctors')).toContainText('Total');

  await page.goto('/reports/anc');
  await expect(page.getByTestId('tile-active')).toBeVisible();
  await page.goto('/reports/vaccines');
  await expect(page.getByTestId('tile-overdue')).toBeVisible();
  await page.goto('/reports/adjustments');
  await expect(page.getByTestId('tile-discounts')).toBeVisible();

  await page.goto('/reports/collection');
  await page.getByTestId('report-to').fill('2020-01-01');
  await expect(page.getByText('Choose a start date that is not after the end date.')).toBeVisible();

  const missing = await page.goto('/reports/no-such-report');
  expect(missing?.status()).toBe(404);
});

test('owner dashboard fits a phone and is read-only', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signInReady(page, E2E_USERS.owner);
  await page.goto('/reports/dashboard');
  const dash = page.getByTestId('owner-dashboard');
  await expect(dash).toBeVisible();
  for (const id of [
    'dash-opd',
    'dash-waiting',
    'dash-net',
    'dash-modes',
    'trend-opd',
    'month-compare',
  ]) {
    await expect(page.getByTestId(id)).toBeVisible();
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  // Nothing on the page can change data: no form fields, only the refresh button.
  await expect(dash.locator('input, textarea, select, form')).toHaveCount(0);
  await page.getByTestId('dashboard-refresh').click();
  await expect(page.getByTestId('dashboard-date')).toBeVisible();

  // The admin holds reports.owner_dashboard through the reports.* bundle; a reception login does not.
  await page.context().clearCookies();
  await signInReady(page, E2E_USERS.reception);
  expect((await page.goto('/reports/dashboard'))?.status()).toBe(404);
});
