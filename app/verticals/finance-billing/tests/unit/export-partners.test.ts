import { COUNTERPARTY_IDENTITIES_MAX_REFS } from '@app/party-registry/api/client';
import type { CounterpartyIdentity } from '@app/party-registry/api/client';
import { describe, expect, it } from 'effect-rstest';
import { ConfigProvider, DateTime, Effect, Schema } from 'effect';
import { FinanceCommandSchema } from '../../shared/actions/apply-command.ts';
import type { FinanceState, Invoice } from '../../shared/apis/records.ts';
import { MANUAL_COUNTERPARTY_ID, transitionFinance } from '../../src/services/persistence.service.ts';
import type { ExportPartnerReference, FinanceValidators } from '../../src/services/persistence.service.ts';
import { resolveExportPartners } from '../../src/services/reference-validation.ts';

const tenantId = 'a0000000-0000-4000-8000-000000000001';
const scope = { legalEntityId: 'a0000000-0000-4000-8000-000000000002', tenantId };
const now = DateTime.makeUnsafe('2026-10-20T08:00:00Z');
const counterpartyRef = (index: number): Invoice['counterpartyRef'] => ({
  moduleId: 'party.registry',
  resourceId: `c0000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
  resourceType: 'party.registry.counterparty',
  tenantId,
});
const identityOf = (ref: Invoice['counterpartyRef']): CounterpartyIdentity => ({
  city: 'Brno',
  companyId: '27082440',
  counterpartyRef: ref,
  displayName: `Partner ${ref.resourceId.slice(-4)}`,
  status: 'ACTIVE',
  vatId: 'CZ27082440',
});
const invoice = (id: string, ref: Invoice['counterpartyRef'], overrides: Partial<Invoice> = {}): Invoice => ({
  accountingCorrelation: `acc-${id}`,
  accountingSyncState: 'NOT_SYNCED',
  businessState: 'CONFIRMED',
  counterpartyRef: ref,
  createdAt: now,
  currency: 'CZK',
  direction: 'INCOMING',
  documentNumber: `PF-${id}`,
  dueDate: '2026-10-30',
  issueDate: '2026-10-01',
  lines: [{ description: 'Energie 09/2026', quantity: 1, unitPriceMinor: 100_000, vatRate: 21 }],
  paidMinor: 0,
  paymentState: 'UNPAID',
  ref: { moduleId: 'finance.billing', resourceId: id, resourceType: 'finance.billing.invoice', tenantId },
  subtotalMinor: 100_000,
  totalMinor: 121_000,
  updatedAt: now,
  vatMinor: 21_000,
  vatRecap: [{ baseMinor: 100_000, rate: 21, vatMinor: 21_000 }],
  ...overrides,
});
const run = (state: FinanceState, command: typeof FinanceCommandSchema.Encoded, validators: FinanceValidators) =>
  Schema.decodeEffect(FinanceCommandSchema)(command).pipe(
    Effect.flatMap((decoded) =>
      transitionFinance(state, decoded, scope, validators, {
        attemptId: 'attempt-1',
        now,
        principalId: 'principal-1',
        resourceId: 'export-1',
      }),
    ),
    Effect.provideService(
      ConfigProvider.ConfigProvider,
      ConfigProvider.fromEnvRecord({ ONTOS_GATEWAY_ISSUER: 'https://shell.example.test' }),
    ),
  );

describe('S08 export partners', () => {
  it.effect('asks the registry for every partner of a large export, each one once and in bounded batches', () =>
    Effect.gen(function* largeExport() {
      const refs = Array.from({ length: 650 }, (_, index) => counterpartyRef(index + 1));
      const batches: (readonly Invoice['counterpartyRef'][])[] = [];
      const partners = yield* resolveExportPartners([...refs, ...refs.slice(0, 40)], (batch) =>
        Effect.sync(() => {
          batches.push(batch);
          return batch.map(identityOf);
        }),
      );
      // More than the customer list's 500 and none dropped.
      expect(partners.size).toBe(650);
      expect(batches.every((batch) => batch.length <= COUNTERPARTY_IDENTITIES_MAX_REFS)).toBe(true);
      expect(batches.flat().map((ref) => ref.resourceId)).toEqual(refs.map((ref) => ref.resourceId));
      expect(partners.get(refs[649]?.resourceId ?? '')).toEqual({
        city: 'Brno',
        displayName: 'Partner 0650',
        ico: '27082440',
        vatId: 'CZ27082440',
      });
    }),
  );

  it.effect('asks nothing when the export names no registry partner', () =>
    Effect.gen(function* noPartners() {
      const partners = yield* resolveExportPartners([], () => Effect.die('no call expected'));
      expect(partners.size).toBe(0);
    }),
  );

  it.effect('resolves a supplier-only and an archived partner of the selected invoices into the handover file', () =>
    Effect.gen(function* supplierPartner() {
      const supplier = counterpartyRef(1);
      const archived = counterpartyRef(2);
      const notSelected = counterpartyRef(3);
      const requested: Invoice['counterpartyRef'][][] = [];
      const registry = new Map<string, ExportPartnerReference>([
        [
          supplier.resourceId,
          { city: 'Brno', displayName: 'Dodavatel energie a.s.', ico: '27082440', vatId: 'CZ27082440' },
        ],
        [archived.resourceId, { city: 'Ostrava', displayName: 'Bývalý partner s.r.o.', ico: '45274649' }],
      ]);
      const validators: FinanceValidators = {
        exportReferences: (refs) =>
          Effect.sync(() => {
            requested.push([...refs]);
            return { issuerName: 'Nájempark', partners: registry };
          }),
        invoice: () => Effect.void,
      };
      const state: FinanceState = {
        financialPlanEntries: [],
        invoices: [
          invoice('pf-1', supplier),
          invoice('pf-2', archived),
          invoice('pf-3', notSelected),
          invoice('pf-4', { ...supplier, resourceId: MANUAL_COUNTERPARTY_ID }, { counterpartyName: 'Ruční dodavatel' }),
        ],
      };
      const result = yield* run(
        state,
        { _tag: 'CreateAccountingExport', format: 'POHODA_XML', invoiceResourceIds: ['pf-1', 'pf-2', 'pf-4'] },
        validators,
      );
      // Exactly the registry counterparties of the selected invoices: not the unselected one, not the hand-typed one.
      expect(requested).toEqual([[supplier, archived]]);
      const content = result.state.accountingExports?.[0]?.content ?? '';
      expect(content).toContain('<typ:company>Dodavatel energie a.s.</typ:company>');
      expect(content).toContain('<typ:city>Brno</typ:city>');
      expect(content).toContain('<typ:ico>27082440</typ:ico>');
      expect(content).toContain('<typ:dic>CZ27082440</typ:dic>');
      expect(content).toContain('<typ:company>Bývalý partner s.r.o.</typ:company>');
      expect(content).toContain('<typ:city>Ostrava</typ:city>');
      expect(content).toContain('<typ:ico>45274649</typ:ico>');
    }),
  );
});
