import { FinanceCompanyIdSchema } from '../../shared/apis/records.ts';
import { NodeServices } from '@effect/platform-node';
import { DateTime, Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import type { Invoice } from '../../shared/apis/records.ts';
import { buildAccountingExport, exportFileName } from '../../shared/domain/finance-planning.ts';
import type { ExportMeta, ExportRow } from '../../shared/domain/finance-planning.ts';
import {
  POHODA_NO_VAT_BREAKDOWN_NOTE,
  buildPohodaDataPack,
  pohodaVatRate,
  variableSymbol,
} from '../../shared/domain/pohoda-xml.ts';
import { validatePohodaXml } from '../support/pohoda-xsd.ts';

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
      yield* validatePohodaXml(xml);
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
      yield* validatePohodaXml(xml);
    }),
  );

  test.effect('omits the dataPack ico attribute when the accounting unit has no IČO and keeps the company name', () =>
    Effect.gen(function* issuerWithoutIco() {
      const xml = yield* buildAccountingExport({ format: 'POHODA_XML', meta: obchodNoIco, rows });
      expect(xml).not.toContain(' ico="');
      expect(xml).toContain('<typ:company>Obchodní firma</typ:company>');
      expect(xml).not.toContain('SIMULACE');
      yield* validatePohodaXml(xml);
    }),
  );

  test.effect('writes formula-leading CSV text as plain text and keeps amounts numeric', () =>
    Effect.gen(function* formulaCsv() {
      const csv = yield* buildAccountingExport({
        format: 'CSV',
        meta: siampark,
        rows: [
          {
            counterpartyName: '=HYPERLINK("http://attacker.invalid","Klikni")',
            documentLink: link('out-1'),
            invoice: invoice('csv-1', { budgetCategory: '@SUM(A1:A9)', documentNumber: '+420', totalMinor: 100_000 }),
          },
          { counterpartyName: '-2+3', documentLink: link('csv-2'), invoice: invoice('csv-2') },
        ],
      });
      const [, first, second] = csv.split('\r\n');
      expect(first).toContain(`;"'=HYPERLINK(""http://attacker.invalid"",""Klikni"")";`);
      expect(first).toContain(";'+420;");
      expect(first).toContain(";'@SUM(A1:A9);");
      expect(first).toContain(';1000.00;');
      expect(second).toContain(";'-2+3;");
      expect(csv).not.toMatch(/;[=+\-@]/u);
    }),
  );

  test.effect('refuses a document number POHODA would cut instead of truncating the identity', () =>
    Effect.gen(function* overlongNumber() {
      const supplierNumber = 'DOD-2026-0000000000000000000000001';
      const refusal = yield* Effect.flip(
        buildPohodaDataPack(
          [
            {
              counterpartyName: 'Dodavatel',
              documentLink: link('in-2'),
              invoice: invoice('in-2', { direction: 'INCOMING', documentNumber: supplierNumber }),
            },
          ],
          siampark,
        ),
      );
      expect(refusal.problem).toBe('pohoda_document_number_too_long');
      expect(refusal.documentNumber).toBe(supplierNumber);
      const exactly32 = 'FV-2026-00000000000000000000001';
      expect([...exactly32].length).toBeLessThanOrEqual(32);
      const xml = yield* buildPohodaDataPack(
        [
          {
            counterpartyName: 'Odběratel',
            documentLink: link('out-3'),
            invoice: invoice('out-3', { documentNumber: exactly32 }),
          },
        ],
        siampark,
      );
      expect(xml).toContain(`<typ:numberRequested>${exactly32}</typ:numberRequested>`);
    }),
  );

  test.effect('refuses a VAT rate POHODA has no summary column for instead of reporting it as zero', () =>
    Effect.gen(function* unsupportedRate() {
      const refusal = yield* Effect.flip(
        buildPohodaDataPack(
          [
            {
              counterpartyName: 'Odběratel',
              documentLink: link('out-15'),
              invoice: invoice('out-15', {
                documentNumber: 'FV-2026-0015',
                lines: [{ description: 'Služba', quantity: 1, unitPriceMinor: 100_000, vatRate: 15 }],
                vatRecap: [{ baseMinor: 100_000, rate: 15, vatMinor: 15_000 }],
              }),
            },
          ],
          siampark,
        ),
      );
      expect(refusal.problem).toBe('pohoda_vat_rate_unsupported');
      expect(refusal.documentNumber).toBe('FV-2026-0015');
    }),
  );

  test.effect('refuses text XML cannot carry and names the invoice instead of writing an unparsable file', () =>
    Effect.gen(function* forbiddenCharacter() {
      const refusal = yield* Effect.flip(
        buildPohodaDataPack(
          [
            {
              counterpartyName: `Nájemce${String.fromCodePoint(0x1b)}`,
              documentLink: link('out-ctl'),
              invoice: invoice('out-ctl', { documentNumber: 'FV-2026-0099' }),
            },
          ],
          siampark,
        ),
      );
      expect(refusal.problem).toBe('pohoda_text_has_forbidden_character');
      expect(refusal.documentNumber).toBe('FV-2026-0099');
      const batch = yield* Effect.flip(
        buildPohodaDataPack(rows, { ...siampark, createdBy: `Finance${String.fromCodePoint(0)}` }),
      );
      expect(batch.problem).toBe('pohoda_text_has_forbidden_character');
      expect(batch.documentNumber).toBeUndefined();
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
