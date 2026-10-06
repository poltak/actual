// @ts-strict-ignore
import { getForeignCurrencies } from '#server/currencies/base-currency';
import { MissingRateError } from '#server/currencies/plan';
import { getStoredRate } from '#server/currencies/rates';
import * as db from '#server/db';
import { convertAmount } from '#shared/currency-conversion';

import { runRules } from './transaction-rules';

async function getPayee(acct) {
  return db.first<db.DbPayee>('SELECT * FROM payees WHERE transfer_acct = ?', [
    acct,
  ]);
}

async function getTransferredAccount(transaction) {
  if (transaction.payee) {
    const result = await db.first<Pick<db.DbViewPayee, 'transfer_acct'>>(
      'SELECT transfer_acct FROM v_payees WHERE id = ?',
      [transaction.payee],
    );

    return result?.transfer_acct || null;
  }
  return null;
}

async function clearCategory(transaction, transferAcct) {
  const { offbudget: fromOffBudget } = await db.first<
    Pick<db.DbAccount, 'offbudget'>
  >('SELECT offbudget FROM accounts WHERE id = ?', [transaction.account]);
  const { offbudget: toOffBudget } = await db.first<
    Pick<db.DbAccount, 'offbudget'>
  >('SELECT offbudget FROM accounts WHERE id = ?', [transferAcct]);

  // If the transfer is between two on budget or two off budget accounts,
  // we should clear the category, because the category is not relevant
  if (fromOffBudget === toOffBudget) {
    await db.updateTransaction({ id: transaction.id, category: null });
    if (transaction.transfer_id) {
      await db.updateTransaction({
        id: transaction.transfer_id,
        category: null,
      });
    }
    return true;
  }
  return false;
}

// The native amount for the side of a transfer in `targetAccount`.
// `amount` is the base value and the two sides mirror it, but each side
// has its own amount in the currency of its account.
//
// Returns undefined when nothing has to be written.
async function getOtherSideNativeAmount({
  transaction,
  targetAccount,
  given,
  stored,
}: {
  // The side that the caller wrote
  transaction;
  targetAccount: string;
  // The amount in the other account, when the caller knows it
  given?: number | null;
  // The other side as it is in the database, for an update
  stored?: Pick<db.DbTransaction, 'acct' | 'native_amount'> | null;
}): Promise<number | null | undefined> {
  const { baseCurrency, foreignCurrencies } = await getForeignCurrencies();
  const targetCurrency = foreignCurrencies.get(targetAccount) ?? null;

  if (!targetCurrency) {
    // An account in the base currency stores no native amount
    return stored && stored.native_amount != null ? null : undefined;
  }
  if (given != null) {
    return given;
  }

  const sourceCurrency = foreignCurrencies.get(transaction.account) ?? null;
  if (sourceCurrency === targetCurrency) {
    return -(transaction.native_amount ?? transaction.amount) || 0;
  }

  // The amount in a different currency is real money that only the user
  // knows. Keep it while that side stays in the same currency.
  const storedCurrency = stored
    ? (foreignCurrencies.get(stored.acct) ?? null)
    : null;
  if (stored?.native_amount != null && storedCurrency === targetCurrency) {
    return undefined;
  }

  if (transaction.amount === 0) {
    return 0;
  }
  const rate = await getStoredRate({
    from: targetCurrency,
    to: baseCurrency,
    date: transaction.date,
  });
  if (!rate) {
    throw new MissingRateError({
      from: targetCurrency,
      to: baseCurrency,
      date: transaction.date,
    });
  }
  return convertAmount({
    amount: -transaction.amount,
    rate: 1 / rate.rate,
    fromCurrency: baseCurrency,
    toCurrency: targetCurrency,
  });
}

