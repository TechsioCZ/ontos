import { FinanceCompanyIdSchema } from '../../shared/apis/records.ts';
import { NodeServices } from '@effect/platform-node';
import { ChildProcess } from 'effect/process';
import { Config, DateTime, Effect, FileSystem, Path, Schema, Stream } from 'effect';
import { expect, it } from 'effect-rstest';
import type { Invoice } from '../../shared/apis/records.ts';
import { buildAccountingExport, exportFileName } from '../../shared/domain/finance-planning.ts';
import type { ExportMeta, ExportRow } from '../../shared/domain/finance-planning.ts';
import { POHODA_NO_VAT_BREAKDOWN_NOTE, pohodaVatRate, variableSymbol } from '../../shared/domain/pohoda-xml.ts';

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
    moduleId: 'finance.billing',
    resourceId: id,
    resourceType: 'finance.billing.invoice',
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
    { baseMinor: 10_000, rate: 12, vatMinor: 1200 },
  ],
});
const received = invoice('in-1', {
  budgetCategory: 'Energie',
  counterpartyCompanyId: Schema.decodeSync(FinanceCompanyIdSchema)('27232433'),
  direction: 'INCOMING',
  documentNumber: '2026-0918774',
  dueDate: '2026-10-19',
  issueDate: '2026-10-05',
  totalMinor: 4_862_000,
});
const link = (id: string) => `http://localhost:3020/cs/finance?resourceId=${id}`;
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
  createdBy: 'Finance (finance@najempark.demo)',
  issuer: {
    city: 'Praha',
    ico: '12345678',
    name: 'Nájempark',
    street: 'Testovací 1',
    vatId: 'CZ12345678',
    zip: '110 00',
  },
  version: 4,
};
const obchodNoIco: ExportMeta = {
  batchNumber: 'UP-2026-001',
  createdAt: '2026-10-20T08:00:00.000Z',
  createdBy: 'Účetní (ucetni@demo.ontos)',
  issuer: { name: 'Obchodní firma' },
  version: 1,
};

/** Official STORMWARE dataPack 2.0 schemas are supplied outside the repository. */
const validateAgainstXsd = Effect.fn('FinanceTest.validatePohodaXsd')(function* validateAgainstXsd(xml: string) {
  const directory = yield* Config.String('POHODA_XSD_DIR').pipe(
    Config.withDefault('/Volumes/DevWork/agent-scratch/pohoda-xsd/download'),
  );
  const path = yield* Path.Path;
  const xsd = path.join(directory, 'data.xsd');
  const fs = yield* FileSystem.FileSystem;
  if (!(yield* fs.exists(xsd))) {
    yield* Effect.logWarning(`POHODA XSD not found at ${xsd}; schema validation skipped`);
    return;
  }
  const validation = yield* ChildProcess.make('/usr/bin/xmllint', ['--noout', '--schema', xsd, '-'], {
    stderr: 'inherit',
    stdin: Stream.make(new TextEncoder().encode(xml)),
    stdout: 'ignore',
  });
  expect(yield* validation.exitCode).toBe(0);
});

it.layer(NodeServices.layer)('POHODA XML export (STORMWARE dataPack 2.0)', (test) => {
  test.effect('writes issued invoices with number, VS, dates, partner and issuer identity, lines and VAT summary', () =>
    Effect.gen(function* issuedXml() {
      const xml = yield* buildAccountingExport({ format: 'POHODA_XML', meta: siampark, rows });
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
        '<typ:company>Nájempark</typ:company>',
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
      yield* validateAgainstXsd(xml);
    }),
  );

  test.effect('writes a received invoice without VAT breakdown as nonSubsume with the full amount and a note', () =>
    Effect.gen(function* receivedXml() {
      const [, receivedRow] = rows;
      if (receivedRow === undefined) {
        expect.unreachable('The export fixture must include its received invoice');
      }
      const xml = yield* buildAccountingExport({ format: 'POHODA_XML', meta: siampark, rows: [receivedRow] });
      expect(xml).toContain('<inv:invoiceType>receivedInvoice</inv:invoiceType>');
      expect(xml).toContain('<inv:originalDocument>2026-0918774</inv:originalDocument>');
      expect(xml).toContain('<typ:classificationVATType>nonSubsume</typ:classificationVATType>');
      expect(xml).toContain('<typ:priceNone>48620.00</typ:priceNone>');
      expect(xml).toContain('<typ:ico>27232433</typ:ico>');
      expect(xml).toContain(POHODA_NO_VAT_BREAKDOWN_NOTE);
      expect(xml).not.toContain('<inv:number>');
      expect(xml).not.toContain('<inv:invoiceDetail>');
      yield* validateAgainstXsd(xml);
    }),
  );

  test.effect('omits the dataPack ico attribute when the accounting unit has no IČO and keeps the company name', () =>
    Effect.gen(function* issuerWithoutIco() {
      const xml = yield* buildAccountingExport({ format: 'POHODA_XML', meta: obchodNoIco, rows });
      expect(xml).not.toContain(' ico="');
      expect(xml).toContain('<typ:company>Obchodní firma</typ:company>');
      expect(xml).not.toContain('SIMULACE');
      yield* validateAgainstXsd(xml);
    }),
  );

  test('maps Czech VAT rates, variable symbols and the file name', () => {
    expect(([21, 12, 10, 0] as const).map(pohodaVatRate)).toEqual(['high', 'low', 'third', 'none']);
    expect(variableSymbol('FV-2026-0001')).toBe('20260001');
    expect(variableSymbol('2026-0918774')).toBe('0260918774');
    expect(variableSymbol('bez čísla')).toBeUndefined();
    expect(exportFileName('POHODA_XML', { batchNumber: 'UP-2026-004', version: 4 })).toBe('UP-2026-004-v4.xml');
  });
});
