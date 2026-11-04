import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';

import { Clock, DateTime, Effect, Option, Predicate, Result, Schema } from 'effect';
import { Hex } from 'effect/encoding';
import type { OperationalScope } from '../operations/context.ts';
import { isVerifiedOutboxWorkerHandlerContext } from '../outbox/definition.ts';
import type { OutboxWorkerHandlerContext } from '../outbox/definition.ts';

import { CoreSearchProjectionStore, coreSearchQueryMatchesScope } from './projection-store.ts';
import type { CoreSearchProjectionRefreshStoreService, CoreSearchProjectionStoreService } from './projection-store.ts';
import { deriveCoreSearchRepresentation } from './evidence-codec.ts';
import {
  CoreSearchResourceRefSchema,
  coreSearchModuleId,
  coreSearchResourceRefKey,
  coreSearchResourceType,
  coreSearchSelectedLegalEntityId,
  coreSearchStableKey,
  coreSearchTenantId,
} from './resource-ref.ts';
import type { CoreSearchResourceRef } from './resource-ref.ts';
import {
  CORE_SEARCH_LABEL_REFRESH_PAGE_LIMIT,
  CoreSearchDerivedRepairCommitSchema,
  CoreSearchDerivedRepairOpenSchema,
  CoreSearchDerivedRepairRequestSchema,
  CoreSearchDerivedRepairResourceIdsSchema,
  CoreSearchLabelRefreshJobSchema,
  CoreSearchLabelRefreshOpenSchema,
  CoreSearchLabelRefreshPageQuerySchema,
  advanceCoreSearchLabelBarrier,
  compareCoreSearchLabelRefreshCursor,
  coreSearchDerivedRepairCursor,
  coreSearchLabelBarrierKey,
  coreSearchLabelRefreshCursorKey,
  coreSearchLabelBarrierViolation,
  decodeCoreSearchLabelRefreshCursorOption,
  planCoreSearchDerivedRepairReopen,
} from './label-refresh.ts';
import type {
  CoreSearchDerivedRepairCommit,
  CoreSearchDerivedRepairJob,
  CoreSearchDerivedRepairOpen,
  CoreSearchDerivedRepairProgress,
  CoreSearchDerivedRepairRequest,
  CoreSearchDerivedRepairResult,
  CoreSearchDerivedRepairScan,
  CoreSearchLabelRefreshJob,
  CoreSearchLabelRefreshOpen,
  CoreSearchLabelRefreshPageQuery,
} from './label-refresh.ts';
import type { CoreSearchQueryRuntimeService } from './query-runtime.ts';
import {
  CoreSearchQueryTextSchema,
  CoreSearchRelevanceSchema,
  CORE_SEARCH_MAX_RESOURCE_TYPES,
  coreSearchResourceTypes,
  createCoreSearchValueMatcher,
  parseCoreSearchQuery,
} from './search-contract.ts';
import { compareCoreSearchHitIdentity, coreSearchRank, coreSearchRelevanceForRank } from './search-ranking.ts';

export { CoreSearchProjectionRefreshStore, CoreSearchProjectionStore } from './projection-store.ts';
export { CoreSearchQueryRuntime } from './query-runtime.ts';
export type { CoreSearchProjectionRefreshStoreService, CoreSearchProjectionStoreService } from './projection-store.ts';
export type { CoreSearchQueryRuntimeService } from './query-runtime.ts';

export const CORE_SEARCH_MAX_TERM_LENGTH = 300;
export const CORE_SEARCH_MAX_SEARCHABLE_TERMS = 2002;
const boundedText = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(CORE_SEARCH_MAX_TERM_LENGTH));
const stableKey = coreSearchStableKey;
const moduleId = coreSearchModuleId;
const resourceType = coreSearchResourceType;
const selectedLegalEntityId = coreSearchSelectedLegalEntityId;
const tenantId = coreSearchTenantId;
const projectionVersion = Schema.String.check(Schema.isPattern(/^[1-9][0-9]*$/u));
type UnparsedCoreSearchInput = typeof Schema.Unknown.Type;

export { CoreSearchResourceRefSchema, coreSearchResourceRefKey } from './resource-ref.ts';
export type { CoreSearchResourceRef } from './resource-ref.ts';
export {
  CORE_SEARCH_LABEL_REFERENCE_LOOKUP_LIMIT,
  CORE_SEARCH_LABEL_REFRESH_PAGE_LIMIT,
  CoreSearchDerivedRepairCommitSchema,
  CoreSearchDerivedRepairGenerationSchema,
  CoreSearchDerivedRepairJobSchema,
  CoreSearchDerivedRepairOpenSchema,
  CoreSearchDerivedRepairProgressSchema,
  CoreSearchDerivedRepairRequestSchema,
  CoreSearchDerivedRepairResourceIdsSchema,
  CoreSearchDerivedRepairResultSchema,
  CoreSearchDerivedRepairScanSchema,
  CoreSearchDerivedRepairStateSchema,
  CoreSearchLabelRefreshJobSchema,
  CoreSearchLabelRefreshOpenSchema,
  CoreSearchLabelRefreshPageQuerySchema,
  CoreSearchLabelRefreshStateSchema,
  CoreSearchLabelSourceRevisionSchema,
  advanceCoreSearchLabelBarrier,
  compareCoreSearchLabelRefreshCursor,
  coreSearchDerivedRepairCursor,
  coreSearchLabelBarrierKey,
  coreSearchLabelRefreshCursorKey,
  decodeCoreSearchLabelRefreshCursor,
  decodeCoreSearchLabelRefreshCursorOption,
  planCoreSearchDerivedRepairReopen,
} from './label-refresh.ts';
export type {
  CoreSearchDerivedRepairCommit,
  CoreSearchDerivedRepairGeneration,
  CoreSearchDerivedRepairJob,
  CoreSearchDerivedRepairOpen,
  CoreSearchDerivedRepairProgress,
  CoreSearchDerivedRepairReopenPlan,
  CoreSearchDerivedRepairRequest,
  CoreSearchDerivedRepairResult,
  CoreSearchDerivedRepairScan,
  CoreSearchDerivedRepairState,
  CoreSearchLabelRefreshJob,
  CoreSearchLabelRefreshOpen,
  CoreSearchLabelRefreshPageQuery,
  CoreSearchLabelRefreshState,
  CoreSearchLabelSourceRevision,
} from './label-refresh.ts';

/**
 * Canonical owner source identity and revision used to build this document. This is provenance,
 * never permission to disclose or match its label. Owners must retain current source authorization.
 * Decimal strings preserve owner bigint revisions without transport rounding. Keep the edge and
 * advance its revision on label withdrawal while the relationship exists; remove only its text.
 */
export const CoreSearchLabelDependencySchema = Schema.Struct({
  ref: CoreSearchResourceRefSchema,
  selectedLegalEntityId,
  sourceRevision: Schema.String.check(Schema.isPattern(/^(?:0|[1-9][0-9]*)$/u)),
});
export type CoreSearchLabelDependency = typeof CoreSearchLabelDependencySchema.Type;

export const CoreSearchProjectionDependentQuerySchema = Schema.Struct({
  moduleId,
  selectedLegalEntityId,
  sourceRef: CoreSearchResourceRefSchema,
  tenantId,
});
export type CoreSearchProjectionDependentQuery = typeof CoreSearchProjectionDependentQuerySchema.Type;

export const CoreSearchFacetSchema = Schema.Struct({
  key: stableKey,
  values: Schema.Array(boundedText).check(Schema.isMaxLength(50)),
});
export type CoreSearchFacet = typeof CoreSearchFacetSchema.Type;

export const CoreSearchMetadataFieldSchema = Schema.Union([
  Schema.Struct({
    key: stableKey,
    kind: Schema.Literal('boolean'),
    value: Schema.Boolean,
  }),
  Schema.Struct({
    key: stableKey,
    kind: Schema.Literal('string'),
    value: boundedText,
  }),
  Schema.Struct({
    key: stableKey,
    kind: Schema.Literal('strings'),
    value: Schema.Array(boundedText).check(Schema.isMaxLength(50)),
  }),
]);
export type CoreSearchMetadataField = typeof CoreSearchMetadataFieldSchema.Type;

export const CoreSearchTemporalFacetSchema = Schema.Struct({
  key: stableKey,
  validFrom: boundedText,
  validTo: Schema.optionalKey(boundedText),
  value: boundedText,
});
export type CoreSearchTemporalFacet = typeof CoreSearchTemporalFacetSchema.Type;

export const CoreSearchTemporalSearchableTextSchema = Schema.Struct({
  validFrom: boundedText,
  validTo: Schema.optionalKey(boundedText),
  value: boundedText,
});
const temporalSearchableText = Schema.optionalKey(
  Schema.Array(CoreSearchTemporalSearchableTextSchema).check(Schema.isMaxLength(100)),
);

