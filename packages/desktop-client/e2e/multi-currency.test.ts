import type { Page } from '@playwright/test';

import { expect, test } from './fixtures';
import {
  addForeignAccount,
  findRow,
  getRows,
  openBudget,
  PAST_DATE,
  PAST_DATE_INPUT,
  PAST_RATE,
  savePrefs,
  USD_TO_VND,
} from './multi-currency-helpers';
import { AccountPage } from './page-models/account-page';
import { ConfigurationPage } from './page-models/configuration-page';

test.describe('Multi-currency', () => {
  let page: Page;
  let accountPage: AccountPage;

  test.beforeEach(async ({ browser }) => {
    page = await browser.newPage();
    accountPage = new AccountPage(page);
  });

  test.afterEach(async () => {
    await page?.close();
  });

  const usdRow = (notes: string) =>
    accountPage.transactionTableRow.filter({ hasText: notes });

  async function addUsdRow({
    notes,
    debit,
    date,
  }: {
    notes: string;
    debit: string;
    date?: string;
  }) {
    await accountPage.enterSingleTransaction({ notes, debit });
    if (date) {
      const dateCell = accountPage.newTransactionRow.getByTestId('date');
      await dateCell.click();
      await dateCell.locator('input').fill(date);
      await page.keyboard.press('Tab');
    }
    await accountPage.addTransactionButton.click();
  }

  async function usdWallet() {
    return addForeignAccount(page, {
      name: 'USD Wallet',
      currencyLabel: /^USD - /,
      balance: '1.234,56',
    });
  }

  test.describe('in a VND budget with a USD account', () => {
    let rateService: Awaited<ReturnType<typeof openBudget>>;

    test.beforeEach(async () => {
      rateService = await openBudget(page, { baseCurrency: 'VND' });
    });

    test('converts the starting balance of a new account', async () => {
      const accountId = await usdWallet();

      const row = await findRow(
        page,
        accountId,
        ({ native_amount }) => native_amount === 123456,
      );
      expect(row?.amount).toBe(123456 * USD_TO_VND);
      await expect(page.getByTestId('account-balance')).toContainText(
        '1.234,56',
      );
      await expect(page.getByText(/30\.864\.000/).first()).toBeVisible();
    });

    test('adds and edits an amount in the currency of the account', async () => {
      const accountId = await usdWallet();

      await addUsdRow({ notes: 'coffee', debit: '12,5' });
      const added = await findRow(page, accountId, r => r.notes === 'coffee');
      expect(added).toMatchObject({
        native_amount: -1250,
        amount: -1250 * USD_TO_VND,
        cleared: true,
      });
      await accountPage.cancelTransactionButton.click();

      const debit = usdRow('coffee').getByTestId('debit');
      await debit.click();
      await debit.locator('input').fill('20');
      await page.keyboard.press('Enter');

      await findRow(page, accountId, r => r.native_amount === -2000);
      await expect(page.getByTestId('account-balance')).toContainText(
        '1.214,56',
      );
    });

    test('uses the rate of the date of a transaction', async () => {
      const accountId = await usdWallet();

      await addUsdRow({
        notes: 'old',
        debit: '10',
        date: PAST_DATE_INPUT,
      });

      const row = await findRow(page, accountId, r => r.notes === 'old');
      expect(row).toMatchObject({
        date: PAST_DATE,
        native_amount: -1000,
        amount: -1000 * PAST_RATE,
      });
    });

    test('searches, filters and sorts by the amount of the account', async () => {
      await usdWallet();
      await addUsdRow({ notes: 'coffee', debit: '20' });
      await addUsdRow({ notes: 'lunch', debit: '5' });
      await accountPage.cancelTransactionButton.click();
      const search = page.getByPlaceholder('Search');

      await search.fill('$20');
      await expect(accountPage.transactionTableRow).toHaveCount(1);
      await expect(usdRow('coffee')).toBeVisible();
      await search.fill(String(20 * USD_TO_VND));
      await expect(accountPage.transactionTableRow).toHaveCount(0);
      await search.fill('');

      await accountPage.filterBy('Amount');
      const tooltip = page.getByTestId('filters-menu-tooltip');
      await tooltip.getByRole('textbox').fill('-20');
      await tooltip.getByRole('button', { name: 'Apply' }).click();
      await expect(accountPage.transactionTableRow).toHaveCount(1);
      const chip = page.getByRole('button', { name: /amount is/ });
      await expect(chip).toContainText('$');
      await expect(chip).toContainText('20,00');
      await chip.click();
      await expect(tooltip.getByRole('textbox')).toHaveValue('20,00');
      await page.keyboard.press('Escape');
      await accountPage.removeFilter(0);

      await page.getByRole('button', { name: 'Payment' }).click();
      await expect(accountPage.transactionTableRow.first()).toContainText(
        'coffee',
      );
      await expect(accountPage.transactionTableRow.nth(1)).toContainText(
        'lunch',
      );
    });

    test('asks for the real amount of a transfer between two currencies', async () => {
      const accountId = await usdWallet();

      await accountPage.addNewTransactionButton.click();
      const payee = accountPage.newTransactionRow.getByTestId('payee');
      await payee.click();
      await payee.locator('input').pressSequentially('Bank of');
      await page
        .getByTestId('autocomplete')
        .getByText('Bank of America')
        .click();
      const debit = accountPage.newTransactionRow.getByTestId('debit');
      await debit.click();
      await debit.locator('input').fill('10');
      await accountPage.addTransactionButton.click();

      const dialog = page.getByRole('dialog');
      await expect(dialog).toContainText('Amounts in two currencies');
      await expect(dialog.getByRole('textbox')).toHaveValue('250.000');
      await dialog.getByRole('textbox').fill('260.000');
      await dialog.getByRole('button', { name: 'Save' }).click();

      const row = await findRow(page, accountId, r => r.amount === -26000000);
      expect(row?.native_amount).toBe(-1000);
      const other = await page.evaluate(async id => {
        const { data } = await window.$query(
          window.$q('transactions').filter({ id }).select(['amount']),
        );
        return data[0].amount;
      }, row?.transfer_id);
      expect(other).toBe(26000000);
    });

    test('reconciles in the currency of the account', async () => {
      const accountId = await usdWallet();

      await page.getByRole('button', { name: 'Reconcile' }).click();
      await page.locator('[data-popover] input').fill('1.200,00');
      await page
        .locator('[data-popover]')
        .getByRole('button', { name: 'Reconcile' })
        .click();
      await expect(page.getByText(/needs -.*34,56 to match/)).toBeVisible();
      await page
        .getByRole('button', { name: 'Create reconciliation transaction' })
        .click();

      const row = await findRow(
        page,
        accountId,
        r => r.native_amount === -3456,
      );
      expect(row?.amount).toBe(-3456 * USD_TO_VND);
      await expect(page.getByText('All reconciled!')).toBeVisible();
    });

    test('books the difference to the rate of today', async () => {
      const accountId = await usdWallet();
      await addUsdRow({
        notes: 'old',
        debit: '10',
        date: PAST_DATE_INPUT,
      });
      await findRow(page, accountId, r => r.notes === 'old');
      await accountPage.cancelTransactionButton.click();

      await page.getByRole('button', { name: 'Book the difference' }).click();

      const row = await findRow(page, accountId, r => r.native_amount === 0);
      expect(row?.amount_locked).toBe(true);
      await expect(
        page.getByRole('button', { name: 'Book the difference' }),
      ).toHaveCount(0);
    });

    test('splits an amount in the currency of the account', async () => {
      const accountId = await usdWallet();

      await accountPage.createSplitTransaction([
        { debit: '30' },
        { debit: '10' },
        { debit: '20' },
      ]);

      const parent = await findRow(page, accountId, r => r.is_parent);
      expect(parent).toMatchObject({
        native_amount: -3000,
        amount: -3000 * USD_TO_VND,
      });
      const children = (await getRows(page, accountId)).filter(r => r.is_child);
      expect(children.map(r => r.native_amount)).toEqual(
        expect.arrayContaining([-1000, -2000]),
      );
    });

    test('keeps a new transaction when no rate is available', async () => {
      const accountId = await usdWallet();
      await savePrefs(page, { exchangeRateProvider: '' });
      await page.reload();
      await expect(accountPage.addNewTransactionButton).toBeVisible();

      await addUsdRow({ notes: 'keep me', debit: '77', date: '01/15/2016' });

      await expect(page.getByText(/No exchange rate for USD/)).toBeVisible();
      await expect(accountPage.newTransactionRow).toContainText('keep me');
      await expect(accountPage.newTransactionRow).toContainText('77,00');
      expect(await getRows(page, accountId)).toHaveLength(1);

      await savePrefs(page, { exchangeRateProvider: 'frankfurter' });
      await accountPage.addTransactionButton.click();
      await findRow(page, accountId, r => r.notes === 'keep me');
    });

    test('posts a schedule at the rate of its own date', async () => {
      const accountId = await usdWallet();
      const posted = '2016-12-20';
      rateService.usdRates.set(posted, 27000);
      await page.evaluate(
        async ({ account, date }) => {
          await window.$send('rates-ensure', {
            requests: [{ from: 'USD', to: 'VND', date: '2016-12-17' }],
          });
          await window.$send('schedule/create', {
            schedule: { posts_transaction: true, name: 'Rent' },
            conditions: [
              { op: 'is', field: 'account', value: account },
              { op: 'is', field: 'date', value: date },
              { op: 'is', field: 'amount', value: -5000 },
            ],
          });
          await window.$send('schedule/force-run-service');
        },
        { account: accountId, date: posted },
      );

      const row = await findRow(page, accountId, r => r.date === posted);
      expect(row).toMatchObject({
        native_amount: -5000,
        amount: -5000 * 27000,
      });
    });

    test('locks the budget currency while a foreign account exists', async () => {
      await usdWallet();

      await page.goto('/settings/experimental');
      await expect(page.locator('#settings-flag-currency')).toBeDisabled();
      await expect(page.locator('#settings-flag-multiCurrency')).toBeDisabled();

      await page.goto('/settings/general');
      await expect(
        page.getByText('The currency of the budget cannot change'),
      ).toBeVisible();
    });
  });

  test('turns the features on and hides the decimals of VND', async () => {
    await page.goto('/');
    await new ConfigurationPage(page).createTestFile();

    await page.goto('/settings/experimental');
    await page.locator('#settings-flag-currency').click();
    await page.locator('#settings-flag-multiCurrency').click();
    await expect
      .poll(() =>
        page.evaluate(
          async () =>
            (await window.$send('preferences/get'))['flags.multiCurrency'],
        ),
      )
      .toBe('true');

    await page.goto('/settings/general');
    await page.getByRole('button', { name: 'None', exact: true }).click();
    await page.getByText(/^VND - /).click();

    await expect(page.locator('#settings-exchangeRateDownload')).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(
          async () => (await window.$send('preferences/get')).hideFraction,
        ),
      )
      .toBe('true');
  });

  test('shows and stores VND with no decimals in a USD budget', async () => {
    await openBudget(page, { baseCurrency: 'USD' });
    const accountId = await addForeignAccount(page, {
      name: 'VND Bank',
      currencyLabel: /^VND - /,
      balance: '15000000',
    });
    await expect(page.getByTestId('account-balance')).toContainText(
      '15,000,000',
    );
    await expect(page.getByTestId('account-balance')).not.toContainText('.00');

    await addUsdRow({ notes: 'pho', debit: '50000' });

    const row = await findRow(page, accountId, r => r.notes === 'pho');
    expect(row?.native_amount).toBe(-5000000);
  });
});
