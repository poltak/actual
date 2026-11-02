import type { Page } from '@playwright/test';

import { expect } from './fixtures';
import { ConfigurationPage } from './page-models/configuration-page';

export const USD_TO_VND = 25000;
export const VND_TO_USD = 0.00004;

// The app runs with today pinned to 2017-01-01 in these tests
export const PAST_DATE = '2016-12-15';
export const PAST_DATE_INPUT = '12/15/2016';
export const PAST_RATE = 26000;

type RateRow = { date: string; base: string; quote: string; rate: number };

export type TransactionRow = {
  id: string;
  date: string;
  notes: string | null;
  amount: number;
  native_amount: number | null;
  amount_locked: boolean;
  cleared: boolean;
  is_parent: boolean;
  is_child: boolean;
  transfer_id: string | null;
};

function datesBetween(from: string, to: string) {
  const dates: string[] = [];
  const end = new Date(`${to}T00:00:00Z`);
  for (
    let day = new Date(`${from}T00:00:00Z`);
    day <= end;
    day.setUTCDate(day.getUTCDate() + 1)
  ) {
    dates.push(day.toISOString().slice(0, 10));
  }
  return dates;
}

/**
 * Answers the requests to the rate service, so that no test uses the
 * network. A test can give a date its own USD rate, or stop the answers.
 */
export async function mockRateService(page: Page) {
  const service = {
    usdRates: new Map<string, number>([[PAST_DATE, PAST_RATE]]),
    hasNoRates: false,
  };

  await page.context().route('https://api.frankfurter.dev/**', route => {
    const url = new URL(route.request().url());
    const base = url.searchParams.get('base') ?? '';
    const quote = url.searchParams.get('quotes') ?? '';
    const from = url.searchParams.get('from') ?? '';
    const to = url.searchParams.get('to') ?? from;

    const rows: RateRow[] = service.hasNoRates
      ? []
      : datesBetween(from, to).map(date => ({
          date,
          base,
          quote,
          rate:
            base === 'USD'
              ? (service.usdRates.get(date) ?? USD_TO_VND)
              : VND_TO_USD,
        }));
    return route.fulfill({ json: rows });
  });

  return service;
}

export async function savePrefs(page: Page, prefs: Record<string, string>) {
  await page.evaluate(async entries => {
    for (const [id, value] of entries) {
      await window.$send('preferences/save', { id, value });
    }
  }, Object.entries(prefs));
}

/** Opens a demo budget with the multi-currency features on */
export async function openBudget(
  page: Page,
  { baseCurrency }: { baseCurrency: 'VND' | 'USD' },
) {
  const service = await mockRateService(page);
  await page.goto('/');
  await new ConfigurationPage(page).createTestFile();
  await savePrefs(page, {
    'flags.currency': 'true',
    'flags.multiCurrency': 'true',
    defaultCurrencyCode: baseCurrency,
    exchangeRateProvider: 'frankfurter',
    ...(baseCurrency === 'VND' && {
      hideFraction: 'true',
      numberFormat: 'dot-comma',
    }),
  });
  await page.reload();
  await expect(page.getByTestId('sidebar-add-account')).toBeVisible();
  return service;
}

/** Adds an account with its own currency and stays on its page */
export async function addForeignAccount(
  page: Page,
  {
    name,
    currencyLabel,
    balance,
  }: { name: string; currencyLabel: RegExp; balance: string },
) {
  await page.getByRole('button', { name: 'Add account' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.locator('input[name=name]').fill(name);
  await dialog.getByRole('button', { name: 'Currency:' }).click();
  await page.getByText(currencyLabel).click();
  await dialog.locator('input[name=balance]').fill(balance);
  await dialog.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.getByTestId('account-name')).toHaveText(name);
  return page.url().split('/').pop() ?? '';
}

export async function getRows(page: Page, accountId: string) {
  return page.evaluate(async account => {
    const { data } = await window.$query(
      window
        .$q('transactions')
        .filter({ account })
        .options({ splits: 'all' })
        .select([
          'id',
          'date',
          'notes',
          'amount',
          'native_amount',
          'amount_locked',
          'cleared',
          'is_parent',
          'is_child',
          'transfer_id',
        ]),
    );
    return data as TransactionRow[];
  }, accountId);
}

export async function findRow(
  page: Page,
  accountId: string,
  matches: (row: TransactionRow) => boolean,
) {
  await expect
    .poll(async () => (await getRows(page, accountId)).some(matches))
    .toBe(true);
  const rows = await getRows(page, accountId);
  return rows.find(matches);
}
