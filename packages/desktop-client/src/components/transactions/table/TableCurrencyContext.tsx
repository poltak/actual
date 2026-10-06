import { createContext, useContext, useMemo } from 'react';
import type { ReactNode } from 'react';

type TableCurrencies = {
  // The currency of the account of this page when it is not the
  // currency of the budget. Null for a page with more than one account
  // and for an account in the currency of the budget.
  pageCurrency: string | null;
  // The currency of an account when it is not the currency of the budget
  foreignCurrencyOf: (accountId: string | null | undefined) => string | null;
};

const TableCurrencyContext = createContext<TableCurrencies>({
  pageCurrency: null,
  foreignCurrencyOf: () => null,
});

type TableCurrencyProviderProps = TableCurrencies & {
  children: ReactNode;
};

/**
 * Tells the rows of a transaction table in which currency their amounts
 * are. The big table file reads this in the few places that format or
 * parse an amount, so it needs no new props through its layers.
 */
export function TableCurrencyProvider({
  pageCurrency,
  foreignCurrencyOf,
  children,
}: TableCurrencyProviderProps) {
  // The same object while the two values are the same, so that the rows
  // of the table do not draw again for no reason
  const value = useMemo(
    () => ({ pageCurrency, foreignCurrencyOf }),
    [pageCurrency, foreignCurrencyOf],
  );

  return (
    <TableCurrencyContext.Provider value={value}>
      {children}
    </TableCurrencyContext.Provider>
  );
}

export function useTableCurrencies(): TableCurrencies {
  return useContext(TableCurrencyContext);
}
