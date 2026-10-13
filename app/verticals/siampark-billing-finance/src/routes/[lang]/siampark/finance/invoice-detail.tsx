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
import { customerDisplayName, customerOf, isOverdue, opportunityTitle, paymentKind } from './invoice-view.ts';
import type { useFinanceRecords } from './use-finance-records.ts';

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

  return (
    <>
      <div className="print:hidden">
        <Button icon="icon-[mdi--arrow-left]" onClick={closeDetail} size="sm" theme="borderless" variant="secondary">
          {t(`${ns}.back`)}
        </Button>
      </div>
      <PageHeader
        actions={
          <div className="flex flex-wrap items-center gap-100 print:hidden">
            <Button
              icon="icon-[mdi--printer-outline]"
              onClick={() => window.print()}
              size="sm"
              theme="outlined"
              variant="secondary"
            >
              {t(`${ns}.print`)}
            </Button>
            {canWrite && isDraft && (
              <Button
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
        }
        description={t(`${ns}.issuedDue`, {
          due: formatDate(invoice.dueDate),
          issued: formatDate(invoice.issueDate),
        })}
        meta={
          <>
            <StatusBadge kind="invoice" value={invoice.businessState} />
            <StatusBadge kind="payment" value={paymentKind(invoice, referenceDate)} />
          </>
        }
        title={number}
      />
      {isOverdue(invoice, referenceDate) && (
        <StatusText showIcon status="error">
          {t(`${ns}.overdueNotice`)}
        </StatusText>
      )}
      <div className="grid grid-cols-1 items-start gap-250 xl:grid-cols-3">
        <div className="flex min-w-0 flex-col gap-250 xl:col-span-2">
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
          <SectionCard flush title={t(`${ns}.vatRecap`)}>
            {vatRecap.length === 0 ? (
              <p className="px-250 pb-250 text-fg-secondary text-sm">—</p>
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
          </SectionCard>
        </div>
        <div className="flex min-w-0 flex-col gap-250">
          <SectionCard title={t(`${ns}.supplier`)}>
            <p className="text-sm">{t(`${ns}.supplierName`)}</p>
          </SectionCard>
          <SectionCard title={t(`${ns}.customer`)}>
            <DetailList
              items={[
                {
                  label: t(`${ns}.columns.customer`),
                  value: customerDisplayName(customer, t(`${ns}.unknownCustomer`)),
                },
                { label: t(`${ns}.companyId`), value: customer?.companyId ?? '—' },
                { label: t(`${ns}.vatId`), value: customer?.vatId ?? '—' },
                { label: t(`${ns}.city`), value: customer?.city ?? '—' },
                { label: t(`${ns}.source`), value: sourceLabel },
              ]}
            />
          </SectionCard>
          <SectionCard title={t(`${ns}.totals`)}>
            <DetailList
              items={[
                {
                  label: t(`${ns}.subtotal`),
                  value: <span className="tabular-nums">{optionalMoney(invoice.subtotalMinor)}</span>,
                },
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
          </SectionCard>
        </div>
      </div>
    </>
  );
};
