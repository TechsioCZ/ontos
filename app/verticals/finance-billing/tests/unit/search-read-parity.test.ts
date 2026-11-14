import { financeBillingRegistration } from '../../vertical.registration.ts';
import { makeTestBoundAccessGate } from '@app/core-runtime/testing/access-gate';
import { NodeCrypto } from '@effect/platform-node';
import { ContextAccess, CoreSearchProjectionHitSchema, CoreSearchQueryRuntime } from '@app/core-runtime';
import type { OperationalScope } from '@app/core-runtime';
import { makeReadTestHarness } from '@app/core-runtime/testing/reads';
import { Context, DateTime, Effect, Exit, Layer, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { CoreSearchRelevanceSchema } from '@app/core-runtime/search-contract';
import type { CoreSearchRelevance } from '@app/core-runtime/search-contract';
import { FinanceStateSchema } from '../../shared/apis/records.ts';
import { DocumentsProviderResponseSchema } from '../../shared/apis/documents-search.ts';
import { InvoicesProviderResponseSchema } from '../../shared/apis/invoices-search.ts';
import { SearchProjectionUnavailable } from '../../shared/domain/search-projection-error.ts';
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
  counterpartyName: 'Původní Žluťoučký zákazník',
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
  readonly expectedCount?: number;
  readonly expectedTitle?: string;
  readonly foreignOwnerRow?: boolean;
  readonly includeArchived?: boolean;
  readonly kind: 'document' | 'invoice';
  readonly moduleAllowed?: boolean;
  readonly principal?: string;
  readonly query?: string;
  readonly refreshModuleGrant?: boolean;
  readonly state?:
    | 'empty'
    | 'missing'
    | 'orphan'
    | 'voided'
    | 'withdrawn'
    | 'renumbered'
    | 'renamed-party'
    | 'renamed-file';
  readonly unavailable?: boolean;
}

interface SearchHit {
  readonly ref: { readonly tenantId: string };
  readonly relevance?: CoreSearchRelevance;
  readonly selectedLegalEntityId: string;
  readonly title: string;
}

const checkHits = (hits: readonly SearchHit[]) => {
  for (const hit of hits) {
    expect(Object.keys(hit).toSorted()).toEqual(['ref', 'relevance', 'selectedLegalEntityId', 'title']);
    expect(Schema.is(CoreSearchRelevanceSchema)(hit.relevance)).toBe(true);
    expect(hit.selectedLegalEntityId).toBe(companyId);
    expect(hit.ref.tenantId).toBe(tenantId);
  }
  return hits.length;
};

const expectedSearchCount = (scenario: Scenario): number =>
  scenario.expectedCount ?? (scenario.company === otherCompanyId || scenario.state !== undefined ? 0 : 1);

const ownerSearchState = (scenario: Scenario): typeof encoded => {
  if (scenario.state === 'empty') {
    return { ...encoded, documents: [], invoices: [] };
  }
  if (scenario.state === 'voided') {
    return { ...encoded, invoices: [{ ...invoice, businessState: 'VOIDED' }] };
  }
  if (scenario.state === 'withdrawn') {
    return { ...encoded, documents: [] };
  }
  if (scenario.state === 'renumbered') {
    return { ...encoded, invoices: [{ ...invoice, documentNumber: 'FV-2026-202' }] };
  }
  if (scenario.state === 'renamed-party') {
    return { ...encoded, invoices: [{ ...invoice, counterpartyName: 'Nový zákazník' }] };
  }
  if (scenario.state === 'renamed-file') {
    return {
      ...encoded,
      documents: encoded.documents.map((document) => ({ ...document, fileName: 'Aktuální soubor.pdf' })),
    };
  }
  if (scenario.state === 'orphan') {
    return {
      ...encoded,
      documents: encoded.documents.map((document) => ({ ...document, invoiceResourceId: 'missing-invoice' })),
    };
  }
  return encoded;
};

