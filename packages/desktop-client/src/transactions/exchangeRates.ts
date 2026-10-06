import { send } from '@actual-app/core/platform/client/connection';
import type { AccountEntity } from '@actual-app/core/types/models';
import { t } from 'i18next';

import { addNotification } from '#notifications/notificationsSlice';
import type { AppDispatch } from '#redux/store';

import type { RateRequest } from './accountCurrencyView';

function notifyMissingRate(dispatch: AppDispatch, missing: RateRequest[]) {
  const { from, date } = missing[0];
  dispatch(
    addNotification({
      notification: {
        type: 'error',
        message: t(
          'No exchange rate for {{currency}} on {{date}} is available, so the transaction was not saved. Turn on "Download exchange rates" in the settings.',
          { currency: from, date },
        ),
      },
    }),
  );
}

/**
 * Gets the exchange rates that a save needs. The server cannot wait for
 * a download while it saves, so a screen calls this first.
 *
 * Gives false and shows a message when a rate is not available. The
 * save must stop then.
 */
export async function ensureRatesOrNotify({
  requests,
  dispatch,
}: {
  requests: RateRequest[];
  dispatch: AppDispatch;
}): Promise<boolean> {
  if (requests.length === 0) {
    return true;
  }

  const { missing } = await send('rates-ensure', { requests });
  if (missing.length > 0) {
    notifyMissingRate(dispatch, missing);
    return false;
  }
  return true;
}

/**
 * The same for a screen that has an account and some dates. An account
 * in the currency of the budget needs no rate.
 */
export async function ensureAccountRatesOrNotify({
  accountId,
  dates,
  dispatch,
}: {
  accountId: AccountEntity['id'];
  dates: string[];
  dispatch: AppDispatch;
}): Promise<boolean> {
  const { missing } = await send('rates-ensure-for-account', {
    accountId,
    dates,
  });
  if (missing.length > 0) {
    notifyMissingRate(dispatch, missing);
    return false;
  }
  return true;
}
