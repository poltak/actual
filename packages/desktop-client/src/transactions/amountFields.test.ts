import { getAmountFields } from './amountFields';

// A currency of null is the currency of the budget
describe('getAmountFields', () => {
  it('lets a person set the value of a transaction in a foreign currency account', () => {
    expect(
      getAmountFields({
        currency: 'USD',
        hasPartner: false,
        partnerCurrency: null,
      }),
    ).toEqual({ hasOtherSideField: false, hasBaseValueField: true });
  });

  it('has nothing to set for a transaction in the currency of the budget', () => {
    expect(
      getAmountFields({
        currency: null,
        hasPartner: false,
        partnerCurrency: null,
      }),
    ).toEqual({ hasOtherSideField: false, hasBaseValueField: false });
  });

  it('shows only the other side when one side is in the currency of the budget', () => {
    const expected = { hasOtherSideField: true, hasBaseValueField: false };

    expect(
      getAmountFields({
        currency: 'USD',
        hasPartner: true,
        partnerCurrency: null,
      }),
    ).toEqual(expected);
    expect(
      getAmountFields({
        currency: null,
        hasPartner: true,
        partnerCurrency: 'USD',
      }),
    ).toEqual(expected);
  });

  it('shows the two fields for a transfer between two foreign currencies', () => {
    expect(
      getAmountFields({
        currency: 'USD',
        hasPartner: true,
        partnerCurrency: 'EUR',
      }),
    ).toEqual({ hasOtherSideField: true, hasBaseValueField: true });
  });

  it('shows only the value for a transfer in one foreign currency', () => {
    expect(
      getAmountFields({
        currency: 'USD',
        hasPartner: true,
        partnerCurrency: 'USD',
      }),
    ).toEqual({ hasOtherSideField: false, hasBaseValueField: true });
  });

  it('has nothing to set for a transfer in the currency of the budget', () => {
    expect(
      getAmountFields({
        currency: null,
        hasPartner: true,
        partnerCurrency: null,
      }),
    ).toEqual({ hasOtherSideField: false, hasBaseValueField: false });
  });
});
