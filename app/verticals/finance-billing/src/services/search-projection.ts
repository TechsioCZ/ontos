import {
  CoreSearchProjectionDocumentSchema,
  CoreSearchProjectionStore,
  CoreSearchQueryRuntime,
  coreSearchIngestionRegistryLayer,
  defineCoreSearchIngestionRegistrations,
} from '@app/core-runtime';
import { matchesCoreSearchValues, parseCoreSearchQuery } from '@app/core-runtime/search-contract';
import { coreSearchRelevance } from '@app/core-runtime/search-ranking';
import type { OperationalScope, OutboxWorkerHandlerContext } from '@app/core-runtime';
import { Context, Effect, Layer, Schema } from 'effect';
import type { FinanceState } from '../../shared/apis/records.ts';
import { SearchSource } from './search-source.ts';
import { searchUnavailable as unavailable } from '../../shared/domain/search-projection-error.ts';

const moduleId = 'finance.billing';
export const searchIngestionRegistrations = defineCoreSearchIngestionRegistrations([
  {
    consumerModuleKey: moduleId,
    producerModuleKey: moduleId,
    topic: 'finance.billing.search-changed.v1',
    workerKey: 'finance.billing.project-search',
  },
  {
    consumerModuleKey: moduleId,
    producerModuleKey: moduleId,
    topic: 'finance.billing.search-rebuild-requested.v1',
    workerKey: 'finance.billing.rebuild-search',
  },
]);
export const SearchIngestionRegistryLive = coreSearchIngestionRegistryLayer(searchIngestionRegistrations);
export interface SearchSnapshot {
  readonly companies: readonly { readonly legalEntityId: string; readonly state: FinanceState }[];
  readonly projectionVersion: string;
  readonly tenantId: string;
}

/**
 * Only Finance-owned invoice evidence and public file metadata. counterpartyName and counterpartyCompanyId
 * are stored invoice snapshots, not current Party labels. Current Party labels require approved publication.
 * Never index bytes, hashes, actors, notes or payment details (including the accounting issuer's IČO as a partner).
 */
export const buildSearchDocuments = Effect.fn('Finance.buildSearchDocuments')(function* build(
  snapshot: SearchSnapshot,
) {
  if (snapshot.companies.some(({ state }) => state.invoices.some(({ ref }) => ref.tenantId !== snapshot.tenantId))) {
    return yield* unavailable();
  }
  const documents = snapshot.companies.flatMap(({ legalEntityId, state }) => {
    const common = {
      archived: false,
      facets: [],
      metadata: [],
      projectionVersion: snapshot.projectionVersion,
      selectedLegalEntityId: legalEntityId,
    };
    const invoices = state.invoices.flatMap((invoice) =>
      invoice.businessState === 'VOIDED'
        ? []
        : [
            {
              ...common,
              ref: invoice.ref,
              searchableText: [
                invoice.number,
                invoice.documentNumber,
                invoice.counterpartyName,
                invoice.counterpartyCompanyId,
                invoice.issueDate,
                invoice.dueDate,
                invoice.sourceOrder?.number,
              ].filter((value) => value !== undefined),
              title: invoice.number ?? invoice.documentNumber ?? invoice.counterpartyName ?? 'Faktura',
            },
          ],
    );
    const attachments = (state.documents ?? []).flatMap((document) => {
      if (
        document.invoiceResourceId !== undefined &&
        !state.invoices.some(
          (invoice) => invoice.ref.resourceId === document.invoiceResourceId && invoice.businessState !== 'VOIDED',
        )
      ) {
        return [];
      }
      return [
        {
          ...common,
          ref: {
            moduleId,
            resourceId: document.id,
            resourceType: 'finance.billing.document',
            tenantId: snapshot.tenantId,
          },
          searchableText: [document.fileName],
          title: document.fileName,
        },
      ];
    });
    return [...invoices, ...attachments];
  });
  return yield* Schema.decodeUnknownEffect(Schema.Array(CoreSearchProjectionDocumentSchema))(documents).pipe(
    Effect.mapError(unavailable),
  );
});
export const createSearchProjector = Effect.gen(function* createProjector() {
  const sourcePort = yield* SearchSource;
  const store = yield* CoreSearchProjectionStore;
  return {
    project: Effect.fn('Finance.projectSearch')(function* project(context: OutboxWorkerHandlerContext) {
      const source = yield* sourcePort.load(context);
      if (source.tenantId !== context.tenantId) {
        return yield* unavailable();
      }
      const documents = yield* buildSearchDocuments(source);
      // All snapshot SQL has committed. Core Search enforces the caller's access list predicate and fields;
      // the owner writes no permission-graph containment edge.
      // Every lifecycle event reads a full owner snapshot with a Core-reserved version. Replacement prunes deletions,
      // voided invoices and withdrawn files, including empty companies, without trusting payload revisions or scope.
      yield* Effect.forEach(
        ['finance.billing.invoice', 'finance.billing.document'],
        (resourceType) =>
          store.replace(
            {
              documents: documents.filter((document) => document.ref.resourceType === resourceType),
              moduleId,
              rebuildVersion: source.projectionVersion,
              resourceType,
              tenantId: source.tenantId,
            },
            context,
          ),
        { concurrency: 1, discard: true },
      ).pipe(Effect.mapError(unavailable));
      return yield* Effect.void;
    }),
  };
});
export class SearchProjector extends Context.Service<SearchProjector, Effect.Success<typeof createSearchProjector>>()(
  '@app/finance-billing/services/search-projection/SearchProjector',
) {}
export const SearchProjectorLive = Layer.effect(SearchProjector, createSearchProjector);

