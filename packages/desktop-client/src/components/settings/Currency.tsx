import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { Select } from '@actual-app/components/select';
import { theme } from '@actual-app/components/theme';
import {
  currencies,
  FRANKFURTER_PROVIDER,
  getCurrency,
  hidesFractionByDefault,
} from '@actual-app/core/shared/currencies';
import { css } from '@emotion/css';

import { Checkbox } from '#components/forms';
import { useAccountCurrencies } from '#hooks/useAccountCurrencies';
import { useFeatureFlag } from '#hooks/useFeatureFlag';
import { useSyncedPref } from '#hooks/useSyncedPref';

import { SettingsGroup } from './SettingsGroup';
import { SettingsRow } from './SettingsRow';

// The names of the currencies in the language of the user
function useCurrencyTranslations() {
  const { t } = useTranslation();

  const currencyTranslations = useMemo(
    () =>
      new Map<string, string>([
        ['', t('None')],
        ['AED', t('UAE Dirham')],
        ['ARS', t('Argentinian Peso')],
        ['AUD', t('Australian Dollar')],
        ['BDT', t('Bangladeshi Taka')],
        ['BRL', t('Brazilian Real')],
        ['BYN', t('Belarusian Ruble')],
        ['CAD', t('Canadian Dollar')],
        ['CHF', t('Swiss Franc')],
        ['CLP', t('Chilean Peso')],
        ['CNY', t('Yuan Renminbi')],
        ['COP', t('Colombian Peso')],
        ['CRC', t('Costa Rican Colón')],
        ['CZK', t('Czech Koruna')],
        ['DKK', t('Danish Krone')],
        ['DOP', t('Dominican Peso')],
        ['EGP', t('Egyptian Pound')],
        ['EUR', t('Euro')],
        ['GBP', t('Pound Sterling')],
        ['GTQ', t('Guatemalan Quetzal')],
        ['HKD', t('Hong Kong Dollar')],
        ['HUF', t('Hungarian Forint')],
        ['IDR', t('Indonesian Rupiah')],
        ['ILS', t('Israeli New Shekel')],
        ['INR', t('Indian Rupee')],
        ['IRR', t('Iranian Rial')],
        ['JMD', t('Jamaican Dollar')],
        ['JPY', t('Japanese Yen')],
        ['KRW', t('South Korean Won')],
        ['LKR', t('Sri Lankan Rupee')],
        ['MDL', t('Moldovan Leu')],
        ['MKD', t('Macedonian Denar')],
        ['MXN', t('Mexican Peso')],
        ['MYR', t('Malaysian Ringgit')],
        ['NOK', t('Norwegian Krone')],
        ['PEN', t('Peruvian Sol')],
        ['PHP', t('Philippine Peso')],
        ['PKR', t('Pakistani Rupee')],
        ['PLN', t('Polish Złoty')],
        ['QAR', t('Qatari Riyal')],
        ['RON', t('Romanian Leu')],
        ['RSD', t('Serbian Dinar')],
        ['RUB', t('Russian Ruble')],
        ['SAR', t('Saudi Riyal')],
        ['SEK', t('Swedish Krona')],
        ['SGD', t('Singapore Dollar')],
        ['THB', t('Thai Baht')],
        ['TRY', t('Turkish Lira')],
        ['TWD', t('New Taiwan Dollar')],
        ['TZS', t('Tanzanian Shilling')],
        ['UAH', t('Ukrainian Hryvnia')],
        ['USD', t('US Dollar')],
        ['UYU', t('Uruguayan Peso')],
        ['UZS', t('Uzbek Soum')],
        ['VND', t('Vietnamese Dong')],
        ['ZAR', t('South African Rand')],
      ]),
    [t],
  );

  return currencyTranslations;
}

/** The currencies as options for a select, with the code as the value */
export function useCurrencyOptions(): [string, string][] {
  const currencyTranslations = useCurrencyTranslations();

  return currencies.map(currency => {
    const translatedName =
      currencyTranslations.get(currency.code) ?? currency.name;
    if (currency.code === '') {
      return [currency.code, translatedName];
    }
    return [
      currency.code,
      `${currency.code} - ${translatedName} (${currency.symbol})`,
    ];
  });
}

