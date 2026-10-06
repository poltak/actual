import * as db from '#server/db';

/**
 * The currency of the budget. `transactions.amount` is always in this
 * currency. Null means that the user did not select a currency.
 */
export async function getBaseCurrency(): Promise<string | null> {
  const row = await db.first<Pick<db.DbPreference, 'value'>>(
    "SELECT value FROM preferences WHERE id = 'defaultCurrencyCode'",
  );
  return row?.value ? row.value : null;
}

/**
 * True when an account holds a currency that is not the currency of the
 * budget. An account with no currency is in the base currency.
 */
export function isForeignCurrency({
  currency,
  baseCurrency,
}: {
  currency: string | null | undefined;
  baseCurrency: string | null;
}): boolean {
  return currency != null && currency !== '' && currency !== baseCurrency;
}
