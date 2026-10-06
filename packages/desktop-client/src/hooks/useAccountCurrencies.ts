import { isForeignCurrency } from '@actual-app/core/shared/currencies';
import type { AccountEntity } from '@actual-app/core/types/models';

import { useAccounts } from './useAccounts';
import { useSyncedPref } from './useSyncedPref';

type AccountCurrencies = {
  // The currency of the budget. Empty when the user selected none.
  baseCurrency: string;
  // The currency of an account when it is not the currency of the
  // budget. Null for all other accounts, and for no account.
  foreignCurrencyOf: (
    accountId: AccountEntity['id'] | null | undefined,
  ) => string | null;
  hasForeignAccount: boolean;
  // True until the accounts are loaded
  isPending: boolean;
};

/**
 * Tells a screen which accounts hold a currency that is not the
 * currency of the budget. Such an account shows its amounts in its own
 * currency.
 */
export function useAccountCurrencies(): AccountCurrencies {
  const { data: accounts = [], isPending } = useAccounts();
  const [defaultCurrencyCode] = useSyncedPref('defaultCurrencyCode');
  const baseCurrency = defaultCurrencyCode || '';

  const foreignCurrencies = new Map<string, string>();
  if (baseCurrency !== '') {
    for (const { id, currency } of accounts) {
      if (currency && isForeignCurrency({ currency, baseCurrency })) {
        foreignCurrencies.set(id, currency);
      }
    }
  }

  return {
    baseCurrency,
    foreignCurrencyOf: accountId =>
      (accountId ? foreignCurrencies.get(accountId) : undefined) ?? null,
    hasForeignAccount: foreignCurrencies.size > 0,
    isPending,
  };
}

/**
 * The currency of this account when it is not the currency of the
 * budget. Null for all other accounts, and for no account.
 */
export function useForeignCurrencyOf(
  account: Pick<AccountEntity, 'currency'> | null | undefined,
): string | null {
  const [defaultCurrencyCode] = useSyncedPref('defaultCurrencyCode');
  const baseCurrency = defaultCurrencyCode || '';
  const currency = account?.currency;

  return baseCurrency !== '' &&
    currency &&
    isForeignCurrency({ currency, baseCurrency })
    ? currency
    : null;
}