export const CoreSearchAliasSchema = Schema.Struct({
  kind: Schema.Literals(['resource', 'subject']),
  ref: CoreSearchResourceRefSchema,
  searchableText: Schema.Array(boundedText).check(Schema.isMaxLength(100)),
  temporalSearchableText,
});

export const CoreSearchProjectionDocumentSchema = Schema.Struct({
  aliases: Schema.optionalKey(Schema.Array(CoreSearchAliasSchema).check(Schema.isMaxLength(100))),
  archived: Schema.Boolean,
  facets: Schema.Array(CoreSearchFacetSchema).check(Schema.isMaxLength(50)),
  labelDependencies: Schema.optionalKey(Schema.Array(CoreSearchLabelDependencySchema).check(Schema.isMaxLength(100))),
  matchedRef: Schema.optionalKey(CoreSearchResourceRefSchema),
  matchedSubjectRef: Schema.optionalKey(CoreSearchResourceRefSchema),
  metadata: Schema.Array(CoreSearchMetadataFieldSchema).check(Schema.isMaxLength(50)),
  projectionVersion,
  ref: CoreSearchResourceRefSchema,
  // Merchandise supports 1,000 active variant SKU/name pairs plus the parent SKU/name.
  searchableText: Schema.Array(boundedText).check(Schema.isMaxLength(CORE_SEARCH_MAX_SEARCHABLE_TERMS)),
  selectedLegalEntityId: Schema.optionalKey(selectedLegalEntityId),
  subjectRef: Schema.optionalKey(CoreSearchResourceRefSchema),
  temporalFacets: Schema.optionalKey(Schema.Array(CoreSearchTemporalFacetSchema).check(Schema.isMaxLength(100))),
  temporalSearchableText,
  title: boundedText,
});
export type CoreSearchProjectionDocument = typeof CoreSearchProjectionDocumentSchema.Type;

export const CoreSearchProjectionHitSchema = Schema.Struct({
  archived: Schema.Boolean,
  facets: Schema.Array(CoreSearchFacetSchema).check(Schema.isMaxLength(50)),
  matchedRef: Schema.optionalKey(CoreSearchResourceRefSchema),
  matchedSubjectRef: Schema.optionalKey(CoreSearchResourceRefSchema),
  metadata: Schema.Array(CoreSearchMetadataFieldSchema).check(Schema.isMaxLength(50)),
  ref: CoreSearchResourceRefSchema,
  // Additive and only emitted when the caller asks for it; old arrays remain valid.
  relevance: Schema.optionalKey(CoreSearchRelevanceSchema),
  selectedLegalEntityId: Schema.optionalKey(selectedLegalEntityId),
  subjectRef: Schema.optionalKey(CoreSearchResourceRefSchema),
  temporalFacets: Schema.optionalKey(Schema.Array(CoreSearchTemporalFacetSchema).check(Schema.isMaxLength(100))),
  title: boundedText,
});
export type CoreSearchProjectionHit = typeof CoreSearchProjectionHitSchema.Type;

const resourceTypeList = Schema.Array(resourceType).check(Schema.isMaxLength(CORE_SEARCH_MAX_RESOURCE_TYPES));

export const CoreSearchQuerySchema = Schema.Struct({
  effectiveAt: Schema.optionalKey(Schema.DateTimeUtcFromString),
  facets: Schema.optionalKey(Schema.Array(CoreSearchFacetSchema).check(Schema.isMaxLength(20))),
  includeArchived: Schema.Boolean,
  // Opt-in so unchanged callers keep their exact old hit arrays.
  includeRelevance: Schema.optionalKey(Schema.Boolean),
  moduleId,
  query: CoreSearchQueryTextSchema,
  // Legacy single-type callers stay valid; new callers may select up to 64 types.
  resourceType: Schema.optionalKey(resourceType),
  resourceTypes: Schema.optionalKey(resourceTypeList),
  selectedLegalEntityId: Schema.optionalKey(selectedLegalEntityId),
  tenantId,
}).check(
  Schema.makeFilter((query) => {
    const types = coreSearchResourceTypes(query);
    return types.length > 0 && types.length <= CORE_SEARCH_MAX_RESOURCE_TYPES;
  }),
);
export type CoreSearchQuery = typeof CoreSearchQuerySchema.Type;

export const CoreSearchProjectionReplacementSchema = Schema.Struct({
  documents: Schema.Array(CoreSearchProjectionDocumentSchema).check(Schema.isMaxLength(10_000)),
  moduleId,
  rebuildVersion: projectionVersion,
  resourceType,
  tenantId,
});
export type CoreSearchProjectionReplacement = typeof CoreSearchProjectionReplacementSchema.Type;

export const CoreSearchProjectionMutationSchema = Schema.Union([
  Schema.Struct({
    document: CoreSearchProjectionDocumentSchema,
    kind: Schema.Literal('upsert'),
  }),
  Schema.Struct({
    kind: Schema.Literal('delete'),
    projectionVersion,
    ref: CoreSearchResourceRefSchema,
  }),
]);
export type CoreSearchProjectionMutation = typeof CoreSearchProjectionMutationSchema.Type;

/** Bounded atomic refresh work, not an arbitrarily chunked replacement snapshot. */
export const CoreSearchProjectionBatchSchema = Schema.Struct({
  moduleId,
  mutations: Schema.Array(CoreSearchProjectionMutationSchema).check(Schema.isMinLength(1), Schema.isMaxLength(1000)),
  tenantId,
});
export type CoreSearchProjectionBatch = typeof CoreSearchProjectionBatchSchema.Type;

/** One bounded durable label-refresh page of dependents, ordered by the canonical keyset cursor. */
export const CoreSearchLabelRefreshPageSchema = Schema.Struct({
  documents: Schema.Array(CoreSearchProjectionDocumentSchema).check(Schema.isMaxLength(1000)),
  hasMore: Schema.Boolean,
  /** Canonical key of the last document on this page; `Option.none()` when the sweep found nothing. */
  pageEnd: Schema.OptionFromNullOr(Schema.String),
});
export type CoreSearchLabelRefreshPage = typeof CoreSearchLabelRefreshPageSchema.Type;

/** One page of target mutations plus its keyset cursor advance, committed as one transaction. */
export const CoreSearchLabelRefreshCommitSchema = Schema.Struct({
  job: Schema.toType(CoreSearchLabelRefreshJobSchema),
  mutations: Schema.Array(CoreSearchProjectionMutationSchema).check(Schema.isMaxLength(1000)),
  /** Canonical key returned by the matching read; `Option.none()` only when the page was empty. */
  pageEnd: Schema.toType(Schema.OptionFromNullOr(Schema.String)),
});
export type CoreSearchLabelRefreshCommit = typeof CoreSearchLabelRefreshCommitSchema.Type;

export class CoreSearchProjectionInvalid extends Schema.TaggedError<CoreSearchProjectionInvalid>()(
  'CoreSearchProjectionInvalid',
  {
    cause: Schema.optionalKey(Schema.Unknown),
    code: Schema.Literal('core_search_projection_invalid'),
    reason: Schema.String,
  },
) {}

const projectionUnavailableFields = {
  cause: Schema.optionalKey(Schema.Unknown),
  code: Schema.Literal('core_search_projection_unavailable'),
  reason: Schema.String,
};
const CoreSearchProjectionUnavailableSchema = Schema.TaggedStruct(
  'CoreSearchProjectionUnavailable',
  projectionUnavailableFields,
);
export type CoreSearchProjectionUnavailableError = typeof CoreSearchProjectionUnavailableSchema.Type;
export const CoreSearchProjectionUnavailable = Schema.TaggedError<CoreSearchProjectionUnavailableError>()(
  'CoreSearchProjectionUnavailable',
  projectionUnavailableFields,
);
const projectionUnitKeyCodec = Schema.fromJsonString(Schema.Tuple([Schema.String, Schema.String, Schema.String]));
const encodeProjectionUnitKey = Schema.encodeUnknownResult(projectionUnitKeyCodec);
const projectionUnitKey = (tenant: string, module: string, type: string): string =>
  Result.getOrThrow(encodeProjectionUnitKey([tenant, module, type]));
const documentKey = ({ ref }: CoreSearchProjectionDocument): string => ref.resourceId;

const invalid = (reason: string, cause?: unknown): CoreSearchProjectionInvalid => {
  if (cause === undefined) {
    return new CoreSearchProjectionInvalid({
      code: 'core_search_projection_invalid',
      reason,
    });
  }
  return new CoreSearchProjectionInvalid({
    cause,
    code: 'core_search_projection_invalid',
    reason,
  });
};

const hasUniqueKeys = (values: readonly { readonly key: string }[]): boolean =>
  new Set(values.map(({ key }) => key)).size === values.length;