export async function addTransfer(
  transaction,
  transferredAccount,
  { otherSideNativeAmount }: { otherSideNativeAmount?: number | null } = {},
) {
  if (transaction.is_parent) {
    // For split transactions, we should create transfers using child transactions.
    // This is to ensure that the amounts received by the transferred account
    // reflects the amounts in the child transactions and not the parent transaction
    // amount which is the total amount.
    return null;
  }

  const { id: fromPayee } = await db.first<Pick<db.DbPayee, 'id'>>(
    'SELECT id FROM payees WHERE transfer_acct = ?',
    [transaction.account],
  );

  const transferTransaction = {
    account: transferredAccount,
    amount: -transaction.amount,
    payee: fromPayee,
    date: transaction.date,
    transfer_id: transaction.id,
    notes: transaction.notes || null,
    schedule: transaction.schedule,
    cleared: false,
  };
  const nativeAmount = await getOtherSideNativeAmount({
    transaction,
    targetAccount: transferredAccount,
    given: otherSideNativeAmount,
  });
  // With the native amount on the row, the rules see the amount in the
  // currency of the account that gets the transfer
  const { notes, cleared, schedule } = await runRules({
    ...transferTransaction,
    ...(nativeAmount != null && { native_amount: nativeAmount }),
  });
  const matchedSchedule = schedule ?? transaction.schedule;

  const id = await db.insertTransaction({
    ...transferTransaction,
    ...(nativeAmount != null && { native_amount: nativeAmount }),
    notes,
    cleared,
    schedule: matchedSchedule,
  });

  await db.updateTransaction({
    id: transaction.id,
    transfer_id: id,
    ...(matchedSchedule ? { schedule: matchedSchedule } : {}),
  });
  const categoryCleared = await clearCategory(transaction, transferredAccount);

  return {
    id: transaction.id,
    transfer_id: id,
    ...(categoryCleared ? { category: null } : {}),
  };
}

export async function removeTransfer(transaction) {
  const transferTrans = await db.getTransaction(transaction.transfer_id);

  // Perform operations on the transfer transaction only
  // if it is found. For example: when users delete both
  // (in & out) transfer transactions at the same time -
  // transfer transaction will not be found.
  if (transferTrans) {
    if (transferTrans.is_child) {
      // If it's a child transaction, we don't delete it because that
      // would invalidate the whole split transaction. Instead of turn
      // it into a normal transaction
      await db.updateTransaction({
        id: transaction.transfer_id,
        transfer_id: null,
        payee: null,
      });
    } else {
      await db.deleteTransaction({ id: transaction.transfer_id });
    }
  }
  await db.updateTransaction({ id: transaction.id, transfer_id: null });
  return { id: transaction.id, transfer_id: null };
}

export async function updateTransfer(transaction, transferredAccount) {
  const payee = await getPayee(transaction.account);
  const stored = await db.first<
    Pick<db.DbTransaction, 'acct' | 'native_amount'>
  >('SELECT acct, native_amount FROM transactions WHERE id = ?', [
    transaction.transfer_id,
  ]);
  const nativeAmount = await getOtherSideNativeAmount({
    transaction,
    targetAccount: transferredAccount,
    stored,
  });

  await db.updateTransaction({
    id: transaction.transfer_id,
    account: transferredAccount,
    // Make sure to update the payee on the other side in case the
    // user moved this transaction into another account
    payee: payee.id,
    notes: transaction.notes,
    amount: -transaction.amount,
    ...(nativeAmount !== undefined && { native_amount: nativeAmount }),
    schedule: transaction.schedule,
  });

  const categoryCleared = await clearCategory(transaction, transferredAccount);
  if (categoryCleared) {
    return { id: transaction.id, category: null };
  }
}

export async function onInsert(
  transaction,
  options: { otherSideNativeAmount?: number | null } = {},
) {
  const transferredAccount = await getTransferredAccount(transaction);

  if (transferredAccount) {
    return addTransfer(transaction, transferredAccount, options);
  }
}

export async function onDelete(transaction) {
  if (transaction.transfer_id) {
    await removeTransfer(transaction);
  }
}

export async function onUpdate(
  transaction,
  options: { otherSideNativeAmount?: number | null } = {},
) {
  const transferredAccount = await getTransferredAccount(transaction);

  if (transaction.is_parent) {
    return removeTransfer(transaction);
  }

  if (transferredAccount && !transaction.transfer_id) {
    return addTransfer(transaction, transferredAccount, options);
  }

  if (!transferredAccount && transaction.transfer_id) {
    return removeTransfer(transaction);
  }

  if (transferredAccount && transaction.transfer_id) {
    return updateTransfer(transaction, transferredAccount);
  }
}
