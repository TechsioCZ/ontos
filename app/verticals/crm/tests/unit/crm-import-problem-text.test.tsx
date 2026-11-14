// The import screens turn CSV problem codes into sentences in the screen's language, through the real CRM i18n
// namespace, and keep showing the stored sentence for outcomes (and older batches) without a code.
import { FederatedI18nBoundary } from '@modern-js/i18n-integration/federation';
import { getI18nInstance } from '@modern-js/plugin-i18n/i18n';
import { ModernI18nProvider } from '@modern-js/plugin-i18n/runtime/consumer';
import { Effect } from 'effect';
import { describe, expect, it } from 'effect-rstest';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { CsvProblem, ImportRowResult } from '../../shared/domain/imports.ts';
import { useCsvProblemText } from '../../src/crm/csv-problem-text.ts';
import { crmI18nResources } from '../../src/crm/i18n.ts';
import { RowResults } from '../../src/routes/[lang]/crm/importy/import-panel.tsx';

const renderIn = (language: 'cs' | 'en', children: ReactNode) =>
  Effect.gen(function* renderTranslated() {
    const host = yield* Effect.promise(() => getI18nInstance());
    yield* Effect.promise(() =>
      host.init({
        defaultNS: 'translation',
        fallbackLng: language,
        initImmediate: false,
        interpolation: { escapeValue: false },
        lng: language,
        ns: ['translation'],
        resources: { cs: { translation: {} }, en: { translation: {} } },
      }),
    );
    return renderToStaticMarkup(
      <ModernI18nProvider value={{ i18nInstance: host, language, languages: ['cs', 'en'] }}>
        <FederatedI18nBoundary
          defaultNamespace="crm"
          fallbackLanguage={language}
          resources={crmI18nResources}
          supportedLanguages={['cs', 'en']}
        >
          {children}
        </FederatedI18nBoundary>
      </ModernI18nProvider>,
    );
  });

const ProblemProbe = ({ problems }: { readonly problems: readonly CsvProblem[] }) => {
  const problemText = useCsvProblemText();
  return (
    <ul>
      {problems.map((problem) => (
        <li key={problemText(problem)}>{problemText(problem)}</li>
      ))}
    </ul>
  );
};

const results: readonly ImportRowResult[] = [
  {
    message: 'Řádek 3, sloupec „Částka“: „12,3,4“ není platné desetinné číslo.',
    outcome: 'error',
    problem: { _tag: 'InvalidAmount', row: 3, value: '12,3,4' },
    row: 3,
  },
  { message: 'Chybí stav objednávky (sloupec stav)', outcome: 'error', row: 4 },
];

describe('CSV import problem sentences', () => {
  it.effect('renders codes by row and column label in Czech and English', () =>
    Effect.gen(function* problemSentences() {
      const problems: readonly CsvProblem[] = [
        { _tag: 'InvalidTime', column: 'cas_udalosti', row: 5 },
        { _tag: 'MissingColumns', columns: ['zdroj', 'id_objednavky'] },
        { _tag: 'UnterminatedQuote', position: 3, row: 2 },
      ];
      const cs = yield* renderIn('cs', <ProblemProbe problems={problems} />);
      expect(cs).toContain('Řádek 5, sloupec „Čas události“: zadejte platné datum nebo čas');
      expect(cs).toContain('Řádek 1: v hlavičce chybí povinné sloupce Zdroj, ID objednávky.');
      expect(cs).toContain('Řádek 2, sloupec 3: chybí uzavírací uvozovka.');
      const en = yield* renderIn('en', <ProblemProbe problems={problems} />);
      expect(en).toContain('Row 5, column “Event time”: enter a valid date or time');
      expect(en).toContain('Row 1: the header is missing the required columns Source, Order ID.');
      expect(en).toContain('Row 2, column 3: missing closing quote.');
      expect(en).not.toContain('cas_udalosti');
      return yield* Effect.void;
    }),
  );

  it.effect('translates coded row results and keeps stored sentences without a code', () =>
    Effect.gen(function* rowResultSentences() {
      const en = yield* renderIn('en', <RowResults results={results} />);
      expect(en).toContain('Row 3, column “Amount”: “12,3,4” is not a valid decimal number.');
      expect(en).toContain('Chybí stav objednávky (sloupec stav)');
      expect(en).not.toContain('není platné desetinné číslo');
      return yield* Effect.void;
    }),
  );
});
