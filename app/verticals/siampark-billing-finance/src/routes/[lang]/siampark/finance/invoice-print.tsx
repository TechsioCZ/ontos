import { formatDate, formatMoney, formatNumber, formatPercent } from '@app/admin-ui';
import type { Invoice } from '../../../../../shared/apis/records.ts';

/** A clean browser-print sheet, isolated from application navigation and interactive controls. */
export const InvoicePrint = ({
  invoice,
  counterpartyName,
  issuerName,
}: {
  readonly invoice: Invoice;
  readonly counterpartyName: string;
  readonly issuerName: string;
}) => {
  const draft = invoice.businessState === 'DRAFT';
  const incoming = invoice.direction === 'INCOMING';
  return (
    <section aria-hidden data-finance-print-sheet="">
      {draft && <div className="finance-print-watermark">NÁVRH</div>}
      <h1>
        {incoming ? 'Přijatá faktura' : 'Faktura'} {invoice.number ?? invoice.documentNumber}
      </h1>
      <p>
        {draft
          ? 'NÁVRH – nejde o odborně schválený účetní doklad.'
          : 'Pracovní evidence OntOS – nejde o potvrzení zaúčtování.'}
      </p>
      <div className="finance-print-parties">
        <div>
          <h2>Dodavatel</h2>
          <p>{incoming ? counterpartyName : issuerName}</p>
        </div>
        <div>
          <h2>Odběratel</h2>
          <p>{incoming ? issuerName : counterpartyName}</p>
        </div>
      </div>
      <dl className="finance-print-dates">
        <dt>Datum vystavení</dt>
        <dd>{formatDate(invoice.issueDate)}</dd>
        <dt>Datum splatnosti</dt>
        <dd>{formatDate(invoice.dueDate)}</dd>
        <dt>Měna</dt>
        <dd>{invoice.currency}</dd>
      </dl>
      {(invoice.lines?.length ?? 0) > 0 ? (
        <table>
          <thead>
            <tr>
              <th>Položka</th>
              <th>Množství</th>
              <th>Cena za kus</th>
              <th>DPH</th>
              <th>Základ</th>
            </tr>
          </thead>
          <tbody>
            {invoice.lines?.map((line, index) => (
              <tr key={index}>
                <td>{line.description}</td>
                <td>{formatNumber(line.quantity)}</td>
                <td>{formatMoney(line.unitPriceMinor)}</td>
                <td>{formatPercent(line.vatRate / 100)}</td>
                <td>{formatMoney(line.quantity * line.unitPriceMinor)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p>Podrobné položky jsou uvedeny v přiloženém dokladu dodavatele.</p>
      )}
      <dl className="finance-print-totals">
        {invoice.subtotalMinor !== undefined && (
          <>
            <dt>Základ celkem</dt>
            <dd>{formatMoney(invoice.subtotalMinor)}</dd>
          </>
        )}
        {invoice.vatMinor !== undefined && (
          <>
            <dt>DPH celkem</dt>
            <dd>{formatMoney(invoice.vatMinor)}</dd>
          </>
        )}
        <dt>
          <strong>Celkem</strong>
        </dt>
        <dd>
          <strong>{formatMoney(invoice.totalMinor)}</strong>
        </dd>
        <dt>Potvrzené úhrady</dt>
        <dd>{formatMoney(invoice.paidMinor)}</dd>
        <dt>Zbývá uhradit</dt>
        <dd>{formatMoney(Math.max(0, invoice.totalMinor - invoice.paidMinor))}</dd>
      </dl>
      <footer>Vytvořeno z pracovní evidence OntOS. Daňové a účetní posouzení provádí odpovědná účetní.</footer>
    </section>
  );
};
