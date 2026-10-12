import { Button } from '@techsio/ui-kit/atoms/button';
import { FederatedI18nBoundary, useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { useRouterState } from '@modern-js/plugin-tanstack/runtime';
import { Effect, Match, Random } from 'effect';
import { useState } from 'react';
import { executeRecords } from '../../../../api/records-client.ts';
import { browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';
import type { RecordsResponse } from '../../../../../shared/apis/records.ts';
import csResource from '../../../../../locales/cs/workforce.json';
import enResource from '../../../../../locales/en/workforce.json';
import { UltramodernRouteHead } from '../../../ultramodern-route-head';
import '../../../index.css';

const workforceI18nResources = {
  cs: { workforce: csResource },
  en: { workforce: enResource },
} as const;

const key = 'workforce.pages.records';

const RecordsPageContent = () => {
  const { t } = useModernI18n();
  const [records, setRecords] = useState<RecordsResponse>();
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState('');
  const refresh = () => {
    setPending(true);
    void browserRuntime.runPromise(
      Effect.all([Random.nextInt, Random.nextInt], { concurrency: 1 }).pipe(
        Effect.map(([first, second]) => `workforce:${first}:${second}`),
        Effect.flatMap((id) => executeRecords({}, id)),
        Effect.match({
          onFailure: (error) => {
            setRecords(undefined);
            setMessage(
              Match.value(error).pipe(
                Match.tag('RecordsForbiddenProblem', () => t(`${key}.forbidden`)),
                Match.orElse(() => t(`${key}.unavailable`)),
              ),
            );
            setPending(false);
          },
          onSuccess: (result) => {
            setRecords(result);
            setMessage('');
            setPending(false);
          },
        }),
      ),
    );
  };
  return (
    <>
      <UltramodernRouteHead />
      <section
        aria-labelledby="records-heading"
        className="workforce:w-full workforce:min-w-0 workforce:space-y-4 workforce:text-(--color-page-fg)"
      >
        <header className="workforce:flex workforce:flex-wrap workforce:items-center workforce:justify-between workforce:gap-4">
          <h1 className="workforce:text-2xl workforce:font-semibold" id="records-heading">
            {t(`${key}.title`)}
          </h1>
          <Button disabled={pending} onClick={refresh} size="sm" theme="outlined" variant="secondary">
            {t(`${key}.refresh`)}
          </Button>
        </header>
        <output aria-live="polite" className="workforce:block workforce:text-sm">
          {message}
        </output>
        {records !== undefined && (
          <p className="workforce:text-sm workforce:text-(--color-fg-secondary)">
            {records.items.length === 0 ? t(`${key}.empty`) : t(`${key}.count`, { total: records.items.length })}
          </p>
        )}
      </section>
    </>
  );
};

export const RecordsPage = () => {
  const location = useRouterState({ select: (state) => state.location.href });
  return (
    <FederatedI18nBoundary
      defaultNamespace="workforce"
      fallbackLanguage="en"
      resources={workforceI18nResources}
      supportedLanguages={['en', 'cs']}
    >
      <RecordsPageContent key={location} />
    </FederatedI18nBoundary>
  );
};

export default RecordsPage;
