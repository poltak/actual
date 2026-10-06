import type { TransactionEntity } from '#types/models';

export function validForTransfer(
  fromTransaction: TransactionEntity,
  toTransaction: TransactionEntity,
  {
    fromCurrency = null,
    toCurrency = null,
  }: {
    // The currency of the account of each transaction. Null means the
    // base currency of the budget.
    fromCurrency?: string | null;
    toCurrency?: string | null;
  } = {},
) {
  // The amount that each account shows
  const fromAmount = fromTransaction.native_amount ?? fromTransaction.amount;
  const toAmount = toTransaction.native_amount ?? toTransaction.amount;

  // Two accounts in the same currency must zero each other out. Between
  // two currencies the two amounts are different numbers, so only the
  // direction can be checked.
  const amountsFit =
    fromCurrency === toCurrency
      ? fromAmount + toAmount === 0
      : fromAmount !== 0 && Math.sign(fromAmount) === -Math.sign(toAmount);

  if (
    // not already a transfer
    [fromTransaction, toTransaction].every(tran => tran.transfer_id == null) &&
    fromTransaction.account !== toTransaction.account && // belong to different accounts
    amountsFit
  ) {
    return true;
  }
  return false;
}
