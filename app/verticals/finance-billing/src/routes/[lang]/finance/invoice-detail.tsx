import {
  DetailList,
  formatDate,
  formatMoney,
  formatNumber,
  formatPercent,
  PageHeader,
  SectionCard,
  StatusBadge,
} from '@app/admin-ui';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { Table } from '@techsio/ui-kit/organisms/table';
import type { Invoice } from '../../../../shared/apis/records.ts';
import {
  customerDisplayName,
  customerLoadingLabel,
  customerOf,
  invoiceStatusBadge,
  isOverdue,
  isVoidable,
  opportunityTitle,
} from './invoice-view.ts';
import type { useFinanceRecords } from './use-finance-records.ts';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { InvoicePrint } from './invoice-print.tsx';
import { useInvoiceIssuer } from './use-invoice-issuer.ts';
import { SelectTemplate } from '@techsio/ui-kit/templates/select';
import {
  CounterpartyHistory,
  InvoiceDocuments,
  InvoiceHandover,
  InvoicePayments,
  InvoiceReminders,
} from './invoice-extras.tsx';
import { FinanceTableScroll } from './finance-table-scroll.tsx';
import { InvoiceLifecycleCard, PaymentTermsCard, PriorSettlementCard } from './invoice-workflow.tsx';
import { objectSummary } from './object-fields.tsx';
import type { RentalObjects } from './use-rental-objects.ts';
import { lineBaseMinor, lineDiscountMinor, totalDiscountMinor } from '../../../../shared/domain/invoice-totals.ts';

/** Clickable chain from the invoice back to its property, unit, lease and contract. */
const InvoiceAnchors = ({ invoice, objects }: { readonly invoice: Invoice; readonly objects: RentalObjects }) => {
  const lang = typeof window === 'undefined' ? 'cs' : (window.location.pathname.split('/')[1] ?? 'cs');
  const links = [
    invoice.propertyRef === undefined
      ? undefined
      : {
          href: `/${lang}/nemovitosti?resourceId=${invoice.propertyRef.resourceId}`,
          label: `Nemovitost: ${objects.propertyName(invoice.propertyRef.resourceId) ?? 'otevřít'}`,
        },
    invoice.unitRef === undefined
      ? undefined
      : {
          href: `/${lang}/nemovitosti?resourceId=${invoice.unitRef.resourceId}`,
          label: `Jednotka: ${objects.unitName(invoice.unitRef.resourceId) ?? 'otevřít'}`,
        },
    invoice.occupancyRef === undefined
      ? undefined
      : { href: `/${lang}/najmy?resourceId=${invoice.occupancyRef.resourceId}`, label: 'Nájem / pobyt' },
    invoice.contractRef === undefined
      ? undefined
      : { href: `/${lang}/smlouvy?resourceId=${invoice.contractRef.resourceId}`, label: 'Smlouva' },
  ].filter((link) => link !== undefined);
  if (links.length === 0 && invoice.costCenter === undefined) {
    return null;
  }
  return (
    <SectionCard title="Související objekt a vazby">
      <ul className="flex flex-col gap-100 text-sm">
        {invoice.costCenter !== undefined && (
          <li>Středisko: {invoice.costCenter}</li>
        )}
        {links.map((link) => (
          <li key={link.label}>
            <a className="underline" href={link.href} style={{ color: 'var(--color-link)' }}>
              {link.label}
            </a>
          </li>
        ))}
      </ul>
    </SectionCard>
  );
};

const DOCUMENT_KIND_LABEL: Readonly<Record<string, string>> = {
  ADVANCE: 'Zálohová faktura',
  FINAL: 'Konečná faktura',
  PARTIAL: 'Dílčí faktura',
  RECURRING: 'Opakovaná faktura',
  STANDARD: 'Běžná faktura',
};

type FinanceViewModel = ReturnType<typeof useFinanceRecords>;

const ns = 'finance-billing.faktury';

/** Missing amounts render as an em dash instead of a zero. */
const optionalMoney = (minor: number | undefined) => (minor === undefined ? '—' : formatMoney(minor));

interface FinanceInvoiceDetailProps {
  readonly invoice: Invoice;
  readonly vm: FinanceViewModel;
}

