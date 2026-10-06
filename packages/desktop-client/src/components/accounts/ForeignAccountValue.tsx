import React, { useEffect, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';

import { Button } from '@actual-app/components/button';
import { send } from '@actual-app/core/platform/client/connection';
import { convertAmount } from '@actual-app/core/shared/currency-conversion';
import { currentDay } from '@actual-app/core/shared/months';
import { q } from '@actual-app/core/shared/query';
import type { AccountEntity } from '@actual-app/core/types/models';

import { useSheetValue } from '#hooks/useSheetValue';
import { useSyncedPref } from '#hooks/useSyncedPref';

import { DetailedBalance } from './Balance';

type ForeignAccountValueProps = {
  account: AccountEntity;
  // The currency of the account, which is not the currency of the budget
  currency: string;
  // The page loads its transactions again after the difference is booked
  onBooked?: () => void;
};

/**
 * Shows what a foreign currency account is worth in the currency of the
 * budget.
 *
 * Each transaction keeps the value of its date. So the sum of these
 * values is not the same as the balance at the rate of today, after the
 * rate changes. When the two are different, this shows the two numbers
 * and a button that books the difference as one transaction.
 */
export function ForeignAccountValue({
  account,
  currency,
  onBooked,
}: ForeignAccountValueProps) {
  const { t } = useTranslation();
  const [defaultCurrencyCode] = useSyncedPref('defaultCurrencyCode');
  const baseCurrency = defaultCurrencyCode || '';

  const accountQuery = q('transactions')
    .filter({ account: account.id })
    .options({ splits: 'none' });
  const storedValue =
    useSheetValue<'balance', `balance-query-${string}`>({
      name: `balance-query-${account.id}-stored-value`,
      query: accountQuery.calculate({ $sum: '$amount' }),
    }) ?? 0;
  const balance =
    useSheetValue<'balance', `balance-query-${string}`>({
      name: `balance-query-${account.id}-native`,
      query: accountQuery.calculate({ $sum: '$native_amount' }),
    }) ?? 0;

  const [rate, setRate] = useState<number | null>(null);
  useEffect(() => {
    let isCurrent = true;

    async function loadRateOfToday() {
      const today = currentDay();
      await send('rates-ensure-for-account', {
        accountId: account.id,
        dates: [today],
      });
      const stored = await send('rate-get', {
        from: currency,
        to: baseCurrency,
        date: today,
      });
      if (isCurrent) {
        setRate(stored?.rate ?? null);
      }
    }

    void loadRateOfToday();
    return () => {
      isCurrent = false;
    };
  }, [account.id, currency, baseCurrency]);

  const marketValue =
    rate == null
      ? null
      : convertAmount({
          amount: balance,
          rate,
          fromCurrency: currency,
          toCurrency: baseCurrency,
        });
  const hasDifference = marketValue != null && marketValue !== storedValue;

  const [isBooking, setIsBooking] = useState(false);
  async function onBookDifference() {
    setIsBooking(true);
    try {
      await send('account-revalue', {
        id: account.id,
        notes: t('Exchange rate difference'),
      });
      onBooked?.();
    } finally {
      setIsBooking(false);
    }
  }

  return (
    <>
      <DetailedBalance name={t('Value:')} balance={storedValue} />
      {hasDifference && (
        <>
          <DetailedBalance
            name={t('At the rate of today:')}
            balance={marketValue}
          />
          <Button
            variant="bare"
            isDisabled={isBooking}
            onPress={() => void onBookDifference()}
          >
            <Trans>Book the difference</Trans>
          </Button>
        </>
      )}
    </>
  );
}