const governedSearchProgram = Effect.fn('Finance.testSearchReadParity')(function* run(scenario: Scenario) {
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
  const stored = ownerSearchState(scenario);
  let { moduleAllowed = true } = scenario;
  const currentGate = makeTestBoundAccessGate({ defaultAnswer: { outcome: 'ALLOWED' } });
  const currentDecision = () => {
    let outcome: 'ALLOWED' | 'DENIED' | 'UNAVAILABLE' = moduleAllowed ? 'ALLOWED' : 'DENIED';
    if (scenario.unavailable === true) {
      outcome = 'UNAVAILABLE';
    }
    return makeTestBoundAccessGate({
      answers: {
        [`finance.billing.search-${scenario.kind === 'invoice' ? 'invoices' : 'documents'}.read`]: { outcome },
      },
    });
  };
  const accessDecision = {
    ...currentGate.bound,
    decide: (input: Parameters<typeof currentGate.bound.decide>[0]) => currentDecision().bound.decide(input),
    list: (input: Parameters<typeof currentGate.bound.list>[0]) => currentDecision().bound.list(input),
  };
  const harness = yield* makeReadTestHarness({
    accessDecision,
    compositionRevision: 'a'.repeat(64),
    executeOwnerQuery: ({ scope: actualScope, sql }) => {
      expect(actualScope).toEqual({ legalEntityId: principal.legalEntityId, tenantId });
      expect(sql).toContain('"finance_billing"."finance_states"');
      return Effect.succeed(
        scenario.state === 'missing' || principal.legalEntityId !== companyId
          ? []
          : [
              {
                legalEntityId: scenario.foreignOwnerRow === true ? otherCompanyId : principal.legalEntityId,
                revision: 7,
                state: stored,
                tenantId,
              },
            ],
      );
    },
    operationTime,
    ownerAuthorizationDecision: 'allowed',
    ownerRegistration: financeBillingRegistration,
    permissionDecision: 'allowed',
    scope: principal,
  });
  const services = yield* Layer.build(harness.layer);
  Object.assign(Context.get(services, ContextAccess), {
    contextPermissions: () => Effect.die('Retired permission authority was invoked'),
    modules: () => Effect.die('Retired module authority was invoked'),
    resources: () => Effect.die('Retired resource authority was invoked'),
  });
  let searches = 0;
  const runtime: CoreSearchQueryRuntime['Service'] = {
    search: (query, actualScope) =>
      Effect.sync(() => {
        searches += 1;
        expect(actualScope).toEqual(principal);
        expect(query).toMatchObject({
          includeArchived: false,
          includeRelevance: true,
          resourceType: `finance.billing.${scenario.kind}`,
          selectedLegalEntityId: principal.legalEntityId,
          tenantId,
        });
        expect(harness.snapshot().ownerQueries).toHaveLength(1);
        expect(harness.snapshot().statements.some((statement) => /^commit$/iu.test(statement))).toBe(true);
        return documents.filter((document) => document.ref.resourceType === `finance.billing.${scenario.kind}`);
      }),
  };
  const request = {
    input: {
      includeArchived: scenario.includeArchived ?? false,
      query: scenario.query ?? (scenario.kind === 'invoice' ? 'FV' : 'příloha'),
    },
    principal,
    transport: { correlationId: scope.correlationId },
  };
  const read = (
    scenario.kind === 'invoice'
      ? harness.runtime
          .runRead({ ...request, registration: invoicesRead })
          .pipe(Effect.map((hits): readonly SearchHit[] => hits))
      : harness.runtime
          .runRead({ ...request, registration: documentsRead })
          .pipe(Effect.map((hits): readonly SearchHit[] => hits))
  ).pipe(Effect.provideService(CoreSearchQueryRuntime, runtime));
  const outcome = yield* Effect.exit(read);
  if (scenario.moduleAllowed === false || scenario.unavailable === true || scenario.foreignOwnerRow === true) {
    expect(Exit.isFailure(outcome)).toBe(true);
    expect(harness.snapshot().ownerQueries).toHaveLength(scenario.foreignOwnerRow === true ? 1 : 0);
    expect(searches).toBe(0);
  } else {
    expect(Exit.isSuccess(outcome)).toBe(true);
    if (Exit.isSuccess(outcome)) {
      expect(checkHits(outcome.value)).toBe(expectedSearchCount(scenario));
      if (scenario.expectedTitle !== undefined) {
        expect(outcome.value.map((hit) => hit.title)).toEqual([scenario.expectedTitle]);
      }
    }
  }
  if (scenario.refreshModuleGrant === true) {
    moduleAllowed = true;
    expect(checkHits(yield* read)).toBe(1);
    expect(searches).toBe(1);
    moduleAllowed = false;
    expect(Exit.isFailure(yield* Effect.exit(read))).toBe(true);
    expect(searches).toBe(1);
    expect(harness.snapshot().ownerQueries).toHaveLength(1);
  }
});
const governedSearch = (scenario: Scenario) => Effect.scoped(governedSearchProgram(scenario));

