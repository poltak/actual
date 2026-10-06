import { MissingRateError } from '#server/currencies/plan';
import { saveRates } from '#server/currencies/rates';
import * as db from '#server/db';
// The handlers come from the main module, as in the app. Some server
// modules import each other in a circle and only load in that order.
import { handlers } from '#server/main';
import * as prefs from '#server/prefs';

// The tests run with a fixed clock, so today is 2017-01-01. The budget
// is in VND, stored times 100, and one USD is 25,000 VND.
const TODAY = '2017-01-01';

const createAccount = handlers['account-create'];
const closeAccount = handlers['account-close'];
const getAccounts = handlers['accounts-get'];
const getBalance = handlers['account-balance'];
const getProperties = handlers['account-properties'];
const savePref = handlers['preferences/save'];

type Row = {
  acct: string;
  amount: number;
  native_amount: number | null;
  starting_balance_flag: number;
};

function transactionsOf(account: string) {
  return db.all<Row>(
    `SELECT acct, amount, native_amount, starting_balance_flag
       FROM transactions WHERE acct = ? AND tombstone = 0`,
    [account],
  );
}

async function accountCount() {
  const rows = await db.all<{ id: string }>(
    'SELECT id FROM accounts WHERE tombstone = 0',
  );
  return rows.length;
}

async function useVndBudget() {
  await db.update('preferences', { id: 'defaultCurrencyCode', value: 'VND' });
  await saveRates({
    rates: [{ from: 'USD', to: 'VND', date: TODAY, rate: 25000 }],
    source: 'manual',
  });
}

beforeEach(global.emptyDatabase());

describe('account-create with a currency', () => {
  it('stores the currency and converts the starting balance', async () => {
    await useVndBudget();

    const id = await createAccount({
      name: 'Wise USD',
      balance: 123.45,
      currency: 'USD',
    });

    expect(await getAccounts()).toEqual([
      expect.objectContaining({ id, name: 'Wise USD', currency: 'USD' }),
    ]);
    expect(await transactionsOf(id)).toEqual([
      {
        acct: id,
        amount: 308625000,
        native_amount: 12345,
        starting_balance_flag: 1,
      },
    ]);
  });

  it('stores no currency for an account in the currency of the budget', async () => {
    await useVndBudget();

    const explicit = await createAccount({
      name: 'Bank',
      balance: 5000000,
      currency: 'VND',
    });
    const implicit = await createAccount({ name: 'Cash', balance: 100000 });

    const accounts = await getAccounts();
    expect(accounts.map(account => account.currency)).toEqual([null, null]);
    expect(await transactionsOf(explicit)).toEqual([
      expect.objectContaining({ amount: 500000000, native_amount: null }),
    ]);
    expect(await transactionsOf(implicit)).toEqual([
      expect.objectContaining({ amount: 10000000, native_amount: null }),
    ]);
  });

  it('needs a currency for the budget first', async () => {
    await expect(
      createAccount({ name: 'Wise USD', currency: 'USD' }),
    ).rejects.toThrow('Select the currency of the budget');
    expect(await accountCount()).toBe(0);
  });

  it('refuses a currency that is not in the list', async () => {
    await useVndBudget();

    await expect(
      createAccount({ name: 'Mystery', currency: 'XYZ' }),
    ).rejects.toThrow('Unknown currency: XYZ');
    expect(await accountCount()).toBe(0);
  });

  it('makes no account when the starting balance needs a rate that is not stored', async () => {
    await db.update('preferences', { id: 'defaultCurrencyCode', value: 'VND' });

    await expect(
      createAccount({ name: 'Wise USD', balance: 10, currency: 'USD' }),
    ).rejects.toBeInstanceOf(MissingRateError);
    expect(await accountCount()).toBe(0);

    // With no balance, no rate is necessary
    await createAccount({ name: 'Wise USD', currency: 'USD' });
    expect(await accountCount()).toBe(1);
  });
});

describe('the balance of a foreign currency account', () => {
  it('is in the currency of the account, with its stored value next to it', async () => {
    await useVndBudget();
    const usd = await createAccount({
      name: 'Wise USD',
      balance: 100,
      currency: 'USD',
    });
    const cash = await createAccount({ name: 'Cash', balance: 300000 });

    expect(await getBalance({ id: usd, cutoff: TODAY })).toBe(10000);
    expect(await getProperties({ id: usd })).toEqual({
      balance: 10000,
      baseBalance: 250000000,
      numTransactions: 1,
    });

    expect(await getBalance({ id: cash, cutoff: TODAY })).toBe(30000000);
    expect(await getProperties({ id: cash })).toEqual({
      balance: 30000000,
      baseBalance: 30000000,
      numTransactions: 1,
    });
  });
});

describe('account-close for a foreign currency account', () => {
  it('moves the balance and its stored value to the other account', async () => {
    await useVndBudget();
    const usd = await createAccount({
      name: 'Wise USD',
      balance: 100,
      currency: 'USD',
    });
    const bank = await createAccount({ name: 'Bank' });
    // The stored value is not the balance times the rate of today
    const added = await handlers['transaction-add']({
      id: 'gift',
      account: usd,
      native_amount: 5000,
      amount: 130000000,
      date: TODAY,
    });
    expect(added).toBeDefined();
    expect(await getProperties({ id: usd })).toMatchObject({
      balance: 15000,
      baseBalance: 380000000,
    });

    await closeAccount({ id: usd, transferAccountId: bank });

    expect(await getProperties({ id: usd })).toMatchObject({
      balance: 0,
      baseBalance: 0,
    });
    expect(await transactionsOf(bank)).toEqual([
      expect.objectContaining({ amount: 380000000, native_amount: null }),
    ]);
  });
});

describe('the currency of the budget', () => {
  it('cannot change while an account has a different currency', async () => {
    await useVndBudget();
    await createAccount({ name: 'Wise USD', currency: 'USD' });

    await expect(
      savePref({ id: 'defaultCurrencyCode', value: 'EUR' }),
    ).rejects.toThrow(
      'cannot change while an account has a different currency',
    );
    await expect(
      savePref({ id: 'defaultCurrencyCode', value: '' }),
    ).rejects.toThrow('cannot change');

    // The same value is not a change
    await savePref({ id: 'defaultCurrencyCode', value: 'VND' });
  });

  it('can change while all accounts are in the currency of the budget', async () => {
    await useVndBudget();
    await createAccount({ name: 'Cash' });

    await savePref({ id: 'defaultCurrencyCode', value: 'EUR' });

    const row = await db.first<{ value: string }>(
      "SELECT value FROM preferences WHERE id = 'defaultCurrencyCode'",
    );
    expect(row?.value).toBe('EUR');
  });
});

describe('the API for accounts', () => {
  beforeEach(async () => {
    await prefs.loadPrefs();
  });

  it('takes a currency at creation, returns it, and does not let it change', async () => {
    await useVndBudget();

    const id = await handlers['api/account-create']({
      account: { name: 'Wise USD', currency: 'USD' },
      initialBalance: 12345,
    });

    expect(await handlers['api/accounts-get']()).toEqual([
      expect.objectContaining({ id, name: 'Wise USD', currency: 'USD' }),
    ]);
    expect(await transactionsOf(id)).toEqual([
      expect.objectContaining({ amount: 308625000, native_amount: 12345 }),
    ]);

    await expect(
      handlers['api/account-update']({ id, fields: { currency: 'EUR' } }),
    ).rejects.toThrow('The currency of an account cannot change');
  });
});
