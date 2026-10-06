import { convertAmount, impliedRate } from './currency-conversion';

describe('convertAmount', () => {
  it('converts between two currencies that both store two decimal places', () => {
    // 8.00 USD at 25,954 VND for one USD. VND is stored times 100.
    expect(
      convertAmount({
        amount: -800,
        rate: 25954,
        fromCurrency: 'USD',
        toCurrency: 'VND',
      }),
    ).toBe(-20763200);
  });

  it('scales by the decimal places of each currency', () => {
    // 10.00 USD at 150.25 JPY for one USD. JPY is stored with no decimals.
    expect(
      convertAmount({
        amount: 1000,
        rate: 150.25,
        fromCurrency: 'USD',
        toCurrency: 'JPY',
      }),
    ).toBe(1503);

    // 1,503 JPY back to USD cents
    expect(
      convertAmount({
        amount: 1503,
        rate: 1 / 150.25,
        fromCurrency: 'JPY',
        toCurrency: 'USD',
      }),
    ).toBe(1000);
  });

  it('gives opposite results for opposite amounts, also at a half', () => {
    // 0.25 EUR at 0.5 is 0.125, a half in the last place
    const positive = convertAmount({
      amount: 25,
      rate: 0.5,
      fromCurrency: 'EUR',
      toCurrency: 'USD',
    });
    const negative = convertAmount({
      amount: -25,
      rate: 0.5,
      fromCurrency: 'EUR',
      toCurrency: 'USD',
    });

    expect(positive).toBe(13);
    expect(negative).toBe(-13);
  });

  it('returns zero, not negative zero, for a zero amount', () => {
    const result = convertAmount({
      amount: -0,
      rate: 25954,
      fromCurrency: 'USD',
      toCurrency: 'VND',
    });

    expect(Object.is(result, 0)).toBe(true);
  });

  it('rejects a rate that is not a positive number', () => {
    for (const rate of [0, -1, NaN, Infinity]) {
      expect(() =>
        convertAmount({
          amount: 100,
          rate,
          fromCurrency: 'USD',
          toCurrency: 'VND',
        }),
      ).toThrow('rate must be a positive number');
    }
  });

  it('rejects an amount that is not an integer', () => {
    expect(() =>
      convertAmount({
        amount: 1.5,
        rate: 2,
        fromCurrency: 'USD',
        toCurrency: 'VND',
      }),
    ).toThrow('not an integer');
  });
});

describe('impliedRate', () => {
  it('gives the rate of a real conversion', () => {
    // 1,988.99 USD became 50,729,873 VND
    const rate = impliedRate({
      fromAmount: -198899,
      toAmount: 5072987300,
      fromCurrency: 'USD',
      toCurrency: 'VND',
    });

    expect(rate).toBeCloseTo(25505.3434, 4);
  });

  it('gives a rate that converts back to the real amount', () => {
    const rate = impliedRate({
      fromAmount: -198899,
      toAmount: 5072987300,
      fromCurrency: 'USD',
      toCurrency: 'VND',
    });

    expect(
      convertAmount({
        amount: -198899,
        rate: rate!,
        fromCurrency: 'USD',
        toCurrency: 'VND',
      }),
    ).toBe(-5072987300);
  });

  it('takes the decimal places of each currency into account', () => {
    // 10.00 USD became 1,503 JPY
    expect(
      impliedRate({
        fromAmount: 1000,
        toAmount: 1503,
        fromCurrency: 'USD',
        toCurrency: 'JPY',
      }),
    ).toBeCloseTo(150.3, 6);
  });

  it('returns null when one amount is zero', () => {
    expect(
      impliedRate({
        fromAmount: 0,
        toAmount: 100,
        fromCurrency: 'USD',
        toCurrency: 'VND',
      }),
    ).toBeNull();
    expect(
      impliedRate({
        fromAmount: 100,
        toAmount: 0,
        fromCurrency: 'USD',
        toCurrency: 'VND',
      }),
    ).toBeNull();
  });
});
