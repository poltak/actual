import * as db from '#server/db';
// The handlers come from the main module, as in the app. Some server
// modules import each other in a circle and only load in that order.
import { handlers } from '#server/main';
import { batchUpdateTransactions } from '#server/transactions';

import { MissingRateError } from './plan';
import { saveRates } from './rates';

// The budget is in VND, stored times 100. The tests run with a fixed
// clock, so today is 2017-01-01.
const TODAY = '2017-01-01';
const PAY_DAY = '2016-06-01';
const SPEND_DAY = '2016-09-01';

const getMarketValue = handlers['account-market-value'];
const revalue = handlers['account-revalue'];

type Row = {
  id: string;
  amount: number;
  native_amount: number | null;
  amount_locked: number | null;
  date: number;
  notes: string | null;
  category: string | null;
  cleared: number;
};

function transactionsOf(account: string) {
  return db.all<Row>(
    `SELECT id, amount, native_amount, amount_locked, date, notes, category, cleared
       FROM transactions WHERE acct = ? AND tombstone = 0 ORDER BY date, id`,
    [account],
  );
}

beforeEach(global.emptyDatabase());
beforeEach(async () => {
  await db.update('preferences', { id: 'defaultCurrencyCode', value: 'VND' });
  await db.insertAccount({ id: 'cash', name: 'cash' });
  await db.insertAccount({ id: 'wise-usd', name: 'wise-usd', currency: 'USD' });
  await saveRates({
    rates: [
      { from: 'USD', to: 'VND', date: PAY_DAY, rate: 20000 },
      { from: 'USD', to: 'VND', date: SPEND_DAY, rate: 22000 },
    ],
    source: 'manual',
  });
});

async function useRateOfToday(rate: number) {
  await saveRates({
    rates: [{ from: 'USD', to: 'VND', date: TODAY, rate }],
    source: 'manual',
  });
}

// 100.00 USD arrives when one USD is 20,000 VND
async function addSalary() {
  await batchUpdateTransactions({
    added: [{ id: 'pay', account: 'wise-usd', date: PAY_DAY, amount: 10000 }],
  });
}

describe('account-market-value', () => {
  it('compares the balance at the rate of today with the stored value', async () => {
    await addSalary();
    await useRateOfToday(25000);

    expect(await getMarketValue({ id: 'wise-usd' })).toEqual({
      currency: 'USD',
      baseCurrency: 'VND',
      balance: 10000,
      storedValue: 200000000,
      marketValue: 250000000,
      difference: 50000000,
      rate: expect.objectContaining({ rate: 25000, date: TODAY }),
    });
  });

  it('gives no market value while no rate of today is stored', async () => {
    await addSalary();

    expect(await getMarketValue({ id: 'wise-usd' })).toEqual({
      currency: 'USD',
      baseCurrency: 'VND',
      balance: 10000,
      storedValue: 200000000,
      marketValue: null,
      difference: null,
      rate: null,
    });
  });

  it('has no difference for an account in the currency of the budget', async () => {
    await batchUpdateTransactions({
      added: [{ id: 'c1', account: 'cash', date: PAY_DAY, amount: 700000 }],
    });

    expect(await getMarketValue({ id: 'cash' })).toEqual({
      currency: null,
      baseCurrency: 'VND',
      balance: 700000,
      storedValue: 700000,
      marketValue: 700000,
      difference: 0,
      rate: null,
    });
  });

  it('refuses an account that does not exist', async () => {
    await expect(getMarketValue({ id: 'nothing' })).rejects.toThrow(
      'Account not found',
    );
  });
});

describe('account-revalue', () => {
  it('books the difference and leaves the balance of the account', async () => {
    await addSalary();
    await useRateOfToday(25000);

    const id = await revalue({ id: 'wise-usd', notes: 'Exchange difference' });

    expect(await transactionsOf('wise-usd')).toEqual([
      expect.objectContaining({ id: 'pay', amount: 200000000 }),
      {
        id,
        amount: 50000000,
        native_amount: 0,
        amount_locked: 1,
        date: db.toDateRepr(TODAY),
        notes: 'Exchange difference',
        category: null,
        cleared: 1,
      },
    ]);
    expect(await getMarketValue({ id: 'wise-usd' })).toMatchObject({
      balance: 10000,
      storedValue: 250000000,
      marketValue: 250000000,
      difference: 0,
    });
  });

  it('does nothing when the two values are equal', async () => {
    await addSalary();
    await useRateOfToday(25000);
    await revalue({ id: 'wise-usd' });

    expect(await revalue({ id: 'wise-usd' })).toBeNull();
    expect(await transactionsOf('wise-usd')).toHaveLength(2);
  });

  it('books a loss with a category', async () => {
    await addSalary();
    await useRateOfToday(18000);
    const groupId = await db.insertCategoryGroup({ name: 'Bills' });
    const category = await db.insertCategory({
      name: 'Exchange',
      cat_group: groupId,
    });

    const id = await revalue({ id: 'wise-usd', category });

    expect(await transactionsOf('wise-usd')).toContainEqual(
      expect.objectContaining({ id, amount: -20000000, category }),
    );
  });

  it('clears the value that stays in an account with a balance of zero', async () => {
    await addSalary();
    // All of the money leaves at a better rate, so the stored values of
    // the two rows do not sum to zero
    await batchUpdateTransactions({
      added: [
        { id: 'spend', account: 'wise-usd', date: SPEND_DAY, amount: -10000 },
      ],
    });
    await useRateOfToday(25000);
    expect(await getMarketValue({ id: 'wise-usd' })).toMatchObject({
      balance: 0,
      storedValue: -20000000,
      marketValue: 0,
      difference: 20000000,
    });

    await revalue({ id: 'wise-usd' });

    expect(await getMarketValue({ id: 'wise-usd' })).toMatchObject({
      balance: 0,
      storedValue: 0,
      difference: 0,
    });
  });

  it('needs a rate of today', async () => {
    await addSalary();

    await expect(revalue({ id: 'wise-usd' })).rejects.toBeInstanceOf(
      MissingRateError,
    );
    expect(await transactionsOf('wise-usd')).toHaveLength(1);
  });

  it('does nothing for an account in the currency of the budget', async () => {
    await batchUpdateTransactions({
      added: [{ id: 'c1', account: 'cash', date: PAY_DAY, amount: 700000 }],
    });

    expect(await revalue({ id: 'cash' })).toBeNull();
    expect(await transactionsOf('cash')).toHaveLength(1);
  });
});
