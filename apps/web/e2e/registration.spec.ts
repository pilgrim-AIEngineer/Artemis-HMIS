/**
 * REG-01/REG-02: start of flow 1 (docs/32), "new patient". Keyboard first (search focused on
 * load, F2, Enter), duplicate prompt, family on one mobile, Hindi screens. Synthetic data only.
 * Desktop and tablet projects share one database, so each uses its own mobile number.
 */
import { expect, test, type Page } from '@playwright/test';
import { E2E_USERS } from './fixtures';
import { signInReady } from './helpers';

async function register(
  page: Page,
  p: { first: string; last: string; age: string; mobile: string; female?: boolean },
) {
  await page.getByLabel('First name').fill(p.first);
  await page.getByLabel('Surname').fill(p.last);
  await page.getByText(p.female === false ? 'Male' : 'Female', { exact: true }).click();
  await page.getByLabel('Age', { exact: true }).fill(p.age);
  await page.getByLabel('Mobile number', { exact: true }).fill(p.mobile);
}

test('register a new patient with the keyboard, find them by a spelling variant', async ({
  page,
}, info) => {
  const mobile = info.project.name === 'desktop' ? '9415100001' : '9415100002';
  const first = info.project.name === 'desktop' ? 'Sunita' : 'Poonam';
  const variant = info.project.name === 'desktop' ? 'Suneeta' : 'Punam';

  await signInReady(page, E2E_USERS.reception);
  await page.goto('/reception');
  const search = page.getByRole('combobox', { name: 'Find patient' });
  await expect(search).toBeFocused();

  await page.keyboard.press('F2');
  await expect(page).toHaveURL(/\/reception\/patients\/new$/);
  await expect(page.getByLabel('First name')).toBeFocused();

  // Empty submit explains what is missing, in plain words.
  await page.getByRole('button', { name: 'Save patient' }).click();
  await expect(page.getByText('Please fill this in.').first()).toBeVisible();

  await register(page, { first, last: 'Devi', age: '28', mobile });
  // Age typed → estimated birth date is shown; Hindi name was suggested.
  await expect(page.getByText(/Estimated birth date: 01-Jul-\d{4}/)).toBeVisible();
  await expect(page.getByLabel('Name in Hindi')).not.toHaveValue('');
  await page.getByRole('button', { name: 'Save patient' }).click();

  await expect(page).toHaveURL(/\/reception\/patients\/[0-9a-f-]{36}\?registered=/);
  await expect(page.getByRole('status')).toContainText(/Patient registered\. UHID UH-\d{6}/);
  await expect(page.getByRole('group', { name: `${first} Devi` })).toBeVisible();

  // Search by spelling variant: ↑/↓ + Enter opens the patient.
  await page.goto('/reception');
  await expect(search).toBeFocused();
  await search.fill(variant);
  const option = page.getByRole('option', { name: new RegExp(`${first} Devi`) });
  await expect(option).toBeVisible();
  await search.press('Enter');
  await expect(page).toHaveURL(/\/reception\/patients\/[0-9a-f-]{36}$/);
  await expect(page.getByRole('group', { name: `${first} Devi` })).toBeVisible();
});

test('duplicate prompt on the same mobile, then a family member without it', async ({
  page,
}, info) => {
  const mobile = info.project.name === 'desktop' ? '9415100011' : '9415100012';
  const first = info.project.name === 'desktop' ? 'Anita' : 'Geeta';
  const variant = info.project.name === 'desktop' ? 'Anitha' : 'Gita';

  await signInReady(page, E2E_USERS.reception);
  await page.goto('/reception/patients/new');
  await register(page, { first, last: 'Gupta', age: '30', mobile });
  await page.getByRole('button', { name: 'Save patient' }).click();
  await expect(page).toHaveURL(/registered=/);
  const firstUrl = page.url().split('?')[0]!;

  // Same mobile, similar spelling, similar age → prompt, nothing created.
  await page.goto('/reception/patients/new');
  await register(page, { first: variant, last: 'Gupta', age: '31', mobile });
  await expect(page.getByText('Already on this mobile number')).toBeVisible();
  await page.getByRole('button', { name: 'Save patient' }).click();
  const dialog = page.getByRole('dialog', { name: 'Possible existing patient' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('link', { name: 'Use this patient' })).toBeFocused();

  // "Create new anyway" needs a reason.
  await dialog.getByRole('button', { name: 'Create new anyway' }).click();
  await dialog.getByRole('button', { name: 'Create new patient' }).click();
  await expect(dialog.getByText('Please write why this is a different person.')).toBeVisible();

  await dialog.getByRole('button', { name: 'Back to the form' }).click();
  await dialog.getByRole('link', { name: 'Use this patient' }).click();
  await expect(page).toHaveURL(firstUrl);

  // Add family member: contact is pre-filled, a different name saves without a prompt.
  await page.getByRole('link', { name: 'Add family member' }).click();
  await expect(page.getByLabel('Mobile number', { exact: true })).toHaveValue(mobile);
  await page.getByLabel('First name').fill('Rakesh');
  await page.getByText('Male', { exact: true }).click();
  await page.getByLabel('Age', { exact: true }).fill('34');
  await page.getByRole('button', { name: 'Save patient' }).click();
  await expect(page).toHaveURL(/registered=/);

  // A mobile search lists the family together.
  await page.goto('/reception');
  await page.getByRole('combobox', { name: 'Find patient' }).fill(mobile);
  await expect(page.getByRole('heading', { name: /Family on mobile ending/ })).toBeVisible();
  await expect(page.getByRole('option')).toHaveCount(2);
});

test('reception screens work in Hindi', async ({ page }) => {
  await signInReady(page, E2E_USERS.reception);
  await page.goto('/account');
  await page.getByRole('button', { name: 'हिन्दी' }).first().click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'hi');
  await page.goto('/reception');
  await expect(page.getByRole('combobox', { name: 'मरीज़ खोजें' })).toBeFocused();
  await page.keyboard.press('F2');
  await expect(page.getByRole('heading', { level: 1, name: 'नया मरीज़' })).toBeVisible();
  await expect(page.getByLabel('पहला नाम')).toBeFocused();
  // Put the account back to English for the other specs.
  await page.goto('/account');
  await page.getByRole('button', { name: 'English' }).first().click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
});
