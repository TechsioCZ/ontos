import type { Invoice, InvoiceLine, VatRate, VatRecapEntry } from '../apis/records.ts';
import { POHODA_DATAPACK_VERSION } from '../apis/records.ts';
import type { ExportIssuer, ExportMeta, ExportPartnerIdentity, ExportRow } from './finance-planning.ts';
import { computeInvoiceTotals, lineBaseMinor, lineGrossMinor, lineVatMinor } from './invoice-totals.ts';

/** Official STORMWARE namespaces of POHODA XML version 2 (https://www.stormware.cz/xml/schema/version_2/). */
/* oxlint-disable sonarjs/no-clear-text-protocols -- Approved demo/sales-crm exception: official XML namespace URIs require exact byte identity. */
export const POHODA_NAMESPACES = {
  dat: 'http://www.stormware.cz/schema/version_2/data.xsd',
  inv: 'http://www.stormware.cz/schema/version_2/invoice.xsd',
  typ: 'http://www.stormware.cz/schema/version_2/type.xsd',
} as const;
/* oxlint-enable sonarjs/no-clear-text-protocols */

/** Written to the POHODA internal note of a received invoice that has no VAT breakdown in OntOS. */
export const POHODA_NO_VAT_BREAKDOWN_NOTE =
  'Rozpis DPH není v OntOS evidován – účetní doplní členění DPH podle originálu dokladu.';

const xmlEscape = (value: string) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');

/** XSD character limits count Unicode code points; the string iterator retains surrogate pairs. */
const text = (value: string, maxLength: number) => {
  const codePoints = value.trim()[Symbol.iterator]();
  return xmlEscape([...codePoints].slice(0, maxLength).join(''));
};

/** Haléře → "1234.50" (POHODA amounts use a dot and two decimals). */
const money = (minor: number) => (minor / 100).toFixed(2);

/** Czech VAT rate → POHODA `typ:vatRateType`: 21 % high, 12 % low, 10 % third, 0 % none. */
export const pohodaVatRate = (rate: VatRate): 'high' | 'low' | 'none' | 'third' => {
  if (rate === 21) {
    return 'high';
  }
  if (rate === 12) {
    return 'low';
  }
  if (rate === 10) {
    return 'third';
  }
  return 'none';
};

export const pohodaInvoiceType = (invoice: Pick<Invoice, 'direction' | 'documentKind'>) => {
  const advance = invoice.documentKind === 'ADVANCE';
  if (invoice.direction === 'OUTGOING') {
    return advance ? 'issuedAdvanceInvoice' : 'issuedInvoice';
  }
  return advance ? 'receivedAdvanceInvoice' : 'receivedInvoice';
};

/** Variable symbol: the digits of the document number, at most the last 10; undefined when it has no digits. */
export const variableSymbol = (documentNumber: string): string | undefined => {
  const digits = documentNumber.replaceAll(/\D/gu, '');
  return digits === '' ? undefined : digits.slice(-10);
};

/** The stored VAT recap, else one computed from the line snapshots, else undefined (no VAT breakdown known). */
export const vatRecapOf = (invoice: Pick<Invoice, 'lines' | 'vatRecap'>): readonly VatRecapEntry[] | undefined =>
  invoice.vatRecap ?? (invoice.lines === undefined ? undefined : computeInvoiceTotals(invoice.lines)?.vatRecap);

interface AddressParts {
  readonly city?: string | undefined;
  readonly company?: string | undefined;
  readonly dic?: string | undefined;
  readonly ico?: string | undefined;
  readonly street?: string | undefined;
  readonly zip?: string | undefined;
}

/** `typ:address` children in XSD order (company, city, street, zip, ico, dic); empty parts are left out. */
const addressXml = (parts: AddressParts, indent: string) => {
  const fields: readonly (readonly [string, string | undefined, number])[] = [
    ['company', parts.company, 255],
    ['city', parts.city, 45],
    ['street', parts.street, 64],
    ['zip', parts.zip, 15],
    ['ico', parts.ico, 15],
    ['dic', parts.dic, 18],
  ];
  const lines = fields.flatMap(([name, value, max]) =>
    value === undefined || value.trim() === '' ? [] : [`${indent}  <typ:${name}>${text(value, max)}</typ:${name}>`],
  );
  return lines.length === 0 ? undefined : `${indent}<typ:address>\n${lines.join('\n')}\n${indent}</typ:address>`;
};

interface ItemElementInput {
  readonly base: number;
  readonly discountPercentage?: number;
  readonly label: string;
  readonly quantity: number;
  readonly rate: VatRate;
  readonly unitPrice: number;
  readonly vat: number;
}

type MutableItemElementInput = { -readonly [Key in keyof ItemElementInput]: ItemElementInput[Key] };

