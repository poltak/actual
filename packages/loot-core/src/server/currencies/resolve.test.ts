import { ownsTransferAmount, resolveRowAmounts } from './resolve';
import type { ResolveRowInput, StoredAmounts } from './resolve';

// The budget is in VND. One USD is 25,000 VND, so 10.00 USD is
// 250,000.00 VND. Each integer is in minor units: 1000 and 25000000.
const RATE = 25000;

const usdRow: StoredAmounts = {
  account: 'wise-usd',
  date: '2026-10-01',
  amount: -25000000,
  native_amount: -1000,
  amount_locked: false,
};

function resolveUsd(input: Partial<ResolveRowInput>) {
  return resolveRowAmounts({
    existing: usdRow,
    change: {},
    amountSemantics: 'explicit',
    baseCurrency: 'VND',
    accountCurrency: 'USD',
    rate: RATE,
    ...input,
  });
}

describe('resolveRowAmounts in a base currency account', () => {
  it('stores no native amount for a new row', () => {
    for (const accountCurrency of [null, '', 'VND']) {
      expect(
        resolveRowAmounts({
          existing: null,
          change: { account: 'cash', date: '2026-10-01', amount: -5000000 },
          amountSemantics: 'explicit',
          baseCurrency: 'VND',
          accountCurrency,
          rate: null,
        }),
      ).toEqual({
        ok: true,
        amount: -5000000,
        native_amount: null,
        amount_locked: false,
      });
    }
  });

  it('drops a native amount that a full row brings from the view', () => {
    // The view gives `amount` as `native_amount` for such a row, so a
    // caller that sends the full row back sends the old number there
    expect(
      resolveRowAmounts({
        existing: {
          account: 'cash',
          date: '2026-10-01',
          amount: -5000000,
          native_amount: null,
          amount_locked: false,
        },
        change: { amount: -6000000, native_amount: -5000000 },
        amountSemantics: 'explicit',
        baseCurrency: 'VND',
        accountCurrency: null,
        rate: null,
      }),
    ).toMatchObject({ ok: true, amount: -6000000, native_amount: null });
  });

  it('treats every account as a base currency account while the budget has no currency', () => {
    expect(
      resolveRowAmounts({
        existing: null,
        change: { amount: -1000 },
        amountSemantics: 'explicit',
        baseCurrency: null,
        accountCurrency: 'USD',
        rate: null,
      }),
    ).toEqual({
      ok: true,
      amount: -1000,
      native_amount: null,
      amount_locked: false,
    });
  });

  it('keeps the typed number of a row that moves in from a foreign account', () => {
    expect(
      resolveRowAmounts({
        existing: usdRow,
        change: { account: 'cash' },
        amountSemantics: 'explicit',
        baseCurrency: 'VND',
        accountCurrency: null,
        rate: null,
      }),
    ).toEqual({
      ok: true,
      amount: -1000,
      native_amount: null,
      amount_locked: false,
    });
  });
});

