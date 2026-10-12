import { Button } from '@techsio/ui-kit/atoms/button';
import { FederatedI18nBoundary, useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { useRouterState } from '@modern-js/plugin-tanstack/runtime';
import { Effect, Match, Random } from 'effect';
import { useState } from 'react';
import { executeRecords } from '../../../../api/records-client.ts';
import { browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';
import type { RecordsResponse } from '../../../../../shared/apis/records.ts';
import csResource from '../../../../../locales/cs/sales-pipeline.json';
import enResource from '../../../../../locales/en/sales-pipeline.json';
import { UltramodernRouteHead } from '../../../ultramodern-route-head';
import '../../../index.css';

const salesPipelineI18nResources = {
  cs: { 'sales-pipeline': csResource },
  en: { 'sales-pipeline': enResource },
} as const;

const key = 'sales-pipeline.pages.records';

const RecordsPageContent = () => {
  const { t } = useModernI18n();
  const [records, setRecords] = useState<RecordsResponse>();
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState('');
  const refresh = () => {
    setPending(true);
    void browserRuntime.runPromise(
      Effect.all([Random.nextInt, Random.nextInt], { concurrency: 1 }).pipe(
        Effect.map(([first, second]) => `sales-pipeline:${first}:${second}`),
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
        className="salespipeline:w-full salespipeline:min-w-0 salespipeline:space-y-4 salespipeline:text-(--color-page-fg)"
      >
        <header className="salespipeline:flex salespipeline:flex-wrap salespipeline:items-center salespipeline:justify-between salespipeline:gap-4">
          <h1 className="salespipeline:text-2xl salespipeline:font-semibold" id="records-heading">
            {t(`${key}.title`)}
          </h1>
          <Button disabled={pending} onClick={refresh} size="sm" theme="outlined" variant="secondary">
            {t(`${key}.refresh`)}
          </Button>
        </header>
        <output aria-live="polite" className="salespipeline:block salespipeline:text-sm">
          {message}
        </output>
        {records !== undefined && (
          <p className="salespipeline:text-sm salespipeline:text-(--color-fg-secondary)">
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
      defaultNamespace="sales-pipeline"
      fallbackLanguage="en"
      resources={salesPipelineI18nResources}
      supportedLanguages={['en', 'cs']}
    >
      <RecordsPageContent key={location} />
    </FederatedI18nBoundary>
  );
};

export default RecordsPage;
