import { v4 as uuidv4 } from 'uuid';

import * as db from '#server/db';
import { batchUpdateTransactions } from '#server/transactions';
import { convertAmount } from '#shared/currency-conversion';
import * as monthUtils from '#shared/months';
import type { IntegerAmount } from '#shared/util';
import type {
  AccountEntity,
  CategoryEntity,
  TransactionEntity,
} from '#types/models';

import { getBaseCurrency, isForeignCurrency } from './base-currency';
import { MissingRateError } from './plan';
import { getStoredRate } from './rates';
import type { StoredRate } from './rates';

export type AccountMarketValue = {
  // Null for an account in the currency of the budget
  currency: string | null;
  baseCurrency: string | null;
  // The balance in the currency of the account
  balance: IntegerAmount;
  // The sum of the base values that the transactions store. Each one
  // has the rate of its own date.
  storedValue: IntegerAmount;
  // The balance at the rate of today, in the base currency. Null when
  // no rate is stored for today or for the 7 days around it.
  marketValue: IntegerAmount | null;
  // The market value minus the stored value. This is the exchange gain
  // or loss that no transaction shows yet.
  difference: IntegerAmount | null;
  // The rate that gave the market value
  rate: StoredRate | null;
};

/**
 * Compares what the balance of an account is worth today with the value
 * that its transactions store.
 *
 * The two numbers are different for a foreign currency account, because
 * each transaction keeps the base value of its date. For an account in
 * the base currency they are always equal.
 */
export async function getAccountMarketValue({
  id,
}: {
  id: AccountEntity['id'];
}): Promise<AccountMarketValue> {
  const account = await db.first<Pick<db.DbAccount, 'id' | 'currency'>>(
    'SELECT id, currency FROM accounts WHERE id = ? AND tombstone = 0',
    [id],
  );
  if (!account) {
    throw new Error('Account not found: ' + id);
  }

  const sums = await db.first<{
    balance: number | null;
    storedValue: number | null;
  }>(
    `SELECT sum(IFNULL(native_amount, amount)) as balance, sum(amount) as storedValue
       FROM transactions WHERE acct = ? AND isParent = 0 AND tombstone = 0`,
    [id],
  );
  const balance = sums?.balance ?? 0;
  const storedValue = sums?.storedValue ?? 0;

  const baseCurrency = await getBaseCurrency();
  const { currency } = account;
  if (
    !currency ||
    baseCurrency == null ||
    !isForeignCurrency({ currency, baseCurrency })
  ) {
    return {
      currency: null,
      baseCurrency,
      balance,
      storedValue,
      marketValue: storedValue,
      difference: 0,
      rate: null,
    };
  }

  const rate = await getStoredRate({
    from: currency,
    to: baseCurrency,
    date: monthUtils.currentDay(),
  });
  if (!rate) {
    return {
      currency,
      baseCurrency,
      balance,
      storedValue,
      marketValue: null,
      difference: null,
      rate: null,
    };
  }

  const marketValue = convertAmount({
    amount: balance,
    rate: rate.rate,
    fromCurrency: currency,
    toCurrency: baseCurrency,
  });
  return {
    currency,
    baseCurrency,
    balance,
    storedValue,
    marketValue,
    difference: marketValue - storedValue,
    rate,
  };
}

/**
 * Books the exchange gain or loss of a foreign currency account as one
 * transaction, so that the stored value of the account becomes equal to
 * its market value.
 *
 * The transaction has a native amount of zero, so the balance in the
 * currency of the account stays as it is. Its base value is locked,
 * because no rate can give it.
 *
 * Returns the id of the new transaction, or null when the two values
 * are already equal.
 */
export async function revalueAccount({
  id,
  category = null,
  notes = null,
}: {
  id: AccountEntity['id'];
  category?: CategoryEntity['id'] | null;
  // The caller translates the text
  notes?: string | null;
}): Promise<TransactionEntity['id'] | null> {
  const value = await getAccountMarketValue({ id });
  if (value.currency == null || value.baseCurrency == null) {
    return null;
  }

  const date = monthUtils.currentDay();
  if (value.difference == null) {
    throw new MissingRateError({
      from: value.currency,
      to: value.baseCurrency,
      date,
    });
  }
  if (value.difference === 0) {
    return null;
  }

  const transactionId = uuidv4();
  await batchUpdateTransactions({
    added: [
      {
        id: transactionId,
        account: id,
        date,
        amount: value.difference,
        native_amount: 0,
        amount_locked: true,
        cleared: true,
        category: category ?? undefined,
        notes: notes ?? undefined,
      },
    ],
    amountSemantics: 'explicit',
  });
  return transactionId;
}