const toEpochMillis = (value: string): number | undefined =>
  DateTime.make(value).pipe(Option.map(DateTime.toEpochMillis), Option.getOrUndefined);

/** Search mutations retain the trusted worker's owner, tenant, and executable release. */
export const validateCoreSearchProjectionWorkerContext = (
  context: OutboxWorkerHandlerContext,
  owner: { readonly moduleId: string; readonly tenantId: string },
): Effect.Effect<void, CoreSearchProjectionInvalid> =>
  isVerifiedOutboxWorkerHandlerContext(context) &&
  /^[a-f0-9]{64}$/u.test(context.compositionRevision) &&
  context.tenantId === owner.tenantId &&
  context.producerModuleKey === owner.moduleId
    ? Effect.void
    : Effect.fail(invalid('Core Search mutation requires its verified owner worker and Application Composition'));

/** Foreign-source deliveries may refresh only their verified consumer's own documents. */
export const validateCoreSearchProjectionRefreshWorkerContext = (
  context: OutboxWorkerHandlerContext,
  owner: { readonly moduleId: string; readonly tenantId: string },
): Effect.Effect<void, CoreSearchProjectionInvalid> =>
  isVerifiedOutboxWorkerHandlerContext(context) &&
  /^[a-f0-9]{64}$/u.test(context.compositionRevision) &&
  context.tenantId === owner.tenantId &&
  context.consumerModuleKey === owner.moduleId
    ? Effect.void
    : Effect.fail(invalid('Core Search refresh requires its verified consumer worker and Application Composition'));

const invalidPeriod = ({ validFrom, validTo }: Readonly<{ validFrom: string; validTo?: string }>): boolean => {
  const from = toEpochMillis(validFrom);
  const to = validTo === undefined ? undefined : toEpochMillis(validTo);
  return from === undefined || (validTo !== undefined && (to === undefined || to <= from));
};

const hasForeignDocumentReference = (document: CoreSearchProjectionDocument, tenant: string): boolean =>
  [document.matchedRef, document.subjectRef, document.matchedSubjectRef].some(
    (ref) => ref !== undefined && ref.tenantId !== tenant,
  );

const hasInvalidDocumentFacets = (document: CoreSearchProjectionDocument): boolean =>
  !hasUniqueKeys(document.facets) ||
  !hasUniqueKeys(document.metadata) ||
  document.facets.some(({ values }) => values.length === 0 || new Set(values).size !== values.length);

const hasInvalidDocumentPeriods = (document: CoreSearchProjectionDocument): boolean =>
  (document.temporalFacets ?? []).some(invalidPeriod) || (document.temporalSearchableText ?? []).some(invalidPeriod);

const hasInvalidDocumentAliases = (document: CoreSearchProjectionDocument, tenant: string): boolean =>
  (document.aliases ?? []).some(
    (alias) => alias.ref.tenantId !== tenant || (alias.temporalSearchableText ?? []).some(invalidPeriod),
  );

const hasInvalidLabelDependencies = (document: CoreSearchProjectionDocument): boolean => {
  const dependencies = document.labelDependencies ?? [];
  return (
    dependencies.some(
      (dependency) =>
        dependency.ref.tenantId !== document.ref.tenantId ||
        dependency.selectedLegalEntityId !== document.selectedLegalEntityId,
    ) || new Set(dependencies.map(({ ref }) => coreSearchResourceRefKey(ref))).size !== dependencies.length
  );
};

/** Exact canonical reference match; never compare IDs without their owner, type and tenant. */
export const coreSearchDocumentDependsOn = (
  document: CoreSearchProjectionDocument,
  query: CoreSearchProjectionDependentQuery,
): boolean =>
  document.ref.tenantId === query.tenantId &&
  document.ref.moduleId === query.moduleId &&
  document.selectedLegalEntityId === query.selectedLegalEntityId &&
  (document.labelDependencies ?? []).some(
    (dependency) =>
      dependency.selectedLegalEntityId === query.selectedLegalEntityId &&
      coreSearchResourceRefKey(dependency.ref) === coreSearchResourceRefKey(query.sourceRef),
  );

const validateDocument = (
  document: CoreSearchProjectionDocument,
  expected: Readonly<{
    moduleId: string;
    resourceType: string;
    tenantId: string;
  }>,
): Result.Result<true, CoreSearchProjectionInvalid> => {
  if (
    document.ref.tenantId !== expected.tenantId ||
    document.ref.moduleId !== expected.moduleId ||
    document.ref.resourceType !== expected.resourceType ||
    hasForeignDocumentReference(document, expected.tenantId) ||
    hasInvalidDocumentFacets(document) ||
    hasInvalidDocumentPeriods(document) ||
    hasInvalidDocumentAliases(document, expected.tenantId) ||
    hasInvalidLabelDependencies(document)
  ) {
    return Result.fail(invalid('Core Search replacement contains an inconsistent document'));
  }
  return Result.succeed(true);
};

const validateReplacement = (
  input: typeof CoreSearchProjectionReplacementSchema.Type,
): Result.Result<typeof CoreSearchProjectionReplacementSchema.Type, CoreSearchProjectionInvalid> => {
  const seen = new Set<string>();
  const rebuildVersion = BigInt(input.rebuildVersion);
  for (const document of input.documents) {
    const validity = validateDocument(document, input);
    if (Result.isFailure(validity)) {
      return Result.fail(validity.failure);
    }
    if (BigInt(document.projectionVersion) > rebuildVersion) {
      return Result.fail(invalid('Core Search replacement contains an inconsistent document'));
    }
    const key = documentKey(document);
    if (seen.has(key)) {
      return Result.fail(invalid('Core Search replacement contains a duplicate resource'));
    }
    seen.add(key);
  }
  return Result.succeed(input);
};

const validateMutation = (
  mutation: typeof CoreSearchProjectionMutationSchema.Type,
): Result.Result<typeof CoreSearchProjectionMutationSchema.Type, CoreSearchProjectionInvalid> => {
  if (mutation.kind === 'upsert') {
    const validity = validateDocument(mutation.document, mutation.document.ref);
    if (Result.isFailure(validity)) {
      return Result.fail(validity.failure);
    }
  }
  return Result.succeed(mutation);
};

export const decodeCoreSearchProjectionReplacement = (
  input: UnparsedCoreSearchInput,
): CoreSearchProjectionReplacement =>
  Result.getOrThrow(
    Result.flatMap(
      Schema.decodeUnknownResult(CoreSearchProjectionReplacementSchema, {
        onExcessProperty: 'error',
      })(input),
      validateReplacement,
    ),
  );

export const decodeCoreSearchProjectionMutation = (input: UnparsedCoreSearchInput): CoreSearchProjectionMutation =>
  Result.getOrThrow(
    Result.flatMap(
      Schema.decodeUnknownResult(CoreSearchProjectionMutationSchema, {
        onExcessProperty: 'error',
      })(input),
      validateMutation,
    ),
  );

export const decodeCoreSearchProjectionBatch = Effect.fn('CoreSearchProjection.decodeBatch')(
  function* decodeCoreSearchProjectionBatchEffect(
    input: UnparsedCoreSearchInput,
  ): Effect.fn.Return<CoreSearchProjectionBatch, CoreSearchProjectionInvalid> {
    const batch = yield* Schema.decodeUnknownEffect(CoreSearchProjectionBatchSchema, {
      onExcessProperty: 'error',
    })(input).pipe(Effect.mapError((cause) => invalid('Core Search refresh batch is invalid', cause)));
    const seen = new Set<string>();
    yield* Effect.forEach(
      batch.mutations,
      (mutation) =>
        Effect.fromResult(validateMutation(mutation)).pipe(
          Effect.flatMap(() => {
            const ref = mutation.kind === 'upsert' ? mutation.document.ref : mutation.ref;
            const key = coreSearchResourceRefKey(ref);
            if (ref.tenantId !== batch.tenantId || ref.moduleId !== batch.moduleId || seen.has(key)) {
              return Effect.fail(invalid('Core Search refresh batch has a foreign or duplicate target'));
            }
            seen.add(key);
            return Effect.void;
          }),
        ),
      { concurrency: 1, discard: true },
    );
    return batch;
  },
);

export const decodeCoreSearchProjectionDependentQuery = (input: UnparsedCoreSearchInput) =>
  Schema.decodeUnknownEffect(CoreSearchProjectionDependentQuerySchema, { onExcessProperty: 'error' })(input).pipe(
    Effect.mapError((cause) => invalid('Core Search dependency query is invalid', cause)),
    Effect.flatMap((query) =>
      query.sourceRef.tenantId === query.tenantId
        ? Effect.succeed(query)
        : Effect.fail(invalid('Core Search dependency query has a foreign source')),
    ),
  );