const itemElement = (input: ItemElementInput) => `          <inv:invoiceItem>
            <inv:text>${text(input.label, 90)}</inv:text>
            <inv:quantity>${input.quantity}</inv:quantity>
            <inv:payVAT>false</inv:payVAT>
            <inv:rateVAT>${pohodaVatRate(input.rate)}</inv:rateVAT>
${input.discountPercentage === undefined ? '' : `            <inv:discountPercentage>${input.discountPercentage}</inv:discountPercentage>\n`}            <inv:homeCurrency>
              <typ:unitPrice>${money(input.unitPrice)}</typ:unitPrice>
              <typ:price>${money(input.base)}</typ:price>
              <typ:priceVAT>${money(input.vat)}</typ:priceVAT>
              <typ:priceSum>${money(input.base + input.vat)}</typ:priceSum>
            </inv:homeCurrency>
          </inv:invoiceItem>`;

/**
 * One OntOS line. A percentage discount becomes POHODA's discountPercentage on the item; a fixed-amount discount
 * becomes its own negative item "Sleva", so item sums still equal the stored VAT recap exactly.
 */
const itemXml = (line: InvoiceLine) => {
  const base = lineBaseMinor(line);
  const vat = lineVatMinor(line);
  const { discount } = line;
  if (discount === undefined || discount.kind === 'PERCENT') {
    const item: MutableItemElementInput = {
      base,
      label: line.description,
      quantity: line.quantity,
      rate: line.vatRate,
      unitPrice: line.unitPriceMinor,
      vat,
    };
    if (discount !== undefined) {
      item.discountPercentage = discount.value;
    }
    return itemElement(item);
  }
  const gross = lineGrossMinor(line);
  const grossVat = lineVatMinor({
    quantity: line.quantity,
    unitPriceMinor: line.unitPriceMinor,
    vatRate: line.vatRate,
  });
  return [
    itemElement({
      base: gross,
      label: line.description,
      quantity: line.quantity,
      rate: line.vatRate,
      unitPrice: line.unitPriceMinor,
      vat: grossVat,
    }),
    itemElement({
      base: base - gross,
      label: `Sleva: ${discount.reason}`,
      quantity: 1,
      rate: line.vatRate,
      unitPrice: base - gross,
      vat: vat - grossVat,
    }),
  ].join('\n');
};

const summaryXml = (invoice: Invoice, recap: readonly VatRecapEntry[] | undefined) => {
  const at = (rate: VatRate) => {
    const entries = (recap ?? []).filter((entry) => entry.rate === rate);
    const base = entries.reduce((sum, entry) => sum + entry.baseMinor, 0);
    const vat = entries.reduce((sum, entry) => sum + entry.vatMinor, 0);
    return { base, sum: base + vat, vat };
  };
  // Without a breakdown the whole amount is reported as "bez DPH" and the invoice is classified nonSubsume.
  const none = recap === undefined ? invoice.totalMinor : at(0).base;
  const low = at(12);
  const high = at(21);
  const third = at(10);
  return `        <inv:invoiceSummary>
          <inv:roundingDocument>none</inv:roundingDocument>
          <inv:roundingVAT>none</inv:roundingVAT>
          <inv:homeCurrency>
            <typ:priceNone>${money(none)}</typ:priceNone>
            <typ:priceLow>${money(low.base)}</typ:priceLow>
            <typ:priceLowVAT>${money(low.vat)}</typ:priceLowVAT>
            <typ:priceLowSum>${money(low.sum)}</typ:priceLowSum>
            <typ:priceHigh>${money(high.base)}</typ:priceHigh>
            <typ:priceHighVAT>${money(high.vat)}</typ:priceHighVAT>
            <typ:priceHighSum>${money(high.sum)}</typ:priceHighSum>
            <typ:price3>${money(third.base)}</typ:price3>
            <typ:price3VAT>${money(third.vat)}</typ:price3VAT>
            <typ:price3Sum>${money(third.sum)}</typ:price3Sum>
          </inv:homeCurrency>
        </inv:invoiceSummary>`;
};

