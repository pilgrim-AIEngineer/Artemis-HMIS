/**
 * FND-06: app shell (menu by permission, skip link, focus), settings, facility profile and the
 * print header screen. Keyboard first, as docs/05 §1.11 asks; the tablet project taps.
 */
import { expect, test } from '@playwright/test';
import { E2E_USERS } from './fixtures';
import { signInReady } from './helpers';

test('menu shows only the work areas the role may open', async ({ page }) => {
  await signInReady(page, E2E_USERS.reception);
  const nav = page.getByRole('navigation', { name: 'Main menu' });
  // Reception also bills (docs/03 §3) and may take vitals (OPD-01). It is a bilingual-label role (docs/05 §1.8): "हिंदी / English".
  await expect(nav.getByRole('link')).toHaveText([
    'रिसेप्शन / Reception',
    'बिलिंग / Billing',
    'नर्सिंग / Nursing',
  ]);
  await expect(page.getByRole('link', { name: /Administration|प्रशासन/ })).toHaveCount(0);

  // The server refuses even when the menu is bypassed.
  const res = await page.goto('/admin/settings');
  expect(res?.status()).toBe(404);
  const api = await page.request.get('/api/trpc/admin.listSettings');
  expect(api.status()).toBe(403);
});

test('admin sees administration, and the launcher offers the new screens', async ({ page }) => {
  await signInReady(page, E2E_USERS.admin);
  const nav = page.getByRole('navigation', { name: 'Main menu' });
  await expect(nav.getByRole('link', { name: 'Administration' })).toBeVisible();
  await expect(nav.getByRole('link', { name: 'Reception' })).toHaveCount(0);
  for (const name of [/^Facility profile/, /^Settings/, /^Print header/, /^Users/]) {
    await expect(page.getByRole('link', { name })).toBeVisible();
  }
  await nav.getByRole('link', { name: 'Administration' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Administration');
  await expect(nav.getByRole('link', { name: 'Administration' })).toHaveAttribute(
    'aria-current',
    'page',
  );
});

test('keyboard: skip link first, Esc goes back, focus moves to the new page', async ({
  page,
}, info) => {
  test.skip(info.project.name === 'tablet', 'keyboard flow is checked on desktop');
  await signInReady(page, E2E_USERS.admin);
  await page.goto('/');
  await page.keyboard.press('Tab');
  const skip = page.getByRole('link', { name: 'Skip to main content' });
  await expect(skip).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#main')).toBeFocused();

  await page.getByRole('link', { name: /^Settings/ }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Settings');
  await expect(page.getByRole('searchbox', { name: 'Find a setting' })).toBeFocused();
  await page.keyboard.press('Escape'); // leaves the field
  await page.keyboard.press('Escape'); // goes back
  await expect(page).toHaveURL(/\/admin$/);
});

test('settings: change, save, see it marked Changed, then back to recommended', async ({
  page,
}, info) => {
  const days = info.project.name === 'tablet' ? '21' : '14';
  await signInReady(page, E2E_USERS.admin);
  await page.goto('/admin/settings');
  const row = page.getByTestId('setting-opd.followUpValidityDays');
  const field = row.getByLabel('Follow-up valid for (days)');
  await expect(field).toHaveValue('7');
  await expect(row.getByText('Recommended')).toBeVisible();

  await field.fill('9999');
  await field.press('Enter'); // Enter saves a single-line field; the server refuses 9999
  await expect(row.getByRole('alert')).toBeVisible();
  await field.fill(days);
  await field.press('Enter');
  await expect(row.getByText('Saved.')).toBeVisible();
  await expect(row.getByText('Changed')).toBeVisible();

  await page.reload();
  await expect(
    page.getByTestId('setting-opd.followUpValidityDays').getByLabel('Follow-up valid for (days)'),
  ).toHaveValue(days);

  await page
    .getByTestId('setting-opd.followUpValidityDays')
    .getByRole('button', { name: 'Use recommended' })
    .click();
  await expect(
    page.getByTestId('setting-opd.followUpValidityDays').getByText('Recommended'),
  ).toBeVisible();
  await expect(
    page.getByTestId('setting-opd.followUpValidityDays').getByLabel('Follow-up valid for (days)'),
  ).toHaveValue('7');
});

test('settings: money settings are typed in rupees, a switch toggles, find narrows the list', async ({
  page,
}) => {
  await signInReady(page, E2E_USERS.admin);
  await page.goto('/admin/settings');
  const refund = page.getByTestId('setting-billing.refundApprovalAbovePaise');
  const amount = refund.getByLabel('Refund needs approval above');
  await expect(amount).toHaveValue('1000');
  await amount.fill('1500.50');
  await refund.getByRole('button', { name: 'Save' }).click();
  await expect(refund.getByText('Saved.')).toBeVisible();
  await page.reload();
  await expect(
    page
      .getByTestId('setting-billing.refundApprovalAbovePaise')
      .getByLabel('Refund needs approval above'),
  ).toHaveValue('1500.50');
  await page
    .getByTestId('setting-billing.refundApprovalAbovePaise')
    .getByRole('button', { name: 'Use recommended' })
    .click();
  await expect(
    page
      .getByTestId('setting-billing.refundApprovalAbovePaise')
      .getByLabel('Refund needs approval above'),
  ).toHaveValue('1000');

  await page.getByRole('searchbox', { name: 'Find a setting' }).fill('training');
  await expect(page.getByRole('listitem').filter({ hasText: 'Training mode' })).toHaveCount(1);
  await expect(page.getByTestId('setting-opd.freeFollowUps')).toHaveCount(0);
  await page.getByRole('searchbox', { name: 'Find a setting' }).fill('zzzz');
  await expect(page.getByText('No setting matches. Try another word.')).toBeVisible();
});

test('facility profile: plain-language errors, then saved', async ({ page }, info) => {
  await signInReady(page, E2E_USERS.admin);
  await page.goto('/admin/facility');
  const name = page.getByLabel('Hospital name');
  await expect(name).toBeFocused();
  await page.getByLabel('PIN code').fill('12');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Enter a 6-digit PIN code.')).toBeVisible();
  await page.getByLabel('PIN code').fill('226001');
  await page.getByLabel('Phone').fill('0522 123456');
  await page.getByLabel('Address', { exact: true }).fill('12 Station Road');
  await page.getByLabel('GSTIN').fill('09abcde1234f1z5');
  await page.getByLabel('Drug licence numbers').fill('UP-20-123\nUP-21-456');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Saved.')).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('GSTIN')).toHaveValue('09ABCDE1234F1Z5');
  await expect(page.getByLabel('Drug licence numbers')).toHaveValue('UP-20-123\nUP-21-456');
  expect(info.project.name).toBeTruthy();
});

test('print header: live preview, saved and used by the real print page', async ({ page }) => {
  await signInReady(page, E2E_USERS.admin);
  await page.goto('/admin/print');
  await page.getByLabel('Hospital name in Hindi').fill('ई२ई अस्पताल');
  await page.getByLabel('Tagline in English').fill('Care with dignity');
  const preview = page.getByTestId('header-preview');
  await expect(preview).toContainText('ई२ई अस्पताल');
  await expect(preview).toContainText('E2E Hospital');
  await expect(preview).toContainText('Care with dignity');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Saved.')).toBeVisible();

  await page.getByRole('link', { name: 'A4' }).click();
  const header = page.locator('.print-header');
  await expect(header).toContainText('ई२ई अस्पताल');
  await expect(header).toContainText('E2E Hospital');
  // Hindi line first, English second (docs/05 §6).
  await expect(header.locator('.print-name-hi')).toBeVisible();
  await expect(header.locator('.print-name')).toBeVisible();
  const hi = await header.locator('.print-name-hi').boundingBox();
  const en = await header.locator('.print-name').boundingBox();
  expect(hi!.y).toBeLessThan(en!.y);

  // Leave the hospital header as found: the pixel tests in print.spec.ts expect it empty.
  await page.goto('/admin/print');
  await page.getByLabel('Hospital name in Hindi').fill('');
  await page.getByLabel('Tagline in English').fill('');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Saved.')).toBeVisible();
});

test('hospital colour: applied to the screens, derived text colour, neutral again', async ({
  page,
}) => {
  await signInReady(page, E2E_USERS.admin);
  await page.goto('/admin/print');
  await page.locator('#accent-picker').fill('#0b6e4f');
  await expect(page.getByText('Sample button')).toBeVisible();
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Saved.')).toBeVisible();

  await page.reload();
  const vars = () =>
    page.evaluate(() => {
      const css = getComputedStyle(document.documentElement);
      return [
        css.getPropertyValue('--primary').trim(),
        css.getPropertyValue('--primary-foreground').trim(),
      ];
    });
  expect(await vars()).toEqual(['#0b6e4f', '#ffffff']);

  await page.getByRole('button', { name: 'Use neutral colour' }).click();
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Saved.')).toBeVisible();
  await page.reload();
  expect((await vars())[0]).not.toBe('#0b6e4f');
});
