import * as db from '#server/db';
// The handlers come from the main module, as in the app. Some server
// modules import each other in a circle and only load in that order.
import { handlers } from '#server/main';
import * as prefs from '#server/prefs';

// The budget is in VND, stored times 100, and one USD is 25,000 VND. So
// 10.00 USD is 1000 in the account and 25000000 in the budget.
//
// The tests run with a fixed clock, so today is 2017-01-01.
const TODAY = '2017-01-01';
const DAY = '2016-12-10';

type Row = {
  id: string;
  amount: number;
  native_amount: number | null;
  amount_locked: number | null;
};

function rowsOf(account: string) {
  return db.all<Row>(
    `SELECT id, amount, native_amount, amount_locked FROM transactions
      WHERE acct = ? AND tombstone = 0 ORDER BY sort_order DESC, id`,
    [account],
  );
}

async function transferPayeeOf(account: string) {
  const payee = await db.first<{ id: string }>(
    'SELECT id FROM payees WHERE transfer_acct = ?',
    [account],
  );
  if (!payee) {
    throw new Error('No transfer payee for ' + account);
  }
  return payee.id;
}

let cash: string;
let usd: string;

beforeEach(global.emptyDatabase());
beforeEach(async () => {
  await prefs.loadPrefs();
  await db.update('preferences', { id: 'defaultCurrencyCode', value: 'VND' });
  await handlers['api/exchange-rates-save']({
    rates: [
      { from: 'USD', to: 'VND', date: DAY, rate: 25000 },
      { from: 'USD', to: 'VND', date: TODAY, rate: 26000 },
    ],
  });
  cash = await handlers['api/account-create']({ account: { name: 'Cash' } });
  usd = await handlers['api/account-create']({
    account: { name: 'Wise USD', currency: 'USD' },
  });
});

describe('the API for exchange rates', () => {
  it('stores rates and reads them', async () => {
    expect(
      await handlers['api/exchange-rate-get']({
        from: 'USD',
        to: 'VND',
        date: DAY,
      }),
    ).toEqual({ rate: 25000, date: DAY, isExactDate: true, source: 'manual' });

    // The nearest rate within 7 days
    expect(
      await handlers['api/exchange-rate-get']({
        from: 'USD',
        to: 'VND',
        date: '2016-12-12',
      }),
    ).toMatchObject({ rate: 25000, date: DAY, isExactDate: false });

    expect(
      await handlers['api/exchange-rate-get']({
        from: 'USD',
        to: 'VND',
        date: '2016-06-01',
      }),
    ).toBeNull();
  });

  it('reports the rates that are not there', async () => {
    const stored = { from: 'USD', to: 'VND', date: DAY };
    const absent = { from: 'USD', to: 'VND', date: '2016-06-01' };

    // The budget has no rate provider, so nothing is downloaded
    expect(
      await handlers['api/exchange-rates-ensure']({
        requests: [stored, absent],
      }),
    ).toEqual({ missing: [absent] });
  });

  it('refuses a rate that cannot be right', async () => {
    const save = handlers['api/exchange-rates-save'];
    const good = { from: 'USD', to: 'VND', date: DAY, rate: 25000 };

    await expect(save({ rates: [{ ...good, from: 'XYZ' }] })).rejects.toThrow(
      'Unknown currency',
    );
    await expect(save({ rates: [{ ...good, to: 'USD' }] })).rejects.toThrow(
      'two different currencies',
    );
    await expect(
      save({ rates: [{ ...good, date: '10/12/2016' }] }),
    ).rejects.toThrow('Invalid date format');
    await expect(save({ rates: [{ ...good, rate: 0 }] })).rejects.toThrow(
      'positive number',
    );
  });
});

describe('api/transactions-add for a foreign currency account', () => {
  it('reads a lone amount in the currency of the account', async () => {
    await handlers['api/transactions-add']({
      accountId: usd,
      transactions: [{ date: DAY, amount: -1000 }],
    });

    expect(await rowsOf(usd)).toEqual([
      expect.objectContaining({ amount: -25000000, native_amount: -1000 }),
    ]);
  });

  it('converts a native amount that comes with no amount', async () => {
    await handlers['api/transactions-add']({
      accountId: usd,
      transactions: [{ date: DAY, native_amount: -1000 }],
    });

    expect(await rowsOf(usd)).toEqual([
      expect.objectContaining({
        amount: -25000000,
        native_amount: -1000,
        amount_locked: null,
      }),
    ]);
  });

  it('keeps the value in the base currency that comes with a native amount', async () => {
    await handlers['api/transactions-add']({
      accountId: usd,
      transactions: [{ date: DAY, amount: -25505300, native_amount: -1000 }],
    });

    expect(await rowsOf(usd)).toEqual([
      expect.objectContaining({
        amount: -25505300,
        native_amount: -1000,
        amount_locked: 1,
      }),
    ]);
  });

  it('makes a transfer between two currencies with the two real amounts', async () => {
    await handlers['api/transactions-add']({
      accountId: cash,
      transactions: [
        {
          date: DAY,
          amount: -25505300,
          payee: await transferPayeeOf(usd),
          _transfer_native_amount: 1000,
        },
      ],
      runTransfers: true,
    });

    expect(await rowsOf(cash)).toEqual([
      expect.objectContaining({ amount: -25505300, native_amount: null }),
    ]);
    expect(await rowsOf(usd)).toEqual([
      expect.objectContaining({ amount: 25505300, native_amount: 1000 }),
    ]);
  });
});

