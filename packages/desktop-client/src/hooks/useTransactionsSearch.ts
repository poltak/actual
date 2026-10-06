import { useEffect, useMemo, useRef, useState } from 'react';

import type { Query } from '@actual-app/core/shared/query';
import { debounce } from 'es-toolkit/compat';

import * as queries from '#queries';

type UseTransactionsSearchProps = {
  updateQuery: (updateFn: (searchQuery: Query) => Query) => void;
  resetQuery: () => void;
  dateFormat: string;
  delayMs?: number;
  // The currency of the account of the page when it is not the currency
  // of the budget. A number in the search text is then in that currency.
  foreignCurrency?: string | null;
};
type UseTransactionsSearchResult = {
  isSearching: boolean;
  search: (searchText: string) => void;
};

export function useTransactionsSearch({
  updateQuery,
  resetQuery,
  dateFormat,
  delayMs = 150,
  foreignCurrency = null,
}: UseTransactionsSearchProps): UseTransactionsSearchResult {
  const [isSearching, setIsSearching] = useState(false);

  const updateQueryRef = useRef(updateQuery);
  updateQueryRef.current = updateQuery;

  const resetQueryRef = useRef(resetQuery);
  resetQueryRef.current = resetQuery;

  const updateSearchQuery = useMemo(
    () =>
      debounce((searchText: string) => {
        if (searchText === '') {
          resetQueryRef.current?.();
          setIsSearching(false);
        } else if (searchText) {
          resetQueryRef.current?.();
          updateQueryRef.current(previousQuery =>
            queries.transactionsSearch(
              previousQuery,
              searchText,
              dateFormat,
              foreignCurrency,
            ),
          );
          setIsSearching(true);
        }
      }, delayMs),
    [dateFormat, delayMs, foreignCurrency],
  );

  useEffect(() => {
    return () => updateSearchQuery.cancel();
  }, [updateSearchQuery]);

  return {
    isSearching,
    search: updateSearchQuery,
  };
}