export const loadSearchHits = Effect.fn('Finance.loadSearchHits')(function* load(
  scope: OperationalScope,
  resourceType: 'finance.billing.invoice' | 'finance.billing.document',
  input: { readonly includeArchived?: boolean; readonly query: string },
) {
  if (scope.legalEntityId === undefined) {
    return yield* unavailable();
  }
  const runtime = yield* CoreSearchQueryRuntime;
  const hits = yield* runtime.search(
    {
      includeArchived: false,
      moduleId,
      query: input.query,
      resourceType,
      selectedLegalEntityId: scope.legalEntityId,
      tenantId: scope.tenantId,
    },
    scope,
  );
  return yield* Effect.forEach(
    hits,
    (hit) => {
      if (
        hit.ref.moduleId !== moduleId ||
        hit.ref.resourceType !== resourceType ||
        hit.ref.tenantId !== scope.tenantId ||
        hit.selectedLegalEntityId !== scope.legalEntityId ||
        hit.archived
      ) {
        return Effect.fail(unavailable());
      }
      return Effect.succeed({ ref: hit.ref, selectedLegalEntityId: hit.selectedLegalEntityId, title: hit.title });
    },
    { concurrency: 1 },
  );
});

/**
 * Recheck current Finance evidence, not just identity, against the same owner state used by the records Read.
 * Core shortlists candidates, but index text may still describe an older number, filename or snapshot name;
 * the current owner projection must match the same Core-normalized tokens before a hit may leave the owner.
 * includeArchived is a compatibility flag: Finance has no archive state and neither value restores voided
 * invoices, orphaned attachments or withdrawn files. Current Party names require an approved publication.
 */
export const loadCurrentSearchHits = Effect.fn('Finance.loadCurrentSearchHits')(function* load(
  scope: OperationalScope,
  resourceType: 'finance.billing.invoice' | 'finance.billing.document',
  input: { readonly includeArchived?: boolean; readonly includeRelevance?: boolean; readonly query: string },
  visible: FinanceState,
) {
  const { legalEntityId } = scope;
  if (legalEntityId === undefined) {
    return yield* unavailable();
  }
  const parsedQuery = yield* Effect.fromResult(parseCoreSearchQuery(input.query)).pipe(Effect.mapError(unavailable));
  const documents = yield* buildSearchDocuments({
    companies: [{ legalEntityId, state: visible }],
    projectionVersion: '1',
    tenantId: scope.tenantId,
  });
  const current = new Map(
    documents.flatMap((document) =>
      document.ref.resourceType === resourceType ? [[document.ref.resourceId, document] as const] : [],
    ),
  );
  const runtime = yield* CoreSearchQueryRuntime;
  const request = {
    includeArchived: false,
    moduleId,
    query: input.query,
    resourceType,
    selectedLegalEntityId: legalEntityId,
    tenantId: scope.tenantId,
  };
  const hits = yield* runtime.search(
    input.includeRelevance === true ? { ...request, includeRelevance: true } : request,
    scope,
  );
  return hits.flatMap((hit) => {
    const document = current.get(hit.ref.resourceId);
    if (
      document === undefined ||
      hit.archived ||
      hit.ref.moduleId !== moduleId ||
      hit.ref.resourceType !== resourceType ||
      hit.ref.tenantId !== scope.tenantId ||
      hit.selectedLegalEntityId !== legalEntityId ||
      !matchesCoreSearchValues([document.title, ...document.searchableText], parsedQuery.tokens)
    ) {
      return [];
    }
    const result = { ref: document.ref, selectedLegalEntityId: legalEntityId, title: document.title };
    // Never carry the shortlist's stale-title score across the current owner evidence boundary.
    return [
      input.includeRelevance === true
        ? {
            ...result,
            relevance: coreSearchRelevance({ ...hit, ref: document.ref, title: document.title }, parsedQuery),
          }
        : result,
    ];
  });
});