export const FinanceInvoiceDetail = ({ invoice, vm }: FinanceInvoiceDetailProps) => {
  const { busy, canWrite, closeDetail, confirmInvoice, referenceDate, references, requestVoid, t } = vm;
  const issuerName = useInvoiceIssuer() ?? 'Údaj neposkytnut';
  const number = invoice.number ?? invoice.documentNumber;
  const isDraft = invoice.businessState === 'DRAFT';
  const lines = invoice.lines ?? [];
  const discountMinor = totalDiscountMinor(lines);
  const priorMinor = (invoice.priorSettlement?.entries ?? []).reduce((sum, entry) => sum + entry.amountMinor, 0);
  const vatRecap = invoice.vatRecap ?? [];
  const customer = customerOf(references.customerById, invoice);
  const title = opportunityTitle(references.opportunityTitles, invoice);
  const sourceLabel =
    invoice.recurringTemplateId !== undefined
      ? `Opakovaná faktura · ${invoice.recurringPeriod ?? 'období neuvedeno'}`
      : invoice.sourceOrder !== undefined
        ? `Objednávka ${invoice.sourceOrder.number}`
        : invoice.opportunityId === undefined
          ? t(`${ns}.sourceManual`)
          : [t(`${ns}.sourceOpportunity`), title].filter((part) => part !== undefined && part !== '').join(' · ');
  const status = invoiceStatusBadge(invoice, referenceDate);
  const incoming = invoice.direction === 'INCOMING';
  const counterpartyName = customerDisplayName(
    customer,
    references.customersLoading && invoice.counterpartyName === undefined
      ? customerLoadingLabel
      : (invoice.counterpartyName ?? t(`${ns}.unknownCustomer`)),
  );

  return (
    <article className="flex min-w-0 flex-col gap-250" data-finance-invoice="">
      <InvoicePrint counterpartyName={counterpartyName} invoice={invoice} issuerName={issuerName} />
      <div className="print:hidden">
        <Button
          className="whitespace-nowrap"
          icon="icon-[mdi--arrow-left]"
          onClick={closeDetail}
          size="sm"
          theme="borderless"
          variant="secondary"
        >
          {t(`${ns}.back`)}
        </Button>
      </div>
      {isDraft && (
        <div
          aria-hidden
          className="pointer-events-none fixed inset-0 z-50 hidden items-center justify-center print:flex"
        >
          <span className="-rotate-30 font-bold text-[9rem] text-fg-secondary opacity-15">NÁVRH</span>
        </div>
      )}
      <PageHeader
        description={`${incoming ? 'Přijatá faktura' : (DOCUMENT_KIND_LABEL[invoice.documentKind ?? 'STANDARD'] ?? '')} · ${t(
          `${ns}.issuedDue`,
          {
            due: formatDate(invoice.dueDate),
            issued: formatDate(invoice.issueDate),
          },
        )}${incoming ? ` · ${counterpartyName}` : ''}`}
        title={number}
      />
      {(invoice.correctsInvoiceRef !== undefined ||
        vm.invoices.some((entry) => entry.correctsInvoiceRef?.resourceId === invoice.ref.resourceId)) && (
        <SectionCard title="Oprava odběratele · DEMO">
          <p className="text-sm">
            {invoice.correctsInvoiceRef === undefined
              ? 'Původní doklad byl stornován kvůli chybnému odběrateli. Historické údaje zůstávají zachované.'
              : 'Náhradní doklad po stornu faktury s chybným odběratelem. Částka a účtované období zůstávají stejné.'}
          </p>
          <a
            className="underline"
            href={`?resourceId=${encodeURIComponent(
              invoice.correctsInvoiceRef?.resourceId ??
                vm.invoices.find((entry) => entry.correctsInvoiceRef?.resourceId === invoice.ref.resourceId)!.ref
                  .resourceId,
            )}`}
          >
            {invoice.correctsInvoiceRef === undefined ? 'Otevřít náhradní doklad' : 'Otevřít původní stornovaný doklad'}
          </a>
        </SectionCard>
      )}
      {isDraft && (
        <div className="flex">
          <Badge size="sm" variant="warning">
            NÁVRH – nejde o odborně schválený účetní doklad
          </Badge>
        </div>
      )}
      {isOverdue(invoice, referenceDate) && (
        <StatusText showIcon status="error">
          {t(`${ns}.overdueNotice`)}
        </StatusText>
      )}
      <div className="grid grid-cols-1 items-start gap-250 xl:grid-cols-[minmax(0,1fr)_24rem]">
        <div className="flex min-w-0 flex-col gap-250">
          <div className="grid grid-cols-1 gap-250 md:grid-cols-2">
            <SectionCard title={t(`${ns}.supplier`)}>
              {incoming ? (
                <DetailList
                  items={[
                    { label: 'Dodavatel', value: counterpartyName },
                    ...(invoice.sourceOrder === undefined
                      ? []
                      : [
                          {
                            label: 'Zdrojová nákupní objednávka',
                            value: (
                              <a
                                className="font-medium text-fg-primary underline"
                                href={`/cs/provoz/nakupy?orderId=${encodeURIComponent(invoice.sourceOrder.id)}`}
                              >
                                {invoice.sourceOrder.number}
                              </a>
                            ),
                          },
                        ]),
                    { label: t(`${ns}.companyId`), value: customer?.companyId ?? invoice.counterpartyCompanyId ?? '—' },
                    { label: 'Číslo dokladu dodavatele', value: invoice.documentNumber },
                    { label: 'Kategorie rozpočtu', value: invoice.budgetCategory ?? '—' },
                    { label: 'Související objekt', value: objectSummary(vm.objects, invoice) ?? '—' },
                  ]}
                />
              ) : (
                <p className="text-sm">{issuerName}</p>
              )}
            </SectionCard>
            <SectionCard title={t(`${ns}.customer`)}>
              {incoming ? (
                <p className="text-sm">{issuerName}</p>
              ) : (
                <DetailList
                  items={[
                    {
                      label: t(`${ns}.columns.customer`),
                      value: counterpartyName,
                    },
                    { label: t(`${ns}.companyId`), value: customer?.companyId ?? invoice.counterpartyCompanyId ?? '—' },
                    { label: t(`${ns}.vatId`), value: customer?.vatId ?? '—' },
                    { label: t(`${ns}.city`), value: customer?.city ?? '—' },
                    { label: t(`${ns}.source`), value: sourceLabel },
                    ...(invoice.recurringPeriod === undefined
                      ? []
                      : [{ label: 'Období opakované faktury', value: invoice.recurringPeriod }]),
                  ]}
                />
              )}
            </SectionCard>
          </div>
          <SectionCard flush title={t(`${ns}.lines`)}>
            {lines.length === 0 ? (
              <p className="px-250 pb-250 text-fg-secondary text-sm">{t(`${ns}.noLines`)}</p>
            ) : (
              <FinanceTableScroll label={t(`${ns}.lines`)}>
              <Table size="sm" variant="line">
                <Table.Header>
                  <Table.Row>
                    <Table.ColumnHeader>{t(`${ns}.colDescription`)}</Table.ColumnHeader>
                    <Table.ColumnHeader align="end">{t(`${ns}.colQuantity`)}</Table.ColumnHeader>
                    <Table.ColumnHeader align="end">{t(`${ns}.colUnitPrice`)}</Table.ColumnHeader>
                    <Table.ColumnHeader align="end">{t(`${ns}.colVat`)}</Table.ColumnHeader>
                    <Table.ColumnHeader align="end">{t(`${ns}.colBase`)}</Table.ColumnHeader>
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {lines.map((line, index) => (
                    <Table.Row key={`${index}-${line.description}-${line.quantity}-${line.unitPriceMinor}-${line.vatRate}`}>
                      <Table.Cell>
                        <span className="flex min-w-0 flex-col">
                          <span>{line.description}</span>
                          {line.priceListItemId !== undefined && (
                            <span className="text-fg-secondary text-xs">z ceníku</span>
                          )}
                          {line.discount !== undefined && (
                            <span className="text-xs" data-finance-line-discount="">
                              Sleva{' '}
                              {line.discount.kind === 'PERCENT'
                                ? `${line.discount.value} %`
                                : formatMoney(line.discount.value)}{' '}
                              (−{formatMoney(lineDiscountMinor(line))}) · důvod: {line.discount.reason}
                            </span>
                          )}
                        </span>
                      </Table.Cell>
                      <Table.Cell align="end" className="tabular-nums">
                        {formatNumber(line.quantity)}
                      </Table.Cell>
                      <Table.Cell align="end" className="tabular-nums">
                        {formatMoney(line.unitPriceMinor)}
                      </Table.Cell>
                      <Table.Cell align="end" className="tabular-nums">
                        {formatPercent(line.vatRate / 100)}
                      </Table.Cell>
                      <Table.Cell align="end" className="tabular-nums">
                        {formatMoney(lineBaseMinor(line))}
                      </Table.Cell>
                    </Table.Row>
                  ))}
                </Table.Body>
              </Table>
              </FinanceTableScroll>
            )}
          </SectionCard>
          <PriorSettlementCard invoice={invoice} vm={vm} />
          <InvoicePayments invoice={invoice} vm={vm} />
          <PaymentTermsCard invoice={invoice} vm={vm} />
          <InvoiceDocuments invoice={invoice} vm={vm} />
          <div className="print:hidden">
            <InvoiceReminders counterpartyName={counterpartyName} invoice={invoice} vm={vm} />
          </div>
        </div>
        <div className="flex min-w-0 flex-col gap-250 xl:sticky xl:top-[5rem]">
          <SectionCard title={t(`${ns}.totals`)}>
            <div className="flex flex-col gap-200">
              <DetailList
                items={[
                  ...(discountMinor === 0
                    ? []
                    : [
                        {
                          label: 'Cena před slevou',
                          value: <span className="tabular-nums">{formatMoney((invoice.subtotalMinor ?? 0) + discountMinor)}</span>,
                        },
                        {
                          label: 'Schválená sleva',
                          value: <span className="tabular-nums">− {formatMoney(discountMinor)}</span>,
                        },
                      ]),
                  {
                    label: t(`${ns}.subtotal`),
                    value: <span className="tabular-nums">{optionalMoney(invoice.subtotalMinor)}</span>,
                  },
                ]}
              />
              <div className="flex flex-col gap-100">
                <span className="text-fg-secondary text-sm">{t(`${ns}.vatRecap`)}</span>
                {vatRecap.length === 0 ? (
                  <p className="text-fg-secondary text-sm">—</p>
                ) : (
                  <Table size="sm" variant="line">
                    <Table.Header>
                      <Table.Row>
                        <Table.ColumnHeader align="end">{t(`${ns}.vatRate`)}</Table.ColumnHeader>
                        <Table.ColumnHeader align="end">{t(`${ns}.vatBase`)}</Table.ColumnHeader>
                        <Table.ColumnHeader align="end">{t(`${ns}.vatAmount`)}</Table.ColumnHeader>
                      </Table.Row>
                    </Table.Header>
                    <Table.Body>
                      {vatRecap.map((entry) => (
                        <Table.Row key={entry.rate}>
                          <Table.Cell align="end" className="tabular-nums">
                            {formatPercent(entry.rate / 100)}
                          </Table.Cell>
                          <Table.Cell align="end" className="tabular-nums">
                            {formatMoney(entry.baseMinor)}
                          </Table.Cell>
                          <Table.Cell align="end" className="tabular-nums">
                            {formatMoney(entry.vatMinor)}
                          </Table.Cell>
                        </Table.Row>
                      ))}
                    </Table.Body>
                  </Table>
                )}
              </div>
              <DetailList
                items={[
                  {
                    label: t(`${ns}.vatTotal`),
                    value: <span className="tabular-nums">{optionalMoney(invoice.vatMinor)}</span>,
                  },
                  {
                    label: t(`${ns}.total`),
                    value: <span className="font-semibold tabular-nums">{formatMoney(invoice.totalMinor)}</span>,
                  },
                  ...(priorMinor === 0
                    ? []
                    : [
                        {
                          label: 'Zohledněno z předchozích dokladů',
                          value: <span className="tabular-nums">− {formatMoney(priorMinor)}</span>,
                        },
                      ]),
                  {
                    label: priorMinor === 0 ? t(`${ns}.paid`) : 'Uhrazeno (včetně zohledněných záloh)',
                    value: <span className="tabular-nums">{formatMoney(invoice.paidMinor)}</span>,
                  },
                ]}
              />
            </div>
          </SectionCard>
          <SectionCard title={t(`${ns}.columns.status`)}>
            <InvoiceLifecycleCard invoice={invoice} vm={vm} />
            {invoice.businessState === 'CONFIRMED' && (
              <div className="mt-100">
                <StatusBadge kind={status.kind} value={status.value} />
              </div>
            )}
            {!incoming && (
              <div className="print:hidden">
                <SelectTemplate
                  disabled={!canWrite || !isDraft || busy}
                  items={Object.entries(DOCUMENT_KIND_LABEL).map(([value, label]) => ({
                    displayValue: label,
                    label,
                    value,
                  }))}
                  label="Druh dokladu"
                  labelProps={{ className: 'font-label text-label-sm' }}
                  onValueChange={({ value }) => {
                    const [next] = value;
                    if (
                      next === 'STANDARD' ||
                      next === 'ADVANCE' ||
                      next === 'PARTIAL' ||
                      next === 'FINAL' ||
                      next === 'RECURRING'
                    ) {
                      void vm.execute(
                        { _tag: 'SetInvoiceDetails', documentKind: next, invoiceRef: invoice.ref },
                        'Druh dokladu uložen',
                      );
                    }
                  }}
                  size="sm"
                  value={[invoice.documentKind ?? 'STANDARD']}
                />
                {(invoice.documentKind === 'FINAL' || invoice.documentKind === 'PARTIAL') && (
                  <p className="mt-100 text-fg-secondary text-xs">
                    Odkazy na dřívější zálohové a dílčí faktury a ručně potvrzené částky jsou v sekci Předchozí zálohové
                    a dílčí doklady.
                  </p>
                )}
              </div>
            )}
          </SectionCard>
          <div className="print:hidden">
            <InvoiceHandover invoice={invoice} vm={vm} />
          </div>
          <InvoiceAnchors invoice={invoice} objects={vm.objects} />
          <div className="print:hidden">
            <CounterpartyHistory invoice={invoice} vm={vm} />
          </div>
          <div className="flex flex-wrap items-center gap-100 print:hidden">
            <Button
              className="whitespace-nowrap"
              icon="icon-[mdi--printer-outline]"
              onClick={() => window.print()}
              size="sm"
              theme="outlined"
              variant="secondary"
            >
              {isDraft ? 'Tisk / PDF (NÁVRH)' : t(`${ns}.print`)}
            </Button>
            {canWrite && isVoidable(invoice) && (
              <Button
                className="whitespace-nowrap"
                disabled={busy}
                onClick={() => requestVoid(invoice)}
                size="sm"
                theme="outlined"
                variant="secondary"
              >
                {t(`${ns}.void`)}
              </Button>
            )}
            {canWrite && isDraft && invoice.reviewState !== 'PREPARED' && (
              <Button
                className="whitespace-nowrap"
                disabled={busy}
                icon="icon-[mdi--clipboard-check-outline]"
                onClick={() =>
                  void vm.execute(
                    {
                      _tag: 'MarkInvoicesPrepared',
                      ...(vm.actorLabel === undefined ? {} : { actorLabel: vm.actorLabel }),
                      invoiceRefs: [invoice.ref],
                    },
                    'Doklad připraven ke schválení',
                  )
                }
                size="sm"
                variant="primary"
              >
                Připravit ke schválení
              </Button>
            )}
            {canWrite && isDraft && invoice.reviewState === 'PREPARED' && (
              <>
                <Button
                  className="whitespace-nowrap"
                  disabled={busy}
                  icon="icon-[mdi--undo]"
                  onClick={() =>
                    void vm.execute({ _tag: 'ReturnInvoiceToDraft', invoiceRef: invoice.ref }, 'Doklad vrácen do návrhu')
                  }
                  size="sm"
                  theme="outlined"
                  variant="secondary"
                >
                  Vrátit do návrhu
                </Button>
                <Button
                  className="whitespace-nowrap"
                  disabled={busy}
                  icon="icon-[mdi--check-circle-outline]"
                  isLoading={busy}
                  loadingText={t(`${ns}.confirming`)}
                  onClick={() => confirmInvoice(invoice)}
                  size="sm"
                  variant="primary"
                >
                  {t(`${ns}.confirmAction`)}
                </Button>
              </>
            )}
          </div>
        </div>
      </div>
    </article>
  );
};