export const decodeCoreSearchLabelRefreshOpen = (
  input: UnparsedCoreSearchInput,
): Effect.Effect<CoreSearchLabelRefreshOpen, CoreSearchProjectionInvalid> =>
  Schema.decodeUnknownEffect(CoreSearchLabelRefreshOpenSchema, { onExcessProperty: 'error' })(input).pipe(
    Effect.mapError((cause) => invalid('Core Search label refresh request is invalid', cause)),
  );

export const decodeCoreSearchLabelRefreshPageQuery = (
  input: UnparsedCoreSearchInput,
): Effect.Effect<CoreSearchLabelRefreshPageQuery, CoreSearchProjectionInvalid> =>
  Schema.decodeUnknownEffect(CoreSearchLabelRefreshPageQuerySchema, { onExcessProperty: 'error' })(input).pipe(
    Effect.mapError((cause) => invalid('Core Search label refresh page query is invalid', cause)),
  );

export const decodeCoreSearchLabelRefreshCommit = (
  input: UnparsedCoreSearchInput,
): Effect.Effect<CoreSearchLabelRefreshCommit, CoreSearchProjectionInvalid> =>
  Schema.decodeUnknownEffect(CoreSearchLabelRefreshCommitSchema, { onExcessProperty: 'error' })(input).pipe(
    Effect.mapError((cause) => invalid('Core Search label refresh page commit is invalid', cause)),
  );

export const decodeCoreSearchDerivedRepairRequest = (
  input: UnparsedCoreSearchInput,
): Effect.Effect<CoreSearchDerivedRepairRequest, CoreSearchProjectionInvalid> =>
  Schema.decodeUnknownEffect(CoreSearchDerivedRepairRequestSchema, { onExcessProperty: 'error' })(input).pipe(
    Effect.mapError((cause) => invalid('Core Search stamp repair request is invalid', cause)),
  );

export const decodeCoreSearchDerivedRepairOpen = (
  input: UnparsedCoreSearchInput,
): Effect.Effect<CoreSearchDerivedRepairOpen, CoreSearchProjectionInvalid> =>
  Schema.decodeUnknownEffect(CoreSearchDerivedRepairOpenSchema, { onExcessProperty: 'error' })(input).pipe(
    Effect.mapError((cause) => invalid('Core Search stamp repair request is invalid', cause)),
  );

export const decodeCoreSearchDerivedRepairCommit = (
  input: UnparsedCoreSearchInput,
): Effect.Effect<CoreSearchDerivedRepairCommit, CoreSearchProjectionInvalid> =>
  Schema.decodeUnknownEffect(CoreSearchDerivedRepairCommitSchema, { onExcessProperty: 'error' })(input).pipe(
    Effect.mapError((cause) => invalid('Core Search stamp repair page is invalid', cause)),
  );

/**
 * A newer observation of the same source edge cannot be replaced by an older one, even after the
 * dependent document or its edge was deleted. The retained barrier is keyed by the exact canonical
 * reference and selected company, never by ID alone.
 */
export const validateCoreSearchLabelBarrier = (
  barriers: ReadonlyMap<string, bigint>,
  dependencies: readonly {
    readonly ref: CoreSearchResourceRef;
    readonly selectedLegalEntityId: string;
    readonly sourceRevision: string;
  }[],
): Result.Result<true, CoreSearchProjectionInvalid> => {
  const violation = coreSearchLabelBarrierViolation(barriers, dependencies);
  return violation === undefined ? Result.succeed(true) : Result.fail(invalid(violation));
};

const validateCoreSearchLabelRefreshTargets = (
  commit: CoreSearchLabelRefreshCommit,
  lower: Option.Option<readonly [string, string]>,
  pageEnd: readonly [string, string],
): Result.Result<CoreSearchLabelRefreshCommit, CoreSearchProjectionInvalid> => {
  const { job } = commit;
  for (const mutation of commit.mutations) {
    const ref = mutation.kind === 'upsert' ? mutation.document.ref : mutation.ref;
    if (ref.tenantId !== job.tenantId || ref.moduleId !== job.moduleId) {
      return Result.fail(invalid('Core Search label refresh page has a foreign target'));
    }
    const key = decodeCoreSearchLabelRefreshCursorOption(coreSearchLabelRefreshCursorKey(ref));
    if (
      Option.isNone(key) ||
      compareCoreSearchLabelRefreshCursor(key.value, pageEnd) > 0 ||
      (Option.isSome(lower) && compareCoreSearchLabelRefreshCursor(key.value, lower.value) <= 0)
    ) {
      return Result.fail(invalid('Core Search label refresh page target is outside its declared page'));
    }
  }
  return Result.succeed(commit);
};

/** Page targets must be strictly ahead of the committed cursor and no further than the declared page end. */
export const validateCoreSearchLabelRefreshPageCommit = (
  commit: CoreSearchLabelRefreshCommit,
): Result.Result<CoreSearchLabelRefreshCommit, CoreSearchProjectionInvalid> => {
  const { job, pageEnd: pageEndKey } = commit;
  if (job.state === 'complete') {
    return commit.mutations.length === 0 && Option.isNone(pageEndKey)
      ? Result.succeed(commit)
      : Result.fail(invalid('Core Search label refresh cannot commit work for a complete job'));
  }
  if (Option.isNone(pageEndKey)) {
    return commit.mutations.length === 0
      ? Result.succeed(commit)
      : Result.fail(invalid('Core Search label refresh cannot mutate a page without a page end'));
  }
  const pageEnd = decodeCoreSearchLabelRefreshCursorOption(pageEndKey.value);
  if (Option.isNone(pageEnd)) {
    return Result.fail(invalid('Core Search label refresh page end is not a canonical cursor'));
  }
  const lowerKey = job.state === 'resweep' ? job.sweepCursor : job.cursor;
  const lower = Option.flatMap(decodeCoreSearchLabelRefreshCursorOption)(lowerKey);
  if (Option.isSome(lowerKey) && Option.isNone(lower)) {
    return Result.fail(invalid('Core Search label refresh cursor is not canonical'));
  }
  if (Option.isSome(lower) && compareCoreSearchLabelRefreshCursor(lower.value, pageEnd.value) >= 0) {
    return Result.fail(invalid('Core Search label refresh page does not advance its keyset cursor'));
  }
  return validateCoreSearchLabelRefreshTargets(commit, lower, pageEnd.value);
};

const encodeJsonValue = Schema.encodeUnknownResult(Schema.fromJsonString(Schema.Any));

const stableJson = (value: UnparsedCoreSearchInput): string => {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(',')}]`;
  }
  if (Predicate.isObject(value)) {
    return `{${Object.entries(value)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${Result.getOrThrow(encodeJsonValue(key))}:${stableJson(entry)}`)
      .join(',')}}`;
  }
  return Result.getOrThrow(encodeJsonValue(value));
};

/** Private Core persistence identity, independent of transport object/document ordering. */
export const coreSearchReplacementFingerprint = (replacement: CoreSearchProjectionReplacement): string =>
  Hex.encode(
    sha256(
      utf8ToBytes(
        stableJson({
          ...replacement,
          documents: replacement.documents.toSorted((left, right) =>
            left.ref.resourceId.localeCompare(right.ref.resourceId),
          ),
        }),
      ),
    ),
  );

const projectionDocumentEquivalence = Schema.toEquivalence(CoreSearchProjectionDocumentSchema);

const decodeMutationEffect = (input: UnparsedCoreSearchInput) =>
  Schema.decodeUnknownEffect(CoreSearchProjectionMutationSchema, {
    onExcessProperty: 'error',
  })(input).pipe(
    Effect.mapError((cause) => invalid('Core Search mutation does not match its declared contract', cause)),
    Effect.flatMap((mutation) => Effect.fromResult(validateMutation(mutation))),
  );

const decodeReplacementEffect = (input: UnparsedCoreSearchInput) =>
  Schema.decodeUnknownEffect(CoreSearchProjectionReplacementSchema, {
    onExcessProperty: 'error',
  })(input).pipe(
    Effect.mapError((cause) => invalid('Core Search replacement does not match its declared contract', cause)),
    Effect.flatMap((replacement) => Effect.fromResult(validateReplacement(replacement))),
  );

type Stored = Readonly<{
  /** Private derived shortlist representation; repair may replace only this. */
  readonly derived?: CoreSearchDerivedRepresentation;
  readonly document?: CoreSearchProjectionDocument;
  readonly projectionVersion: string;
}>;

type CoreSearchDerivedRepresentation = ReturnType<typeof deriveCoreSearchRepresentation>;

const deriveStored = (document: CoreSearchProjectionDocument): CoreSearchDerivedRepresentation =>
  deriveCoreSearchRepresentation(document);

const sameStoredDocument = (current: Stored, next: CoreSearchProjectionDocument | undefined): boolean =>
  current.document === undefined
    ? next === undefined
    : next !== undefined && projectionDocumentEquivalence(current.document, next);

