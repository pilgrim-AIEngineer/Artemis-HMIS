import { expect, test } from '@playwright/test';

test('signed-out visitors land on the login page with security headers', async ({ page }) => {
  const res = await page.goto('/');
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Sign in');
  const csp = (await res?.allHeaders())?.['content-security-policy'] ?? '';
  expect(csp).toContain("frame-ancestors 'none'");
  expect(csp).toMatch(/script-src 'self' 'nonce-/);
});

test('the API health endpoint reports the database', async ({ request }) => {
  const res = await request.get('/api/health');
  expect(res.status()).toBe(200);
  expect(((await res.json()) as { checks: { db: { ok: boolean } } }).checks.db.ok).toBe(true);
});

test('language switches to Hindi using only the keyboard', async ({ page }) => {
  await page.goto('/login');
  const hindi = page.getByRole('button', { name: 'हिन्दी' });
  await hindi.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('साइन इन करें');
  await expect(page.locator('html')).toHaveAttribute('lang', 'hi');
});