it.layer(NodeCrypto.layer)('Finance native search parity', (suite) => {
  for (const kind of ['document', 'invoice'] as const) {
    suite.effect(`${kind}: finance and management use the native module gate without extra resource grants`, () =>
      Effect.forEach([scope.principalId, '50000000-0000-4000-8000-000000000002'], (principal) =>
        governedSearch({ kind, principal }),
      ),
    );
    suite.effect(`${kind}: unavailable canonical authority prevents owner and index observation`, () =>
      governedSearch({ kind, unavailable: true }),
    );
    suite.effect(`${kind}: foreign owner rows fail before index observation`, () =>
      governedSearch({ foreignOwnerRow: true, kind }),
    );
    suite.effect(`${kind}: absent module permission prevents owner and index work`, () =>
      governedSearch({ kind, moduleAllowed: false }),
    );
    suite.effect(`${kind}: newly granted and revoked module access is rechecked on the same runtime`, () =>
      governedSearch({ kind, moduleAllowed: false, refreshModuleGrant: true }),
    );
    suite.effect(`${kind}: another selected company cannot reuse a positive invoice or document index hit`, () =>
      governedSearch({ company: otherCompanyId, kind }),
    );
    suite.effect(`${kind}: missing, deleted and voided current ledger records suppress stale index hits`, () =>
      Effect.gen(function* staleRecords() {
        yield* governedSearch({ kind, state: 'empty' });
        yield* governedSearch({ kind, state: 'missing' });
        yield* governedSearch({ kind, state: 'voided' });
      }),
    );
  }
  suite.effect('renumbered invoices, renamed counterparties and renamed files reject old matching evidence', () =>
    Effect.gen(function* renamedEvidence() {
      yield* governedSearch({ kind: 'invoice', query: 'FV-2026-101', state: 'renumbered' });
      yield* governedSearch({ kind: 'invoice', query: 'zlutoucky', state: 'renamed-party' });
      yield* governedSearch({ kind: 'document', query: 'verejna priloha', state: 'renamed-file' });
      // Terms that still match return current owner labels, never stale index labels.
      yield* governedSearch({
        expectedCount: 1,
        expectedTitle: 'FV-2026-202',
        kind: 'invoice',
        query: 'FV',
        state: 'renumbered',
      });
      yield* governedSearch({
        expectedCount: 1,
        expectedTitle: 'Aktuální soubor.pdf',
        kind: 'document',
        query: 'pdf',
        state: 'renamed-file',
      });
    }),
  );
  suite.effect('archive compatibility never revives voided invoices or withdrawn/orphaned attachments', () =>
    Effect.gen(function* archiveCompatibility() {
      for (const includeArchived of [false, true]) {
        yield* governedSearch({ includeArchived, kind: 'invoice' });
        yield* governedSearch({ includeArchived, kind: 'document' });
        yield* governedSearch({ includeArchived, kind: 'invoice', state: 'voided' });
        yield* governedSearch({ includeArchived, kind: 'document', state: 'voided' });
        yield* governedSearch({ includeArchived, kind: 'document', state: 'withdrawn' });
        yield* governedSearch({ includeArchived, kind: 'document', state: 'orphan' });
      }
    }),
  );
  suite.effect('documents absent from the native invoice projection cannot survive as index hits', () =>
    Effect.gen(function* withdrawnDocuments() {
      yield* governedSearch({ kind: 'document', state: 'withdrawn' });
      yield* governedSearch({ kind: 'document', state: 'orphan' });
    }),
  );
});

it.effect('invoice rematching uses approved current dates, order number and snapshot name as one evidence group', () =>
  Effect.gen(function* currentInvoiceEvidence() {
    const state = yield* Schema.decodeUnknownEffect(FinanceStateSchema)({
      ...encoded,
      accountingSetup: { issuerIco: '12345678' },
      invoices: [
        {
          ...invoice,
          counterpartyCompanyId: '87654321',
          counterpartyName: 'Příliš žluťoučká Dvořáková',
          note: 'private-invoice-note',
          number: 'FV-2026-0101',
          sourceOrder: { id: 'private-order-id', number: 'SO-2026-0088' },
        },
      ],
    });
    const candidates = yield* buildSearchDocuments({
      companies: [{ legalEntityId: companyId, state }],
      projectionVersion: '1',
      tenantId,
    });
    const invoiceDocument = candidates.find((document) => document.ref.resourceType === 'finance.billing.invoice');
    expect(invoiceDocument?.searchableText).toEqual([
      'FV-2026-0101',
      'FV-2026-101',
      'Příliš žluťoučká Dvořáková',
      '87654321',
      '2026-11-01',
      '2026-11-10',
      'SO-2026-0088',
    ]);
    for (const query of [
      'dvorakova prilis',
      'SO-2026 2026-11-10',
      '2026-11-01',
      'FV-2026-0101',
      'Dvořáková',
      '87654321',
      '87654321 dvorakova',
    ]) {
      const hits = yield* loadCurrentSearchHits(scope, 'finance.billing.invoice', { query }, state).pipe(
        Effect.provideService(CoreSearchQueryRuntime, { search: () => Effect.succeed(candidates) }),
      );
      expect(hits).toEqual([{ ref: invoice.ref, selectedLegalEntityId: companyId, title: 'FV-2026-0101' }]);
    }
    for (const query of [
      '12345678',
      'private-invoice-note',
      'private-accounting',
      'private-order-id',
      invoice.counterpartyRef.resourceId,
      'Dvořáková nonexistent',
    ]) {
      const hits = yield* loadCurrentSearchHits(scope, 'finance.billing.invoice', { query }, state).pipe(
        Effect.provideService(CoreSearchQueryRuntime, { search: () => Effect.succeed(candidates) }),
      );
      expect(hits).toEqual([]);
    }
    const renumbered = yield* Schema.decodeUnknownEffect(FinanceStateSchema)({
      ...encoded,
      invoices: [{ ...invoice, documentNumber: 'NEW-2026-202', number: 'FV-2026-0202' }],
    });
    for (const query of ['FV-2026-0101', 'FV-2026-101', '87654321']) {
      const hits = yield* loadCurrentSearchHits(scope, 'finance.billing.invoice', { query }, renumbered).pipe(
        Effect.provideService(CoreSearchQueryRuntime, { search: () => Effect.succeed(candidates) }),
      );
      expect(hits).toEqual([]);
    }
    // File evidence remains its own group: an invoice's name/number must not prove a filename match.
    for (const query of ['Dvořáková', '87654321']) {
      const documents = yield* loadCurrentSearchHits(scope, 'finance.billing.document', { query }, state).pipe(
        Effect.provideService(CoreSearchQueryRuntime, { search: () => Effect.succeed(candidates) }),
      );
      expect(documents).toEqual([]);
    }
  }),
);

