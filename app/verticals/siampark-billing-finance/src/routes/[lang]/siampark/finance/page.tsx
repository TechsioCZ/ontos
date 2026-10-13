import { FederatedI18nBoundary } from '@modern-js/plugin-i18n/runtime';
import { formatMoney, formatNumber, PageHeader, StatCard, StatRow } from '@app/admin-ui';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { Dialog } from '@techsio/ui-kit/molecules/dialog';
import { Toaster } from '@techsio/ui-kit/molecules/toast';
import { useState } from 'react';
import csResource from '../../../../../locales/cs/siampark-billing-finance.json';
import enResource from '../../../../../locales/en/siampark-billing-finance.json';
import '../../../index.css';
import { UltramodernRouteHead } from '../../../ultramodern-route-head';
import { CreateInvoiceDialog } from './create-invoice-dialog.tsx';
import { FinanceInvoiceDetail } from './invoice-detail.tsx';
import { FinanceInvoiceTable } from './invoices-table.tsx';
import { useFinanceRecords } from './use-finance-records.ts';

const resources = {
  cs: { 'siampark-billing-finance': csResource },
  en: { 'siampark-billing-finance': enResource },
} as const;

const ns = 'siampark-billing-finance.faktury';

/** KPI tiles show whole Kč; the table keeps exact amounts. */
const wholeKc = (minor: number) => formatMoney(Math.round(minor / 100) * 100);

const RecordsPageContent = () => {
  const vm = useFinanceRecords();
  const { busy, cancelVoid, canWrite, confirmVoid, feedback, indicators, references, selected, t, voidTarget } = vm;
  const [createOpen, setCreateOpen] = useState(false);
  const kpi = (value: (source: NonNullable<typeof indicators>) => string) =>
    indicators === undefined ? '—' : value(indicators);

  return (
    <>
      <UltramodernRouteHead />
      <Toaster />
      <section className="flex min-w-0 flex-col gap-250 text-fg-primary">
        {selected === undefined ? (
          <>
            <PageHeader
              actions={
                canWrite ? (
                  <Button
                    className="whitespace-nowrap"
                    icon="icon-[mdi--plus]"
                    onClick={() => setCreateOpen(true)}
                    size="sm"
                    variant="primary"
                  >
                    {t(`${ns}.newInvoice`)}
                  </Button>
                ) : undefined
              }
              description={t(`${ns}.description`)}
              title={t(`${ns}.title`)}
            />
            <StatRow>
              <StatCard label={t(`${ns}.kpi.revenue`)} value={kpi((source) => wholeKc(source.revenueMinor))} />
              <StatCard
                label={t(`${ns}.kpi.outstanding`)}
                value={kpi((source) => wholeKc(source.grossOutstandingMinor))}
              />
              <StatCard label={t(`${ns}.kpi.overdue`)} value={kpi((source) => formatNumber(source.overdueInvoices))} />
              <StatCard label={t(`${ns}.kpi.drafts`)} value={kpi((source) => formatNumber(source.draftCount))} />
            </StatRow>
            {(feedback === 'forbidden' ||
              feedback === 'conflict' ||
              feedback === 'unavailable' ||
              feedback === 'validation') && (
              <StatusText showIcon status="error">
                {t(`siampark-billing-finance.demo.feedback.${feedback}`)}
              </StatusText>
            )}
            {references.referencesFailed && (
              <StatusText showIcon status="error">
                {t(`${ns}.referencesError`)}
              </StatusText>
            )}
            <FinanceInvoiceTable vm={vm} />
          </>
        ) : (
          <FinanceInvoiceDetail invoice={selected} vm={vm} />
        )}
      </section>
      <CreateInvoiceDialog onOpenChange={setCreateOpen} open={createOpen} vm={vm} />
      <Dialog
        actions={
          <>
            <Button onClick={cancelVoid} theme="outlined" variant="secondary">
              {t(`${ns}.cancel`)}
            </Button>
            <Button disabled={busy} onClick={confirmVoid} variant="danger">
              {t(`${ns}.voidConfirm`)}
            </Button>
          </>
        }
        customTrigger
        description={t(`${ns}.voidDescription`)}
        onOpenChange={(details) => {
          if (!details.open) {
            cancelVoid();
          }
        }}
        open={voidTarget !== undefined}
        placement="center"
        role="alertdialog"
        size="sm"
        title={t(`${ns}.voidTitle`, { number: voidTarget?.number ?? voidTarget?.documentNumber ?? '' })}
      />
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
