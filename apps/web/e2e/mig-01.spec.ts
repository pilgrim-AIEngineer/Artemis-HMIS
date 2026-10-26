/**
 * MIG-01: import the old patient register. Upload a messy CSV, see the dry run with a per-row
 * error, download the error report, import in batches, and keep reception out.
 */
import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { E2E_USERS } from './fixtures';
import { signInReady } from './helpers';

test('admin imports an old register: dry run, error report, commit', async ({ page, browser }) => {
  // Unique numbers per run: the E2E database keeps patients between runs.
  const stamp = String(Date.now()).slice(-6);
  const csv = [
    'Patient Name,Age,Gender,Mob No,Old Reg No',
    `smt. Imp Alpha${stamp},28 yrs,Female,98${stamp}01,E2E-${stamp}-1`,
    `Imp Beta${stamp},30,F,12345,E2E-${stamp}-2`,
    `Imp Gamma${stamp},31,F,+91 98${stamp}03,E2E-${stamp}-3`,
  ].join('\n');

  await signInReady(page, E2E_USERS.admin);
  await page.goto('/admin');
  await page.getByRole('link', { name: /^Import data/ }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Import data' })).toBeVisible();

  await page.getByLabel('Excel (.xlsx) or CSV file').setInputFiles({
    name: 'old register.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(csv),
  });
  await page.getByRole('button', { name: 'Upload and check' }).click();

  await expect(page.getByRole('heading', { level: 1, name: 'Check the file' })).toBeVisible();
  await expect(page.getByText('Will import: 2')).toBeVisible();
  await expect(page.getByText('Error: 1')).toBeVisible();
  // "Needs attention" is the default view: only the bad row, with a plain-language reason.
  const row = page.getByRole('row', { name: /Not a valid 10-digit mobile/ });
  await expect(row).toBeVisible();
  await expect(page.getByRole('table').last().getByRole('row')).toHaveCount(2); // header + the bad row

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Download error report' }).click(),
  ]);
  expect(download.suggestedFilename()).toBe('old register - errors.csv');
  const report = await readFile(await download.path(), 'utf8');
  expect(report).toContain('Not a valid 10-digit mobile');
  expect(report).toContain('Imp Beta');

  await page.getByRole('button', { name: 'Import 2 rows' }).click();
  await expect(page.getByText('Finished: 2 imported, 0 unchanged, 0 failed.')).toBeVisible();

  // Reception has no import permission: the page does not exist for them.
  const rx = await (await browser.newContext()).newPage();
  await signInReady(rx, E2E_USERS.reception);
  await rx.goto('/reception');
  expect((await rx.request.get('/admin/import')).status()).toBe(404);
  await rx.context().close();
});
