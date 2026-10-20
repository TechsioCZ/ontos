// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics processEnv:off
// @effect-diagnostics globalConsole:off
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'effect-rstest';
import { DateTime, Effect } from 'effect';
import type { FinanceCommand } from '../../shared/actions/apply-command.ts';
import type { FinanceState, Invoice } from '../../shared/apis/records.ts';
import { transitionFinance } from '../../src/services/persistence.service.ts';
import type { FinanceValidators } from '../../src/services/persistence.service.ts';

const XSD = join(process.env['POHODA_XSD_DIR'] ?? '/Volumes/DevWork/agent-scratch/pohoda-xsd/download', 'data.xsd');
const tenantId = 'a0000000-0000-4000-8000-000000000001';
const scope = { legalEntityId: 'a0000000-0000-4000-8000-000000000002', tenantId };
const now = DateTime.makeUnsafe('2026-10-20T08:00:00Z');
const validators: FinanceValidators = { invoice: () => Effect.void };
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
  dueDate: '2026-10-30',
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
const empty: FinanceState = {
  accountingObservations: [],
  financialPlanEntries: [],
  invoices: [],
  paymentObservations: [],
};
let counter = 0;
const run = (state: FinanceState, command: FinanceCommand) => {
  counter += 1;
  return transitionFinance(state, command, scope, validators, {
    attemptId: `attempt-${counter}`,
    now,
    principalId: 'principal-1',
    resourceId: `resource-${counter}`,
  });
};
const validateAgainstXsd = (xml: string) => {
  if (!existsSync(XSD)) {
    console.warn(`POHODA XSD not found at ${XSD}; schema validation skipped`);
    return;
  }
  execFileSync('xmllint', ['--noout', '--schema', XSD, '-'], { input: xml, stdio: ['pipe', 'pipe', 'pipe'] });
};

const issued = invoice('fv-1', {
  counterpartyName: 'Ateliér Horák s.r.o.',
  documentNumber: 'FV-2026-0004',
  lines: [{ description: 'Nájem 09/2026', quantity: 1, unitPriceMinor: 2_500_000, vatRate: 21 }],
  number: 'FV-2026-0004',
  subtotalMinor: 2_500_000,
  totalMinor: 3_025_000,
  vatMinor: 525_000,
  vatRecap: [{ baseMinor: 2_500_000, rate: 21, vatMinor: 525_000 }],
});
const received = invoice('pf-1', {
  counterpartyCompanyId: '47116617',
  counterpartyName: 'Kooperativa pojišťovna, a.s.',
  direction: 'INCOMING',
  documentNumber: '7720115',
  issueDate: '2026-09-20',
  dueDate: '2026-10-04',
  totalMinor: 3_120_000,
});

describe('S08 POHODA XML handover end-to-end', () => {
  it.effect('Siampark: setup IČO + session name + registry partner become a valid, hashed, versioned dataPack', () =>
    Effect.gen(function* siampark() {
      const configured = yield* run({ ...empty, invoices: [issued, received] }, {
        _tag: 'UpdateAccountingSetup',
        issuerCity: 'Praha',
        issuerIco: '12345678',
        issuerVatId: 'CZ12345678',
        product: 'POHODA',
      });
      const result = yield* run(configured.state, {
        _tag: 'CreateAccountingExport',
        actorLabel: 'Finance (finance@siampark.demo)',
        counterparties: { 'fv-1': { city: 'Praha', ico: '27082440', vatId: 'CZ27082440' } },
        format: 'POHODA_XML',
        invoiceResourceIds: ['fv-1', 'pf-1'],
        issuerName: 'Siampark',
      });
      const created = result.state.accountingExports?.[0];
      expect(created?.fileName).toBe('UP-2026-001-v1.xml');
      expect(created?.format).toBe('POHODA_XML');
      expect(created?.status).toBe('HANDED_OVER');
      expect(created?.issuerName).toBe('Siampark');
      expect(created?.issuerIco).toBe('12345678');
      const content = created?.content ?? '';
      expect(created?.sha256).toBe(createHash('sha256').update(content, 'utf8').digest('hex'));
      expect(content).toContain('id="UP-2026-001-v1" ico="12345678"');
      expect(content).toContain('<typ:company>Siampark</typ:company>');
      expect(content).toContain('<typ:dic>CZ12345678</typ:dic>');
      expect(content).toContain('<typ:company>Ateliér Horák s.r.o.</typ:company>');
      expect(content).toContain('<typ:ico>27082440</typ:ico>');
      expect(content).toContain('<typ:ico>47116617</typ:ico>');
      expect(content).toContain('<typ:priceHighVAT>5250.00</typ:priceHighVAT>');
      expect(content).toContain('<inv:invoiceType>receivedInvoice</inv:invoiceType>');
      expect(content).not.toContain('SIMULACE');
      // S08-03: a handover never marks invoices as booked.
      expect(result.state.invoices.every((entry) => entry.accountingSyncState === 'NOT_SYNCED')).toBe(true);
      validateAgainstXsd(content);
    }),
  );

  it.effect('Obchodní firma without an IČO: issuer is the selected company name, no ico attribute, still valid', () =>
    Effect.gen(function* obchod() {
      const result = yield* run({ ...empty, invoices: [issued] }, {
        _tag: 'CreateAccountingExport',
        actorLabel: 'Účetní (ucetni@demo.ontos)',
        format: 'POHODA_XML',
        invoiceResourceIds: ['fv-1'],
        issuerName: 'Obchodní firma',
      });
      const created = result.state.accountingExports?.[0];
      expect(created?.issuerName).toBe('Obchodní firma');
      expect(created?.issuerIco).toBeUndefined();
      expect(created?.content).not.toContain(' ico="');
      expect(created?.content).toContain('<typ:company>Obchodní firma</typ:company>');
      validateAgainstXsd(created?.content ?? '');
    }),
  );
});