/** A newer target generation cannot roll an existing source edge back to an older observation. */
export const validateCoreSearchDependencyRevisions = (
  current: readonly CoreSearchLabelDependency[],
  next: readonly CoreSearchLabelDependency[],
): Result.Result<true, CoreSearchProjectionInvalid> => {
  const prior = new Map(current.map((dependency) => [coreSearchResourceRefKey(dependency.ref), dependency]));
  for (const dependency of next) {
    const observed = prior.get(coreSearchResourceRefKey(dependency.ref));
    if (
      observed !== undefined &&
      observed.selectedLegalEntityId === dependency.selectedLegalEntityId &&
      BigInt(observed.sourceRevision) > BigInt(dependency.sourceRevision)
    ) {
      return Result.fail(invalid('Core Search refresh would roll back a source label revision'));
    }
  }
  return Result.succeed(true);
};

const shouldApplyMutation = (
  current: Stored | undefined,
  next: Stored,
): Result.Result<boolean, CoreSearchProjectionInvalid> => {
  if (current === undefined) {
    return Result.succeed(true);
  }
  const order = BigInt(next.projectionVersion) - BigInt(current.projectionVersion);
  if (order < 0n) {
    return Result.succeed(false);
  }
  if (order > 0n) {
    return Result.succeed(true);
  }
  return sameStoredDocument(current, next.document)
    ? Result.succeed(false)
    : Result.fail(invalid('Core Search mutation reuses a version for different content'));
};

const shouldReplaceProjection = (
  prior: Readonly<{ fingerprint: string; version: bigint }> | undefined,
  version: bigint,
  fingerprint: string,
): Result.Result<boolean, CoreSearchProjectionInvalid> => {
  if (prior === undefined || version > prior.version) {
    return Result.succeed(true);
  }
  if (version < prior.version) {
    return Result.succeed(false);
  }
  return fingerprint === prior.fingerprint
    ? Result.succeed(false)
    : Result.fail(invalid('Core Search rebuild reuses a version for different content'));
};

const mergeReplacementDocuments = (
  current: Map<string, Stored>,
  documents: readonly CoreSearchProjectionDocument[],
): Result.Result<true, CoreSearchProjectionInvalid> => {
  for (const document of documents) {
    const existing = current.get(document.ref.resourceId);
    if (existing === undefined || BigInt(existing.projectionVersion) < BigInt(document.projectionVersion)) {
      const revisions = validateCoreSearchDependencyRevisions(
        existing?.document?.labelDependencies ?? [],
        document.labelDependencies ?? [],
      );
      if (Result.isFailure(revisions)) {
        return revisions;
      }
      current.set(document.ref.resourceId, {
        derived: deriveStored(document),
        document,
        projectionVersion: document.projectionVersion,
      });
    } else if (existing.projectionVersion === document.projectionVersion && !sameStoredDocument(existing, document)) {
      return Result.fail(invalid('Core Search rebuild reuses a version for different content'));
    }
  }
  return Result.succeed(true);
};

const retireMissingDocuments = (current: Map<string, Stored>, replacement: CoreSearchProjectionReplacement): void => {
  const nextIds = new Set<string>(replacement.documents.map(({ ref }) => ref.resourceId));
  for (const [id, existing] of current) {
    if (!nextIds.has(id) && BigInt(existing.projectionVersion) < BigInt(replacement.rebuildVersion)) {
      current.set(id, { projectionVersion: replacement.rebuildVersion });
    }
  }
};

const jobKey = (job: CoreSearchLabelRefreshJob): string =>
  `${coreSearchResourceRefKey(job.sourceRef)}|${job.legalEntityId}|${job.moduleId}`;

/** One committed label-refresh page: a non-empty page advances the keyset; a drained page flips the phase. */
const advanceLabelRefreshJob = (
  job: CoreSearchLabelRefreshJob,
  pageEnd: Option.Option<string>,
): CoreSearchLabelRefreshJob => {
  const casVersion = (BigInt(job.casVersion) + 1n).toString();
  if (Option.isNone(pageEnd)) {
    return {
      ...job,
      casVersion,
      state: job.state === 'sweeping' ? 'resweep' : 'complete',
      sweepCursor: job.state === 'sweeping' ? Option.none() : job.sweepCursor,
    };
  }
  return {
    ...job,
    casVersion,
    cursor: job.state === 'sweeping' ? pageEnd : job.cursor,
    sweepCursor: job.state === 'resweep' ? pageEnd : job.sweepCursor,
  };
};

const derivedRepairJobKey = (job: CoreSearchDerivedRepairJob): string =>
  projectionUnitKey(job.tenantId, job.moduleId, job.resourceType);

const cursorResourceIdOfTuple = (tuple: readonly [string, string]): string => tuple[1];

const derivedRepairCursorId = (value: Option.Option<string>): Option.Option<string> =>
  Option.flatMap((key: string) => Option.map(cursorResourceIdOfTuple)(decodeCoreSearchLabelRefreshCursorOption(key)))(
    value,
  );

const derivedRepairPhaseCursor = (job: CoreSearchDerivedRepairJob): Option.Option<string> =>
  job.state === 'resweep' ? job.sweepCursor : job.cursor;

/**
 * One committed repair page: a non-empty page advances the phase cursor; a drained page moves the job
 * to the resweep phase, and a drained resweep completes it. The CAS version always advances.
 */
const advanceDerivedRepairJob = (
  job: CoreSearchDerivedRepairJob,
  pageEnd: Option.Option<string>,
): CoreSearchDerivedRepairJob => {
  const casVersion = (BigInt(job.casVersion) + 1n).toString();
  if (Option.isNone(pageEnd)) {
    return {
      ...job,
      casVersion,
      state: job.state === 'sweeping' ? 'resweep' : 'complete',
      sweepCursor: job.state === 'sweeping' ? Option.none() : job.sweepCursor,
    };
  }
  const pageEndCursor = Option.some(coreSearchDerivedRepairCursor(job.resourceType, pageEnd.value));
  return {
    ...job,
    casVersion,
    cursor: job.state === 'sweeping' ? pageEndCursor : job.cursor,
    sweepCursor: job.state === 'resweep' ? pageEndCursor : job.sweepCursor,
  };
};

