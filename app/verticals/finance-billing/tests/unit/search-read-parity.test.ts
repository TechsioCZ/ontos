import { NodeCrypto } from '@effect/platform-node';
import { ContextAccess, CoreSearchProjectionHitSchema, CoreSearchQueryRuntime } from '@app/core-runtime';
import type { ContextAccessService, OperationalScope } from '@app/core-runtime';
import { makeReadTestHarness } from '@app/core-runtime/testing/reads';
import { Context, DateTime, Effect, Exit, Layer, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { FinanceStateSchema } from '../../shared/apis/records.ts';
import { documentsRead } from '../../src/search/documents.provider.ts';
import { invoicesRead } from '../../src/search/invoices.provider.ts';
import { buildSearchDocuments, loadCurrentSearchHits } from '../../src/services/search-projection.ts';

const tenantId = '20000000-0000-4000-8000-000000000001';
const companyId = '30000000-0000-4000-8000-000000000001';
const otherCompanyId = '30000000-0000-4000-8000-000000000002';
const operationTime = DateTime.toDateUtc(DateTime.makeUnsafe('2026-11-02T00:00:00Z'));
const scope: OperationalScope = {
  authBindingId: '60000000-0000-4000-8000-000000000001',
  authContextRef: 'session:finance-search-parity',
  authMethod: 'session',
  correlationId: 'finance-search-parity',
  legalEntityId: companyId,
  principalId: '50000000-0000-4000-8000-000000000001',
  tenantId,
};
const invoice = {
  accountingCorrelation: 'private-accounting',
  accountingSyncState: 'NOT_SYNCED',
  businessState: 'DRAFT',
  counterpartyRef: {
    moduleId: 'party.registry',
    resourceId: '40000000-0000-4000-8000-000000000001',
    resourceType: 'party.registry.counterparty',
    tenantId,
  },
  createdAt: '2026-11-01T00:00:00Z',
  currency: 'CZK',
  direction: 'OUTGOING',
  documentNumber: 'FV-2026-101',
  dueDate: '2026-11-10',
  issueDate: '2026-11-01',
  paidMinor: 0,
  paymentState: 'UNPAID',
  ref: {
    moduleId: 'finance.billing',
    resourceId: 'invoice-101',
    resourceType: 'finance.billing.invoice',
    tenantId,
  },
  totalMinor: 100,
  updatedAt: '2026-11-01T00:00:00Z',
};
const encoded = {
  documents: [
    {
      fileName: 'Veřejná příloha.pdf',
      id: 'attachment-1',
      invoiceResourceId: 'invoice-101',
      mimeType: 'application/pdf',
      sha256: 'private-hash',
      sizeBytes: 10,
      uploadedAt: '2026-11-01T00:00:00Z',
    },
  ],
  financialPlanEntries: [],
  invoices: [invoice],
};
interface Scenario {
  readonly company?: string;
  readonly kind: 'document' | 'invoice';
  readonly moduleAllowed?: boolean;
  readonly principal?: string;
  readonly state?: 'empty' | 'missing' | 'orphan' | 'voided' | 'withdrawn';
}

const checkHits = (
  hits: readonly {
    readonly ref: { readonly tenantId: string };
    readonly selectedLegalEntityId: string;
    readonly title: string;
  }[],
) => {
  for (const hit of hits) {
    expect(Object.keys(hit).toSorted()).toEqual(['ref', 'selectedLegalEntityId', 'title']);
    expect(hit.selectedLegalEntityId).toBe(companyId);
    expect(hit.ref.tenantId).toBe(tenantId);
  }
  return hits.length;
};

const governedSearch = Effect.fn('Finance.testSearchReadParity')(function* run(scenario: Scenario) {
  const state = yield* Schema.decodeUnknownEffect(FinanceStateSchema)(encoded);
  const documents = yield* buildSearchDocuments({
    companies: [{ legalEntityId: companyId, state }],
    projectionVersion: '1',
    tenantId,
  });
  const principal = {
    ...scope,
    legalEntityId: scenario.company ?? companyId,
    principalId: scenario.principal ?? scope.principalId,
  };
  let stored = encoded;
  if (scenario.state === 'empty') {
    stored = { ...encoded, documents: [], invoices: [] };
  } else if (scenario.state === 'voided') {
    stored = { ...encoded, invoices: [{ ...invoice, businessState: 'VOIDED' }] };
  } else if (scenario.state === 'withdrawn') {
    stored = { ...encoded, documents: [] };
  } else if (scenario.state === 'orphan') {
    stored = {
      ...encoded,
      documents: encoded.documents.map((document) => ({ ...document, invoiceResourceId: 'missing-invoice' })),
    };
  }
  const harness = yield* makeReadTestHarness({
    compositionRevision: 'a'.repeat(64),
    executeOwnerQuery: ({ scope: actualScope, sql }) => {
      expect(actualScope).toEqual({ legalEntityId: principal.legalEntityId, tenantId });
      expect(sql).toContain('"finance_billing"."finance_states"');
      return Effect.succeed(
        scenario.state === 'missing' || principal.legalEntityId !== companyId ? [] : [{ revision: 7, state: stored }],
      );
    },
    operationTime,
    ownerAuthorizationDecision: 'allowed',
    permissionDecision: 'allowed',
    scope: principal,
  });
  const services = yield* Layer.build(harness.layer);
  const permissionChecks: Pick<ContextAccessService, 'modules' | 'resources'> = {
    modules: ({ moduleIds }) =>
      Effect.succeed(
        moduleIds.map((moduleId) => ({
          decision: scenario.moduleAllowed === false ? ('denied' as const) : ('allowed' as const),
          key: moduleId,
        })),
      ),
    resources: () => Effect.die('Native finance records do not require generic resource.read'),
  };
  Object.assign(Context.get(services, ContextAccess), permissionChecks);
  let searches = 0;
  const runtime: CoreSearchQueryRuntime['Service'] = {
    search: (query, actualScope) =>
      Effect.sync(() => {
        searches += 1;
        expect(actualScope).toEqual(principal);
        expect(query).toMatchObject({
          includeArchived: false,
          resourceType: `finance.billing.${scenario.kind}`,
          selectedLegalEntityId: principal.legalEntityId,
          tenantId,
        });
        expect(harness.snapshot().ownerQueries).toHaveLength(1);
        expect(harness.snapshot().statements.some((statement) => /^commit$/iu.test(statement))).toBe(true);
        return documents.filter((document) => document.ref.resourceType === `finance.billing.${scenario.kind}`);
      }),
  };
  const request = { input: { query: 'FV' }, principal, transport: { correlationId: scope.correlationId } };
  const read =
    scenario.kind === 'invoice'
      ? harness.runtime.runRead({ ...request, registration: invoicesRead }).pipe(Effect.map(checkHits))
      : harness.runtime.runRead({ ...request, registration: documentsRead }).pipe(Effect.map(checkHits));
  const outcome = yield* read.pipe(Effect.provideService(CoreSearchQueryRuntime, runtime), Effect.exit);
  if (scenario.moduleAllowed === false) {
    expect(Exit.isFailure(outcome)).toBe(true);
    expect(harness.snapshot().ownerQueries).toEqual([]);
    expect(searches).toBe(0);
  } else {
    expect(Exit.isSuccess(outcome)).toBe(true);
    if (Exit.isSuccess(outcome)) {
      const count = scenario.company === otherCompanyId || scenario.state !== undefined ? 0 : 1;
      expect(outcome.value).toBe(count);
    }
  }
});

it.layer(NodeCrypto.layer)('Finance native search parity', (suite) => {
  for (const kind of ['document', 'invoice'] as const) {
    suite.effect(`${kind}: finance and management use the native module gate without extra resource grants`, () =>
      Effect.forEach([scope.principalId, '50000000-0000-4000-8000-000000000002'], (principal) =>
        governedSearch({ kind, principal }),
      ).pipe(Effect.scoped),
    );
    suite.effect(`${kind}: absent module permission prevents owner and index work`, () =>
      governedSearch({ kind, moduleAllowed: false }).pipe(Effect.scoped),
    );
    suite.effect(`${kind}: another selected company cannot reuse a positive invoice or document index hit`, () =>
      governedSearch({ company: otherCompanyId, kind }).pipe(Effect.scoped),
    );
    suite.effect(`${kind}: missing, deleted and voided current ledger records suppress stale index hits`, () =>
      Effect.gen(function* staleRecords() {
        yield* governedSearch({ kind, state: 'empty' });
        yield* governedSearch({ kind, state: 'missing' });
        yield* governedSearch({ kind, state: 'voided' });
      }).pipe(Effect.scoped),
    );
  }
  suite.effect('documents absent from the native invoice projection cannot survive as index hits', () =>
    Effect.gen(function* withdrawnDocuments() {
      yield* governedSearch({ kind: 'document', state: 'withdrawn' });
      yield* governedSearch({ kind: 'document', state: 'orphan' });
    }).pipe(Effect.scoped),
  );
});

it.effect('current owner identity and labels defeat stale, foreign and wrong-kind index candidates', () =>
  Effect.gen(function* filtersCandidates() {
    const state = yield* Schema.decodeUnknownEffect(FinanceStateSchema)(encoded);
    const [document] = yield* buildSearchDocuments({
      companies: [{ legalEntityId: companyId, state }],
      projectionVersion: '1',
      tenantId,
    });
    if (document === undefined) {
      return yield* Effect.die('Fixture invoice missing');
    }
    const hit = yield* Schema.decodeUnknownEffect(CoreSearchProjectionHitSchema)(document);
    const candidates = yield* Schema.decodeUnknownEffect(Schema.Array(CoreSearchProjectionHitSchema))([
      { ...hit, title: 'Stale index title' },
      { ...hit, archived: true },
      { ...hit, ref: { ...hit.ref, resourceId: 'deleted-id' } },
      { ...hit, ref: { ...hit.ref, moduleId: 'another.owner' } },
      { ...hit, ref: { ...hit.ref, resourceType: 'finance.billing.document' } },
      { ...hit, ref: { ...hit.ref, tenantId: otherCompanyId } },
      { ...hit, selectedLegalEntityId: otherCompanyId },
    ]);
    const result = yield* loadCurrentSearchHits(scope, 'finance.billing.invoice', { query: 'FV' }, state).pipe(
      Effect.provideService(CoreSearchQueryRuntime, { search: () => Effect.succeed(candidates) }),
    );
    expect(result).toEqual([{ ref: hit.ref, selectedLegalEntityId: companyId, title: 'FV-2026-101' }]);
    return yield* Effect.void;
  }),
);