describe('api/transactions-get', () => {
  it('returns the two amounts of each transaction', async () => {
    await handlers['api/transactions-add']({
      accountId: usd,
      transactions: [{ date: DAY, amount: -1000 }],
    });
    await handlers['api/transactions-add']({
      accountId: cash,
      transactions: [{ date: DAY, amount: -700000 }],
    });

    expect(await handlers['api/transactions-get']({ accountId: usd })).toEqual([
      expect.objectContaining({ amount: -25000000, native_amount: -1000 }),
    ]);
    // For the currency of the budget, the two amounts are equal
    expect(await handlers['api/transactions-get']({ accountId: cash })).toEqual(
      [expect.objectContaining({ amount: -700000, native_amount: -700000 })],
    );
  });
});

describe('api/transaction-update for a foreign currency account', () => {
  let id: string;

  beforeEach(async () => {
    await handlers['api/transactions-add']({
      accountId: usd,
      transactions: [{ date: DAY, amount: -1000 }],
    });
    [{ id }] = await rowsOf(usd);
  });

  it('refuses an amount with no native amount, and writes nothing', async () => {
    await expect(
      handlers['api/transaction-update']({ id, fields: { amount: -2000 } }),
    ).rejects.toThrow('Send `native_amount`');

    expect(await rowsOf(usd)).toEqual([
      expect.objectContaining({ amount: -25000000, native_amount: -1000 }),
    ]);
  });

  it('accepts the amount that the transaction already has', async () => {
    await handlers['api/transaction-update']({
      id,
      fields: { amount: -25000000, notes: 'same' },
    });

    expect(await rowsOf(usd)).toEqual([
      expect.objectContaining({ amount: -25000000, native_amount: -1000 }),
    ]);
  });

  it('converts a new native amount', async () => {
    await handlers['api/transaction-update']({
      id,
      fields: { native_amount: -2000 },
    });

    expect(await rowsOf(usd)).toEqual([
      expect.objectContaining({
        amount: -50000000,
        native_amount: -2000,
        amount_locked: null,
      }),
    ]);
  });

  it('keeps a value in the base currency that comes with the native amount', async () => {
    await handlers['api/transaction-update']({
      id,
      fields: { native_amount: -2000, amount: -51000000 },
    });

    expect(await rowsOf(usd)).toEqual([
      expect.objectContaining({
        amount: -51000000,
        native_amount: -2000,
        amount_locked: 1,
      }),
    ]);
  });

  it('passes a missing rate on to the caller', async () => {
    await expect(
      handlers['api/transaction-update']({
        id,
        fields: { native_amount: -2000, date: '2016-06-01' },
      }),
    ).rejects.toThrow('No exchange rate from USD to VND for 2016-06-01');
  });

  it('takes a lone amount for an account in the currency of the budget', async () => {
    await handlers['api/transactions-add']({
      accountId: cash,
      transactions: [{ date: DAY, amount: -700000 }],
    });
    const [{ id: cashId }] = await rowsOf(cash);

    await handlers['api/transaction-update']({
      id: cashId,
      fields: { amount: -800000 },
    });

    expect(await rowsOf(cash)).toEqual([
      expect.objectContaining({ amount: -800000, native_amount: null }),
    ]);
  });
});

describe('the API for the market value of an account', () => {
  it('reads the market value and books the difference', async () => {
    await handlers['api/transactions-add']({
      accountId: usd,
      transactions: [{ date: DAY, amount: 10000 }],
    });

    expect(await handlers['api/account-market-value']({ id: usd })).toEqual({
      currency: 'USD',
      baseCurrency: 'VND',
      balance: 10000,
      storedValue: 250000000,
      marketValue: 260000000,
      difference: 10000000,
      rate: expect.objectContaining({ rate: 26000, date: TODAY }),
    });

    const id = await handlers['api/account-revalue']({
      id: usd,
      notes: 'Exchange difference',
    });

    expect(await rowsOf(usd)).toContainEqual({
      id,
      amount: 10000000,
      native_amount: 0,
      amount_locked: 1,
    });
    expect(
      await handlers['api/account-market-value']({ id: usd }),
    ).toMatchObject({ balance: 10000, storedValue: 260000000, difference: 0 });
  });
});
