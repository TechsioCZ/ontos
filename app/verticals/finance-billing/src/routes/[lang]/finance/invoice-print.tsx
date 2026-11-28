import { invoiceLineKey, withOccurrenceKeys } from './finance-ui.tsx';
import { Fragment } from 'react';
import { formatDate, formatMoney, formatNumber, formatPercent } from '@app/admin-ui';
import type { Invoice } from '../../../../shared/apis/records.ts';
import { lineBaseMinor, lineDiscountMinor, totalDiscountMinor } from '../../../../shared/domain/invoice-totals.ts';

const discountLabel = (discount: NonNullable<NonNullable<Invoice['lines']>[number]['discount']>) =>
  discount.kind === 'PERCENT' ? `${discount.value} %` : formatMoney(discount.value);

/** A clean browser-print sheet, isolated from application navigation and interactive controls. */
export const InvoicePrint = ({
  counterpartyName,
  invoice,
  issuerName,
}: {
  readonly counterpartyName: string;
  readonly invoice: Invoice;
  readonly issuerName: string;
}) => {
  const draft = invoice.businessState === 'DRAFT';
  const incoming = invoice.direction === 'INCOMING';
  return (
    <section
      aria-hidden
      className="relative hidden bg-base font-[Arial,sans-serif] text-fg-primary text-sm leading-normal"
      data-finance-print-sheet=""
    >
      {draft && (
        <div className="pointer-events-none fixed inset-x-0 top-[40%] -rotate-30 text-center font-bold text-[7.5rem] text-fg-primary opacity-10">
          NÁVRH
        </div>
      )}
      <h1 className="mb-7.5 text-xl">
        {incoming ? 'Přijatá faktura' : 'Faktura'} {invoice.number ?? invoice.documentNumber}
      </h1>
      <p className="mb-4">
        {draft
          ? 'NÁVRH – nejde o odborně schválený účetní doklad.'
          : 'Pracovní evidence OntOS – nejde o potvrzení zaúčtování.'}
      </p>
      <div className="my-9.5 grid grid-cols-2 gap-9.5">
        <div>
          <h2 className="mb-2 text-base">Dodavatel</h2>
          <p className="mb-4">{incoming ? counterpartyName : issuerName}</p>
        </div>
        <div>
          <h2 className="mb-2 text-base">Odběratel</h2>
          <p className="mb-4">{incoming ? issuerName : counterpartyName}</p>
        </div>
      </div>
      <dl className="my-5.5 grid grid-cols-2 gap-x-9.5 gap-y-2">
        <dt>Datum vystavení</dt>
        <dd className="text-right tabular-nums">{formatDate(invoice.issueDate)}</dd>
        <dt>Datum splatnosti</dt>
        <dd className="text-right tabular-nums">{formatDate(invoice.dueDate)}</dd>
        <dt>Měna</dt>
        <dd className="text-right tabular-nums">{invoice.currency}</dd>
      </dl>
      {(invoice.lines?.length ?? 0) > 0 ? (
        <table className="my-9.5 w-full border-collapse">
          <thead>
            <tr>
              <th className="border-b border-border-primary px-2 py-3 text-left">Položka</th>
              <th className="border-b border-border-primary px-2 py-3 text-right">Množství</th>
              <th className="border-b border-border-primary px-2 py-3 text-right">Cena za kus</th>
              <th className="border-b border-border-primary px-2 py-3 text-right">DPH</th>
              <th className="border-b border-border-primary px-2 py-3 text-right">Základ</th>
            </tr>
          </thead>
          <tbody>
            {withOccurrenceKeys(invoice.lines ?? [], (line) => invoiceLineKey(line)).map(({ key, value: line }) => (
              <tr key={key}>
                <td className="border-b border-border-primary px-2 py-3 text-left">
                  {line.description}
                  {line.discount !== undefined &&
                    ` (sleva ${discountLabel(line.discount)} = −${formatMoney(lineDiscountMinor(line))}, ${line.discount.reason})`}
                </td>
                <td className="border-b border-border-primary px-2 py-3 text-right">{formatNumber(line.quantity)}</td>
                <td className="border-b border-border-primary px-2 py-3 text-right">
                  {formatMoney(line.unitPriceMinor)}
                </td>
                <td className="border-b border-border-primary px-2 py-3 text-right">
                  {formatPercent(line.vatRate / 100)}
                </td>
                <td className="border-b border-border-primary px-2 py-3 text-right">
                  {formatMoney(lineBaseMinor(line))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="mb-4">Podrobné položky jsou uvedeny v přiloženém dokladu dodavatele.</p>
      )}
      <dl className="my-5.5 ml-[40%] grid break-inside-avoid grid-cols-2 gap-x-9.5 gap-y-2">
        {invoice.subtotalMinor !== undefined && (
          <>
            <dt>Základ celkem</dt>
            <dd className="text-right tabular-nums">{formatMoney(invoice.subtotalMinor)}</dd>
          </>
        )}
        {invoice.vatMinor !== undefined && (
          <>
            <dt>DPH celkem</dt>
            <dd className="text-right tabular-nums">{formatMoney(invoice.vatMinor)}</dd>
          </>
        )}
        <dt>
          <strong>Celkem</strong>
        </dt>
        <dd className="text-right tabular-nums">
          <strong>{formatMoney(invoice.totalMinor)}</strong>
        </dd>
        {totalDiscountMinor(invoice.lines ?? []) > 0 && (
          <>
            <dt>Schválená sleva (v základu)</dt>
            <dd className="text-right tabular-nums">− {formatMoney(totalDiscountMinor(invoice.lines ?? []))}</dd>
          </>
        )}
        {invoice.priorSettlement?.entries.map((entry) => (
          <Fragment key={entry.invoiceResourceId}>
            <dt>Zohledněno z dokladu {entry.number}</dt>
            <dd className="text-right tabular-nums">− {formatMoney(entry.amountMinor)}</dd>
          </Fragment>
        ))}
        <dt>Potvrzené úhrady</dt>
        <dd className="text-right tabular-nums">{formatMoney(invoice.paidMinor)}</dd>
        <dt>Zbývá uhradit</dt>
        <dd className="text-right tabular-nums">{formatMoney(Math.max(0, invoice.totalMinor - invoice.paidMinor))}</dd>
      </dl>
      {invoice.paymentTerms !== undefined && (
        <p className="mb-4">
          {invoice.paymentTerms.skontoText === undefined ? '' : `Skonto: ${invoice.paymentTerms.skontoText}. `}
          {invoice.paymentTerms.lateInterestText === undefined
            ? ''
            : `Úrok z prodlení: ${invoice.paymentTerms.lateInterestText}.`}
        </p>
      )}
      <footer className="mt-17 border-t border-border-primary pt-4 text-xs text-fg-secondary">
        Vytvořeno z pracovní evidence OntOS. Daňové a účetní posouzení provádí odpovědná účetní.
      </footer>
    </section>
  );
};
