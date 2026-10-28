import { IssuerIcoSchema } from '../../shared/apis/records.ts';
import { describe, expect, it } from 'effect-rstest';
import { ConfigProvider, DateTime, Effect, Schema } from 'effect';
import { FinanceReferenceUnavailable } from '../../shared/actions/errors/finance-reference-unavailable.ts';
import { FinanceCommandSchema } from '../../shared/actions/apply-command.ts';
import type { FinanceState, Invoice } from '../../shared/apis/records.ts';
import { withoutExportFiles } from '../../src/api/records.read.ts';
import { projectFinanceRecords, transitionFinance } from '../../src/services/persistence.service.ts';
import type { FinanceValidators } from '../../src/services/persistence.service.ts';

const tenantId = 'a0000000-0000-4000-8000-000000000001';
const scope = { legalEntityId: 'a0000000-0000-4000-8000-000000000002', tenantId };
const now = DateTime.makeUnsafe('2026-10-20T08:00:00Z');
const deployedShell = ConfigProvider.fromEnvRecord({ ONTOS_GATEWAY_ISSUER: 'https://shell.example.test' });
const trusted: FinanceValidators = {
  exportReferences: Effect.succeed({ issuerName: 'Nájempark', partners: new Map() }),
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
const run = (
  state: FinanceState,
  command: typeof FinanceCommandSchema.Encoded,
  validators: FinanceValidators = trusted,
  configuration = deployedShell,
) => {
  counter += 1;
  const execution = {
    attemptId: `attempt-${counter}`,
    now,
    principalId: 'principal-1',
    resourceId: `resource-${counter}`,
  };
  return Schema.decodeEffect(FinanceCommandSchema)(command).pipe(
    Effect.flatMap((decoded) => transitionFinance(state, decoded, scope, validators, execution)),
    Effect.provideService(ConfigProvider.ConfigProvider, configuration),
  );
};

describe('S08 export issuer identity', () => {
  for (const format of ['CSV', 'JSON', 'POHODA_XML'] as const) {
    it.effect(`${format} links each exported invoice to the configured Shell instead of localhost`, () =>
      Effect.gen(function* documentLink() {
        const result = yield* run(
          {
            ...empty,
            invoices: [
              invoice('a0000000-0000-4000-8000-000000000021'),
              invoice('a0000000-0000-4000-8000-000000000022'),
            ],
          },
          {
            _tag: 'CreateAccountingExport',
            format,
            invoiceResourceIds: ['a0000000-0000-4000-8000-000000000021', 'a0000000-0000-4000-8000-000000000022'],
          },
          trusted,
          ConfigProvider.fromEnvRecord({ ONTOS_GATEWAY_ISSUER: 'https://shell.example.test/' }),
        );
        const content = result.state.accountingExports?.[0]?.content;
        expect(content).toContain(
          'https://shell.example.test/cs/finance?resourceId=a0000000-0000-4000-8000-000000000021',
        );
        expect(content).toContain(
          'https://shell.example.test/cs/finance?resourceId=a0000000-0000-4000-8000-000000000022',
        );
        expect(content).not.toContain('localhost');
      }),
    );
  }

  for (const { label, origin } of [
    { label: 'missing', origin: null },
    { label: 'malformed', origin: 'not-a-url' },
    { label: 'non-HTTP', origin: 'ftp://shell.example.test' },
    { label: 'credential-bearing', origin: 'https://user:unused@shell.example.test' },
  ]) {
    it.effect(`refuses an export with a ${label} Shell origin`, () =>
      Effect.gen(function* unavailableShell() {
        const failure = yield* Effect.flip(
          run(
            { ...empty, invoices: [invoice('a')] },
            { _tag: 'CreateAccountingExport', format: 'CSV', invoiceResourceIds: ['a'] },
            trusted,
            ConfigProvider.fromEnvRecord(origin === null ? {} : { ONTOS_GATEWAY_ISSUER: origin }),
          ),
        );
        expect(Schema.is(FinanceReferenceUnavailable)(failure)).toBe(true);
        if (!Schema.is(FinanceReferenceUnavailable)(failure)) {
          expect.unreachable('An unusable Shell origin must retain the reference-unavailable failure');
        }
        expect(failure.reason).toBe('export_shell_origin_unavailable');
      }),
    );
  }

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
        accountingSetup: { issuerIco: yield* Schema.decodeEffect(IssuerIcoSchema)('12345678') },
        invoices: [invoice('a'), invoice('b')],
      };
      const result = yield* run(state, {
        _tag: 'CreateAccountingExport',
        actorLabel: 'Účetní (ucetni@demo.ontos)',
        format: 'CSV',
        invoiceResourceIds: ['a', 'b'],
      });
      const created = result.state.accountingExports?.[0];
      expect(created?.issuerName).toBe('Nájempark');
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
