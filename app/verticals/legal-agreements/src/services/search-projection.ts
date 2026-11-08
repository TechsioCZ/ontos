import {
  CoreSearchProjectionHitSchema,
  CoreSearchProjectionDocumentSchema,
  CoreSearchProjectionStore,
  CoreSearchQueryRuntime,
  coreSearchIngestionRegistryLayer,
  defineCoreSearchIngestionRegistrations,
} from '@app/core-runtime';
import type { OperationalScope, OutboxWorkerHandlerContext } from '@app/core-runtime';
import type { ListAccessPredicate } from '@app/core-runtime/access/decision/list-access';
import { RecordKeySchema } from '@app/core-runtime/access/ids';
import { matchesCoreSearchValues, parseCoreSearchQuery } from '@app/core-runtime/search-contract';
import { compareCoreSearchHits, coreSearchRelevance } from '@app/core-runtime/search-ranking';
import { Context, Effect, Layer, Option, Schema } from 'effect';
import type { AgreementsState } from '../../shared/apis/records.ts';
import { SearchSource } from './search-source.ts';
import { presentContracts } from './persistence.service.ts';
import { searchUnavailable as unavailable } from '../../shared/domain/search-projection-error.ts';
import type { ParentContractRead } from './search-access.ts';
import {
  loadParentContractPredicate,
  requireSearchFields,
  requireSearchPredicate,
  searchRecordVisible,
} from './search-access.ts';

export interface LegalSearchAuthorization {
  readonly deniedFieldPaths: readonly (readonly string[])[] | undefined;
  readonly listAccess: ListAccessPredicate | undefined;
  readonly parentRead?: ParentContractRead;
}

const moduleId = 'legal.agreements';
export const searchIngestionRegistrations = defineCoreSearchIngestionRegistrations([
  {
    consumerModuleKey: moduleId,
    producerModuleKey: moduleId,
    topic: 'legal.agreements.search-changed.v1',
    workerKey: 'legal.agreements.project-search',
  },
  {
    consumerModuleKey: moduleId,
    producerModuleKey: moduleId,
    topic: 'legal.agreements.search-rebuild-requested.v1',
    workerKey: 'legal.agreements.rebuild-search',
  },
]);
export const SearchIngestionRegistryLive = coreSearchIngestionRegistryLayer(searchIngestionRegistrations);
export interface SearchSnapshot {
  readonly companies: readonly { readonly legalEntityId: string; readonly state: AgreementsState }[];
  readonly projectionVersion: string;
  readonly tenantId: string;
}

/** Approved subject/kind/dates and document title/kind/filename/own technical ID only.
 * No foreign labels or IDs, notes, signers, signatures, rent, contacts, OCR or file contents.
 * Document timestamps are not search evidence without a separate field policy.
 */
