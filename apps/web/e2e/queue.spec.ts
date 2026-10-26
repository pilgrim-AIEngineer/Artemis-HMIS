/**
 * REG-03 / REG-04: visit creation with the fee from the tariff, free follow-up, token, and the
 * live queue across two screens (reception and the doctor-room assistant), including the
 * 5-second polling fallback when the event stream is unavailable. Synthetic data only. Desktop
 * and tablet projects share one database, so each registers its own patient.
 */
import { expect, test, type Browser, type Page } from '@playwright/test';
import { E2E_USERS } from './fixtures';
import { signInReady } from './helpers';

async function register(page: Page, first: string, mobile: string) {
  await page.goto('/reception/patients/new');
  await page.getByLabel('First name').fill(first);
  await page.getByLabel('Surname').fill('Queuetest');
  await page.getByText('Female', { exact: true }).click();
  await page.getByLabel('Age', { exact: true }).fill('29');
  await page.getByLabel('Mobile number', { exact: true }).fill(mobile);
  await page.getByRole('button', { name: 'Save patient' }).click();
  await expect(page).toHaveURL(/\/reception\/patients\/[0-9a-f-]{36}\?registered=/);
}

async function assistantPage(browser: Browser, viewport: { width: number; height: number }) {
  const ctx = await browser.newContext({ viewport, timezoneId: 'Asia/Kolkata', locale: 'en-IN' });
  const page = await ctx.newPage();
  await signInReady(page, E2E_USERS.assistant);
  return { ctx, page };
}

test('visit with fee from the tariff, follow-up, and a live queue on two screens', async ({
  page,
  browser,
}, info) => {
  const desktop = info.project.name === 'desktop';
  const first = desktop ? 'Radha' : 'Meena';
  const mobile = desktop ? '9415200001' : '9415200002';
  const viewport = page.viewportSize() ?? { width: 1366, height: 768 };

  await signInReady(page, E2E_USERS.reception);
  await register(page, first, mobile);

  // New visit: pick the gynaecologist; the fee comes from the tariff, not from typing.
  await page.getByRole('link', { name: 'New visit' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'New visit' })).toBeVisible();
  await page.getByRole('button', { name: /Dr\. Sunita Verma/ }).click();
  await expect(page.getByTestId('visit-fee')).toHaveText('₹500.00');
  await expect(page.getByRole('radio', { name: /^New/ })).toBeChecked();
  await page.getByRole('button', { name: 'Save visit' }).click();

  // Fee ₹500: the token waits for the payment; reception releases it once the fee is collected.
  const created = page.getByTestId('visit-created');
  await expect(created).toContainText('Visit OP/');
  await expect(created).toContainText('Collect ₹500.00, then give the token.');
  await created.getByRole('button', { name: 'Fee collected: give token' }).click();
  await expect(created.getByRole('status').filter({ hasText: /Token\s*\d+/ })).toBeVisible();

  // ---- live queue: reception on this page, assistant in another browser context
  const { ctx, page: room } = await assistantPage(browser, viewport);
  await room.goto('/assistant');
  await expect(room.getByRole('heading', { level: 1, name: 'Doctor room queue' })).toBeVisible();
  await expect(room.getByTestId('live-status')).toHaveText('Live');

  await page.goto('/reception/queue');
  await expect(page.getByTestId('live-status')).toHaveText('Live');
  const mine = (p: Page) => p.getByRole('listitem').filter({ hasText: `${first} Queuetest` });
  await expect(mine(page)).toHaveAttribute('data-state', 'waiting');
  await expect(mine(page).getByText('Waiting', { exact: true })).toBeVisible();

  // The assistant sends the patient in; reception sees it within 2 s without reloading.
  await expect(mine(room)).toBeVisible();
  await expect(mine(room).getByRole('button', { name: 'No-show' })).toHaveCount(0); // desk action
  await mine(room).getByRole('button', { name: 'Send in' }).click();
  await expect(mine(page)).toHaveAttribute('data-state', 'with_doctor', { timeout: 2_000 });

  // Seen → done on the room screen; the card moves to the finished list on both screens.
  await mine(room).getByRole('button', { name: 'Seen' }).click();
  await expect(mine(page)).toHaveAttribute('data-state', 'seen', { timeout: 2_000 });
  await mine(room).getByRole('button', { name: 'Done' }).click();
  // Finished patients move to the collapsed "finished" list on every screen.
  await expect(mine(page)).toHaveCount(0, { timeout: 2_000 });
  await page.getByText(/\d+ finished or left/).click();
  await expect(mine(page)).toHaveAttribute('data-state', 'done');

  // The patient is back the same day: confirmation, then a follow-up at the follow-up rate.
  await page.goto('/reception');
  await page.getByRole('combobox', { name: 'Find patient' }).fill(mobile);
  await page.getByRole('option', { name: new RegExp(`${first} Queuetest`) }).click();
  await page.getByRole('link', { name: 'New visit' }).click();
  await page.getByRole('button', { name: /Dr\. Sunita Verma/ }).click();
  await expect(page.getByText(/Follow-up is allowed until/)).toBeVisible();
  await page.getByRole('button', { name: 'Save visit' }).click();
  await expect(
    page.getByText('This patient already has a visit with this doctor today.'),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Yes, make another visit today' }).click();
  await page.getByRole('button', { name: 'Save visit' }).click();
  const second = page.getByTestId('visit-created');
  // Inside the validity the visit is a follow-up at the follow-up rate of the tariff (₹300 in the
  // demo rates); a rate of ₹0 would give the token at once (covered by the integration tests).
  await expect(second.getByRole('status')).toContainText('Collect ₹300.00, then give the token.');
  await ctx.close();
});

test('the queue keeps updating every 5 seconds when the live stream is unavailable', async ({
  page,
  browser,
}, info) => {
  const first = info.project.name === 'desktop' ? 'Sarita' : 'Kavita';
  const mobile = info.project.name === 'desktop' ? '9415200011' : '9415200012';
  const viewport = page.viewportSize() ?? { width: 1366, height: 768 };

  await signInReady(page, E2E_USERS.reception);
  await register(page, first, mobile);
  await page.route('**/api/events', (route) => route.fulfill({ status: 503, body: '' }));
  await page.goto('/reception/queue');
  await expect(page.getByTestId('live-status')).toHaveText('Refreshing every 5 seconds');

  // Another screen books a visit; this one picks it up by polling (no reload).
  const other = await browser.newContext({ viewport, timezoneId: 'Asia/Kolkata', locale: 'en-IN' });
  const desk = await other.newPage();
  await signInReady(desk, E2E_USERS.reception);
  await desk.goto('/reception');
  await desk.getByRole('combobox', { name: 'Find patient' }).fill(mobile);
  await desk.getByRole('option', { name: new RegExp(`${first} Queuetest`) }).click();
  await desk.getByRole('link', { name: 'New visit' }).click();
  await desk.getByRole('button', { name: /Dr\. Sunita Verma/ }).click();
  await desk.getByRole('button', { name: 'Save visit' }).click();
  await expect(desk.getByTestId('visit-created')).toContainText('Visit OP/');
  await desk.getByRole('button', { name: 'Fee collected: give token' }).click();
  await expect(
    desk
      .getByTestId('visit-created')
      .getByRole('status')
      .filter({ hasText: /Token\s*\d+/ }),
  ).toBeVisible();

  await expect(page.getByRole('listitem').filter({ hasText: `${first} Queuetest` })).toBeVisible({
    timeout: 8_000,
  });
  await other.close();
});
