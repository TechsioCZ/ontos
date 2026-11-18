import { FederatedI18nBoundary } from '@modern-js/i18n-integration/federation';
import { getI18nInstance } from '@modern-js/plugin-i18n/i18n';
import { ModernI18nProvider, useModernI18n } from '@modern-js/plugin-i18n/runtime/consumer';
import { Effect } from 'effect';
import { expect, it } from 'effect-rstest';
import { createElement } from 'react';
import { jsx } from 'react/jsx-runtime';
import { renderToStaticMarkup } from 'react-dom/server';
import { crmI18nResources } from '../../src/crm/i18n.ts';

const ChartTranslationProbe = () => {
  const { t } = useModernI18n();
  return createElement(
    'p',
    null,
    [
      t('crm.reports.chart.countsDescription', { from: '2026-01', to: '2026-02' }),
      t('crm.reports.chart.valueAria', { currency: 'EUR' }),
      t('crm.reports.chart.noAmount'),
    ].join('|'),
  );
};

it.effect.each([
  {
    expected:
      'Počet objednávek od 2026-01 do 2026-02. Přesná čísla včetně stavů jsou v datové tabulce pod grafy.|Hodnota objednávek v EUR po měsících|Zdroj u započtených objednávek neposkytl částku a měnu.',
    language: 'cs',
  },
  {
    expected:
      'Number of orders from 2026-01 to 2026-02. Exact figures including statuses are in the data table below the charts.|Order value in EUR by month|The source did not provide an amount and currency for the counted orders.',
    language: 'en',
  },
])('resolves $language chart descriptions and currency through the CRM runtime namespace', ({ expected, language }) =>
  Effect.gen(function* chartTranslations() {
    const host = yield* Effect.promise(() => getI18nInstance());
    yield* Effect.promise(() =>
      host.init({
        defaultNS: 'translation',
        fallbackLng: language,
        initImmediate: false,
        lng: language,
        ns: ['translation'],
        resources: { cs: { translation: { hostOnly: 'host' } }, en: { translation: { hostOnly: 'host' } } },
      }),
    );
    const actual = renderToStaticMarkup(
      jsx(ModernI18nProvider, {
        children: jsx(FederatedI18nBoundary, {
          children: jsx(ChartTranslationProbe, {}),
          defaultNamespace: 'crm',
          fallbackLanguage: language,
          resources: crmI18nResources,
          supportedLanguages: ['cs', 'en'],
        }),
        value: { i18nInstance: host, language, languages: ['cs', 'en'] },
      }),
    );
    expect(actual).toBe(renderToStaticMarkup(createElement('p', null, expected)));
    expect(host.t('crm.reports.chart.noAmount')).toBe('crm.reports.chart.noAmount');
    expect(host.t('hostOnly')).toBe('host');
  }),
);
