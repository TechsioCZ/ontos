import { useRouterState } from '@modern-js/plugin-tanstack/runtime';
import { FederatedI18nBoundary } from '@modern-js/plugin-i18n/runtime';
import {
  formatDate,
  formatMoney,
  formatNumber,
  PageHeader,
  StatCard,
  StatRow,
  Toaster,
  dialogCloseLabel,
} from '@app/admin-ui';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { Dialog } from '@techsio/ui-kit/molecules/dialog';
import { Tabs } from '@techsio/ui-kit/molecules/tabs';
import { useState } from 'react';
import { Option } from 'effect';
import csResource from '../../../../../locales/cs/siampark-billing-finance.json';
import enResource from '../../../../../locales/en/siampark-billing-finance.json';
import '../../../index.css';
import { UltramodernRouteHead } from '../../../ultramodern-route-head';
import { CreateInvoiceDialog } from './create-invoice-dialog.tsx';
import { FinanceInvoiceDetail } from './invoice-detail.tsx';
import { FinanceInvoiceTable } from './invoices-table.tsx';
import { AccountingPanel } from './accounting-panel.tsx';
import { IncomingInvoiceDialog } from './incoming-invoice-dialog.tsx';
import { PlanningPanel } from './planning-panel.tsx';
import { RecurringPanel } from './recurring-panel.tsx';
import { customerInvoiceFilterKey, decodeCustomerInvoiceSearch, useFinanceRecords } from './use-finance-records.ts';

const resources = {
  cs: { 'siampark-billing-finance': csResource },
  en: { 'siampark-billing-finance': enResource },
} as const;

const ns = 'siampark-billing-finance.faktury';

/** KPI tiles show whole Kč; the table keeps exact amounts. */
const wholeKc = (minor: number) => formatMoney(Math.round(minor / 100) * 100);

const TABS = ['faktury', 'opakovane', 'predani', 'plan'] as const;
type FinanceTab = (typeof TABS)[number];
const initialTab = (): FinanceTab => {
  if (typeof window === 'undefined') {
    return 'faktury';
  }
  const value = new URL(window.location.href).searchParams.get('tab');
  return TABS.find((tab) => tab === value) ?? 'faktury';
};

