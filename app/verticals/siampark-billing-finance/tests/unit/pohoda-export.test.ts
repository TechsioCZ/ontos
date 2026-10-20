// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics processEnv:off
// @effect-diagnostics globalConsole:off
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DateTime } from 'effect';
import { describe, expect, it } from 'effect-rstest';
import type { Invoice } from '../../shared/apis/records.ts';
import { buildAccountingExport, exportFileName } from '../../shared/domain/finance-planning.ts';
import type { ExportMeta, ExportRow } from '../../shared/domain/finance-planning.ts';
import { POHODA_NO_VAT_BREAKDOWN_NOTE, pohodaVatRate, variableSymbol } from '../../shared/domain/pohoda-xml.ts';

/** Official STORMWARE XSDs (https://www.stormware.cz/xml/schema/version_2/), downloaded outside the repo. */
const XSD_DIR = process.env['POHODA_XSD_DIR'] ?? '/Volumes/DevWork/agent-scratch/pohoda-xsd/download';
const XSD = join(XSD_DIR, 'data.xsd');

const tenantId = 'a0000000-0000-4000-8000-000000000001';
const now = DateTime.makeUnsafe('2026-10-20T08:00:00Z');
const counterpartyRef = {
  moduleId: 'party.registry' as const,
  resourceId: 'a0000000-0000-4000-8000-000000000012',
  resourceType: 'party.registry.counterparty' as const,
  tenantId,
};
const invoice = (id: string, overrides: Partial<Invoice> = {}): Invoice => ({
  accountingCorrelation: `acc-${id}`,
  accountingSyncState: 'NOT_SYNCED',
  businessState: 'CONFIRMED',
  counterpartyRef,
  createdAt: now,
  currency: 'CZK',
  direction: 'OUTGOING',
  documentNumber: id,
  dueDate: '2026-10-15',
  issueDate: '2026-10-01',
  paidMinor: 0,
  paymentState: 'UNPAID',
  ref: {
    moduleId: 'siampark.billing-finance',
    resourceId: id,
    resourceType: 'siampark.billing-finance.invoice',
    tenantId,
  },
  totalMinor: 100_000,
  updatedAt: now,
  ...overrides,
});

const issued = invoice('out-1', {
  documentNumber: 'FV-2026-0001',
  lines: [
    { description: 'Nájem kanceláře & skladu', quantity: 2, unitPriceMinor: 100_000, vatRate: 21 },
    { description: 'Úklid', quantity: 1, unitPriceMinor: 10_000, vatRate: 12 },
  ],
  number: 'FV-2026-0001',
  subtotalMinor: 210_000,
  totalMinor: 253_200,
  vatMinor: 43_200,
  vatRecap: [
    { baseMinor: 200_000, rate: 21, vatMinor: 42_000 },
    { baseMinor: 10_000, rate: 12, vatMinor: 1_200 },
  ],
});
const received = invoice('in-1', {
  budgetCategory: 'Energie',
  counterpartyCompanyId: '27232433',
  direction: 'INCOMING',
  documentNumber: '2026-0918774',
  dueDate: '2026-10-19',
  issueDate: '2026-10-05',
  totalMinor: 4_862_000,
});
const link = (id: string) => `http://localhost:3020/cs/siampark/finance?resourceId=${id}`;
const rows: readonly ExportRow[] = [
  {
    counterpartyName: 'Ateliér Horák s.r.o.',
    documentLink: link('out-1'),
    invoice: issued,
    partner: { city: 'Praha', ico: '27082440', vatId: 'CZ27082440' },
  },
  { counterpartyName: 'ČEZ Prodej, a.s.', documentLink: link('in-1'), invoice: received, partner: { ico: '27232433' } },
];
const siampark: ExportMeta = {
  batchNumber: 'UP-2026-004',
  createdAt: '2026-10-20T08:00:00.000Z',
  createdBy: 'Finance (finance@siampark.demo)',
  issuer: { city: 'Praha', ico: '12345678', name: 'Siampark', street: 'Testovací 1', vatId: 'CZ12345678', zip: '110 00' },
  version: 4,
};
const obchodNoIco: ExportMeta = {
  batchNumber: 'UP-2026-001',
  createdAt: '2026-10-20T08:00:00.000Z',
  createdBy: 'Účetní (ucetni@demo.ontos)',
  issuer: { name: 'Obchodní firma' },
  version: 1,
};

