import { describe, expect, it } from 'effect-rstest';
import { DateTime, Effect, Schema } from 'effect';
import { FinanceReferenceUnavailable } from '../../shared/actions/errors/finance-reference-unavailable.ts';
import type { FinanceCommand } from '../../shared/actions/apply-command.ts';
import type { FinanceState, Invoice } from '../../shared/apis/records.ts';
import { withoutExportFiles } from '../../src/api/records.read.ts';
import { projectFinanceRecords, transitionFinance } from '../../src/services/persistence.service.ts';
import type { FinanceValidators } from '../../src/services/persistence.service.ts';

const tenantId = 'a0000000-0000-4000-8000-000000000001';
const scope = { legalEntityId: 'a0000000-0000-4000-8000-000000000002', tenantId };
const now = DateTime.makeUnsafe('2026-10-20T08:00:00Z');
const trusted: FinanceValidators = {
  exportReferences: Effect.succeed({ issuerName: 'Siampark', partners: new Map() }),
  invoice: () => Effect.void,
};
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
    moduleId: 'finance.billing',
    resourceId: id,
    resourceType: 'finance.billing.invoice',
    tenantId,
  },
  totalMinor: 100_000,
  updatedAt: now,
  ...overrides,
});
const empty: FinanceState = {
  financialPlanEntries: [],
  invoices: [],
};
let counter = 0;
const run = (state: FinanceState, command: FinanceCommand, validators: FinanceValidators = trusted) => {
  counter += 1;
  return transitionFinance(state, command, scope, validators, {
    attemptId: `attempt-${counter}`,
    now,
    principalId: 'principal-1',
    resourceId: `resource-${counter}`,
  });
};

describe('S08 export issuer identity', () => {
  it.effect('stores the accounting-unit identity entered by the administrator', () =>
    Effect.gen(function* setup() {
      const result = yield* run(empty, {
        _tag: 'UpdateAccountingSetup',
        issuerCity: 'Praha',
        issuerIco: '12345678',
        issuerStreet: 'Testovací 1',
        issuerVatId: 'CZ12345678',
        issuerZip: '110 00',
        product: 'POHODA',
      });
      expect(result.state.accountingSetup?.issuerIco).toBe('12345678');
      expect(result.state.accountingSetup?.issuerVatId).toBe('CZ12345678');
      expect(result.state.accountingSetup?.issuerZip).toBe('110 00');
    }),
  );

  it.effect('snapshots the Core legal entity name and the setup IČO on the export record', () =>
    Effect.gen(function* snapshot() {
      const state: FinanceState = {
        ...empty,
        accountingSetup: { issuerIco: '12345678' },
        invoices: [invoice('a'), invoice('b')],
      };
      const result = yield* run(state, {
        _tag: 'CreateAccountingExport',
        actorLabel: 'Účetní (ucetni@demo.ontos)',
        format: 'CSV',
        invoiceResourceIds: ['a', 'b'],
      });
      const created = result.state.accountingExports?.[0];
      expect(created?.issuerName).toBe('Siampark');
      expect(created?.issuerIco).toBe('12345678');
      expect(created?.invoiceResourceIds).toEqual(['a', 'b']);
      expect(created?.actorPrincipalId).toBe('principal-1');
    }),
  );

  it.effect('refuses the export when the issuer cannot be resolved from Core', () =>
    Effect.gen(function* noIssuer() {
      const failure = yield* Effect.flip(
        run(
          { ...empty, invoices: [invoice('a')] },
          { _tag: 'CreateAccountingExport', format: 'POHODA_XML', invoiceResourceIds: ['a'] },
          { invoice: () => Effect.void },
        ),
      );
      expect(Schema.is(FinanceReferenceUnavailable)(failure)).toBe(true);
      expect('reason' in failure ? failure.reason : undefined).toBe('export_references_unavailable');
    }),
  );

  it.effect('read-only principals see the handover history without the file body', () =>
    Effect.gen(function* readOnly() {
      const created = yield* run(
        { ...empty, invoices: [invoice('a')] },
        { _tag: 'CreateAccountingExport', format: 'POHODA_XML', invoiceResourceIds: ['a'] },
      );
      const visible = withoutExportFiles(projectFinanceRecords(created.state, 1, {}));
      const entry = visible.state.accountingExports?.[0];
      expect(entry?.content).toBe('');
      expect(entry?.sha256).toBe(created.state.accountingExports?.[0]?.sha256);
      expect(entry?.batchNumber).toBe('UP-2026-001');
    }),
  );
});
