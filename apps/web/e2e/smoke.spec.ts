import { expect, test } from '@playwright/test';

test('home page loads and talks to the API', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Hospital Management System');
  await expect(page.getByRole('heading', { name: 'System status' })).toBeVisible();
  // tRPC round trip from the browser: the server row resolves from "Checking…" to "Running".
  await expect(page.getByText('Running', { exact: true })).toBeVisible();
});

test('language switches to Hindi using only the keyboard', async ({ page }) => {
  await page.goto('/');
  const hindi = page.getByRole('button', { name: 'हिन्दी' });
  await hindi.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('अस्पताल प्रबंधन प्रणाली');
  await expect(page.locator('html')).toHaveAttribute('lang', 'hi');
});