const validateAgainstXsd = (xml: string) => {
  if (!existsSync(XSD)) {
    console.warn(`POHODA XSD not found at ${XSD}; schema validation skipped`);
    return;
  }
  // xmllint exits non-zero (execFileSync throws with its stderr) when the document violates the schema.
  execFileSync('xmllint', ['--noout', '--schema', XSD, '-'], { input: xml, stdio: ['pipe', 'pipe', 'pipe'] });
};

describe('POHODA XML export (STORMWARE dataPack 2.0)', () => {
  it('writes issued invoices with number, VS, dates, partner and issuer identity, lines and VAT summary', () => {
    const xml = buildAccountingExport('POHODA_XML', rows, siampark);
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    for (const fragment of [
      'xmlns:dat="http://www.stormware.cz/schema/version_2/data.xsd"',
      'xmlns:inv="http://www.stormware.cz/schema/version_2/invoice.xsd"',
      'xmlns:typ="http://www.stormware.cz/schema/version_2/type.xsd"',
      'version="2.0" id="UP-2026-004-v4" ico="12345678"',
      '<inv:invoiceType>issuedInvoice</inv:invoiceType>',
      '<typ:numberRequested>FV-2026-0001</typ:numberRequested>',
      '<inv:symVar>20260001</inv:symVar>',
      '<inv:date>2026-10-01</inv:date>',
      '<inv:dateTax>2026-10-01</inv:dateTax>',
      '<inv:dateDue>2026-10-15</inv:dateDue>',
      '<typ:company>Ateliér Horák s.r.o.</typ:company>',
      '<typ:ico>27082440</typ:ico>',
      '<typ:dic>CZ27082440</typ:dic>',
      '<typ:company>Siampark</typ:company>',
      '<typ:ico>12345678</typ:ico>',
      '<typ:paymentType>draft</typ:paymentType>',
      '<inv:text>Nájem kanceláře &amp; skladu</inv:text>',
      '<inv:rateVAT>high</inv:rateVAT>',
      '<inv:rateVAT>low</inv:rateVAT>',
      '<typ:priceHigh>2000.00</typ:priceHigh>',
      '<typ:priceHighVAT>420.00</typ:priceHighVAT>',
      '<typ:priceHighSum>2420.00</typ:priceHighSum>',
      '<typ:priceLow>100.00</typ:priceLow>',
      '<typ:priceLowVAT>12.00</typ:priceLowVAT>',
      `<inv:note>Doklad v OntOS: ${link('out-1')}</inv:note>`,
    ]) {
      expect(xml).toContain(fragment);
    }
    validateAgainstXsd(xml);
  });

  it('writes a received invoice without VAT breakdown as nonSubsume with the full amount and a note', () => {
    const xml = buildAccountingExport('POHODA_XML', [rows[1] as ExportRow], siampark);
    expect(xml).toContain('<inv:invoiceType>receivedInvoice</inv:invoiceType>');
    expect(xml).toContain('<inv:originalDocument>2026-0918774</inv:originalDocument>');
    expect(xml).toContain('<typ:classificationVATType>nonSubsume</typ:classificationVATType>');
    expect(xml).toContain('<typ:priceNone>48620.00</typ:priceNone>');
    expect(xml).toContain('<typ:ico>27232433</typ:ico>');
    expect(xml).toContain(POHODA_NO_VAT_BREAKDOWN_NOTE);
    expect(xml).not.toContain('<inv:number>');
    expect(xml).not.toContain('<inv:invoiceDetail>');
    validateAgainstXsd(xml);
  });

  it('omits the dataPack ico attribute when the accounting unit has no IČO and keeps the company name', () => {
    const xml = buildAccountingExport('POHODA_XML', rows, obchodNoIco);
    expect(xml).not.toContain(' ico="');
    expect(xml).toContain('<typ:company>Obchodní firma</typ:company>');
    expect(xml).not.toContain('SIMULACE');
    validateAgainstXsd(xml);
  });

  it('maps Czech VAT rates, variable symbols and the file name', () => {
    expect([21, 12, 10, 0].map((rate) => pohodaVatRate(rate as 0 | 10 | 12 | 21))).toEqual([
      'high',
      'low',
      'third',
      'none',
    ]);
    expect(variableSymbol('FV-2026-0001')).toBe('20260001');
    expect(variableSymbol('2026-0918774')).toBe('0260918774');
    expect(variableSymbol('bez čísla')).toBeUndefined();
    expect(exportFileName('POHODA_XML', { batchNumber: 'UP-2026-004', version: 4 })).toBe('UP-2026-004-v4.xml');
  });
});
