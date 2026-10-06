export type AmountFields = {
  // The dialog has a field for the amount in the account on the other
  // side of a transfer
  hasOtherSideField: boolean;
  // The dialog has a field for the value of the transaction in the
  // currency of the budget
  hasBaseValueField: boolean;
};

/**
 * Decides which amounts of a transaction a person can set by hand in the
 * dialog "Amounts in two currencies".
 *
 * A currency is null for an account in the currency of the budget.
 */
export function getAmountFields({
  currency,
  hasPartner,
  partnerCurrency,
}: {
  // The currency of the account of the transaction
  currency: string | null;
  // True when the transaction is one side of a transfer
  hasPartner: boolean;
  // The currency of the account on the other side of the transfer
  partnerCurrency: string | null;
}): AmountFields {
  const isForeign = currency != null;
  if (!hasPartner) {
    return { hasOtherSideField: false, hasBaseValueField: isForeign };
  }

  return {
    // In one currency, the two sides of a transfer always have the same
    // amount
    hasOtherSideField: currency !== partnerCurrency,
    // When one side is in the currency of the budget, the amount of that
    // side is the value of the transfer. The other-side field sets it,
    // or it is the amount of this transaction.
    hasBaseValueField: isForeign && partnerCurrency != null,
  };
}
