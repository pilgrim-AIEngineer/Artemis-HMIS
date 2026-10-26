/**
 * OPD-02 … OPD-04 / flow 4 (docs/32 §2): the assistant scans the OPD sheet's QR → photo of the
 * paper Rx → four drugs in shorthand + three orders + follow-up → save, timed at a realistic
 * typing speed of 25 words per minute (docs/11 §5: ≤ 60 s). Then the orders show up pre-ticked
 * on the bill, and a reloaded half-typed Rx offers its draft back. Desktop and tablet share one
 * database, so each registers its own patients. Synthetic data only.
 */
import { expect, test, type Browser, type Page } from '@playwright/test';
import { E2E_USERS } from './fixtures';
import { payVisitInCash, registerPatient, signInReady } from './helpers';

/** 25 wpm × 5 characters per word = 125 characters a minute. */
const KEY_DELAY_MS = Math.round(60_000 / (25 * 5));

async function asUser(browser: Browser, page: Page, user: { username: string }) {
  const ctx = await browser.newContext({
    viewport: page.viewportSize() ?? { width: 1366, height: 768 },
    timezoneId: 'Asia/Kolkata',
    locale: 'en-IN',
    hasTouch: test.info().project.name === 'tablet',
  });
  const p = await ctx.newPage();
  await signInReady(p, user);
  return { ctx, page: p };
}

/** Paid visit with the gynaecologist, sent in and seen by the doctor (assistant's room board). */
async function seenVisit(reception: Page, room: Page, p: { first: string; mobile: string }) {
  await registerPatient(reception, { first: p.first, last: 'Rxtest', age: '29', mobile: p.mobile });
  await reception.getByRole('link', { name: 'New visit' }).click();
  await reception.getByRole('button', { name: /Dr\. Sunita Verma/ }).click();
  await reception.getByRole('button', { name: 'Save visit' }).click();
  await payVisitInCash(reception);

  await room.goto('/assistant');
  const card = room.getByRole('listitem').filter({ hasText: `${p.first} Rxtest` });
  await card.getByRole('button', { name: 'Send in' }).click();
  await card.getByRole('button', { name: 'Seen' }).click();
  // The card links to the Rx screen; its id is what the sheet's QR code carries (`E:<id>`).
  const href = await card.getByRole('link', { name: 'Type Rx' }).getAttribute('href');
  const encounterId = /\/assistant\/rx\/([0-9a-f-]{36})$/.exec(href ?? '')![1]!;
  return encounterId;
}

/** A 2400×1800 JPEG "photo" of a sheet, drawn in the page (bigger than the 1600 px limit). */
async function sheetPhoto(page: Page): Promise<Buffer> {
  const b64 = await page.evaluate(async () => {
    const c = document.createElement('canvas');
    c.width = 2400;
    c.height = 1800;
    const g = c.getContext('2d')!;
    g.fillStyle = '#fff';
    g.fillRect(0, 0, c.width, c.height);
    g.fillStyle = '#123';
    g.font = '96px sans-serif';
    g.fillText('Rx  pcm 1-0-1 af 5d', 120, 300);
    const blob = await new Promise<Blob>((r) => c.toBlob((x) => r(x!), 'image/jpeg', 0.9));
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let s = '';
    for (const x of bytes) s += String.fromCharCode(x);
    return btoa(s);
  });
  return Buffer.from(b64, 'base64');
}

