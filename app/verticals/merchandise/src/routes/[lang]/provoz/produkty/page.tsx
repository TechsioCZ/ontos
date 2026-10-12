import { Button } from '@techsio/ui-kit/atoms/button';
import { FederatedI18nBoundary, useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { useRouterState } from '@modern-js/plugin-tanstack/runtime';
import { Effect, Match, Random } from 'effect';
import { useState } from 'react';
import { listProducts } from '../../../../api/records-client.ts';
import { browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';
import type { ProductRecord } from '../../../../../shared/apis/records.ts';
import csResource from '../../../../../locales/cs/merchandise.json';
import enResource from '../../../../../locales/en/merchandise.json';
import { UltramodernRouteHead } from '../../../ultramodern-route-head';
import '../../../index.css';

const merchandiseI18nResources = {
  cs: { merchandise: csResource },
  en: { merchandise: enResource },
} as const;

const key = 'merchandise.pages.products';

const RecordsPageContent = () => {
  const { t } = useModernI18n();
  const [records, setRecords] = useState<readonly ProductRecord[]>();
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState('');
  const refresh = () => {
    setPending(true);
    void browserRuntime.runPromise(
      Effect.all([Random.nextInt, Random.nextInt], { concurrency: 1 }).pipe(
        Effect.map(([first, second]) => `merchandise:${first}:${second}`),
        Effect.flatMap((id) => listProducts(id)),
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
        className="merchandise:w-full merchandise:min-w-0 merchandise:space-y-4 merchandise:text-(--color-page-fg)"
      >
        <header className="merchandise:flex merchandise:flex-wrap merchandise:items-center merchandise:justify-between merchandise:gap-4">
          <h1 className="merchandise:text-2xl merchandise:font-semibold" id="records-heading">
            {t(`${key}.title`)}
          </h1>
          <Button disabled={pending} onClick={refresh} size="sm" theme="outlined" variant="secondary">
            {t(`${key}.refresh`)}
          </Button>
        </header>
        <output aria-live="polite" className="merchandise:block merchandise:text-sm">
          {message}
        </output>
        {records !== undefined && (
          <p className="merchandise:text-sm merchandise:text-(--color-fg-secondary)">
            {records.length === 0 ? t(`${key}.empty`) : t(`${key}.count`, { total: records.length })}
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
      defaultNamespace="merchandise"
      fallbackLanguage="en"
      resources={merchandiseI18nResources}
      supportedLanguages={['en', 'cs']}
    >
      <RecordsPageContent key={location} />
    </FederatedI18nBoundary>
  );
};

export default RecordsPage;