describe('resolveRowAmounts in a foreign currency account', () => {
  it('converts a new row with the stored rate', () => {
    expect(
      resolveUsd({
        existing: null,
        change: {
          account: 'wise-usd',
          date: '2026-10-01',
          native_amount: -1000,
        },
      }),
    ).toEqual({
      ok: true,
      amount: -25000000,
      native_amount: -1000,
      amount_locked: false,
    });
  });

  it('needs a native amount for a new row from a screen', () => {
    expect(
      resolveUsd({
        existing: null,
        change: { account: 'wise-usd', date: '2026-10-01', amount: -1000 },
      }),
    ).toEqual({ ok: false, reason: 'missing-native-amount' });
  });

  it('reads a lone amount as native for a caller that knows no currencies', () => {
    expect(
      resolveUsd({
        existing: null,
        change: { account: 'wise-usd', date: '2026-10-01', amount: -1000 },
        amountSemantics: 'native',
      }),
    ).toEqual({
      ok: true,
      amount: -25000000,
      native_amount: -1000,
      amount_locked: false,
    });

    // The same for an update
    expect(
      resolveUsd({ change: { amount: -1200 }, amountSemantics: 'native' }),
    ).toMatchObject({ amount: -30000000, native_amount: -1200 });
  });

  it('reports a missing rate, but not for a zero amount', () => {
    expect(
      resolveUsd({
        existing: null,
        change: { native_amount: -1000 },
        rate: null,
      }),
    ).toEqual({ ok: false, reason: 'missing-rate' });

    expect(
      resolveUsd({ existing: null, change: { native_amount: 0 }, rate: null }),
    ).toMatchObject({ ok: true, amount: 0, native_amount: 0 });
  });

  it('converts again when only the native amount is in the update', () => {
    // An update holds only the changed fields
    expect(resolveUsd({ change: { native_amount: -1200 } })).toEqual({
      ok: true,
      amount: -30000000,
      native_amount: -1200,
      amount_locked: false,
    });
  });

  it('converts again when the date changes', () => {
    expect(resolveUsd({ change: { date: '2026-10-02' }, rate: 25100 })).toEqual(
      {
        ok: true,
        amount: -25100000,
        native_amount: -1000,
        amount_locked: false,
      },
    );
  });

  it('keeps the base value when no amount, date or account changes', () => {
    // The rate of today is not the rate of the stored value
    expect(resolveUsd({ change: {}, rate: 26000 })).toMatchObject({
      amount: -25000000,
      native_amount: -1000,
    });

    // A full row with the stored values is not a change, and it needs no rate
    expect(
      resolveUsd({
        change: {
          account: 'wise-usd',
          date: '2026-10-01',
          amount: -25000000,
          native_amount: -1000,
          amount_locked: false,
        },
        rate: null,
      }),
    ).toEqual({
      ok: true,
      amount: -25000000,
      native_amount: -1000,
      amount_locked: false,
    });
  });

  it('locks a base value that the write brings', () => {
    // From the dialog that sets the value of one row
    expect(resolveUsd({ change: { amount: -25480000 } })).toEqual({
      ok: true,
      amount: -25480000,
      native_amount: -1000,
      amount_locked: true,
    });

    // A new row with the two real numbers, for example from an import script
    expect(
      resolveUsd({
        existing: null,
        change: { native_amount: -1000, amount: -25480000 },
        amountSemantics: 'native',
        rate: null,
      }),
    ).toEqual({
      ok: true,
      amount: -25480000,
      native_amount: -1000,
      amount_locked: true,
    });
  });

  it('never calculates a locked value again', () => {
    const locked = { ...usdRow, amount: -25480000, amount_locked: true };

    expect(
      resolveUsd({ existing: locked, change: { date: '2026-10-05' } }),
    ).toMatchObject({ amount: -25480000, amount_locked: true });
    expect(
      resolveUsd({ existing: locked, change: { native_amount: -1100 } }),
    ).toEqual({
      ok: true,
      amount: -25480000,
      native_amount: -1100,
      amount_locked: true,
    });
  });

  it('calculates the value again when the lock is removed', () => {
    const locked = { ...usdRow, amount: -25480000, amount_locked: true };

    expect(
      resolveUsd({ existing: locked, change: { amount_locked: false } }),
    ).toEqual({
      ok: true,
      amount: -25000000,
      native_amount: -1000,
      amount_locked: false,
    });
  });

  it('locks the current value on request', () => {
    expect(resolveUsd({ change: { amount_locked: true } })).toEqual({
      ok: true,
      amount: -25000000,
      native_amount: -1000,
      amount_locked: true,
    });
  });

  it('keeps the typed number and converts again when the row moves to an account in another currency', () => {
    // From the USD account to a EUR account: 10.00 stays 10.00
    expect(
      resolveRowAmounts({
        existing: usdRow,
        change: { account: 'wise-eur' },
        amountSemantics: 'explicit',
        baseCurrency: 'VND',
        accountCurrency: 'EUR',
        rate: 29000,
      }),
    ).toEqual({
      ok: true,
      amount: -29000000,
      native_amount: -1000,
      amount_locked: false,
    });
  });

  it('reads the stored amount as native for a row that was never converted', () => {
    // Written by a client that knows no currencies: 10.00 in a USD account
    const unconverted = { ...usdRow, amount: -1000, native_amount: null };

    expect(
      resolveUsd({ existing: unconverted, change: { date: '2026-10-01' } }),
    ).toEqual({
      ok: true,
      amount: -25000000,
      native_amount: -1000,
      amount_locked: false,
    });
  });
});