test.describe.serial('Rx transcription (OPD-02 … OPD-04)', () => {
  test('flow 4: scan → photo → 4-drug shorthand Rx + 3 orders + follow-up in under 60 s', async ({
    page,
    browser,
  }, info) => {
    test.setTimeout(240_000);
    const desktop = info.project.name === 'desktop';
    const first = desktop ? 'Rekha' : 'Malti';
    const mobile = desktop ? '9415500001' : '9415500002';

    await signInReady(page, E2E_USERS.reception);
    const { ctx, page: rx } = await asUser(browser, page, E2E_USERS.assistant);
    const encounterId = await seenVisit(page, rx, { first, mobile });

    // ---- timed from the scan to the saved Rx
    const started = Date.now();
    await rx.goto('/assistant/rx');
    const scan = rx.getByLabel('Scan the OPD sheet');
    await expect(scan).toBeFocused();
    // A keyboard-wedge scanner types the QR payload and Enter.
    await scan.pressSequentially(`E:${encounterId}`, { delay: 5 });
    await scan.press('Enter');
    await expect(rx).toHaveURL(new RegExp(`/assistant/rx/${encounterId}$`));
    await expect(rx.getByRole('heading', { name: 'Type the prescription' })).toBeVisible();
    await expect(rx.getByRole('group', { name: `${first} Rxtest` })).toBeVisible();

    // Saving needs the photo (rx.requirePhoto, default on).
    await expect(rx.getByTestId('rx-need-photo')).toBeVisible();
    await rx.getByTestId('rx-scan-file').setInputFiles({
      name: 'sheet.jpg',
      mimeType: 'image/jpeg',
      buffer: await sheetPhoto(rx),
    });
    const img = rx.getByRole('img', { name: 'Photo of the paper prescription' });
    await expect(img).toBeVisible();
    // Compressed in the browser to 1600 px on the long side (docs/01 §2).
    await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(1600);
    await expect(rx.getByTestId('rx-need-photo')).toHaveCount(0);

    // Four shorthand lines, typed at 25 wpm, Enter after each.
    const line = rx.getByLabel('Medicine line');
    const lines: [string, RegExp, string][] = [
      ['pcm 1-0-1 af 5d', /Paracetamol 500 mg/, '1-0-1, खाने के बाद, 5 दिन'],
      ['folic acid bd x1m', /Folic acid 5 mg/, '1-0-1, 1 महीना'],
      ['pantoprazole od bf 15d', /Pantoprazole 40 mg/, '1-0-0, खाने से पहले, 15 दिन'],
      ['cal od af 1m', /Calcium \+ vitamin D3/, '1-0-0, खाने के बाद, 1 महीना'],
    ];
    for (const [i, [text, drug, hindi]] of lines.entries()) {
      await line.pressSequentially(text, { delay: KEY_DELAY_MS });
      await line.press('Enter');
      const row = rx.getByTestId('rx-row').nth(i);
      await expect(row.getByRole('combobox', { name: /^Medicine of row/ })).toHaveValue(drug);
      await expect(row.getByTestId('rx-row-hindi')).toContainText(hindi);
      await expect(line).toHaveValue('');
    }
    await expect(rx.getByTestId('rx-row')).toHaveCount(4);
    // Quantity: pattern × days for tablets (folic acid BD × 30 days).
    await expect(rx.getByTestId('rx-row').nth(1).getByTestId('rx-row-hindi')).toContainText(
      'Qty 60',
    );

    // Three orders from the sheet's quick-tick list.
    await rx.getByRole('tab', { name: 'Orders' }).click();
    const quick = rx.getByTestId('rx-quick-orders');
    for (const o of ['CBC', 'TSH', 'Obstetric USG'])
      await quick.getByLabel(o, { exact: true }).check();
    await expect(rx.getByRole('tab', { name: /^Orders\s*\(3\)$/ })).toBeVisible();

    // Follow-up in 7 days.
    await rx.getByRole('tab', { name: /Follow-up/ }).click();
    await rx.getByRole('button', { name: 'After 7 days' }).click();
    await expect(rx.getByTestId('rx-follow-up-shown')).toContainText('Follow-up on');

    await rx.getByRole('button', { name: /Save prescription/ }).click();
    const saved = rx.getByTestId('rx-saved');
    await expect(saved).toContainText('Prescription saved');
    await expect(saved).toContainText('3 orders sent to billing.');
    const seconds = (Date.now() - started) / 1000;
    test.info().annotations.push({ type: 'flow-4-seconds', description: seconds.toFixed(1) });
    expect(seconds).toBeLessThanOrEqual(60);

    // The token moved on; the visit is now under "Typed today".
    await rx.getByRole('link', { name: 'Next patient' }).click();
    await expect(
      rx
        .getByTestId('rx-done')
        .getByRole('listitem')
        .filter({ hasText: `${first} Rxtest` }),
    ).toBeVisible();

    // ---- billing: the orders wait pre-ticked on a new draft bill (consultation already paid)
    const { ctx: billCtx, page: cashier } = await asUser(browser, page, E2E_USERS.cashier);
    await cashier.goto('/billing');
    await cashier.getByRole('combobox', { name: 'Find bill' }).fill(mobile);
    await cashier.getByRole('option', { name: new RegExp(`${first} Rxtest`) }).click();
    const orders = cashier.getByTestId('unbilled-orders');
    await expect(orders).toContainText('Complete blood count (CBC)');
    await expect(orders).toContainText('Obstetric USG – early');
    await orders.getByRole('button', { name: 'Add 3 orders to the bill' }).click();
    await expect(orders).toHaveCount(0);
    await expect(cashier.getByText('₹1,650.00').first()).toBeVisible();

    await billCtx.close();
    await ctx.close();
  });

  test('a reloaded screen offers its draft back; a warning sends the Rx to the doctor', async ({
    page,
    browser,
  }, info) => {
    test.setTimeout(150_000);
    const desktop = info.project.name === 'desktop';
    const first = desktop ? 'Sushila' : 'Kamla';
    const mobile = desktop ? '9415500003' : '9415500004';
    await signInReady(page, E2E_USERS.reception);
    const { ctx, page: rx } = await asUser(browser, page, E2E_USERS.assistant);
    const encounterId = await seenVisit(page, rx, { first, mobile });

    await rx.goto(`/assistant/rx/${encounterId}`);
    const line = rx.getByLabel('Medicine line');
    await line.fill('pcm 1-0-1 af 5d');
    await line.press('Enter');
    await expect(rx.getByTestId('rx-row')).toHaveCount(1);
    // An unknown drug: kept as typed, with a warning (non-blocking).
    await line.fill('syp mysteryol 5ml tds 3d');
    await line.press('Enter');
    await expect(rx.getByTestId('rx-row').nth(1)).toContainText('Not in the medicine list');
    // The browser copy is written every 5 s.
    await expect(rx.getByTestId('rx-autosave')).toContainText('Draft kept on this computer', {
      timeout: 8_000,
    });

    await rx.reload();
    await expect(rx.getByTestId('rx-restore')).toBeVisible();
    await expect(rx.getByLabel('Medicine line')).toBeDisabled();
    await rx.getByRole('button', { name: 'Restore draft' }).click();
    await expect(rx.getByTestId('rx-row')).toHaveCount(2);

    // Without the photo the Rx cannot be saved.
    await expect(rx.getByRole('button', { name: /Save prescription/ })).toBeDisabled();
    await rx.getByTestId('rx-scan-file').setInputFiles({
      name: 'sheet.jpg',
      mimeType: 'image/jpeg',
      buffer: await sheetPhoto(rx),
    });
    await expect(rx.getByRole('img', { name: 'Photo of the paper prescription' })).toBeVisible();
    await rx.keyboard.press('Control+Enter');
    const saved = rx.getByTestId('rx-saved');
    await expect(saved).toContainText('Prescription saved');
    // A warning puts it on the doctor's list in the default "sample" mode (Q15).
    await expect(saved).toContainText('The doctor will check this one against the paper.');
    await ctx.close();
  });
});
