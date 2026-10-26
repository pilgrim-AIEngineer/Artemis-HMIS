/**
 * FND-02 critical flows: login, idle lock → PIN unlock, switch user (docs/32 §2, docs/01 §5).
 * Desktop uses the physical keyboard, the tablet project taps the on-screen keypad.
 */
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { E2E_PASSWORD, E2E_USERS } from './fixtures';
import { signIn } from './helpers';

async function enterPin(page: Page, pin: string, info: TestInfo) {
  if (info.project.name === 'tablet') {
    const keypad = page.getByRole('group', { name: 'PIN keypad' });
    for (const d of pin) await keypad.getByRole('button', { name: d, exact: true }).tap();
    await keypad.getByRole('button', { name: 'Unlock' }).tap();
  } else {
    await page.keyboard.type(pin);
    await page.keyboard.press('Enter');
  }
}

test('login: wrong password is explained, right password reaches home', async ({ page }) => {
  await signIn(page, E2E_USERS.reception, 'not-the-password');
  await expect(page.getByText('Wrong username or password.')).toBeVisible();
  await page.getByLabel('Password', { exact: true }).fill(E2E_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    `Welcome, ${E2E_USERS.reception.fullName}`,
  );
  await expect(page.getByTestId('current-user')).toHaveText(E2E_USERS.reception.fullName);
  // Session cookie is HttpOnly: invisible to page scripts.
  expect(await page.evaluate(() => document.cookie)).not.toContain('__Host-hmis_session');
  const cookies = await page.context().cookies();
  expect(cookies.find((c) => c.name === '__Host-hmis_session')).toMatchObject({
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
  });
});

test('idle lock after 10 minutes, then PIN unlock for the same user', async ({ page }, info) => {
  await page.clock.install();
  await signIn(page, E2E_USERS.reception);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Welcome');

  await page.clock.fastForward('09:00');
  await expect(page.getByRole('dialog', { name: 'Screen locked' })).toBeHidden();
  await page.clock.fastForward('01:30');
  const lock = page.getByRole('dialog', { name: 'Screen locked' });
  await expect(lock).toBeVisible();
  await expect(lock).toContainText(`${E2E_USERS.reception.fullName}, enter your PIN to continue.`);
  await expect(page.getByRole('heading', { name: /^Welcome/ })).toBeHidden();

  await enterPin(page, '9999', info);
  await expect(lock).toContainText(/Wrong PIN\. \d tries left\./);

  await enterPin(page, E2E_USERS.reception.pin, info);
  await expect(lock).toBeHidden();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Welcome');

  // The server agrees the session is active again.
  await page.reload();
  await expect(page.getByRole('dialog', { name: 'Screen locked' })).toBeHidden();
});

test('a locked screen survives a reload and Switch user goes to full login', async ({ page }) => {
  await signIn(page, E2E_USERS.reception);
  // Wait for the server to record the lock before reloading.
  await Promise.all([
    page.waitForResponse((r) => r.url().includes('auth.lock') && r.ok()),
    page.getByRole('button', { name: 'Lock' }).click(),
  ]);
  await expect(page.getByRole('dialog', { name: 'Screen locked' })).toBeVisible();
  await page.reload();
  const lock = page.getByRole('dialog', { name: 'Screen locked' });
  await expect(lock).toBeVisible();
  await lock.getByRole('button', { name: 'Switch user' }).click();
  await expect(page).toHaveURL(/\/login/);
  await signIn(page, E2E_USERS.admin);
  await expect(page.getByTestId('current-user')).toHaveText(E2E_USERS.admin.fullName);
});

test('admin creates a user who must change the temporary password', async ({ page }, info) => {
  const username = `e2e_new_${info.project.name}_${Date.now().toString(36)}`;
  await signIn(page, E2E_USERS.admin);
  await page.getByRole('link', { name: /^Users/ }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Users');
  await expect(page.getByRole('searchbox')).toBeFocused();
  await page.getByRole('link', { name: 'New user' }).click();
  await page.getByLabel('Full name').fill('Sunita Devi');
  await page.getByLabel('Username').fill(username);
  await page.getByRole('checkbox', { name: 'Cashier' }).check();
  await page.getByLabel('Temporary password').fill('first-pass-77');
  await page.getByRole('button', { name: 'Create user' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Sunita Devi');

  await page.getByRole('button', { name: 'Switch user' }).click();
  await expect(page).toHaveURL(/\/login/);
  await signIn(page, { username }, 'first-pass-77');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Choose a new password');
  await page.getByLabel('Temporary password').fill('first-pass-77');
  await page.getByLabel('New password', { exact: true }).fill('my-own-pass-1');
  await page.getByLabel('New password again').fill('my-own-pass-1');
  await page.getByRole('button', { name: 'Save password' }).click();
  // New users default to Hindi; the user's language applies after sign-in (docs/05 §1.8).
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('स्वागत है, Sunita Devi');
});
