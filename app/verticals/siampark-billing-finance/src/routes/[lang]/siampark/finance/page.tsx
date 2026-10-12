import { FederatedI18nBoundary } from '@modern-js/plugin-i18n/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { SelectTemplate as Select } from '@techsio/ui-kit/templates/select';
import { financeBrowserRuntime } from '../../../../runtime/browser.ts';
import { Effect } from 'effect';
import { financeFailureFeedback, useFinanceRecords } from './use-finance-records.ts';
import { FinanceInvoiceTable, FinanceInvoiceDetail, FinanceDraftForm, FinancePlanTable } from './finance-records.tsx';
import { UltramodernRouteHead } from '../../../ultramodern-route-head';
import csResource from '../../../../../locales/cs/siampark-billing-finance.json';
import enResource from '../../../../../locales/en/siampark-billing-finance.json';
import '../../../index.css';

const resources = {
  cs: { 'siampark-billing-finance': csResource },
  en: { 'siampark-billing-finance': enResource },
} as const;
const RecordsPageContent = () => {
  const vm = useFinanceRecords();
  const {
    busy,
    directionFilter,
    feedback,
    filterPropertyId,
    load,
    money,
    properties,
    selected,
    setDirectionFilter,
    setFeedback,
    setFilterPropertyId,
    snapshot,
    t,
    visible,
  } = vm;
  return (
    <>
      <UltramodernRouteHead />
      <section className="siamparkbillingfinance:w-full siamparkbillingfinance:min-w-0 siamparkbillingfinance:max-w-none siamparkbillingfinance:space-y-6 siamparkbillingfinance:p-0 siamparkbillingfinance:text-(--color-page-fg)">
        <header className="siamparkbillingfinance:flex siamparkbillingfinance:flex-wrap siamparkbillingfinance:items-start siamparkbillingfinance:justify-between siamparkbillingfinance:gap-4 siamparkbillingfinance:border-b siamparkbillingfinance:border-(--color-border-muted) siamparkbillingfinance:pb-5">
          <div className="siamparkbillingfinance:space-y-2">
            <h1 className="siamparkbillingfinance:text-2xl siamparkbillingfinance:font-semibold siamparkbillingfinance:tracking-tight">
              {t('siampark-billing-finance.pages.records.title')}
            </h1>
            <p className="siamparkbillingfinance:text-sm siamparkbillingfinance:text-(--color-fg-secondary)">
              {t('siampark-billing-finance.demo.simulation')}
            </p>
          </div>
          <output aria-live="polite">
            <Badge
              size="sm"
              variant={
                (
                  {
                    conflict: 'warning',
                    forbidden: 'danger',
                    loading: 'info',
                    ready: 'success',
                    saving: 'info',
                    unavailable: 'danger',
                    validation: 'warning',
                  } as const
                )[feedback]
              }
            >
              {t(`siampark-billing-finance.demo.feedback.${feedback}`)}
            </Badge>
          </output>
        </header>
        {snapshot !== undefined && (
          <div className="siamparkbillingfinance:grid siamparkbillingfinance:gap-4 siamparkbillingfinance:sm:grid-cols-2 siamparkbillingfinance:xl:grid-cols-4">
            {[
              {
                label: t('siampark-billing-finance.demo.labels.REVENUE'),
                value: money(snapshot.indicators.revenueMinor),
              },
              { label: t('siampark-billing-finance.demo.labels.COST'), value: money(snapshot.indicators.costMinor) },
              {
                label: t('siampark-billing-finance.demo.outstanding'),
                value: money(snapshot.indicators.grossOutstandingMinor),
              },
              { label: t('siampark-billing-finance.demo.overdue'), value: snapshot.indicators.overdueInvoices },
            ].map(({ label, value }) => (
              <article
                className="siamparkbillingfinance:min-w-0 siamparkbillingfinance:rounded-lg siamparkbillingfinance:border siamparkbillingfinance:border-(--color-border-muted) siamparkbillingfinance:bg-(--color-surface) siamparkbillingfinance:p-5"
                key={label}
              >
                <p className="siamparkbillingfinance:text-xs siamparkbillingfinance:font-medium siamparkbillingfinance:text-(--color-fg-secondary)">
                  {label}
                </p>
                <p className="siamparkbillingfinance:mt-2 siamparkbillingfinance:text-2xl siamparkbillingfinance:font-semibold siamparkbillingfinance:tabular-nums">
                  {value}
                </p>
              </article>
            ))}
          </div>
        )}
        <div className="siamparkbillingfinance:grid siamparkbillingfinance:items-end siamparkbillingfinance:gap-4 siamparkbillingfinance:rounded-lg siamparkbillingfinance:border siamparkbillingfinance:border-(--color-border-muted) siamparkbillingfinance:bg-(--color-surface-subtle) siamparkbillingfinance:p-4 siamparkbillingfinance:md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
          <Select
            items={['ALL', 'OUTGOING', 'INCOMING'].map((value) => ({
              label: t(`siampark-billing-finance.demo.labels.${value}`),
              value,
            }))}
            label={t('siampark-billing-finance.demo.direction')}
            onValueChange={({ value }) => setDirectionFilter(value[0] ?? '')}
            value={[directionFilter]}
          />
          <Select
            items={[
              { label: t('siampark-billing-finance.demo.labels.ALL'), value: '' },
              ...(properties?.properties.map((record) => ({
                label: record.name,
                value: record.propertyRef.resourceId,
              })) ?? []),
            ]}
            label={t('siampark-billing-finance.demo.property')}
            onValueChange={({ value }) => setFilterPropertyId(value[0] ?? '')}
            value={[filterPropertyId]}
          />
          <Button
            disabled={busy}
            onClick={() => {
              void financeBrowserRuntime.runPromise(
                load().pipe(
                  Effect.match({
                    onFailure: (failure) => setFeedback(financeFailureFeedback(failure)),
                    onSuccess: () => setFeedback('ready'),
                  }),
                ),
              );
            }}
            size="sm"
            theme="outlined"
            variant="secondary"
          >
            {t('siampark-billing-finance.demo.refresh')}
          </Button>
        </div>
        {snapshot !== undefined && visible.length === 0 && (
          <p className="siamparkbillingfinance:rounded-lg siamparkbillingfinance:border siamparkbillingfinance:border-(--color-border-muted) siamparkbillingfinance:bg-(--color-surface-subtle) siamparkbillingfinance:p-5 siamparkbillingfinance:text-sm siamparkbillingfinance:text-(--color-fg-secondary)">
            {t('siampark-billing-finance.demo.empty')}
          </p>
        )}
        <FinanceInvoiceTable vm={vm} />
        {selected !== undefined && <FinanceInvoiceDetail vm={vm} />}
        <FinanceDraftForm vm={vm} />
        <FinancePlanTable vm={vm} />
        {snapshot !== undefined && (
          <p className="siamparkbillingfinance:rounded-lg siamparkbillingfinance:border siamparkbillingfinance:border-(--color-border-muted) siamparkbillingfinance:bg-(--color-surface-subtle) siamparkbillingfinance:p-4 siamparkbillingfinance:text-sm siamparkbillingfinance:text-(--color-fg-secondary)">
            {t('siampark-billing-finance.demo.variance', {
              cost: money(snapshot.indicators.costVarianceMinor),
              revenue: money(snapshot.indicators.revenueVarianceMinor),
            })}
          </p>
        )}
      </section>
    </>
  );
};
export const RecordsPage = () => (
  <FederatedI18nBoundary
    defaultNamespace="siampark-billing-finance"
    fallbackLanguage="en"
    resources={resources}
    supportedLanguages={['en', 'cs']}
  >
    <RecordsPageContent />
  </FederatedI18nBoundary>
);
export default RecordsPage;
