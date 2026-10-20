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
import type { Invoice } from '../../../../../shared/apis/records.ts';
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
import { InvoiceDocuments, InvoiceHandover, InvoicePayments, InvoiceReminders } from './invoice-extras.tsx';

/** Clickable chain from the invoice back to its property, unit, lease and contract. */
const InvoiceAnchors = ({ invoice }: { readonly invoice: Invoice }) => {
  const lang = typeof window === 'undefined' ? 'cs' : (window.location.pathname.split('/')[1] ?? 'cs');
  const links = [
    invoice.propertyRef === undefined
      ? undefined
      : { href: `/${lang}/siampark/properties?resourceId=${invoice.propertyRef.resourceId}`, label: 'Nemovitost' },
    invoice.unitRef === undefined
      ? undefined
      : { href: `/${lang}/siampark/properties?resourceId=${invoice.unitRef.resourceId}`, label: 'Jednotka' },
    invoice.occupancyRef === undefined
      ? undefined
      : { href: `/${lang}/siampark/occupancy?resourceId=${invoice.occupancyRef.resourceId}`, label: 'Nájem / pobyt' },
    invoice.contractRef === undefined
      ? undefined
      : { href: `/${lang}/siampark/agreements?resourceId=${invoice.contractRef.resourceId}`, label: 'Smlouva' },
  ].filter((link) => link !== undefined);
  if (links.length === 0) {
    return null;
  }
  return (
    <SectionCard title="Vazby">
      <ul className="flex flex-col gap-100 text-sm">
        {links.map((link) => (
          <li key={link.label}>
            <a
              className="inline-flex items-center gap-50 text-fg-link underline-offset-2 hover:underline"
              href={link.href}
            >
              <span aria-hidden className="icon-[mdi--link-variant] size-4" />
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

const ns = 'siampark-billing-finance.faktury';

/** Missing amounts render as an em dash instead of a zero. */
const optionalMoney = (minor: number | undefined) => (minor === undefined ? '—' : formatMoney(minor));

interface FinanceInvoiceDetailProps {
  readonly invoice: Invoice;
  readonly vm: FinanceViewModel;
}

export const FinanceInvoiceDetail = ({ invoice, vm }: FinanceInvoiceDetailProps) => {
  const { busy, canWrite, closeDetail, confirmInvoice, referenceDate, references, requestVoid, t } = vm;
  const number = invoice.number ?? invoice.documentNumber;
  const isDraft = invoice.businessState === 'DRAFT';
  const lines = invoice.lines ?? [];
  const vatRecap = invoice.vatRecap ?? [];
  const customer = customerOf(references.customerById, invoice);
  const title = opportunityTitle(references.opportunityTitles, invoice);
  const sourceLabel =
    invoice.opportunityId === undefined
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
    <>
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
                    { label: t(`${ns}.companyId`), value: customer?.companyId ?? invoice.counterpartyCompanyId ?? '—' },
                    { label: 'Číslo dokladu dodavatele', value: invoice.documentNumber },
                    { label: 'Kategorie rozpočtu', value: invoice.budgetCategory ?? '—' },
                  ]}
                />
              ) : (
                <p className="text-sm">{t(`${ns}.supplierName`)}</p>
              )}
            </SectionCard>
            <SectionCard title={t(`${ns}.customer`)}>
              {incoming ? (
                <p className="text-sm">{t(`${ns}.supplierName`)}</p>
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
                  {lines.map((line) => (
                    <Table.Row key={`${line.description}-${line.quantity}-${line.unitPriceMinor}-${line.vatRate}`}>
                      <Table.Cell>{line.description}</Table.Cell>
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
                        {formatMoney(line.quantity * line.unitPriceMinor)}
                      </Table.Cell>
                    </Table.Row>
                  ))}
                </Table.Body>
              </Table>
            )}
          </SectionCard>
          <InvoicePayments invoice={invoice} vm={vm} />
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
                  {
                    label: t(`${ns}.paid`),
                    value: <span className="tabular-nums">{formatMoney(invoice.paidMinor)}</span>,
                  },
                ]}
              />
            </div>
          </SectionCard>
          <SectionCard title={t(`${ns}.columns.status`)}>
            <StatusBadge kind={status.kind} value={status.value} />
          </SectionCard>
          <div className="print:hidden">
            <InvoiceHandover invoice={invoice} vm={vm} />
          </div>
          <InvoiceAnchors invoice={invoice} />
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
            {canWrite && isDraft && (
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
                {t(`${ns}.confirm`)}
              </Button>
            )}
          </div>
        </div>
      </div>
    </>
  );
};
