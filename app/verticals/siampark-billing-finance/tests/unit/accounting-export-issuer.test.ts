import { describe, expect, it } from 'effect-rstest';
import { DateTime, Effect } from 'effect';
import type { FinanceCommand } from '../../shared/actions/apply-command.ts';
import type { FinanceState, Invoice } from '../../shared/apis/records.ts';
import { transitionFinance } from '../../src/services/persistence.service.ts';
import type { FinanceValidators } from '../../src/services/persistence.service.ts';

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

  it.effect('snapshots the selected company name and the setup IČO on the export record', () =>
    Effect.gen(function* snapshot() {
      const state: FinanceState = {
        ...empty,
        accountingSetup: { issuerIco: '12345678' },
        invoices: [invoice('a'), invoice('b')],
      };
      const result = yield* run(state, {
        _tag: 'CreateAccountingExport',
        format: 'CSV',
        invoiceResourceIds: ['a', 'b'],
        issuerName: 'Siampark',
      });
      const created = result.state.accountingExports?.[0];
      expect(created?.issuerName).toBe('Siampark');
      expect(created?.issuerIco).toBe('12345678');
      expect(created?.invoiceResourceIds).toEqual(['a', 'b']);
    }),
  );

  it.effect('leaves the issuer snapshot empty when neither name nor IČO is known', () =>
    Effect.gen(function* noIssuer() {
      const result = yield* run({ ...empty, invoices: [invoice('a')] }, {
        _tag: 'CreateAccountingExport',
        format: 'JSON',
        invoiceResourceIds: ['a'],
      });
      const created = result.state.accountingExports?.[0];
      expect(created?.issuerName).toBeUndefined();
      expect(created?.issuerIco).toBeUndefined();
    }),
  );
});
