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
 * The foreign currency of each account that has one. An account that is
 * not in the map is in the base currency. The map is empty while the
 * budget has no base currency.
 */
export async function getForeignCurrencies(): Promise<{
  baseCurrency: string | null;
  foreignCurrencies: Map<string, string>;
}> {
  const baseCurrency = await getBaseCurrency();
  const foreignCurrencies = new Map<string, string>();
  if (baseCurrency == null) {
    return { baseCurrency, foreignCurrencies };
  }

  const rows = await db.all<Pick<db.DbAccount, 'id' | 'currency'>>(
    'SELECT id, currency FROM accounts WHERE currency IS NOT NULL',
  );
  for (const { id, currency } of rows) {
    if (currency && isForeignCurrency({ currency, baseCurrency })) {
      foreignCurrencies.set(id, currency);
    }
  }
  return { baseCurrency, foreignCurrencies };
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