export const makeInMemoryCoreSearchProjectionStore = (): CoreSearchProjectionStoreService &
  CoreSearchProjectionRefreshStoreService => {
  const units = new Map<string, Map<string, Stored>>();
  const rebuilds = new Map<string, { readonly fingerprint: string; readonly version: bigint }>();
  // Retained source-revision barrier and durable refresh jobs, keyed exactly as persisted.
  const barriers = new Map<string, bigint>();
  const jobs = new Map<string, CoreSearchLabelRefreshJob>();
  const apply: CoreSearchProjectionStoreService['apply'] = Effect.fn('CoreSearchProjectionStore.apply')(
    function* applyCoreSearchProjection(input: UnparsedCoreSearchInput, context: OutboxWorkerHandlerContext) {
      const mutation = yield* decodeMutationEffect(input);
      const ref = mutation.kind === 'upsert' ? mutation.document.ref : mutation.ref;
      yield* validateCoreSearchProjectionWorkerContext(context, ref);
      const version = mutation.kind === 'upsert' ? mutation.document.projectionVersion : mutation.projectionVersion;
      const unitKey = projectionUnitKey(ref.tenantId, ref.moduleId, ref.resourceType);
      const rebuild = rebuilds.get(unitKey);
      if (rebuild !== undefined && BigInt(version) <= rebuild.version) {
        return yield* Effect.void;
      }
      const unit = units.get(unitKey) ?? new Map<string, Stored>();
      const next: Stored =
        mutation.kind === 'upsert'
          ? { derived: deriveStored(mutation.document), document: mutation.document, projectionVersion: version }
          : { projectionVersion: version };
      const shouldApply = yield* Effect.fromResult(shouldApplyMutation(unit.get(ref.resourceId), next));
      if (!shouldApply) {
        return yield* Effect.void;
      }
      const dependencies = next.document?.labelDependencies ?? [];
      yield* Effect.fromResult(
        validateCoreSearchDependencyRevisions(
          unit.get(ref.resourceId)?.document?.labelDependencies ?? [],
          dependencies,
        ),
      );
      yield* Effect.fromResult(validateCoreSearchLabelBarrier(barriers, dependencies));
      advanceCoreSearchLabelBarrier(barriers, dependencies);
      unit.set(ref.resourceId, next);
      units.set(unitKey, unit);
      return yield* Effect.void;
    },
  );
  // Match the PostgreSQL scope guard, including tenant-global queries and tenant-wide authority.
  const queryCandidates: CoreSearchProjectionStoreService['queryCandidates'] = (input, scope) =>
    coreSearchQueryMatchesScope(input, scope)
      ? Effect.sync(() => {
          const candidates: CoreSearchProjectionDocument[] = [];
          for (const candidateType of coreSearchResourceTypes(input)) {
            for (const { document } of units
              .get(projectionUnitKey(input.tenantId, input.moduleId, candidateType))
              ?.values() ?? []) {
              if (document !== undefined && document.selectedLegalEntityId === input.selectedLegalEntityId) {
                candidates.push(document);
              }
            }
          }
          return candidates;
        })
      : Effect.fail(
          new CoreSearchProjectionUnavailable({
            code: 'core_search_projection_unavailable',
            reason: 'Core Search projection is temporarily unavailable',
          }),
        );
  const replace: CoreSearchProjectionStoreService['replace'] = Effect.fn('CoreSearchProjectionStore.replace')(
    function* replaceCoreSearchProjection(input: UnparsedCoreSearchInput, context: OutboxWorkerHandlerContext) {
      const replacement = yield* decodeReplacementEffect(input);
      yield* validateCoreSearchProjectionWorkerContext(context, replacement);
      const unitKey = projectionUnitKey(replacement.tenantId, replacement.moduleId, replacement.resourceType);
      const prior = rebuilds.get(unitKey);
      const version = BigInt(replacement.rebuildVersion);
      const fingerprint = coreSearchReplacementFingerprint(replacement);
      const shouldReplace = yield* Effect.fromResult(shouldReplaceProjection(prior, version, fingerprint));
      if (!shouldReplace) {
        return yield* Effect.void;
      }
      const current = new Map(units.get(unitKey));
      yield* Effect.fromResult(mergeReplacementDocuments(current, replacement.documents));
      retireMissingDocuments(current, replacement);
      units.set(unitKey, current);
      rebuilds.set(unitKey, { fingerprint, version });
      return yield* Effect.void;
    },
  );
  const applyBatch: CoreSearchProjectionRefreshStoreService['applyBatch'] = Effect.fn(
    'CoreSearchProjectionStore.applyBatch',
  )(function* applyCoreSearchProjectionBatch(input: UnparsedCoreSearchInput, context: OutboxWorkerHandlerContext) {
    const batch = yield* decodeCoreSearchProjectionBatch(input);
    yield* validateCoreSearchProjectionRefreshWorkerContext(context, batch);
    // An equal-version conflict in the last mutation must not commit the first, including its
    // tombstone or dependency replacement. Stage every unit before making changes visible, and stage
    // the retained barrier too so a failed batch cannot advance it either.
    const stagedBarriers = new Map(barriers);
    const stageMutation = Effect.fn('CoreSearchProjectionStore.stageBatchMutation')(function* stageBatchMutation(
      staged: Map<string, Map<string, Stored>>,
      mutation: CoreSearchProjectionMutation,
    ) {
      const ref = mutation.kind === 'upsert' ? mutation.document.ref : mutation.ref;
      const version = mutation.kind === 'upsert' ? mutation.document.projectionVersion : mutation.projectionVersion;
      const key = projectionUnitKey(ref.tenantId, ref.moduleId, ref.resourceType);
      const floor = rebuilds.get(key);
      if (floor !== undefined && BigInt(version) <= floor.version) {
        return staged;
      }
      const unit = staged.get(key) ?? new Map(units.get(key));
      const next: Stored =
        mutation.kind === 'upsert'
          ? { derived: deriveStored(mutation.document), document: mutation.document, projectionVersion: version }
          : { projectionVersion: version };
      const current = unit.get(ref.resourceId);
      if (yield* Effect.fromResult(shouldApplyMutation(current, next))) {
        const dependencies = next.document?.labelDependencies ?? [];
        yield* Effect.fromResult(
          validateCoreSearchDependencyRevisions(current?.document?.labelDependencies ?? [], dependencies),
        );
        // Validate and advance in observation order so an older revision later in the same page is rejected.
        yield* Effect.fromResult(validateCoreSearchLabelBarrier(stagedBarriers, dependencies));
        advanceCoreSearchLabelBarrier(stagedBarriers, dependencies);
        unit.set(ref.resourceId, next);
      }
      staged.set(key, unit);
      return staged;
    });
    const staged = yield* Effect.reduce(batch.mutations, () => new Map<string, Map<string, Stored>>(), stageMutation);
    for (const [key, unit] of staged) {
      units.set(key, unit);
    }
    for (const [key, value] of stagedBarriers) {
      barriers.set(key, value);
    }
  });
  const queryDependents: CoreSearchProjectionRefreshStoreService['queryDependents'] = Effect.fn(
    'CoreSearchProjectionStore.queryDependents',
  )(function* queryCoreSearchDependents(input: UnparsedCoreSearchInput, context: OutboxWorkerHandlerContext) {
    const query = yield* decodeCoreSearchProjectionDependentQuery(input);
    yield* validateCoreSearchProjectionRefreshWorkerContext(context, query);
    const documents: CoreSearchProjectionDocument[] = [];
    for (const unit of units.values()) {
      for (const { document } of unit.values()) {
        if (document !== undefined && coreSearchDocumentDependsOn(document, query)) {
          documents.push(document);
        }
      }
    }
    if (documents.length > 10_000) {
      return yield* new CoreSearchProjectionUnavailable({
        code: 'core_search_projection_unavailable',
        reason: 'Core Search dependency refresh exceeds its complete work budget',
      });
    }
    return documents.toSorted((left, right) =>
      coreSearchResourceRefKey(left.ref).localeCompare(coreSearchResourceRefKey(right.ref)),
    );
  });
  const jobDependents = (job: CoreSearchLabelRefreshJob): readonly CoreSearchProjectionDocument[] => {
    const documents: CoreSearchProjectionDocument[] = [];
    for (const unit of units.values()) {
      for (const { document } of unit.values()) {
        if (
          document !== undefined &&
          document.ref.tenantId === job.tenantId &&
          document.ref.moduleId === job.moduleId &&
          document.selectedLegalEntityId === job.legalEntityId &&
          (document.labelDependencies ?? []).some(
            (dependency) =>
              dependency.selectedLegalEntityId === job.legalEntityId &&
              coreSearchResourceRefKey(dependency.ref) === coreSearchResourceRefKey(job.sourceRef),
          )
        ) {
          documents.push(document);
        }
      }
    }
    return documents.toSorted((left, right) =>
      compareCoreSearchLabelRefreshCursor(
        [left.ref.resourceType, left.ref.resourceId],
        [right.ref.resourceType, right.ref.resourceId],
      ),
    );
  };
  const openLabelRefresh: CoreSearchProjectionRefreshStoreService['openLabelRefresh'] = Effect.fn(
    'CoreSearchProjectionStore.openLabelRefresh',
  )(function* openCoreSearchLabelRefresh(input, context) {
    const open = yield* decodeCoreSearchLabelRefreshOpen(input);
    yield* validateCoreSearchProjectionRefreshWorkerContext(context, open);
    const key = coreSearchLabelBarrierKey(open.sourceRef, open.legalEntityId);
    const incoming = BigInt(open.sourceRevision);
    const retained = barriers.get(key);
    const effective = retained !== undefined && retained > incoming ? retained : incoming;
    if (retained === undefined || effective > retained) {
      barriers.set(key, effective);
    }
    const identity = `${coreSearchResourceRefKey(open.sourceRef)}|${open.legalEntityId}|${open.moduleId}`;
    const existing = jobs.get(identity);
    if (existing === undefined) {
      const created: CoreSearchLabelRefreshJob = {
        casVersion: '1',
        cursor: Option.none(),
        epoch: '1',
        legalEntityId: open.legalEntityId,
        moduleId: open.moduleId,
        sourceRef: open.sourceRef,
        sourceRevision: effective.toString(),
        state: 'sweeping',
        sweepCursor: Option.none(),
        tenantId: open.tenantId,
      };
      jobs.set(identity, created);
      return created;
    }
    if (BigInt(existing.sourceRevision) >= effective) {
      return existing;
    }
    const advanced: CoreSearchLabelRefreshJob = {
      ...existing,
      casVersion: (BigInt(existing.casVersion) + 1n).toString(),
      cursor: Option.none(),
      epoch: (BigInt(existing.epoch) + 1n).toString(),
      sourceRevision: effective.toString(),
      state: 'sweeping',
      sweepCursor: Option.none(),
    };
    jobs.set(identity, advanced);
    return advanced;
  });
  const readLabelRefreshPage: CoreSearchProjectionRefreshStoreService['readLabelRefreshPage'] = Effect.fn(
    'CoreSearchProjectionStore.readLabelRefreshPage',
  )(function* readCoreSearchLabelRefreshPage(input, context) {
    const query = yield* decodeCoreSearchLabelRefreshPageQuery(input);
    yield* validateCoreSearchProjectionRefreshWorkerContext(context, query.job);
    const stored = jobs.get(jobKey(query.job));
    if (
      stored === undefined ||
      stored.epoch !== query.job.epoch ||
      stored.sourceRevision !== query.job.sourceRevision
    ) {
      return yield* invalid('Core Search label refresh token has been superseded');
    }
    if (stored.state === 'complete') {
      return { documents: [], hasMore: false, pageEnd: Option.none() };
    }
    const limit = query.limit ?? CORE_SEARCH_LABEL_REFRESH_PAGE_LIMIT;
    const lower = Option.flatMap(decodeCoreSearchLabelRefreshCursorOption)(
      stored.state === 'resweep' ? stored.sweepCursor : stored.cursor,
    );
    const remaining = jobDependents(stored).filter((document) => {
      if (Option.isNone(lower)) {
        return true;
      }
      return compareCoreSearchLabelRefreshCursor([document.ref.resourceType, document.ref.resourceId], lower.value) > 0;
    });
    const page = remaining.slice(0, limit);
    const last = page.at(-1);
    return {
      documents: page,
      hasMore: remaining.length > page.length,
      pageEnd: last === undefined ? Option.none() : Option.some(coreSearchLabelRefreshCursorKey(last.ref)),
    };
  });
  const commitLabelRefreshPage: CoreSearchProjectionRefreshStoreService['commitLabelRefreshPage'] = Effect.fn(
    'CoreSearchProjectionStore.commitLabelRefreshPage',
  )(function* commitCoreSearchLabelRefreshPage(input, context) {
    const commit = yield* decodeCoreSearchLabelRefreshCommit(input);
    yield* validateCoreSearchProjectionRefreshWorkerContext(context, commit.job);
    yield* Effect.fromResult(validateCoreSearchLabelRefreshPageCommit(commit));
    const identity = jobKey(commit.job);
    const stored = jobs.get(identity);
    const barrier = barriers.get(coreSearchLabelBarrierKey(commit.job.sourceRef, commit.job.legalEntityId));
    if (
      stored === undefined ||
      stored.epoch !== commit.job.epoch ||
      stored.casVersion !== commit.job.casVersion ||
      stored.sourceRevision !== commit.job.sourceRevision ||
      barrier === undefined ||
      barrier > BigInt(stored.sourceRevision)
    ) {
      return yield* invalid('Core Search label refresh token has been superseded');
    }
    const staged = new Map<string, Map<string, Stored>>();
    const stagedBarriers = new Map(barriers);
    const stageMutation = Effect.fn('CoreSearchProjectionStore.stageLabelRefreshMutation')(
      function* stageLabelRefreshMutation(
        accumulated: Map<string, Map<string, Stored>>,
        mutation: CoreSearchProjectionMutation,
      ) {
        const ref = mutation.kind === 'upsert' ? mutation.document.ref : mutation.ref;
        const version = mutation.kind === 'upsert' ? mutation.document.projectionVersion : mutation.projectionVersion;
        const key = projectionUnitKey(ref.tenantId, ref.moduleId, ref.resourceType);
        const unit = accumulated.get(key) ?? new Map(units.get(key));
        const next: Stored =
          mutation.kind === 'upsert'
            ? { derived: deriveStored(mutation.document), document: mutation.document, projectionVersion: version }
            : { projectionVersion: version };
        const current = unit.get(ref.resourceId);
        if (yield* Effect.fromResult(shouldApplyMutation(current, next))) {
          const dependencies = next.document?.labelDependencies ?? [];
          yield* Effect.fromResult(
            validateCoreSearchDependencyRevisions(current?.document?.labelDependencies ?? [], dependencies),
          );
          yield* Effect.fromResult(validateCoreSearchLabelBarrier(stagedBarriers, dependencies));
          advanceCoreSearchLabelBarrier(stagedBarriers, dependencies);
          unit.set(ref.resourceId, next);
        }
        accumulated.set(key, unit);
        return accumulated;
      },
    );
    yield* Effect.reduce(commit.mutations, () => staged, stageMutation);
    for (const [key, unit] of staged) {
      units.set(key, unit);
    }
    for (const [key, value] of stagedBarriers) {
      barriers.set(key, value);
    }
    const nextState = advanceLabelRefreshJob(stored, commit.pageEnd);
    jobs.set(identity, nextState);
    return nextState;
  });
  const repairDerivedRepresentation: CoreSearchProjectionRefreshStoreService['repairDerivedRepresentation'] = Effect.fn(
    'CoreSearchProjectionStore.repairDerivedRepresentation',
  )(function* repairCoreSearchDerivedRepresentation(input, context) {
    const request = yield* decodeCoreSearchDerivedRepairRequest(input);
    yield* validateCoreSearchProjectionRefreshWorkerContext(context, request);
    const limit = request.limit ?? CORE_SEARCH_LABEL_REFRESH_PAGE_LIMIT;
    const { cursor } = request;
    const lower = Option.flatMap(decodeCoreSearchLabelRefreshCursorOption)(cursor);
    if (Option.isSome(cursor) && Option.isNone(lower)) {
      return yield* invalid('Core Search stamp repair cursor is not canonical');
    }
    const lowerId = Option.map(cursorResourceIdOfTuple)(lower);
    const unit =
      units.get(projectionUnitKey(request.tenantId, request.moduleId, request.resourceType)) ??
      new Map<string, Stored>();
    const entries = [...unit.entries()]
      .filter(([id, stored]) => stored.document !== undefined && (Option.isNone(lowerId) || id > lowerId.value))
      .toSorted(([left], [right]) => left.localeCompare(right));
    const page = entries.slice(0, limit);
    let repaired = 0;
    for (const [id, stored] of page) {
      if (stored.document === undefined) {
        continue;
      }
      const derived = deriveStored(stored.document);
      if (
        stored.derived === undefined ||
        stored.derived.searchFormatVersion !== derived.searchFormatVersion ||
        stored.derived.searchSourceVersion !== derived.searchSourceVersion ||
        stored.derived.searchTextV1 !== derived.searchTextV1
      ) {
        unit.set(id, { ...stored, derived });
        repaired += 1;
      }
    }
    const last = page.at(-1)?.[0];
    const complete = entries.length <= page.length;
    const result: CoreSearchDerivedRepairResult = {
      complete,
      cursor:
        complete || last === undefined
          ? Option.none()
          : Option.some(coreSearchDerivedRepairCursor(request.resourceType, last)),
      repaired,
      resweep: request.resweep === true,
      scanned: page.length,
    };
    return result;
  });
  const derivedRepairJobs = new Map<string, CoreSearchDerivedRepairJob>();
  const derivedRepairPageIds = (job: CoreSearchDerivedRepairJob, limit: number): readonly string[] => {
    const unit =
      units.get(projectionUnitKey(job.tenantId, job.moduleId, job.resourceType)) ?? new Map<string, Stored>();
    const lower = derivedRepairCursorId(derivedRepairPhaseCursor(job));
    return [...unit.entries()]
      .flatMap(([id, stored]) =>
        stored.document !== undefined && (Option.isNone(lower) || id > lower.value) ? [id] : [],
      )
      .toSorted((left, right) => left.localeCompare(right))
      .slice(0, limit);
  };
  const openDerivedRepairJob: CoreSearchProjectionRefreshStoreService['openDerivedRepairJob'] = Effect.fn(
    'CoreSearchProjectionStore.openDerivedRepairJob',
  )(function* openCoreSearchDerivedRepairJob(input, context) {
    const open = yield* decodeCoreSearchDerivedRepairOpen(input);
    yield* validateCoreSearchProjectionRefreshWorkerContext(context, open);
    const key = projectionUnitKey(open.tenantId, open.moduleId, open.resourceType);
    const plan = planCoreSearchDerivedRepairReopen(open, Option.fromUndefinedOr(derivedRepairJobs.get(key)));
    if (plan.kind === 'stale') {
      return yield* invalid('Core Search stamp repair restart request is stale');
    }
    if (plan.kind !== 'resume') {
      derivedRepairJobs.set(key, plan.job);
    }
    return plan.job;
  });
  const readDerivedRepairPage: CoreSearchProjectionRefreshStoreService['readDerivedRepairPage'] = Effect.fn(
    'CoreSearchProjectionStore.readDerivedRepairPage',
  )(function* readCoreSearchDerivedRepairPage(input, context) {
    const query = yield* decodeCoreSearchDerivedRepairCommit(input);
    yield* validateCoreSearchProjectionRefreshWorkerContext(context, query.job);
    const stored = derivedRepairJobs.get(derivedRepairJobKey(query.job));
    if (stored === undefined || stored.epoch !== query.job.epoch || stored.casVersion !== query.job.casVersion) {
      return yield* invalid('Core Search stamp repair token has been superseded');
    }
    if (stored.state === 'complete') {
      return { hasMore: false, pageEnd: Option.none(), resourceIds: [] };
    }
    const limit = query.limit ?? CORE_SEARCH_LABEL_REFRESH_PAGE_LIMIT;
    const ids = derivedRepairPageIds(stored, limit + 1);
    const page = ids.slice(0, limit);
    const last = page.at(-1);
    const resourceIds = yield* Schema.decodeUnknownEffect(CoreSearchDerivedRepairResourceIdsSchema)(page).pipe(
      Effect.mapError((cause) => invalid('Core Search stamp repair page has a non-canonical resource identity', cause)),
    );
    const scan: CoreSearchDerivedRepairScan = {
      hasMore: ids.length > limit,
      pageEnd:
        last === undefined ? Option.none() : Option.some(coreSearchDerivedRepairCursor(stored.resourceType, last)),
      resourceIds,
    };
    return scan;
  });
  const commitDerivedRepairPage: CoreSearchProjectionRefreshStoreService['commitDerivedRepairPage'] = Effect.fn(
    'CoreSearchProjectionStore.commitDerivedRepairPage',
  )(function* commitCoreSearchDerivedRepairPage(input, context) {
    const commit = yield* decodeCoreSearchDerivedRepairCommit(input);
    yield* validateCoreSearchProjectionRefreshWorkerContext(context, commit.job);
    const key = derivedRepairJobKey(commit.job);
    const stored = derivedRepairJobs.get(key);
    if (stored === undefined || stored.epoch !== commit.job.epoch || stored.casVersion !== commit.job.casVersion) {
      return yield* invalid('Core Search stamp repair token has been superseded');
    }
    if (stored.state === 'complete') {
      return { job: stored, repaired: 0, scanned: 0 };
    }
    const limit = commit.limit ?? CORE_SEARCH_LABEL_REFRESH_PAGE_LIMIT;
    const page = derivedRepairPageIds(stored, limit);
    const unit = units.get(key) ?? new Map<string, Stored>();
    let repaired = 0;
    for (const id of page) {
      const value = unit.get(id);
      if (value?.document === undefined) {
        continue;
      }
      const derived = deriveStored(value.document);
      if (
        value.derived === undefined ||
        value.derived.searchFormatVersion !== derived.searchFormatVersion ||
        value.derived.searchSourceVersion !== derived.searchSourceVersion ||
        value.derived.searchTextV1 !== derived.searchTextV1
      ) {
        unit.set(id, { ...value, derived });
        repaired += 1;
      }
    }
    units.set(key, unit);
    const nextJob = advanceDerivedRepairJob(stored, Option.fromUndefinedOr(page.at(-1)));
    derivedRepairJobs.set(key, nextJob);
    const progress: CoreSearchDerivedRepairProgress = { job: nextJob, repaired, scanned: page.length };
    return progress;
  });
  return Object.freeze({
    apply,
    applyBatch,
    commitDerivedRepairPage,
    commitLabelRefreshPage,
    openDerivedRepairJob,
    openLabelRefresh,
    queryCandidates,
    queryDependents,
    readDerivedRepairPage,
    readLabelRefreshPage,
    repairDerivedRepresentation,
    replace,
  });
};

