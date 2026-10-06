import React, { useMemo } from 'react';
import { Trans, useTranslation } from 'react-i18next';

import { Select } from '@actual-app/components/select';
import { Text } from '@actual-app/components/text';
import { theme } from '@actual-app/components/theme';
import { View } from '@actual-app/components/view';
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

import { Column, Setting } from './UI';

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
        ['UAH', t('Ukrainian Hryvnia')],
        ['USD', t('US Dollar')],
        ['UYU', t('Uruguayan Peso')],
        ['UZS', t('Uzbek Soum')],
        ['VND', t('Vietnamese Dong')],
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
      setSpaceEnabledPref(cur.symbolFirst ? 'false' : 'true');
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
    <Setting
      primaryAction={
        <View
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: '1.5em',
            width: '100%',
          }}
        >
          <View style={{ display: 'flex', flexDirection: 'row', gap: '1.5em' }}>
            <Column title={t('Default Currency')}>
              <Select
                value={selectedCurrencyCode}
                onChange={handleCurrencyChange}
                options={currencyOptions}
                className={selectButtonClassName}
                style={{ width: '100%' }}
                disabled={hasForeignAccount}
              />
              {hasForeignAccount && (
                <Text style={{ color: theme.pageTextSubdued }}>
                  <Trans>
                    The currency of the budget cannot change while an account
                    has a different currency.
                  </Trans>
                </Text>
              )}
            </Column>

            <Column
              title={t('Symbol Position')}
              style={{
                visibility: selectedCurrencyCode === '' ? 'hidden' : 'visible',
              }}
            >
              <Select
                value={symbolPosition || 'before'}
                onChange={value => setSymbolPositionPref(value)}
                options={symbolPositionOptions.map(f => [f.value, f.label])}
                className={selectButtonClassName}
                style={{ width: '100%' }}
                disabled={selectedCurrencyCode === ''}
              />
            </Column>
          </View>

          {selectedCurrencyCode !== '' && (
            <View
              style={{
                display: 'flex',
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'flex-start',
              }}
            >
              <Checkbox
                id="settings-spaceEnabled"
                checked={spaceEnabled === 'true'}
                onChange={e =>
                  setSpaceEnabledPref(e.target.checked ? 'true' : 'false')
                }
              />
              <label
                htmlFor="settings-spaceEnabled"
                style={{ marginLeft: '0.5em' }}
              >
                <Trans>Add space between amount and symbol</Trans>
              </label>
            </View>
          )}

          {selectedCurrencyCode !== '' && isMultiCurrencyEnabled && (
            <View style={{ gap: '0.3em' }}>
              <View
                style={{
                  display: 'flex',
                  flexDirection: 'row',
                  alignItems: 'center',
                  justifyContent: 'flex-start',
                }}
              >
                <Checkbox
                  id="settings-exchangeRateDownload"
                  checked={exchangeRateProvider === FRANKFURTER_PROVIDER}
                  onChange={e =>
                    setExchangeRateProviderPref(
                      e.target.checked ? FRANKFURTER_PROVIDER : '',
                    )
                  }
                />
                <label
                  htmlFor="settings-exchangeRateDownload"
                  style={{ marginLeft: '0.5em' }}
                >
                  <Trans>Download exchange rates</Trans>
                </label>
              </View>
              <Text style={{ color: theme.pageTextSubdued }}>
                <Trans>
                  An account in a different currency needs the exchange rate of
                  each transaction date. With this setting, Actual gets the
                  rates from api.frankfurter.dev, a free service with the rates
                  of central banks. The request has only the currency codes and
                  the dates.
                </Trans>
              </Text>
            </View>
          )}
        </View>
      }
    >
      <Text>
        <Trans>
          <strong>Currency settings</strong> affect how amounts are displayed
          throughout the application. Changing the currency will affect the
          number format, symbol position, and whether fractions are shown. These
          can be adjusted after the currency is set.
        </Trans>
      </Text>
    </Setting>
  );
}
