import type { Page } from '@playwright/test';

import { expect, test } from './fixtures';
import {
  addForeignAccount,
  findRow,
  openBudget,
  savePrefs,
  USD_TO_VND,
} from './multi-currency-helpers';

const MOBILE_SIZE = { width: 350, height: 600 };

test.describe('Mobile multi-currency', () => {
  let page: Page;

  test.beforeEach(async ({ browser }) => {
    page = await browser.newPage();
  });

  test.afterEach(async () => {
    await page?.close();
  });

  const amountInput = () => page.getByTestId('amount-input');
  const form = () => page.getByTestId('transaction-form');
  const addButton = () =>
    page
      .getByTestId('transaction-form-footer')
      .getByRole('button', { name: 'Add transaction' });

  // Key presses and not `fill`: a phone sends one digit at a time, and
  // the field formats the text after each of them
  async function pressDigits(digits: string) {
    for (const digit of digits) {
      await page.keyboard.press(digit);
    }
  }

  async function openAccountOnMobile(accountId: string) {
    await page.setViewportSize(MOBILE_SIZE);
    await page.goto(`/accounts/${accountId}`);
    await expect(
      page.getByRole('button', { name: 'Add transaction' }),
    ).toBeVisible();
  }

  async function startTransaction() {
    await page.getByRole('button', { name: 'Add transaction' }).click();
    await expect(amountInput()).toBeFocused();
  }

  async function finishAmount() {
    await page.getByRole('heading', { name: 'New Transaction' }).click();
  }

  async function usdWallet() {
    await openBudget(page, { baseCurrency: 'VND' });
    return addForeignAccount(page, {
      name: 'USD Wallet',
      currencyLabel: /^USD - /,
      balance: '1.000,00',
    });
  }

  test('keeps USD decimals in a budget that hides them', async () => {
    const accountId = await usdWallet();
    await openAccountOnMobile(accountId);
    await startTransaction();

    await pressDigits('1250');
    await expect(amountInput()).toHaveValue('12,50');
    await finishAmount();
    await addButton().click();

    const row = await findRow(page, accountId, r => r.native_amount === -1250);
    expect(row).toMatchObject({
      amount: -1250 * USD_TO_VND,
      cleared: true,
    });
  });

  test('splits an amount in USD', async () => {
    const accountId = await usdWallet();
    await openAccountOnMobile(accountId);
    await startTransaction();
    await pressDigits('1250');
    await finishAmount();
    await addButton().click();
    await findRow(page, accountId, r => r.native_amount === -1250);

    await page.getByRole('button', { name: /12,50/ }).first().click();
    await form().getByRole('button', { name: 'Split', exact: true }).click();
    await pressDigits('500');
    await expect(page.getByText('Amount left: 12,50')).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(page.getByText('Amount left: 7,50')).toBeVisible();
    // The field selects its text just after it takes the focus
    await page.waitForFunction(() => {
      const input = document.activeElement as HTMLInputElement;
      return (
        input.value !== '' &&
        input.selectionStart === 0 &&
        input.selectionEnd === input.value.length
      );
    });
    await pressDigits('750');
    await page.keyboard.press('Enter');
    await page.getByRole('heading', { name: 'Transaction' }).click();
    await page.getByRole('button', { name: 'Save changes' }).click();

    await findRow(page, accountId, r => r.is_child && r.native_amount === -500);
    await findRow(page, accountId, r => r.is_child && r.native_amount === -750);
  });

  test('searches by the amount of the account', async () => {
    const accountId = await usdWallet();
    await openAccountOnMobile(accountId);
    const search = page.getByPlaceholder('Search USD Wallet');

    await search.fill('$1000');
    await expect(page.getByText('Starting Balance').first()).toBeVisible();

    await search.fill(String(1000 * USD_TO_VND));
    await expect(page.getByText('Starting Balance')).toHaveCount(0);
  });

  test('keeps the form open when no rate is available', async () => {
    const accountId = await usdWallet();
    await savePrefs(page, { exchangeRateProvider: '' });
    await openAccountOnMobile(accountId);
    await startTransaction();
    await pressDigits('900');
    await finishAmount();
    await form().locator('input[type=date]').fill('2016-02-10');
    await finishAmount();

    await addButton().click();

    await expect(page.getByText(/No exchange rate for USD/)).toBeVisible();
    await expect(form()).toContainText('9,00');
    await expect(page).toHaveURL(/transactions\/new/);
  });

  test('sets and resets the value in the budget currency', async () => {
    const accountId = await usdWallet();
    await openAccountOnMobile(accountId);

    await page.getByRole('button', { name: /Starting Balance/ }).click();
    await page
      .getByRole('button', { name: 'Amounts in two currencies' })
      .click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('textbox').fill('26.000.000');
    await dialog.getByRole('button', { name: 'Save' }).click();
    const locked = await findRow(page, accountId, r => r.amount_locked);
    expect(locked?.amount).toBe(2600000000);

    await page
      .getByRole('button', { name: 'Amounts in two currencies' })
      .click();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Use the exchange rate' })
      .click();

    const reset = await findRow(page, accountId, r => !r.amount_locked);
    expect(reset?.amount).toBe(100000 * USD_TO_VND);
  });

  test('takes VND digits as whole units in the budget currency', async () => {
    await usdWallet();
    await page.setViewportSize(MOBILE_SIZE);
    await page.goto('/accounts');
    await page.getByRole('button', { name: /Bank of America/ }).click();
    await startTransaction();

    await pressDigits('50000');
    await expect(amountInput()).toHaveValue('50.000');
  });

  test('takes VND digits as whole units in a USD budget', async () => {
    await openBudget(page, { baseCurrency: 'USD' });
    const accountId = await addForeignAccount(page, {
      name: 'VND Bank',
      currencyLabel: /^VND - /,
      balance: '15000000',
    });
    await openAccountOnMobile(accountId);
    await startTransaction();

    await pressDigits('50000');
    await expect(amountInput()).toHaveValue('50,000');
  });
});