const RecordsPageContent = () => {
  const vm = useFinanceRecords();
  const {
    busy,
    cancelConfirm,
    cancelVoid,
    canWrite,
    confirmPending,
    confirmTarget,
    confirmVoid,
    feedback,
    indicators,
    references,
    selected,
    t,
    voidTarget,
  } = vm;
  const [createOpen, setCreateOpen] = useState(false);
  const [incomingOpen, setIncomingOpen] = useState(false);
  const [tab, setTabState] = useState<FinanceTab>(initialTab);
  const setTab = (next: string) => {
    const value = TABS.find((entry) => entry === next) ?? 'faktury';
    setTabState(value);
    const url = new URL(window.location.href);
    url.searchParams.set('tab', value);
    window.history.replaceState(window.history.state, '', url);
  };
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
                  <div className="flex flex-wrap gap-100">
                    <Button
                      className="whitespace-nowrap"
                      icon="icon-[mdi--file-download-outline]"
                      onClick={() => setIncomingOpen(true)}
                      size="sm"
                      theme="outlined"
                      variant="secondary"
                    >
                      Přijatá faktura
                    </Button>
                    <Button
                      className="whitespace-nowrap"
                      disabled={references.productsReadable === undefined}
                      icon="icon-[mdi--plus]"
                      onClick={() => setCreateOpen(true)}
                      size="sm"
                      variant="primary"
                    >
                      {t(`${ns}.newInvoice`)}
                    </Button>
                  </div>
                ) : undefined
              }
              description={t(`${ns}.${references.productsReadable === false ? 'rentalDescription' : 'description'}`)}
              title={t(`${ns}.title`)}
            />
            {vm.relatedCustomer && (
              <p className="text-fg-secondary text-sm">
                {t(`${ns}.relatedFilter`)}{' '}
                <a className="underline" href="?">
                  {t(`${ns}.clearRelatedFilter`)}
                </a>
              </p>
            )}
            <StatRow>
              <StatCard label={t(`${ns}.kpi.revenue`)} value={kpi((source) => wholeKc(source.revenueMinor))} />
              <StatCard
                label={t(`${ns}.kpi.outstanding`)}
                value={kpi((source) => wholeKc(source.grossOutstandingMinor))}
              />
              <StatCard
                label={
                  vm.referenceDate === ''
                    ? t(`${ns}.kpi.overdue`)
                    : `${t(`${ns}.kpi.overdue`)} k ${formatDate(vm.referenceDate)}`
                }
                value={kpi((source) => formatNumber(source.overdueInvoices))}
              />
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
            {vm.snapshot === undefined && feedback === 'loading' && (
              <StatusText showIcon status="default">
                Načítám finanční evidenci…
              </StatusText>
            )}
            <Tabs onValueChange={setTab} size="sm" value={tab} variant="line">
              <Tabs.List>
                <Tabs.Trigger value="faktury">Faktury</Tabs.Trigger>
                <Tabs.Trigger value="opakovane">Opakované faktury</Tabs.Trigger>
                <Tabs.Trigger value="predani">Účetní předání</Tabs.Trigger>
                <Tabs.Trigger value="plan">Rozpočet a cash-flow</Tabs.Trigger>
                <Tabs.Indicator />
              </Tabs.List>
              <Tabs.Content className="flex flex-col gap-250 pt-250" value="faktury">
                <FinanceInvoiceTable vm={vm} />
              </Tabs.Content>
              <Tabs.Content className="pt-250" value="opakovane">
                {tab === 'opakovane' && vm.snapshot !== undefined && <RecurringPanel vm={vm} />}
              </Tabs.Content>
              <Tabs.Content className="pt-250" value="predani">
                {tab === 'predani' && vm.snapshot !== undefined && <AccountingPanel vm={vm} />}
              </Tabs.Content>
              <Tabs.Content className="pt-250" value="plan">
                {tab === 'plan' && vm.snapshot !== undefined && <PlanningPanel vm={vm} />}
              </Tabs.Content>
            </Tabs>
          </>
        ) : (
          <FinanceInvoiceDetail invoice={selected} vm={vm} />
        )}
      </section>
      {references.productsReadable !== undefined && (
        <CreateInvoiceDialog onOpenChange={setCreateOpen} open={createOpen} vm={vm} />
      )}
      {canWrite && <IncomingInvoiceDialog onOpenChange={setIncomingOpen} open={incomingOpen} vm={vm} />}
      <Dialog
        actions={
          <>
            <Button onClick={cancelConfirm} theme="outlined" variant="secondary">
              {t(`${ns}.cancel`)}
            </Button>
            <Button disabled={busy} onClick={confirmPending} variant="primary">
              {t(`${ns}.confirmAction`)}
            </Button>
          </>
        }
        closeLabel={dialogCloseLabel}
        customTrigger
        description={t(`${ns}.confirmDescription`)}
        onOpenChange={(details) => {
          if (!details.open) {
            cancelConfirm();
          }
        }}
        open={confirmTarget !== undefined}
        placement="center"
        role="alertdialog"
        size="sm"
        title={t(`${ns}.confirmTitle`, { number: confirmTarget?.number ?? confirmTarget?.documentNumber ?? '' })}
      />
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
        closeLabel={dialogCloseLabel}
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

export const RecordsPage = () => {
  const rawSearch = useRouterState({
    select: (state) => {
      const input: unknown = state.location.search;
      return decodeCustomerInvoiceSearch(input).pipe(Option.getOrElse(() => null));
    },
  });
  const filterKey = customerInvoiceFilterKey(rawSearch);
  return (
    <FederatedI18nBoundary
      defaultNamespace="siampark-billing-finance"
      fallbackLanguage="en"
      resources={resources}
      supportedLanguages={['en', 'cs']}
    >
      <RecordsPageContent key={filterKey} />
    </FederatedI18nBoundary>
  );
};
export default RecordsPage;
