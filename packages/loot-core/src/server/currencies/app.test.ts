import * as db from '#server/db';
// The handlers come from the main module, as in the app. Some server
// modules import each other in a circle and only load in that order.
import { handlers } from '#server/main';

import { saveRates } from './rates';

// The tests run with a fixed clock, so today is 2017-01-01
const DAY = '2016-12-10';

const ensureForAccount = handlers['rates-ensure-for-account'];

beforeEach(global.emptyDatabase());
beforeEach(async () => {
  await db.update('preferences', { id: 'defaultCurrencyCode', value: 'VND' });
  await db.insertAccount({ id: 'cash', name: 'cash' });
  await db.insertAccount({ id: 'wise-usd', name: 'wise-usd', currency: 'USD' });
  await saveRates({
    rates: [{ from: 'USD', to: 'VND', date: DAY, rate: 25000 }],
    source: 'manual',
  });
});

describe('rates-ensure-for-account', () => {
  it('reports the dates with no rate for a foreign currency account', async () => {
    // The budget has no rate provider, so nothing is downloaded
    expect(
      await ensureForAccount({
        accountId: 'wise-usd',
        dates: [DAY, '2016-06-01'],
      }),
    ).toEqual({ missing: [{ from: 'USD', to: 'VND', date: '2016-06-01' }] });
  });

  it('needs no rate for an account in the currency of the budget', async () => {
    expect(
      await ensureForAccount({ accountId: 'cash', dates: ['2016-06-01'] }),
    ).toEqual({ missing: [] });
  });

  it('needs no rate for an account that does not exist', async () => {
    expect(
      await ensureForAccount({ accountId: 'nothing', dates: ['2016-06-01'] }),
    ).toEqual({ missing: [] });
  });
});