const invoiceXml = (row: ExportRow, issuer: ExportIssuer | undefined, meta: ExportMeta) => {
  const { invoice } = row;
  const outgoing = invoice.direction === 'OUTGOING';
  const advance = invoice.documentKind === 'ADVANCE';
  const recap = vatRecapOf(invoice);
  const number = invoice.number ?? invoice.documentNumber;
  const symVar = variableSymbol(number);
  const partner: ExportPartnerIdentity = row.partner ?? {};
  const partnerAddress = addressXml(
    { city: partner.city, company: row.counterpartyName, dic: partner.vatId, ico: partner.ico },
    '            ',
  );
  const myAddress =
    issuer === undefined
      ? undefined
      : addressXml(
          {
            city: issuer.city,
            company: issuer.name,
            dic: issuer.vatId,
            ico: issuer.ico,
            street: issuer.street,
            zip: issuer.zip,
          },
          '            ',
        );
  const title = `${outgoing ? 'Faktura' : 'Přijatá faktura'} ${number}${
    invoice.budgetCategory === undefined ? '' : ` – ${invoice.budgetCategory}`
  }`;
  const intNote = [
    `OntOS doklad ${invoice.ref.resourceId}; předávací balíček ${meta.batchNumber}, verze ${meta.version}.`,
    ...(recap === undefined ? [POHODA_NO_VAT_BREAKDOWN_NOTE] : []),
  ].join(' ');
  const documentNote = `Doklad v OntOS: ${row.documentLink}`;
  const header = [
    `          <inv:invoiceType>${pohodaInvoiceType(invoice)}</inv:invoiceType>`,
    ...(outgoing
      ? [
          '          <inv:number>',
          `            <typ:numberRequested>${text(number, 32)}</typ:numberRequested>`,
          '          </inv:number>',
        ]
      : []),
    ...(symVar === undefined ? [] : [`          <inv:symVar>${symVar}</inv:symVar>`]),
    ...(outgoing ? [] : [`          <inv:originalDocument>${text(invoice.documentNumber, 32)}</inv:originalDocument>`]),
    `          <inv:date>${invoice.issueDate}</inv:date>`,
    ...(advance ? [] : [`          <inv:dateTax>${invoice.issueDate}</inv:dateTax>`]),
    `          <inv:dateDue>${invoice.dueDate}</inv:dateDue>`,
    ...(advance
      ? []
      : [
          '          <inv:classificationVAT>',
          `            <typ:classificationVATType>${recap === undefined ? 'nonSubsume' : 'inland'}</typ:classificationVATType>`,
          '          </inv:classificationVAT>',
        ]),
    `          <inv:text>${text(title, 240)}</inv:text>`,
    ...(partnerAddress === undefined
      ? []
      : ['          <inv:partnerIdentity>', partnerAddress, '          </inv:partnerIdentity>']),
    ...(myAddress === undefined ? [] : ['          <inv:myIdentity>', myAddress, '          </inv:myIdentity>']),
    '          <inv:paymentType>',
    '            <typ:paymentType>draft</typ:paymentType>',
    '          </inv:paymentType>',
    `          <inv:note>${text(documentNote, 4000)}</inv:note>`,
    `          <inv:intNote>${text(intNote, 4000)}</inv:intNote>`,
  ].join('\n');
  const lines = invoice.lines ?? [];
  const detail =
    lines.length === 0
      ? ''
      : `        <inv:invoiceDetail>\n${lines.map(itemXml).join('\n')}\n        </inv:invoiceDetail>\n`;
  return `      <inv:invoice version="${POHODA_DATAPACK_VERSION}">
        <inv:invoiceHeader>
${header}
        </inv:invoiceHeader>
${detail}${summaryXml(invoice, recap)}
      </inv:invoice>`;
};

/**
 * STORMWARE POHODA XML import file: one `dat:dataPack` (version 2.0) with one `inv:invoice` per row, issued
 * (OUTGOING) and received (INCOMING) invoices, amounts in CZK. Validates against the official XSD
 * (data.xsd, version_2). Import and posting are done by the accountant in POHODA, never by OntOS.
 */
export const buildPohodaDataPack = (rows: readonly ExportRow[], meta: ExportMeta): string => {
  const packId = `${meta.batchNumber}-v${meta.version}`;
  const { issuer } = meta;
  const icoAttribute = issuer?.ico === undefined ? '' : ` ico="${xmlEscape(issuer.ico)}"`;
  const note = `Předávací balíček ${meta.batchNumber}, verze ${meta.version}, vytvořil ${meta.createdBy}, ${meta.createdAt}`;
  const items = rows
    .map((row, index) => {
      const itemId = `${packId}-${String(index + 1).padStart(3, '0')}`;
      return `  <dat:dataPackItem version="${POHODA_DATAPACK_VERSION}" id="${text(itemId, 64)}">
${invoiceXml(row, issuer, meta)}
  </dat:dataPackItem>`;
    })
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<dat:dataPack xmlns:dat="${POHODA_NAMESPACES.dat}" xmlns:inv="${POHODA_NAMESPACES.inv}" xmlns:typ="${POHODA_NAMESPACES.typ}" version="${POHODA_DATAPACK_VERSION}" id="${text(packId, 64)}"${icoAttribute} application="OntOS" note="${text(note, 4000)}">
${items}
</dat:dataPack>
`;
};
