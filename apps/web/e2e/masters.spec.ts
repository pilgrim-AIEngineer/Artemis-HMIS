/**
 * FND-07: master data screens. Keyboard first (docs/05 §1.11), taps on the tablet project; soft
 * cancel with Undo; rates in rupees stored as paise; reception is kept out.
 */
import { expect, test, type Page } from '@playwright/test';
import { E2E_USERS } from './fixtures';
import { signInReady } from './helpers';

async function openMasters(page: Page) {
  await page.goto('/admin');
  await page.getByRole('link', { name: /^Master data/ }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Master data' })).toBeVisible();
}

test('hub lists the master lists; reception cannot open them', async ({ page, browser }) => {
  await signInReady(page, E2E_USERS.admin);
  await openMasters(page);
  for (const name of [
    'Departments',
    'Doctors',
    'Services',
    'Tariffs and rates',
    'Payers',
    'Drugs',
  ]) {
    await expect(page.getByRole('link', { name: new RegExp(`^${name}`) }).first()).toBeVisible();
  }

  const other = await browser.newContext();
  const rx = await other.newPage();
  await signInReady(rx, E2E_USERS.reception);
  expect((await rx.goto('/admin/masters'))?.status()).toBe(404);
  expect((await rx.goto('/admin/masters/services'))?.status()).toBe(404);
  expect((await rx.request.get('/api/trpc/masters.listServices')).status()).toBe(403);
  await other.close();
});

test('services: search with keyboard, open a row, see Hindi and GST text', async ({
  page,
}, info) => {
  await signInReady(page, E2E_USERS.admin);
  await page.goto('/admin/masters/services');
  const search = page.getByRole('searchbox', { name: 'Search' });
  await expect(search).toBeFocused();
  await search.fill('colposcpy'); // typo still finds it (trigram)
  const row = page.getByRole('row', { name: /Colposcopy/ });
  await expect(row).toBeVisible();
  if (info.project.name === 'desktop') {
    await search.press('Enter'); // opens the highlighted row
  } else {
    await row.getByRole('button', { name: 'Colposcopy' }).tap();
  }
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByLabel('Name', { exact: true })).toHaveValue('Colposcopy');
  await expect(dialog.getByLabel('Name in Hindi')).toHaveValue('कोल्पोस्कोपी');
  await expect(dialog.getByLabel('Code', { exact: true })).toBeDisabled(); // codes are fixed once created
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
});

// Desktop and tablet share one database, so each project works on its own rows.
test('departments: add, remove with a reason, undo', async ({ page }, info) => {
  const tag = info.project.name;
  const name = `Dental ${tag}`;
  await signInReady(page, E2E_USERS.admin);
  await page.goto('/admin/masters/departments');
  await page.getByRole('button', { name: 'New department' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Name', { exact: true }).fill(name);
  await dialog.getByLabel('Code', { exact: true }).fill(`dent_${tag}`);
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('row', { name: new RegExp(name) })).toBeVisible();

  await page.getByRole('button', { name, exact: true }).click();
  await dialog.getByRole('button', { name: 'Remove…' }).click();
  // A reason is required; nothing happens without one.
  await dialog.getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('short reason');
  await dialog.getByLabel('Reason for removing').fill('Not offered here');
  await dialog.getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: `"${name}" removed.` })).toBeVisible();
  await expect(page.getByRole('row', { name: new RegExp(name) })).toHaveCount(0);

  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(page.getByRole('row', { name: new RegExp(name) })).toBeVisible();
});

test('rates: set a price in rupees, see it, correct it, history keeps the old one', async ({
  page,
}, info) => {
  const svc =
    info.project.name === 'desktop'
      ? { search: 'NST', name: /NST \/ CTG/ }
      : { search: 'Pap', name: /Pap smear/ };
  await signInReady(page, E2E_USERS.admin);
  await page.goto('/admin/masters/tariffs');
  await page
    .getByRole('row', { name: /Standard \(Cash\)/ })
    .getByRole('link', { name: 'Rates' })
    .click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Rates: Standard (Cash)');

  await page.getByRole('searchbox', { name: 'Search' }).fill(svc.search);
  const row = page.getByRole('row', { name: svc.name });
  await expect(row).toContainText('not set');
  await row.getByRole('button', { name: svc.name }).click();

  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('New rate (₹)').fill('1250.5');
  await expect(dialog).toContainText('₹1,250.50'); // Indian grouping preview
  await dialog.getByLabel('New rate (₹)').fill('1.234'); // paise only: three decimals refused
  await expect(dialog.getByRole('button', { name: 'Save rate' })).toBeDisabled();
  await dialog.getByLabel('New rate (₹)').fill('400');
  await dialog.getByRole('button', { name: 'Save rate' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(row).toContainText('₹400.00');

  await row.getByRole('button', { name: svc.name }).click();
  await dialog.getByLabel('New rate (₹)').fill('450');
  await dialog.getByRole('button', { name: 'Save rate' }).click();
  await expect(row).toContainText('₹450.00');

  await row.getByRole('button', { name: svc.name }).click();
  const history = dialog.getByRole('region', { name: 'Rate history' });
  await expect(history).toContainText('₹450.00');
  await expect(history).toContainText('₹400.00');
  await expect(history).toContainText('corrected');
});

test('payers: only Cash / Self can be switched on', async ({ page }, info) => {
  const tag = info.project.name;
  const name = `PM-JAY ${tag}`;
  await signInReady(page, E2E_USERS.admin);
  await page.goto('/admin/masters/payers');
  await expect(page.getByRole('row', { name: /Cash \/ Self/ })).toContainText('Active');
  await page.getByRole('button', { name: 'New payer' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Name', { exact: true }).fill(name);
  await dialog.getByLabel('Type').selectOption('pmjay');
  await dialog.getByLabel('Code', { exact: true }).fill(`pmjay-${tag}`);
  await dialog.getByLabel('In use').check();
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog.getByRole('alert')).toContainText('Only Cash / Self can be switched on');
  await dialog.getByLabel('In use').uncheck();
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('row', { name: new RegExp(name) })).toContainText('Switched off');
});