it.effect('current public labels recompute stale high scores, while legacy helper calls retain their old shape', () =>
  Effect.gen(function* verifiedRelevance() {
    const state = yield* Schema.decodeUnknownEffect(FinanceStateSchema)(encoded);
    const documents = yield* buildSearchDocuments({
      companies: [{ legalEntityId: companyId, state }],
      projectionVersion: '1',
      tenantId,
    });
    for (const [resourceType, query, expectedScore] of [
      ['finance.billing.invoice', 'zlutoucky', 100],
      ['finance.billing.document', 'priloha', 700],
    ] as const) {
      const current = documents.find((document) => document.ref.resourceType === resourceType);
      if (current === undefined) {
        return yield* Effect.die('Fixture current record missing');
      }
      const stale = yield* Schema.decodeEffect(CoreSearchProjectionHitSchema)({
        ...current,
        relevance: { score: 900, version: '1' },
        title: query,
      });
      for (const includeRelevance of [undefined, false, true]) {
        const hits = yield* loadCurrentSearchHits(
          scope,
          resourceType,
          includeRelevance === undefined ? { query } : { includeRelevance, query },
          state,
        ).pipe(
          Effect.provideService(CoreSearchQueryRuntime, {
            search: (input) => {
              if (includeRelevance === true) {
                expect(input).toMatchObject({ includeRelevance: true });
              } else {
                expect(input).not.toHaveProperty('includeRelevance');
              }
              return Effect.succeed([stale]);
            },
          }),
        );
        const result = { ref: current.ref, selectedLegalEntityId: companyId, title: current.title };
        expect(hits).toEqual([
          includeRelevance === true ? { ...result, relevance: { score: expectedScore, version: '1' } } : result,
        ]);
        const responseSchema =
          resourceType === 'finance.billing.invoice' ? InvoicesProviderResponseSchema : DocumentsProviderResponseSchema;
        const serialized = yield* Schema.encodeUnknownEffect(Schema.fromJsonString(responseSchema))(hits);
        expect(serialized).not.toMatch(/private|zlutoucky|counterpartyName|snippet|matchReason/u);
      }
      const rejected = yield* loadCurrentSearchHits(
        scope,
        resourceType,
        { includeRelevance: true, query: 'withdrawn-evidence' },
        state,
      ).pipe(Effect.provideService(CoreSearchQueryRuntime, { search: () => Effect.succeed([stale]) }));
      expect(rejected).toEqual([]);
    }
    return yield* Effect.void;
  }),
);

it.effect('normalized-empty and overlength queries fail closed before any index work', () =>
  Effect.gen(function* emptyQuery() {
    const state = yield* Schema.decodeUnknownEffect(FinanceStateSchema)(encoded);
    for (const resourceType of ['finance.billing.invoice', 'finance.billing.document'] as const) {
      for (const query of ['\u0301\u030C', 'x'.repeat(201)]) {
        const failure = yield* loadCurrentSearchHits(
          scope,
          resourceType,
          { includeRelevance: true, query },
          state,
        ).pipe(
          Effect.provideService(CoreSearchQueryRuntime, {
            search: () => Effect.die('Invalid query reached the index'),
          }),
          Effect.flip,
        );
        expect(Schema.is(SearchProjectionUnavailable)(failure)).toBe(true);
      }
    }
  }),
);

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
