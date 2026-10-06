import {
  currencies,
  getDecimalPlaces,
  hidesFractionByDefault,
  isForeignCurrency,
} from './currencies';

describe('getDecimalPlaces', () => {
  it('returns 2 for empty string (None)', () => {
    expect(getDecimalPlaces('')).toBe(2);
  });

  it('returns 0 for zero-decimal currencies', () => {
    expect(getDecimalPlaces('JPY')).toBe(0);
    expect(getDecimalPlaces('KRW')).toBe(0);
    expect(getDecimalPlaces('IRR')).toBe(0);
  });

  it('returns 2 for standard currencies', () => {
    expect(getDecimalPlaces('USD')).toBe(2);
    expect(getDecimalPlaces('EUR')).toBe(2);
    expect(getDecimalPlaces('GBP')).toBe(2);
  });

  it('returns 2 as safe default for unknown codes', () => {
    expect(getDecimalPlaces('XYZ')).toBe(2);
  });

  it('returns 2 for VND, because every amount is still stored times 100', () => {
    // A change to 0 here would divide all stored VND amounts by 100 on screen.
    expect(currencies.some(currency => currency.code === 'VND')).toBe(true);
    expect(getDecimalPlaces('VND')).toBe(2);
  });
});

describe('currency metadata', () => {
  it.each(currencies)(
    '$name ($code) has a numeric decimalPlaces field',
    currency => {
      expect(typeof currency.decimalPlaces).toBe('number');
    },
  );

  it.each(currencies)(
    '$name ($code) has non-negative decimalPlaces',
    currency => {
      expect(currency.decimalPlaces).toBeGreaterThanOrEqual(0);
    },
  );

  it('first entry is None with code empty string and decimalPlaces 2', () => {
    expect(currencies[0].code).toBe('');
    expect(currencies[0].decimalPlaces).toBe(2);
  });
});

describe('isForeignCurrency', () => {
  it('is true only for a currency that is not the currency of the budget', () => {
    expect(isForeignCurrency({ currency: 'USD', baseCurrency: 'VND' })).toBe(
      true,
    );
    expect(isForeignCurrency({ currency: 'VND', baseCurrency: 'VND' })).toBe(
      false,
    );
  });

  it('reads an account with no currency as in the currency of the budget', () => {
    expect(isForeignCurrency({ currency: null, baseCurrency: 'VND' })).toBe(
      false,
    );
    expect(isForeignCurrency({ currency: '', baseCurrency: 'VND' })).toBe(
      false,
    );
    expect(
      isForeignCurrency({ currency: undefined, baseCurrency: 'VND' }),
    ).toBe(false);
  });
});

describe('hidesFractionByDefault', () => {
  it('is true for a currency with no decimal places', () => {
    expect(hidesFractionByDefault('JPY')).toBe(true);
  });

  it('is true for VND, which is stored with 2 decimal places', () => {
    expect(hidesFractionByDefault('VND')).toBe(true);
  });

  it('is false for a currency with decimals in daily use', () => {
    expect(hidesFractionByDefault('USD')).toBe(false);
    expect(hidesFractionByDefault('')).toBe(false);
  });
});