const isEffectiveTemporalFacet = (temporal: CoreSearchTemporalFacet, key: string, effectiveAt: number): boolean => {
  const from = toEpochMillis(temporal.validFrom);
  const to = temporal.validTo === undefined ? undefined : toEpochMillis(temporal.validTo);
  return temporal.key === key && from !== undefined && from <= effectiveAt && (to === undefined || effectiveAt < to);
};

const matchesFacets = (
  document: CoreSearchProjectionDocument,
  requested: readonly CoreSearchFacet[],
  effectiveAt: number | undefined,
): boolean =>
  requested.every(({ key, values }) => {
    const available = new Set(document.facets.find((candidate) => candidate.key === key)?.values);
    if (effectiveAt !== undefined) {
      for (const temporal of document.temporalFacets ?? []) {
        if (isEffectiveTemporalFacet(temporal, key, effectiveAt)) {
          available.add(temporal.value);
        }
      }
    }
    return values.every((value) => available.has(value));
  });

type MutableProjectionHit = {
  -readonly [Key in keyof CoreSearchProjectionHit]: CoreSearchProjectionHit[Key];
};

const toHit = (document: CoreSearchProjectionDocument): CoreSearchProjectionHit => {
  const hit: MutableProjectionHit = {
    archived: document.archived,
    facets: document.facets,
    metadata: document.metadata,
    ref: document.ref,
    title: document.title,
  };
  if (document.aliases === undefined && document.matchedRef !== undefined) {
    hit.matchedRef = document.matchedRef;
  }
  if (document.aliases === undefined && document.matchedSubjectRef !== undefined) {
    hit.matchedSubjectRef = document.matchedSubjectRef;
  }
  if (document.selectedLegalEntityId !== undefined) {
    hit.selectedLegalEntityId = document.selectedLegalEntityId;
  }
  if (document.subjectRef !== undefined) {
    hit.subjectRef = document.subjectRef;
  }
  if (document.temporalFacets !== undefined) {
    hit.temporalFacets = document.temporalFacets;
  }
  return hit;
};