describe('resolveRowAmounts for a transfer', () => {
  it('mirrors the value of the side that owns it', () => {
    // 1,988.99 USD out, 50,729,873 VND in. The VND side owns the value.
    expect(
      resolveUsd({
        existing: null,
        change: { native_amount: -198899 },
        ownerAmount: 5072987300,
        rate: null,
      }),
    ).toEqual({
      ok: true,
      amount: -5072987300,
      native_amount: -198899,
      amount_locked: false,
    });
  });

  it('keeps the mirrored value when the native amount of this side changes', () => {
    const leg = { ...usdRow, amount: -5072987300, native_amount: -198899 };

    expect(
      resolveUsd({
        existing: leg,
        change: { native_amount: -199000 },
        ownerAmount: 5072987300,
      }),
    ).toEqual({
      ok: true,
      amount: -5072987300,
      native_amount: -199000,
      amount_locked: false,
    });
  });

  it('takes a base value from this side with no lock, because the mirror code copies it to the owner', () => {
    const leg = { ...usdRow, amount: -5072987300, native_amount: -198899 };

    expect(
      resolveUsd({
        existing: leg,
        change: { amount: -5080000000 },
        ownerAmount: 5072987300,
      }),
    ).toEqual({
      ok: true,
      amount: -5080000000,
      native_amount: -198899,
      amount_locked: false,
    });
  });
});

describe('resolveRowAmounts for a split parent', () => {
  it('stores the sum of its children when the split is balanced', () => {
    // 10.00 USD in three parts. The parts round to 8,333,300 + 8,333,300 +
    // 8,333,400, and the parent must not get a different total.
    expect(
      resolveUsd({
        existing: null,
        change: { native_amount: -1000 },
        children: [
          { native_amount: -333, amount: -8325000 },
          { native_amount: -333, amount: -8325000 },
          { native_amount: -334, amount: -8350000 },
        ],
        rate: 25001,
      }),
    ).toEqual({
      ok: true,
      amount: -25000000,
      native_amount: -1000,
      amount_locked: false,
    });
  });

  it('converts its own amount while the split is not balanced', () => {
    expect(
      resolveUsd({
        existing: null,
        change: { native_amount: -1000 },
        children: [{ native_amount: -400, amount: -10000000 }],
      }),
    ).toMatchObject({ amount: -25000000, native_amount: -1000 });
  });
});

describe('ownsTransferAmount', () => {
  it('gives the value to the side in the base currency', () => {
    expect(
      ownsTransferAmount({
        baseCurrency: 'VND',
        currency: null,
        partnerCurrency: 'USD',
        nativeAmount: 5072987300,
      }),
    ).toBe(true);
    expect(
      ownsTransferAmount({
        baseCurrency: 'VND',
        currency: 'USD',
        partnerCurrency: 'VND',
        nativeAmount: -198899,
      }),
    ).toBe(false);
  });

  it('gives the value to the side that the money leaves when no side is in the base currency', () => {
    // 227.30 EUR out, 239.02 USD in
    expect(
      ownsTransferAmount({
        baseCurrency: 'VND',
        currency: 'EUR',
        partnerCurrency: 'USD',
        nativeAmount: -22730,
      }),
    ).toBe(true);
    expect(
      ownsTransferAmount({
        baseCurrency: 'VND',
        currency: 'USD',
        partnerCurrency: 'EUR',
        nativeAmount: 23902,
      }),
    ).toBe(false);
  });

  it('lets each side own the value when the two accounts have the same currency', () => {
    for (const nativeAmount of [-1000, 1000]) {
      expect(
        ownsTransferAmount({
          baseCurrency: 'VND',
          currency: 'USD',
          partnerCurrency: 'USD',
          nativeAmount,
        }),
      ).toBe(true);
      expect(
        ownsTransferAmount({
          baseCurrency: 'VND',
          currency: null,
          partnerCurrency: 'VND',
          nativeAmount,
        }),
      ).toBe(true);
    }
  });
});
