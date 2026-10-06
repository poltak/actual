// @ts-strict-ignore
import * as db from '#server/db';

import * as transfer from './transfer';

beforeEach(global.emptyDatabase());

async function prepareDatabase() {
  await db.insertAccount({ id: 'one', name: 'one' });
  await db.insertAccount({ id: 'two', name: 'two' });
  await db.insertPayee({ name: '', transfer_acct: 'one' });
  await db.insertPayee({ name: '', transfer_acct: 'two' });
}

async function createTransaction(account: string, amount: number, extra = {}) {
  const transaction = {
    id: null,
    account,
    amount,
    payee: await db.insertPayee({ name: 'Non-transfer ' + account }),
    date: '2017-01-01',
    ...extra,
  };
  transaction.id = await db.insertTransaction(transaction);
  return await db.getTransaction(transaction.id);
}

describe('Transfer', () => {
  test('Transfers are properly verified', async () => {
    await prepareDatabase();

    // happy path, two valid transactions
    expect(
      transfer.validForTransfer(
        await createTransaction('one', 5),
        await createTransaction('two', -5),
      ),
    ).toBeTruthy();

    // amount not zeroed out
    expect(
      transfer.validForTransfer(
        await createTransaction('one', 5),
        await createTransaction('two', 5),
      ),
    ).toBeFalsy();

    // amount not match
    expect(
      transfer.validForTransfer(
        await createTransaction('one', 5),
        await createTransaction('two', -6),
      ),
    ).toBeFalsy();

    // accounts match
    expect(
      transfer.validForTransfer(
        await createTransaction('one', 5),
        await createTransaction('one', -5),
      ),
    ).toBeFalsy();

    // one already a transfer
    const existingTransfer = await createTransaction('one', 5);
    expect(
      transfer.validForTransfer(
        await createTransaction('one', 5),
        await createTransaction('two', -5, {
          transfer_id: existingTransfer.id,
        }),
      ),
    ).toBeFalsy();
  });

  test('Transfers between currencies are verified by the amounts of the accounts', async () => {
    const usdOut = { id: 'a', account: 'usd', date: '2017-01-01' };
    const vndIn = { id: 'b', account: 'vnd', date: '2017-01-01' };

    // 10.00 USD left, 250,000.00 VND arrived. The base values differ,
    // because each row was converted on its own.
    expect(
      transfer.validForTransfer(
        { ...usdOut, amount: -25480000, native_amount: -1000 },
        { ...vndIn, amount: 25000000, native_amount: 25000000 },
        { fromCurrency: 'USD', toCurrency: null },
      ),
    ).toBeTruthy();

    // the two rows go in the same direction
    expect(
      transfer.validForTransfer(
        { ...usdOut, amount: -25480000, native_amount: -1000 },
        { ...vndIn, amount: -25000000, native_amount: -25000000 },
        { fromCurrency: 'USD', toCurrency: null },
      ),
    ).toBeFalsy();

    // two accounts in the same foreign currency must zero each other
    // out in that currency, also when the base values differ
    const usdIn = { id: 'c', account: 'usd-2', date: '2017-01-02' };
    expect(
      transfer.validForTransfer(
        { ...usdOut, amount: -25000000, native_amount: -1000 },
        { ...usdIn, amount: 25100000, native_amount: 1000 },
        { fromCurrency: 'USD', toCurrency: 'USD' },
      ),
    ).toBeTruthy();
    expect(
      transfer.validForTransfer(
        { ...usdOut, amount: -25000000, native_amount: -1000 },
        { ...usdIn, amount: 25000000, native_amount: 996 },
        { fromCurrency: 'USD', toCurrency: 'USD' },
      ),
    ).toBeFalsy();
  });
});