export const buildSearchDocuments = Effect.fn('Agreements.buildSearchDocuments')(function* build(
  snapshot: SearchSnapshot,
  businessDate?: string,
) {
  if (
    snapshot.companies.some(
      ({ state }) =>
        state.contracts.some(({ contractRef }) => contractRef.tenantId !== snapshot.tenantId) ||
        state.documents.some(
          ({ contractRef, documentRef }) =>
            documentRef.tenantId !== snapshot.tenantId ||
            (contractRef !== null && contractRef.tenantId !== snapshot.tenantId),
        ),
    )
  ) {
    return yield* unavailable();
  }
  const documents = snapshot.companies.flatMap(({ legalEntityId, state }) => {
    const contracts = presentContracts(state, businessDate);
    const parents = new Map(contracts.map((contract) => [contract.contractRef.resourceId, contract]));
    const contractDocuments = contracts.map((contract) => {
      const kindLabel = contract.kind === 'LEASE' ? 'Nájemní smlouva' : 'Smlouva';
      const title = contract.subject ?? kindLabel;
      return {
        archived: contract.lifecycleState === 'TERMINATED' || contract.isExpired,
        facets: [],
        metadata: [],
        projectionVersion: snapshot.projectionVersion,
        ref: contract.contractRef,
        searchableText: [
          title,
          contract.kind,
          kindLabel,
          contract.contractRef.resourceId,
          contract.startDate,
          ...(contract.endDate === null ? [] : [contract.endDate]),
          ...(contract.renewalNoticeDate === null ? [] : [contract.renewalNoticeDate]),
        ],
        selectedLegalEntityId: legalEntityId,
        title,
      };
    });
    const legalDocuments = state.documents.flatMap((document) => {
      const parent = document.contractRef === null ? undefined : parents.get(document.contractRef.resourceId);
      // Missing/withdrawn parents never become unlinked public documents, even with includeArchived.
      if (document.contractRef !== null && parent === undefined) {
        return [];
      }
      return [
        {
          archived:
            document.lifecycleState === 'ARCHIVED' ||
            parent?.lifecycleState === 'TERMINATED' ||
            parent?.isExpired === true,
          facets: [],
          metadata: [],
          projectionVersion: snapshot.projectionVersion,
          ref: document.documentRef,
          searchableText: [
            document.title,
            document.kind,
            document.documentRef.resourceId,
            ...(document.fileName === null ? [] : [document.fileName]),
          ],
          selectedLegalEntityId: legalEntityId,
          title: document.title,
        },
      ];
    });
    return [...contractDocuments, ...legalDocuments];
  });
  return yield* Schema.decodeUnknownEffect(Schema.Array(CoreSearchProjectionDocumentSchema))(documents).pipe(
    Effect.mapError(unavailable),
  );
});
export const createSearchProjector = Effect.gen(function* createProjector() {
  const sourcePort = yield* SearchSource;
  const store = yield* CoreSearchProjectionStore;
  return {
    project: Effect.fn('Agreements.projectSearch')(function* project(context: OutboxWorkerHandlerContext) {
      const source = yield* sourcePort.load(context);
      if (source.tenantId !== context.tenantId) {
        return yield* unavailable();
      }
      const documents = yield* buildSearchDocuments(source);
      // All snapshot SQL has committed. Core Search enforces the caller's access list predicate and fields;
      // the owner writes no permission-graph containment edge.
      // Core atomically replaces each complete resource-type unit at the same reserved generation.
      // No individual apply: preserve Core floors, CAS and deletion semantics.
      yield* Effect.forEach(
        ['legal.agreements.contract', 'legal.agreements.document'],
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
  '@app/legal-agreements/services/search-projection/SearchProjector',
) {}
export const SearchProjectorLive = Layer.effect(SearchProjector, createSearchProjector);

export const loadSearchHits = Effect.fn('Agreements.loadSearchHits')(function* load(
  scope: OperationalScope,
  resourceType: 'legal.agreements.contract',
  input: { readonly includeArchived?: boolean; readonly query: string },
  authorization: LegalSearchAuthorization,
) {
  if (scope.legalEntityId === undefined) {
    return yield* unavailable();
  }
  yield* requireSearchFields(authorization.deniedFieldPaths);
  const predicate = yield* requireSearchPredicate(authorization.listAccess);
  const runtime = yield* CoreSearchQueryRuntime;
  const hits = yield* runtime.search(
    {
      includeArchived: input.includeArchived ?? false,
      moduleId,
      query: input.query,
      resourceType,
      selectedLegalEntityId: scope.legalEntityId,
      tenantId: scope.tenantId,
    },
    scope,
    { listAccess: predicate },
  );
  const validated = yield* Schema.decodeUnknownEffect(Schema.Array(CoreSearchProjectionHitSchema))(hits).pipe(
    Effect.mapError(unavailable),
  );
  return yield* Effect.forEach(
    validated,
    (hit) => {
      if (
        hit.ref.moduleId !== moduleId ||
        hit.ref.resourceType !== resourceType ||
        hit.ref.tenantId !== scope.tenantId ||
        hit.selectedLegalEntityId !== scope.legalEntityId ||
        (hit.archived && input.includeArchived !== true) ||
        !searchRecordVisible(predicate, hit.ref.resourceId)
      ) {
        return Effect.fail(unavailable());
      }
      return Effect.succeed({ ref: hit.ref, selectedLegalEntityId: hit.selectedLegalEntityId, title: hit.title });
    },
    { concurrency: 1 },
  );
});

/**
 * Recheck current owner evidence and archive state, never the shortlist's stale text/flags.
 * Linked documents independently require the original contract Read's canonical LIST predicate.
 * Translate exact currently visible parent keys into document keys before Core's index limit.
 */
export const loadCurrentSearchHits = Effect.fn('Agreements.loadCurrentSearchHits')(function* load(
  scope: OperationalScope,
  resourceType: 'legal.agreements.contract' | 'legal.agreements.document',
  input: { readonly includeArchived?: boolean; readonly includeRelevance?: boolean; readonly query: string },
  visible: AgreementsState,
  authorization: LegalSearchAuthorization,
) {
  const { legalEntityId } = scope;
  if (legalEntityId === undefined) {
    return yield* unavailable();
  }
  yield* requireSearchFields(authorization.deniedFieldPaths);
  const predicate = yield* requireSearchPredicate(authorization.listAccess);
  const parsed = yield* Effect.fromResult(parseCoreSearchQuery(input.query)).pipe(Effect.mapError(unavailable));
  const documents = yield* buildSearchDocuments({
    companies: [{ legalEntityId, state: visible }],
    projectionVersion: '1',
    tenantId: scope.tenantId,
  });
  const eligible = documents.filter(
    (document) =>
      document.ref.resourceType === resourceType &&
      (input.includeArchived === true || !document.archived) &&
      searchRecordVisible(predicate, document.ref.resourceId) &&
      matchesCoreSearchValues([document.title, ...document.searchableText], parsed.tokens),
  );
  const eligibleIds = new Set<string>(eligible.map(({ ref }) => ref.resourceId));
  const parentByDocument = new Map(
    resourceType === 'legal.agreements.document'
      ? visible.documents.flatMap((document) =>
          document.contractRef === null || !eligibleIds.has(document.documentRef.resourceId)
            ? []
            : [[document.documentRef.resourceId, document.contractRef] as const],
        )
      : [],
  );
  let parentPredicate = Option.none<ListAccessPredicate>();
  if (parentByDocument.size > 0) {
    if (authorization.parentRead === undefined) {
      return yield* unavailable();
    }
    parentPredicate = yield* loadParentContractPredicate(scope, authorization.parentRead);
  }
  const current = new Map(
    eligible.flatMap((document) =>
      !parentByDocument.has(document.ref.resourceId) ||
      Option.exists(parentPredicate, (parentAccess) => {
        const parent = parentByDocument.get(document.ref.resourceId);
        return parent !== undefined && searchRecordVisible(parentAccess, parent.resourceId);
      })
        ? [[document.ref.resourceId, document] as const]
        : [],
    ),
  );
  if (current.size === 0) {
    return [];
  }
  const recordKeys = yield* Schema.decodeUnknownEffect(Schema.NonEmptyArray(RecordKeySchema))([...current.keys()]).pipe(
    Effect.mapError(unavailable),
  );
  const admitted: ListAccessPredicate = {
    groups: [...predicate.groups, { clauses: [{ conditions: [{ _tag: 'RecordKeyIn', recordKeys }] }] }],
  };
  const runtime = yield* CoreSearchQueryRuntime;
  // Keep archived candidates in the shortlist so the current owner snapshot decides inclusion.
  const hits = yield* runtime
    .search(
      {
        includeArchived: true,
        moduleId,
        query: input.query,
        resourceType,
        selectedLegalEntityId: legalEntityId,
        tenantId: scope.tenantId,
      },
      scope,
      { listAccess: admitted },
    )
    .pipe(Effect.mapError(unavailable));
  const validated = yield* Schema.decodeUnknownEffect(Schema.Array(CoreSearchProjectionHitSchema))(hits).pipe(
    Effect.mapError(unavailable),
  );
  if (new Set(validated.map(({ ref }) => ref.resourceId)).size !== validated.length) {
    return yield* unavailable();
  }
  const matched = validated.flatMap((hit) => {
    const document = current.get(hit.ref.resourceId);
    return document === undefined ||
      hit.ref.moduleId !== moduleId ||
      hit.ref.resourceType !== resourceType ||
      hit.ref.tenantId !== scope.tenantId ||
      hit.selectedLegalEntityId !== legalEntityId ||
      !searchRecordVisible(admitted, hit.ref.resourceId) ||
      !matchesCoreSearchValues([document.title, ...document.searchableText], parsed.tokens)
      ? []
      : [document];
  });
  return matched
    .toSorted((left, right) => compareCoreSearchHits(left, right, parsed))
    .map((document) => {
      const result = { ref: document.ref, selectedLegalEntityId: legalEntityId, title: document.title };
      // Recompute only from current, matching evidence. Never forward an index-title score.
      return input.includeRelevance === true ? { ...result, relevance: coreSearchRelevance(document, parsed) } : result;
    });
});