const matchDocument = (
  document: CoreSearchProjectionDocument,
  tokens: readonly string[],
  effectiveAt: number,
): CoreSearchProjectionHit | undefined => {
  const hit = toHit(document);
  const matches = createCoreSearchValueMatcher(tokens);
  const activeValues = (
    values: readonly (typeof CoreSearchTemporalSearchableTextSchema.Type)[] = [],
  ): readonly string[] => {
    const active: string[] = [];
    for (const { validFrom, validTo, value } of values) {
      const from = toEpochMillis(validFrom);
      const to = validTo === undefined ? undefined : toEpochMillis(validTo);
      if (from !== undefined && from <= effectiveAt && (to === undefined || effectiveAt < to)) {
        active.push(value);
      }
    }
    return active;
  };
  // Static evidence already proves a match; only evaluate periods when it does not.
  const canonical = [document.title, ...document.searchableText];
  if (matches(canonical) || matches([...canonical, ...activeValues(document.temporalSearchableText)])) {
    return hit;
  }
  const alias = document.aliases?.find(
    (candidate) =>
      matches(candidate.searchableText) ||
      matches([...candidate.searchableText, ...activeValues(candidate.temporalSearchableText)]),
  );
  if (alias === undefined) {
    return undefined;
  }
  return alias.kind === 'resource' ? { ...hit, matchedRef: alias.ref } : { ...hit, matchedSubjectRef: alias.ref };
};

export const createCoreSearchQueryRuntime: Effect.Effect<
  CoreSearchQueryRuntimeService,
  never,
  CoreSearchProjectionStore
> = Effect.gen(function* createCoreSearchQueryRuntimeService() {
  const store = yield* CoreSearchProjectionStore;
  const search: CoreSearchQueryRuntimeService['search'] = Effect.fn('CoreSearchQueryRuntime.search')(
    function* searchCoreSearchProjection(input: UnparsedCoreSearchInput, scope: OperationalScope) {
      const query = yield* Schema.decodeUnknownEffect(CoreSearchQuerySchema)(input).pipe(
        Effect.mapError((cause) => invalid('Core Search query does not match its declared contract', cause)),
      );
      const parsed = yield* Effect.fromResult(parseCoreSearchQuery(query.query)).pipe(
        Effect.mapError((cause) => invalid('Core Search query has no supported normalized tokens', cause)),
      );
      const documents = yield* store.queryCandidates(query, scope);
      const requestedFacets = query.facets ?? [];
      const resourceTypes = coreSearchResourceTypes(query);
      const effectiveAt =
        query.effectiveAt === undefined ? yield* Clock.currentTimeMillis : DateTime.toEpochMillis(query.effectiveAt);
      const ranked: { readonly hit: CoreSearchProjectionHit; readonly rank: number }[] = [];
      for (const document of documents) {
        if (
          document.ref.tenantId === query.tenantId &&
          document.ref.moduleId === query.moduleId &&
          resourceTypes.includes(document.ref.resourceType) &&
          (query.includeArchived || !document.archived) &&
          document.selectedLegalEntityId === query.selectedLegalEntityId &&
          matchesFacets(document, requestedFacets, effectiveAt)
        ) {
          // Exact decoded evidence has already proven the match; a flat SQL shortlist never ranks.
          const hit = matchDocument(document, parsed.tokens, effectiveAt);
          if (hit !== undefined) {
            ranked.push({ hit, rank: coreSearchRank(hit, parsed) });
          }
        }
      }
      // The tier is a pure function of the hit and query: compute it once per hit, not once per comparison.
      return ranked
        .toSorted((left, right) => left.rank - right.rank || compareCoreSearchHitIdentity(left.hit, right.hit))
        .map(({ hit, rank }) =>
          query.includeRelevance === true ? { ...hit, relevance: coreSearchRelevanceForRank(rank) } : hit,
        );
    },
  );
  return Object.freeze({ search });
});
