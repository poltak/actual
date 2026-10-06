import type { TransactionEntity } from '#types/models';

export function validForMerge(
  transactionA: TransactionEntity | undefined,
  transactionB: TransactionEntity | undefined,
) {
  return !validForMergeExplanation(transactionA, transactionB);
}

export function validForMergeExplanation(
  transactionA: TransactionEntity | undefined,
  transactionB: TransactionEntity | undefined,
): string {
  if (!transactionA || !transactionB) {
    return 'One of the provided transactions does not exist';
  }
  if (transactionA.account !== transactionB.account) {
    return 'Cannot merge transactions from different accounts';
  }
  // The two are in the same account, so they compare in its currency. The
  // base values can differ when the two have different dates.
  const amountA = transactionA.native_amount ?? transactionA.amount;
  const amountB = transactionB.native_amount ?? transactionB.amount;
  if (amountA !== amountB) {
    return 'Cannot merge transactions with different amounts';
  }
  // if both transfers, they should both be transferring to the same account to be eligible for merge.
  // In other words, you cannot merge A->B with A->C, but you can merge A->B with A->B
  if (
    transactionA.transfer_id &&
    transactionB.transfer_id &&
    transactionA.payee !== transactionB.payee
  ) {
    return 'Cannot merge transfers to different accounts';
  }
  return '';
}