export function CurrencySettings() {
  const { t } = useTranslation();
  const currencyOptions = useCurrencyOptions();
  const isMultiCurrencyEnabled = useFeatureFlag('multiCurrency');

  const [defaultCurrencyCode, setDefaultCurrencyCodePref] = useSyncedPref(
    'defaultCurrencyCode',
  );
  const selectedCurrencyCode = defaultCurrencyCode || '';
  // Each amount of a foreign currency account has a stored value in the
  // currency of the budget, so that currency cannot change then
  const { hasForeignAccount } = useAccountCurrencies();

  const [symbolPosition, setSymbolPositionPref] = useSyncedPref(
    'currencySymbolPosition',
  );
  const [spaceEnabled, setSpaceEnabledPref] = useSyncedPref(
    'currencySpaceBetweenAmountAndSymbol',
  );
  const [, setNumberFormatPref] = useSyncedPref('numberFormat');
  const [, setHideFractionPref] = useSyncedPref('hideFraction');
  const [exchangeRateProvider, setExchangeRateProviderPref] = useSyncedPref(
    'exchangeRateProvider',
  );

  const selectButtonClassName = css({
    '&[data-hovered]': {
      backgroundColor: theme.buttonNormalBackgroundHover,
    },
  });

  const handleCurrencyChange = (code: string) => {
    setDefaultCurrencyCodePref(code);
    if (code !== '') {
      const cur = getCurrency(code);
      setNumberFormatPref(cur.numberFormat);
      setHideFractionPref(hidesFractionByDefault(cur.code) ? 'true' : 'false');
      // A currency code used as the symbol (e.g. "CHF 100") needs a space
      const isSpaceEnabled = !cur.symbolFirst || cur.symbol === cur.code;
      setSpaceEnabledPref(isSpaceEnabled ? 'true' : 'false');
      setSymbolPositionPref(cur.symbolFirst ? 'before' : 'after');
    }
  };

  const symbolPositionOptions = useMemo(() => {
    const selectedCurrency = getCurrency(selectedCurrencyCode);
    const symbol = selectedCurrency.symbol || '$';
    const space = spaceEnabled === 'true' ? ' ' : '';

    return [
      {
        value: 'before',
        label: `${t('Before amount')} (${t('e.g.')} ${symbol}${space}100)`,
      },
      {
        value: 'after',
        label: `${t('After amount')} (${t('e.g.')} 100${space}${symbol})`,
      },
    ];
  }, [selectedCurrencyCode, spaceEnabled, t]);

  return (
    <SettingsGroup
      title={t('Currency')}
      description={t(
        'Currency settings affect how amounts are displayed throughout the application. Changing the currency also updates the number format, symbol position and whether decimal places are shown. These can be adjusted after the currency is set.',
      )}
    >
      <SettingsRow
        title={t('Default currency')}
        description={
          hasForeignAccount &&
          t(
            'The currency of the budget cannot change while an account has a different currency.',
          )
        }
        control={
          <Select
            value={selectedCurrencyCode}
            onChange={handleCurrencyChange}
            options={currencyOptions}
            className={selectButtonClassName}
            style={{ maxWidth: '100%' }}
            disabled={hasForeignAccount}
          />
        }
      />
      {selectedCurrencyCode !== '' && (
        <SettingsRow
          title={t('Symbol position')}
          control={
            <Select
              value={symbolPosition || 'before'}
              onChange={value => setSymbolPositionPref(value)}
              options={symbolPositionOptions.map(f => [f.value, f.label])}
              className={selectButtonClassName}
              style={{ maxWidth: '100%' }}
            />
          }
        />
      )}
      {selectedCurrencyCode !== '' && (
        <SettingsRow
          htmlFor="settings-spaceEnabled"
          title={t('Add space between amount and symbol')}
          control={
            <Checkbox
              id="settings-spaceEnabled"
              checked={spaceEnabled === 'true'}
              onChange={e =>
                setSpaceEnabledPref(e.target.checked ? 'true' : 'false')
              }
              style={{ marginRight: 0 }}
            />
          }
        />
      )}
      {selectedCurrencyCode !== '' && isMultiCurrencyEnabled && (
        <SettingsRow
          htmlFor="settings-exchangeRateDownload"
          title={t('Download exchange rates')}
          description={t(
            'An account in a different currency needs the exchange rate of each transaction date. With this setting, Actual gets the rates from api.frankfurter.dev, a free service with the rates of central banks. The request has only the currency codes and the dates.',
          )}
          control={
            <Checkbox
              id="settings-exchangeRateDownload"
              checked={exchangeRateProvider === FRANKFURTER_PROVIDER}
              onChange={e =>
                setExchangeRateProviderPref(
                  e.target.checked ? FRANKFURTER_PROVIDER : '',
                )
              }
              style={{ marginRight: 0 }}
            />
          }
        />
      )}
    </SettingsGroup>
  );
}
