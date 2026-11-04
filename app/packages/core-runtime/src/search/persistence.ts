import { and, asc, eq, gt, or, sql } from 'drizzle-orm';
import { DateTime, Effect, Layer, Option, Result, Schema } from 'effect';
import { isSqlError } from 'effect/sql/SqlError';

import { CoreDatabase } from '../db/client.ts';
import { DatabaseIdentityEnrollmentContext } from '../db/database-identities.ts';
import type { DatabaseIdentityEnrollment } from '../db/database-identity-manifest.ts';
import {
  searchDerivedRepairJobs,
  searchIndexEntries,
  searchLabelRefreshJobs,
  searchLabelSourceRevisions,
  searchProjectionRebuilds,
} from '../db/schema.ts';
import { installOperationalScope } from '../db/scoped-transaction.ts';
import type { CoreDatabaseExecutor, CoreTransaction } from '../db/types.ts';
import { lockApplicationCompositionAuthority } from '../modules/application-composition-authority.ts';
import type { OperationalScope } from '../operations/context.ts';
import type { OutboxWorkerHandlerContext } from '../outbox/definition.ts';
import type {
  CoreSearchDerivedRepairCommit,
  CoreSearchDerivedRepairJob,
  CoreSearchDerivedRepairOpen,
  CoreSearchDerivedRepairProgress,
  CoreSearchDerivedRepairRequest,
  CoreSearchDerivedRepairResult,
  CoreSearchDerivedRepairScan,
  CoreSearchLabelDependency,
  CoreSearchLabelRefreshCommit,
  CoreSearchLabelRefreshJob,
  CoreSearchLabelRefreshOpen,
  CoreSearchLabelRefreshPage,
  CoreSearchLabelRefreshPageQuery,
  CoreSearchLabelRefreshState,
  CoreSearchProjectionBatch,
  CoreSearchProjectionDependentQuery,
  CoreSearchProjectionDocument,
  CoreSearchProjectionMutation,
  CoreSearchProjectionRefreshStoreService,
  CoreSearchProjectionReplacement,
  CoreSearchProjectionStoreService,
  CoreSearchQuery,
  CoreSearchResourceRef,
} from './projection.ts';
import {
  CORE_SEARCH_LABEL_REFRESH_PAGE_LIMIT,
  CoreSearchAliasSchema,
  CoreSearchDerivedRepairJobSchema,
  CoreSearchFacetSchema,
  CoreSearchMetadataFieldSchema,
  CoreSearchLabelDependencySchema,
  CoreSearchLabelRefreshJobSchema,
  CoreSearchProjectionDocumentSchema,
  CoreSearchProjectionDependentQuerySchema,
  CoreSearchProjectionInvalid,
  CoreSearchProjectionStore,
  CoreSearchProjectionRefreshStore,
  CoreSearchProjectionUnavailable,
  CoreSearchQueryRuntime,
  CoreSearchResourceRefSchema,
  CoreSearchTemporalFacetSchema,
  CoreSearchTemporalSearchableTextSchema,
  CORE_SEARCH_MAX_SEARCHABLE_TERMS,
  CORE_SEARCH_MAX_TERM_LENGTH,
  advanceCoreSearchLabelBarrier,
  coreSearchLabelBarrierKey,
  coreSearchDerivedRepairCursor,
  CoreSearchDerivedRepairResourceIdsSchema,
  coreSearchLabelRefreshCursorKey,
  coreSearchReplacementFingerprint,
  createCoreSearchQueryRuntime,
  decodeCoreSearchDerivedRepairCommit,
  decodeCoreSearchDerivedRepairOpen,
  decodeCoreSearchDerivedRepairRequest,
  decodeCoreSearchLabelRefreshCommit,
  decodeCoreSearchLabelRefreshCursorOption,
  decodeCoreSearchLabelRefreshOpen,
  decodeCoreSearchLabelRefreshPageQuery,
  decodeCoreSearchProjectionMutation,
  decodeCoreSearchProjectionBatch,
  decodeCoreSearchProjectionDependentQuery,
  decodeCoreSearchProjectionReplacement,
  coreSearchDocumentDependsOn,
  coreSearchResourceRefKey,
  planCoreSearchDerivedRepairReopen,
  validateCoreSearchLabelBarrier,
  validateCoreSearchLabelRefreshPageCommit,
  validateCoreSearchProjectionRefreshWorkerContext,
  validateCoreSearchProjectionWorkerContext,
  validateCoreSearchDependencyRevisions,
} from './projection.ts';
import { coreSearchQueryMatchesScope } from './projection-store.ts';
import { decodeCoreSearchResourceRef } from './resource-ref.ts';
import { deriveCoreSearchRepresentation } from './evidence-codec.ts';
import { CORE_SEARCH_CANDIDATE_BUDGET, selectCoreSearchCandidates } from './indexed-query.ts';

/** Private storage format. Version 1 rows must be retired by migration before deploying this codec. */
export const CoreSearchPersistedPayloadSchema = Schema.Struct({
  aliases: Schema.optionalKey(Schema.Array(CoreSearchAliasSchema).check(Schema.isMaxLength(100))),
  archived: Schema.Boolean,
  facets: Schema.Array(CoreSearchFacetSchema),
  labelDependencies: Schema.optionalKey(Schema.Array(CoreSearchLabelDependencySchema).check(Schema.isMaxLength(100))),
  matchedRef: Schema.optionalKey(CoreSearchResourceRefSchema),
  matchedSubjectRef: Schema.optionalKey(CoreSearchResourceRefSchema),
  metadata: Schema.Array(CoreSearchMetadataFieldSchema),
  schemaVersion: Schema.Literal('2'),
  searchableText: CoreSearchProjectionDocumentSchema.fields.searchableText,
  subjectRef: Schema.optionalKey(CoreSearchResourceRefSchema),
  temporalFacets: Schema.optionalKey(Schema.Array(CoreSearchTemporalFacetSchema)),
  temporalSearchableText: Schema.optionalKey(
    Schema.Array(CoreSearchTemporalSearchableTextSchema).check(Schema.isMaxLength(100)),
  ),
});
const ProjectionUnitKeySchema = Schema.fromJsonString(Schema.Tuple([Schema.String, Schema.String, Schema.String]));
const encodeDependencyPredicate = Schema.encodeResult(
  Schema.fromJsonString(
    Schema.Array(
      Schema.Struct({
        ref: CoreSearchResourceRefSchema,
        selectedLegalEntityId: CoreSearchProjectionDependentQuerySchema.fields.selectedLegalEntityId,
      }),
    ),
  ),
);

type PersistedDocumentPayload = typeof CoreSearchPersistedPayloadSchema.Type;
type MutablePersistedDocumentPayload = {
  -readonly [Key in keyof PersistedDocumentPayload]: PersistedDocumentPayload[Key];
};
type CoreSearchPersistenceDatabase = Readonly<{
  executor: CoreDatabaseExecutor;
}>;
type CoreSearchProjectionInput = Parameters<CoreSearchProjectionStoreService['apply']>[0];
type CoreSearchPersistenceCause = typeof Schema.Unknown.Type;
type SearchIndexEntry = typeof searchIndexEntries.$inferSelect;
interface PersistedDocumentInput {
  aliases?: PersistedDocumentPayload['aliases'];
  archived: boolean;
  facets: PersistedDocumentPayload['facets'];
  labelDependencies?: PersistedDocumentPayload['labelDependencies'];
  matchedRef?: PersistedDocumentPayload['matchedRef'];
  matchedSubjectRef?: PersistedDocumentPayload['matchedSubjectRef'];
  metadata: PersistedDocumentPayload['metadata'];
  projectionVersion: string;
  ref: Readonly<{
    moduleId: string;
    resourceId: string;
    resourceType: string;
    tenantId: string;
  }>;
  searchableText: readonly string[];
  selectedLegalEntityId?: string;
  subjectRef?: PersistedDocumentPayload['subjectRef'];
  temporalFacets?: PersistedDocumentPayload['temporalFacets'];
  temporalSearchableText?: PersistedDocumentPayload['temporalSearchableText'];
  title: string;
}

const invalid = (reason: string, cause?: CoreSearchPersistenceCause): CoreSearchProjectionInvalid =>
  cause === undefined
    ? new CoreSearchProjectionInvalid({
        code: 'core_search_projection_invalid',
        reason,
      })
    : new CoreSearchProjectionInvalid({
        cause,
        code: 'core_search_projection_invalid',
        reason,
      });
const unavailable = (cause?: CoreSearchPersistenceCause) =>
  cause === undefined
    ? new CoreSearchProjectionUnavailable({
        code: 'core_search_projection_unavailable',
        reason: 'Core Search projection is temporarily unavailable',
      })
    : new CoreSearchProjectionUnavailable({
        cause,
        code: 'core_search_projection_unavailable',
        reason: 'Core Search projection is temporarily unavailable',
      });

const LABEL_REFRESH_TOKEN_SUPERSEDED = 'Core Search label refresh token has been superseded';
const STAMP_REPAIR_TOKEN_SUPERSEDED = 'Core Search stamp repair token has been superseded';

const normalize = (value: string): string => value.normalize('NFKC').toLocaleLowerCase('und');
// NFKC followed by und lowercase expands one UTF-16 input unit by at most 18.
// U+FDFA reaches 18; this was checked over every Unicode 17 scalar on the managed Node runtime.
const normalizedTextExpansion = 18;
export const CORE_SEARCH_BODY_TEXT_MAX_LENGTH =
  (CORE_SEARCH_MAX_SEARCHABLE_TERMS + 1) * CORE_SEARCH_MAX_TERM_LENGTH * normalizedTextExpansion +
  CORE_SEARCH_MAX_SEARCHABLE_TERMS;
export const CoreSearchBodyTextSchema = Schema.String.check(Schema.isMaxLength(CORE_SEARCH_BODY_TEXT_MAX_LENGTH));
const decodeBodyText = Schema.decodeUnknownResult(CoreSearchBodyTextSchema);

/** Private codec seam shared by the SQL adapter and its storage round-trip tests. */
export const coreSearchDocumentBodyText = (
  document: CoreSearchProjectionDocument,
): Result.Result<string, CoreSearchProjectionInvalid> =>
  decodeBodyText([document.title, ...document.searchableText].map(normalize).join('\n')).pipe(
    Result.mapError((cause) => invalid('Core Search normalized body exceeds its supported aggregate bound', cause)),
  );

export const coreSearchDocumentPayload = (document: CoreSearchProjectionDocument): PersistedDocumentPayload => {
  const persisted: MutablePersistedDocumentPayload = {
    archived: document.archived,
    facets: document.facets,
    metadata: document.metadata,
    schemaVersion: '2',
    searchableText: document.searchableText,
  };
  if (document.aliases !== undefined) {
    persisted.aliases = document.aliases;
  }
  if (document.labelDependencies !== undefined) {
    persisted.labelDependencies = document.labelDependencies;
  }
  if (document.matchedRef !== undefined) {
    persisted.matchedRef = document.matchedRef;
  }
  if (document.matchedSubjectRef !== undefined) {
    persisted.matchedSubjectRef = document.matchedSubjectRef;
  }
  if (document.subjectRef !== undefined) {
    persisted.subjectRef = document.subjectRef;
  }
  if (document.temporalFacets !== undefined) {
    persisted.temporalFacets = document.temporalFacets;
  }
  if (document.temporalSearchableText !== undefined) {
    persisted.temporalSearchableText = document.temporalSearchableText;
  }
  return persisted;
};

const persistedPayloadEquivalence = Schema.toEquivalence(CoreSearchPersistedPayloadSchema);
const decodePersistedPayload = Schema.decodeUnknownResult(CoreSearchPersistedPayloadSchema, {
  onExcessProperty: 'error',
});
const encodeProjectionUnitKey = Schema.encodeUnknownResult(ProjectionUnitKeySchema);

const projectionUnitKey = (tenantId: string, moduleId: string, resourceType: string): string =>
  Result.getOrThrow(
    encodeProjectionUnitKey([tenantId, moduleId, resourceType]).pipe(
      Result.mapError((cause) => invalid('Core Search projection unit is invalid', cause)),
    ),
  );

type SearchProjectionRebuildRow = typeof searchProjectionRebuilds.$inferSelect;

/**
 * Page-local read cache. One transaction owns one page or rebuild, and a batch rejects duplicate
 * targets, so a canonical reference and a projection unit each resolve at most once. Reading a
 * target row or rebuild floor once lets validation and application share the exact same read
 * without a second query.
 */
interface PageReadCache {
  readonly floors: Map<string, Option.Option<SearchProjectionRebuildRow>>;
  readonly rows: Map<string, Option.Option<SearchIndexEntry>>;
}

const newPageReadCache = (): PageReadCache => ({ floors: new Map(), rows: new Map() });

const labelBarrierPredicate = (dependency: CoreSearchLabelDependency) =>
  and(
    eq(searchLabelSourceRevisions.labelSourceModuleKey, dependency.ref.moduleId),
    eq(searchLabelSourceRevisions.labelSourceResourceType, dependency.ref.resourceType),
    eq(searchLabelSourceRevisions.labelSourceResourceId, dependency.ref.resourceId),
    eq(searchLabelSourceRevisions.legalEntityId, dependency.selectedLegalEntityId),
  );

interface SearchLabelRefreshJobRow {
  readonly casVersion: bigint;
  readonly cursor: string | null;
  readonly epoch: bigint;
  readonly labelSourceModuleKey: string;
  readonly labelSourceResourceId: string;
  readonly labelSourceResourceType: string;
  readonly legalEntityId: string;
  readonly sourceModuleKey: string;
  readonly sourceRevision: bigint;
  readonly state: string;
  readonly sweepCursor: string | null;
  readonly tenantId: string;
}

const jobFromRow = (row: SearchLabelRefreshJobRow): Option.Option<CoreSearchLabelRefreshJob> =>
  Schema.decodeUnknownOption(CoreSearchLabelRefreshJobSchema)({
    casVersion: row.casVersion.toString(),
    cursor: row.cursor,
    epoch: row.epoch.toString(),
    legalEntityId: row.legalEntityId,
    moduleId: row.sourceModuleKey,
    sourceRef: {
      moduleId: row.labelSourceModuleKey,
      resourceId: row.labelSourceResourceId,
      resourceType: row.labelSourceResourceType,
      tenantId: row.tenantId,
    },
    sourceRevision: row.sourceRevision.toString(),
    state: row.state,
    sweepCursor: row.sweepCursor,
    tenantId: row.tenantId,
  });

const jobIdentityWhere = (job: CoreSearchLabelRefreshJob) =>
  and(
    eq(searchLabelRefreshJobs.tenantId, job.tenantId),
    eq(searchLabelRefreshJobs.sourceModuleKey, job.moduleId),
    eq(searchLabelRefreshJobs.labelSourceModuleKey, job.sourceRef.moduleId),
    eq(searchLabelRefreshJobs.labelSourceResourceType, job.sourceRef.resourceType),
    eq(searchLabelRefreshJobs.labelSourceResourceId, job.sourceRef.resourceId),
    eq(searchLabelRefreshJobs.legalEntityId, job.legalEntityId),
  );

type SearchDerivedRepairJobRow = typeof searchDerivedRepairJobs.$inferSelect;

const repairJobFromRow = (row: SearchDerivedRepairJobRow): Option.Option<CoreSearchDerivedRepairJob> =>
  Schema.decodeUnknownOption(CoreSearchDerivedRepairJobSchema)({
    casVersion: row.casVersion.toString(),
    cursor: row.cursor,
    epoch: row.epoch.toString(),
    moduleId: row.sourceModuleKey,
    resourceType: row.sourceResourceType,
    state: row.state,
    sweepCursor: row.sweepCursor,
    tenantId: row.tenantId,
  });

const repairJobIdentityWhere = (job: CoreSearchDerivedRepairJob) =>
  and(
    eq(searchDerivedRepairJobs.tenantId, job.tenantId),
    eq(searchDerivedRepairJobs.sourceModuleKey, job.moduleId),
    eq(searchDerivedRepairJobs.sourceResourceType, job.resourceType),
  );

const repairPhaseCursor = (job: CoreSearchDerivedRepairJob): Option.Option<string> =>
  job.state === 'resweep' ? job.sweepCursor : job.cursor;

const cursorResourceIdOfTuple = (tuple: readonly [string, string]): string => tuple[1];

const rowMatchesDocument = (
  row: SearchIndexEntry,
  document: CoreSearchProjectionDocument,
): Result.Result<boolean, CoreSearchProjectionInvalid> =>
  Result.all([decodePersistedPayload(row.facetsJson), coreSearchDocumentBodyText(document)]).pipe(
    Result.map(
      ([persistedPayload, normalizedBody]) =>
        !row.deleted &&
        row.legalEntityId === (document.selectedLegalEntityId ?? null) &&
        row.title === document.title &&
        row.bodyText === normalizedBody &&
        persistedPayloadEquivalence(persistedPayload, coreSearchDocumentPayload(document)),
    ),
    Result.mapError((cause) => invalid('Core Search persisted payload is invalid', cause)),
  );

type PersistedSearchDocumentRow = Pick<
  SearchIndexEntry,
  | 'facetsJson'
  | 'bodyText'
  | 'legalEntityId'
  | 'projectionVersion'
  | 'sourceModuleKey'
  | 'sourceResourceId'
  | 'sourceResourceType'
  | 'tenantId'
  | 'title'
>;

/** Strict v2 storage decoding; legacy projections are retired by migration, never guessed from normalized text. */
export const decodeCoreSearchDocumentRow = (
  row: PersistedSearchDocumentRow,
): Result.Result<CoreSearchProjectionDocument, CoreSearchProjectionInvalid> =>
  decodePersistedPayload(row.facetsJson).pipe(
    Result.mapError((cause) => invalid('Core Search persisted payload is invalid', cause)),
    Result.flatMap((decoded) => {
      const document: PersistedDocumentInput = {
        archived: decoded.archived,
        facets: decoded.facets,
        metadata: decoded.metadata,
        projectionVersion: row.projectionVersion.toString(),
        ref: {
          moduleId: row.sourceModuleKey,
          resourceId: row.sourceResourceId,
          resourceType: row.sourceResourceType,
          tenantId: row.tenantId,
        },
        searchableText: decoded.searchableText,
        title: row.title,
      };
      if (decoded.aliases !== undefined) {
        document.aliases = decoded.aliases;
      }
      if (decoded.labelDependencies !== undefined) {
        document.labelDependencies = decoded.labelDependencies;
      }
      if (decoded.matchedRef !== undefined) {
        document.matchedRef = decoded.matchedRef;
      }
      if (decoded.matchedSubjectRef !== undefined) {
        document.matchedSubjectRef = decoded.matchedSubjectRef;
      }
      if (row.legalEntityId !== null) {
        document.selectedLegalEntityId = row.legalEntityId;
      }
      if (decoded.subjectRef !== undefined) {
        document.subjectRef = decoded.subjectRef;
      }
      if (decoded.temporalFacets !== undefined) {
        document.temporalFacets = decoded.temporalFacets;
      }
      if (decoded.temporalSearchableText !== undefined) {
        document.temporalSearchableText = decoded.temporalSearchableText;
      }
      return Result.try({
        catch: (cause) => invalid('Core Search persisted document is invalid', cause),
        try: () => decodeCoreSearchProjectionMutation({ document, kind: 'upsert' }),
      }).pipe(
        Result.flatMap((mutation) => {
          if (mutation.kind !== 'upsert') {
            return Result.fail(invalid('Core Search persisted document is invalid'));
          }
          return coreSearchDocumentBodyText(mutation.document).pipe(
            Result.flatMap((normalizedBody) =>
              normalizedBody === row.bodyText
                ? Result.succeed(mutation.document)
                : Result.fail(invalid('Core Search persisted body does not match its exact searchable terms')),
            ),
          );
        }),
      );
    }),
  );

const persistedDeleteMutation = (
  row: SearchIndexEntry,
  projectionVersion: string,
): Extract<CoreSearchProjectionMutation, { readonly kind: 'delete' }> => {
  const mutation = decodeCoreSearchProjectionMutation({
    kind: 'delete',
    projectionVersion,
    ref: {
      moduleId: row.sourceModuleKey,
      resourceId: row.sourceResourceId,
      resourceType: row.sourceResourceType,
      tenantId: row.tenantId,
    },
  });
  if (mutation.kind !== 'delete') {
    throw invalid('Core Search persisted resource reference is invalid');
  }
  return mutation;
};

const decodeMutation = (input: CoreSearchProjectionInput) =>
  Effect.try({
    catch: (error) =>
      Schema.is(CoreSearchProjectionInvalid)(error)
        ? error
        : invalid('Core Search mutation does not match its declared contract', error),
    try: () => decodeCoreSearchProjectionMutation(input),
  });

const decodeReplacement = (input: CoreSearchProjectionInput) =>
  Effect.try({
    catch: (error) =>
      Schema.is(CoreSearchProjectionInvalid)(error)
        ? error
        : invalid('Core Search replacement does not match its declared contract', error),
    try: () => decodeCoreSearchProjectionReplacement(input),
  });
/** The persisted next state of one committed refresh page, shared by label refresh and stamp repair. */
const advanceRefreshState = (state: CoreSearchLabelRefreshState, drained: boolean): CoreSearchLabelRefreshState => {
  if (!drained) {
    return state;
  }
  return state === 'sweeping' ? 'resweep' : 'complete';
};

interface RefreshJobCursorState {
  readonly cursor: Option.Option<string>;
  readonly state: CoreSearchLabelRefreshState;
  readonly sweepCursor: Option.Option<string>;
}

interface PersistedRefreshJobState {
  readonly cursor: string | null;
  readonly state: CoreSearchLabelRefreshState;
  readonly sweepCursor: string | null;
}

/** One committed page: a non-empty page advances the keyset; a drained page flips the phase. */
const advanceRefreshJobRow = (
  stored: RefreshJobCursorState,
  pageEnd: Option.Option<string>,
): PersistedRefreshJobState => {
  const drained = Option.isNone(pageEnd);
  let { cursor, sweepCursor } = stored;
  if (!drained) {
    if (stored.state === 'sweeping') {
      cursor = pageEnd;
    }
    if (stored.state === 'resweep') {
      sweepCursor = pageEnd;
    }
  } else if (stored.state === 'sweeping') {
    sweepCursor = Option.none();
  }
  return {
    cursor: Option.getOrNull(cursor),
    state: advanceRefreshState(stored.state, drained),
    sweepCursor: Option.getOrNull(sweepCursor),
  };
};

const makeTransactionOperations = (databaseIdentities: DatabaseIdentityEnrollment) => {
  const installTenantScope = Effect.fn('CoreSearchPersistence.installTenantScope')(function* installTenantScopeEffect(
    transaction: CoreTransaction,
    tenantId: string,
    legalEntityId?: string,
  ) {
    const result = yield* transaction
      .execute(
        sql`
        select
          set_config('ontos.tenant_id', ${tenantId}, true) as tenant_id,
          set_config('ontos.legal_entity_id', ${legalEntityId ?? ''}, true) as legal_entity_id
      `,
        'objects',
      )
      .pipe(Effect.mapError(unavailable));
    const verified = Schema.decodeUnknownOption(
      Schema.Struct({
        legal_entity_id: Schema.String,
        tenant_id: Schema.String,
      }),
    )(result[0]);
    if (
      Option.isNone(verified) ||
      verified.value.tenant_id !== tenantId ||
      verified.value.legal_entity_id !== (legalEntityId ?? '')
    ) {
      return yield* unavailable();
    }
    return yield* Effect.void;
  });

  const lockProjectionUnit = Effect.fn('CoreSearchPersistence.lockProjectionUnit')(function* lockProjectionUnitEffect(
    transaction: CoreTransaction,
    tenantId: string,
    moduleId: string,
    resourceType: string,
  ) {
    yield* transaction
      .execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${projectionUnitKey(tenantId, moduleId, resourceType)}, 0))`,
      )
      .pipe(Effect.mapError(unavailable));
  });

  const currentRow = Effect.fn('CoreSearchPersistence.currentRow')(function* currentRowEffect(
    transaction: CoreTransaction,
    ref: CoreSearchResourceRef,
  ) {
    const query = transaction.query.searchIndexEntries.findFirst({
      where: {
        sourceModuleKey: ref.moduleId,
        sourceResourceId: ref.resourceId,
        sourceResourceType: ref.resourceType,
        tenantId: ref.tenantId,
      },
    });
    const row = yield* query.execute.bind(query)().pipe(Effect.mapError(unavailable));
    return Option.fromNullishOr(row);
  });

  const currentRebuild = Effect.fn('CoreSearchPersistence.currentRebuild')(function* currentRebuildEffect(
    transaction: CoreTransaction,
    unit: Readonly<{
      moduleId: string;
      resourceType: string;
      tenantId: string;
    }>,
  ) {
    const query = transaction.query.searchProjectionRebuilds.findFirst({
      where: {
        sourceModuleKey: unit.moduleId,
        sourceResourceType: unit.resourceType,
        tenantId: unit.tenantId,
      },
    });
    const rebuild = yield* query.execute.bind(query)().pipe(Effect.mapError(unavailable));
    return Option.fromNullishOr(rebuild);
  });

  const cachedCurrentRow = Effect.fn('CoreSearchPersistence.cachedCurrentRow')(function* cachedCurrentRowEffect(
    transaction: CoreTransaction,
    cache: PageReadCache,
    ref: CoreSearchResourceRef,
  ) {
    const key = coreSearchResourceRefKey(ref);
    const cached = cache.rows.get(key);
    if (cached !== undefined) {
      return cached;
    }
    const row = yield* currentRow(transaction, ref);
    cache.rows.set(key, row);
    return row;
  });

  const cachedCurrentRebuild = Effect.fn('CoreSearchPersistence.cachedCurrentRebuild')(
    function* cachedCurrentRebuildEffect(
      transaction: CoreTransaction,
      cache: PageReadCache,
      unit: Readonly<{ moduleId: string; resourceType: string; tenantId: string }>,
    ) {
      const key = projectionUnitKey(unit.tenantId, unit.moduleId, unit.resourceType);
      const cached = cache.floors.get(key);
      if (cached !== undefined) {
        return cached;
      }
      const floor = yield* currentRebuild(transaction, unit);
      cache.floors.set(key, floor);
      return floor;
    },
  );

  const loadLabelBarriers = Effect.fn('CoreSearchPersistence.loadLabelBarriers')(function* loadLabelBarriersEffect(
    transaction: CoreTransaction,
    tenantId: string,
    sourceModuleKey: string,
    dependencies: readonly CoreSearchLabelDependency[],
  ) {
    const barriers = new Map<string, bigint>();
    if (dependencies.length === 0) {
      return barriers;
    }
    const query = transaction
      .select({
        legalEntityId: searchLabelSourceRevisions.legalEntityId,
        moduleId: searchLabelSourceRevisions.labelSourceModuleKey,
        resourceId: searchLabelSourceRevisions.labelSourceResourceId,
        resourceType: searchLabelSourceRevisions.labelSourceResourceType,
        sourceRevision: searchLabelSourceRevisions.sourceRevision,
      })
      .from(searchLabelSourceRevisions)
      .where(
        and(
          eq(searchLabelSourceRevisions.tenantId, tenantId),
          eq(searchLabelSourceRevisions.sourceModuleKey, sourceModuleKey),
          or(...dependencies.map(labelBarrierPredicate)),
        ),
      );
    const rows = yield* query.execute.bind(query)().pipe(Effect.mapError(unavailable));
    yield* Effect.forEach(
      rows,
      (row) => {
        const ref = decodeCoreSearchResourceRef({
          moduleId: row.moduleId,
          resourceId: row.resourceId,
          resourceType: row.resourceType,
          tenantId,
        });
        if (Option.isNone(ref)) {
          return unavailable();
        }
        barriers.set(coreSearchLabelBarrierKey(ref.value, row.legalEntityId), row.sourceRevision);
        return Effect.void;
      },
      { concurrency: 1, discard: true },
    );
    return barriers;
  });

  const advanceLabelBarriers = Effect.fn('CoreSearchPersistence.advanceLabelBarriers')(
    function* advanceLabelBarriersEffect(
      transaction: CoreTransaction,
      tenantId: string,
      sourceModuleKey: string,
      dependencies: readonly CoreSearchLabelDependency[],
      updatedAt: Date,
    ) {
      if (dependencies.length === 0) {
        return;
      }
      const maxByKey = new Map<string, CoreSearchLabelDependency>();
      for (const dependency of dependencies) {
        const key = coreSearchLabelBarrierKey(dependency.ref, dependency.selectedLegalEntityId);
        const prior = maxByKey.get(key);
        if (prior === undefined || BigInt(dependency.sourceRevision) > BigInt(prior.sourceRevision)) {
          maxByKey.set(key, dependency);
        }
      }
      const query = transaction
        .insert(searchLabelSourceRevisions)
        .values(
          [...maxByKey.values()].map((dependency) => ({
            labelSourceModuleKey: dependency.ref.moduleId,
            labelSourceResourceId: dependency.ref.resourceId,
            labelSourceResourceType: dependency.ref.resourceType,
            legalEntityId: dependency.selectedLegalEntityId,
            sourceModuleKey,
            sourceRevision: BigInt(dependency.sourceRevision),
            tenantId,
            updatedAt,
          })),
        )
        .onConflictDoUpdate({
          set: {
            sourceRevision: sql`greatest(${searchLabelSourceRevisions.sourceRevision}, excluded.source_revision)`,
            updatedAt,
          },
          target: [
            searchLabelSourceRevisions.tenantId,
            searchLabelSourceRevisions.sourceModuleKey,
            searchLabelSourceRevisions.labelSourceModuleKey,
            searchLabelSourceRevisions.labelSourceResourceType,
            searchLabelSourceRevisions.labelSourceResourceId,
            searchLabelSourceRevisions.legalEntityId,
          ],
        });
      yield* query.execute.bind(query)().pipe(Effect.mapError(unavailable));
    },
  );

  const persistUpsert = Effect.fn('CoreSearchPersistence.persistUpsert')(function* persistUpsertEffect(
    transaction: CoreTransaction,
    cache: PageReadCache,
    document: CoreSearchProjectionDocument,
    updatedAt: Date,
  ) {
    const normalizedBody = yield* Effect.fromResult(coreSearchDocumentBodyText(document));
    const current = yield* cachedCurrentRow(transaction, cache, document.ref);
    const version = BigInt(document.projectionVersion);
    if (Option.isSome(current)) {
      const existing = current.value;
      if (existing.projectionVersion > version) {
        return yield* Effect.void;
      }
      if (existing.projectionVersion === version) {
        const matches = yield* Effect.fromResult(rowMatchesDocument(existing, document));
        if (!matches) {
          return yield* invalid('Core Search mutation reuses a version for different content');
        }
        // Same accepted content may repair a missing/stale derived representation without
        // advancing its lifecycle version, rebuild floor, or publication generation.
        const derived = deriveCoreSearchRepresentation(document);
        if (
          existing.searchFormatVersion !== derived.searchFormatVersion ||
          existing.searchSourceVersion !== derived.searchSourceVersion ||
          existing.searchTextV1 !== derived.searchTextV1
        ) {
          const repair = transaction
            .update(searchIndexEntries)
            .set(derived)
            .where(eq(searchIndexEntries.searchIndexEntryId, existing.searchIndexEntryId));
          yield* repair.execute.bind(repair)().pipe(Effect.mapError(unavailable));
        }
        return yield* Effect.void;
      }
      const query = transaction
        .update(searchIndexEntries)
        .set({
          ...deriveCoreSearchRepresentation(document),
          bodyText: normalizedBody,
          deleted: false,
          facetsJson: coreSearchDocumentPayload(document),
          legalEntityId: document.selectedLegalEntityId ?? null,
          projectionVersion: version,
          title: document.title,
          updatedAt,
        })
        .where(eq(searchIndexEntries.searchIndexEntryId, existing.searchIndexEntryId));
      yield* query.execute.bind(query)().pipe(Effect.mapError(unavailable));
      return yield* Effect.void;
    }
    const query = transaction.insert(searchIndexEntries).values({
      ...deriveCoreSearchRepresentation(document),
      bodyText: normalizedBody,
      deleted: false,
      facetsJson: coreSearchDocumentPayload(document),
      legalEntityId: document.selectedLegalEntityId ?? null,
      projectionVersion: version,
      sourceModuleKey: document.ref.moduleId,
      sourceResourceId: document.ref.resourceId,
      sourceResourceType: document.ref.resourceType,
      tenantId: document.ref.tenantId,
      title: document.title,
    });
    yield* query.execute.bind(query)().pipe(Effect.mapError(unavailable));
    return yield* Effect.void;
  });

  const persistDelete = Effect.fn('CoreSearchPersistence.persistDelete')(function* persistDeleteEffect(
    transaction: CoreTransaction,
    cache: PageReadCache,
    mutation: Extract<CoreSearchProjectionMutation, { readonly kind: 'delete' }>,
    updatedAt: Date,
  ) {
    const current = yield* cachedCurrentRow(transaction, cache, mutation.ref);
    const version = BigInt(mutation.projectionVersion);
    if (Option.isSome(current) && current.value.projectionVersion > version) {
      return yield* Effect.void;
    }
    if (Option.isSome(current) && current.value.projectionVersion === version) {
      if (!current.value.deleted) {
        return yield* invalid('Core Search mutation reuses a version for different content');
      }
      return yield* Effect.void;
    }
    if (Option.isNone(current)) {
      const query = transaction.insert(searchIndexEntries).values({
        bodyText: '',
        deleted: true,
        facetsJson: { schemaVersion: '2' },
        projectionVersion: version,
        searchFormatVersion: null,
        searchSourceVersion: null,
        searchTextV1: null,
        sourceModuleKey: mutation.ref.moduleId,
        sourceResourceId: mutation.ref.resourceId,
        sourceResourceType: mutation.ref.resourceType,
        tenantId: mutation.ref.tenantId,
        title: '',
      });
      yield* query.execute.bind(query)().pipe(Effect.mapError(unavailable));
      return yield* Effect.void;
    }
    const query = transaction
      .update(searchIndexEntries)
      .set({
        bodyText: '',
        deleted: true,
        facetsJson: { schemaVersion: '2' },
        legalEntityId: null,
        projectionVersion: version,
        searchFormatVersion: null,
        searchSourceVersion: null,
        searchTextV1: null,
        title: '',
        updatedAt,
      })
      .where(eq(searchIndexEntries.searchIndexEntryId, current.value.searchIndexEntryId));
    yield* query.execute.bind(query)().pipe(Effect.mapError(unavailable));
    return yield* Effect.void;
  });

  const persistRebuildFloor = Effect.fn('CoreSearchPersistence.persistRebuildFloor')(
    function* persistRebuildFloorEffect(
      transaction: CoreTransaction,
      replacement: CoreSearchProjectionReplacement,
      fingerprint: string,
      updatedAt: Date,
    ) {
      const rebuildVersion = BigInt(replacement.rebuildVersion);
      const query = transaction
        .insert(searchProjectionRebuilds)
        .values({
          fingerprint,
          rebuildVersion,
          sourceModuleKey: replacement.moduleId,
          sourceResourceType: replacement.resourceType,
          tenantId: replacement.tenantId,
        })
        .onConflictDoUpdate({
          set: { fingerprint, rebuildVersion, updatedAt },
          target: [
            searchProjectionRebuilds.tenantId,
            searchProjectionRebuilds.sourceModuleKey,
            searchProjectionRebuilds.sourceResourceType,
          ],
        });
      yield* query.execute.bind(query)().pipe(Effect.mapError(unavailable));
    },
  );

  const replacementRows = Effect.fn('CoreSearchPersistence.replacementRows')(function* replacementRowsEffect(
    transaction: CoreTransaction,
    replacement: CoreSearchProjectionReplacement,
  ) {
    const current = yield* currentRebuild(transaction, replacement);
    const version = BigInt(replacement.rebuildVersion);
    const fingerprint = coreSearchReplacementFingerprint(replacement);
    if (Option.isSome(current) && version < current.value.rebuildVersion) {
      return Option.none();
    }
    if (Option.isSome(current) && version === current.value.rebuildVersion) {
      const prior = current.value;
      if (fingerprint !== prior.fingerprint) {
        return yield* invalid('Core Search rebuild reuses a version for different content');
      }
      return Option.none();
    }
    const query = transaction.query.searchIndexEntries.findMany({
      where: {
        sourceModuleKey: replacement.moduleId,
        sourceResourceType: replacement.resourceType,
        tenantId: replacement.tenantId,
      },
    });
    const existing = yield* query.execute.bind(query)().pipe(Effect.mapError(unavailable));
    return Option.some({ existing, fingerprint });
  });

  /**
   * Phase one of a page or rebuild: read-only dependency validation in observation order. Every
   * statement issued here is a SELECT, so a rejected page never issues a business write; only the
   * observations this phase admitted are advanced in phase two.
   */
  const validateDocumentLabelDependencies = Effect.fn('CoreSearchPersistence.validateDocumentLabelDependencies')(
    function* validateDocumentLabelDependenciesEffect(
      transaction: CoreTransaction,
      cache: PageReadCache,
      barrierMap: Map<string, bigint>,
      document: CoreSearchProjectionDocument,
    ) {
      const floor = yield* cachedCurrentRebuild(transaction, cache, document.ref);
      const version = BigInt(document.projectionVersion);
      if (Option.isSome(floor) && version <= floor.value.rebuildVersion) {
        return [];
      }
      const existing = yield* cachedCurrentRow(transaction, cache, document.ref);
      if (Option.isSome(existing) && existing.value.projectionVersion >= version) {
        // A newer or equal target is handled by its own content check, never by a dependency edge.
        return [];
      }
      if (Option.isSome(existing) && !existing.value.deleted && document.labelDependencies !== undefined) {
        const payload = yield* Effect.fromResult(decodePersistedPayload(existing.value.facetsJson)).pipe(
          Effect.mapError((cause) => invalid('Core Search persisted dependency payload is invalid', cause)),
        );
        yield* Effect.fromResult(
          validateCoreSearchDependencyRevisions(payload.labelDependencies ?? [], document.labelDependencies),
        );
      }
      const dependencies = document.labelDependencies ?? [];
      yield* Effect.fromResult(validateCoreSearchLabelBarrier(barrierMap, dependencies));
      advanceCoreSearchLabelBarrier(barrierMap, dependencies);
      return dependencies;
    },
  );

  /**
   * Phase one of a page or rebuild: read-only dependency validation in observation order. Every
   * statement issued here is a SELECT, so a rejected page never issues a business write; only the
   * observations this phase admitted are advanced in phase two.
   */
  const validateLabelDependencies = Effect.fn('CoreSearchPersistence.validateLabelDependencies')(
    function* validateLabelDependenciesEffect(
      transaction: CoreTransaction,
      cache: PageReadCache,
      tenantId: string,
      moduleId: string,
      documents: readonly CoreSearchProjectionDocument[],
    ) {
      const requested = documents.flatMap((document) => document.labelDependencies ?? []);
      const barrierMap = yield* loadLabelBarriers(transaction, tenantId, moduleId, requested);
      const emptyAdmitted: readonly CoreSearchLabelDependency[] = [];
      return yield* Effect.reduce(
        documents,
        () => emptyAdmitted,
        (admitted, document) =>
          Effect.map(validateDocumentLabelDependencies(transaction, cache, barrierMap, document), (dependencies) =>
            dependencies.length === 0 ? admitted : [...admitted, ...dependencies],
          ),
      );
    },
  );

  const replaceProjection = Effect.fn('CoreSearchPersistence.replaceProjection')(function* replaceProjectionEffect(
    transaction: CoreTransaction,
    replacement: CoreSearchProjectionReplacement,
    updatedAt: Date,
  ) {
    yield* lockProjectionUnit(transaction, replacement.tenantId, replacement.moduleId, replacement.resourceType);
    const work = yield* replacementRows(transaction, replacement);
    if (Option.isNone(work)) {
      return;
    }
    const { existing, fingerprint } = work.value;
    const cache = newPageReadCache();
    const admitted = yield* validateLabelDependencies(
      transaction,
      cache,
      replacement.tenantId,
      replacement.moduleId,
      replacement.documents,
    );
    yield* advanceLabelBarriers(transaction, replacement.tenantId, replacement.moduleId, admitted, updatedAt);
    yield* Effect.forEach(replacement.documents, (document) => persistUpsert(transaction, cache, document, updatedAt), {
      concurrency: 1,
      discard: true,
    });
    const nextIds = new Set<string>(replacement.documents.map(({ ref }) => ref.resourceId));
    const staleRows = existing.filter(
      (row) => !nextIds.has(row.sourceResourceId) && row.projectionVersion < BigInt(replacement.rebuildVersion),
    );
    yield* Effect.forEach(
      staleRows,
      (row) => persistDelete(transaction, cache, persistedDeleteMutation(row, replacement.rebuildVersion), updatedAt),
      { concurrency: 1, discard: true },
    );
    yield* persistRebuildFloor(transaction, replacement, fingerprint, updatedAt);
  });

  const applyMutationCore = Effect.fn('CoreSearchPersistence.applyMutationCore')(function* applyMutationCoreEffect(
    transaction: CoreTransaction,
    cache: PageReadCache,
    mutation: CoreSearchProjectionMutation,
    updatedAt: Date,
  ) {
    const ref = mutation.kind === 'upsert' ? mutation.document.ref : mutation.ref;
    const rebuild = yield* cachedCurrentRebuild(transaction, cache, ref);
    const version = BigInt(
      mutation.kind === 'upsert' ? mutation.document.projectionVersion : mutation.projectionVersion,
    );
    if (Option.isSome(rebuild) && version <= rebuild.value.rebuildVersion) {
      return;
    }
    if (mutation.kind === 'upsert') {
      yield* persistUpsert(transaction, cache, mutation.document, updatedAt);
      return;
    }
    yield* persistDelete(transaction, cache, mutation, updatedAt);
  });

  const applyMutationTransaction = Effect.fn('CoreSearchPersistence.applyMutationTransaction')(
    function* applyMutationTransactionEffect(
      transaction: CoreTransaction,
      mutation: CoreSearchProjectionMutation,
      updatedAt: Date,
    ) {
      const ref = mutation.kind === 'upsert' ? mutation.document.ref : mutation.ref;
      yield* installTenantScope(transaction, ref.tenantId);
      yield* lockProjectionUnit(transaction, ref.tenantId, ref.moduleId, ref.resourceType);
      const cache = newPageReadCache();
      const admitted = yield* validateLabelDependencies(
        transaction,
        cache,
        ref.tenantId,
        ref.moduleId,
        mutation.kind === 'upsert' ? [mutation.document] : [],
      );
      yield* advanceLabelBarriers(transaction, ref.tenantId, ref.moduleId, admitted, updatedAt);
      yield* applyMutationCore(transaction, cache, mutation, updatedAt);
    },
  );

  const applyBatchTransaction = Effect.fn('CoreSearchPersistence.applyBatchTransaction')(
    function* applyBatchTransactionEffect(
      transaction: CoreTransaction,
      batch: CoreSearchProjectionBatch,
      updatedAt: Date,
      legalEntityId?: string,
    ) {
      yield* installTenantScope(transaction, batch.tenantId, legalEntityId);
      // Take every unit lock in the same order before applying any mutation. Concurrent batches
      // spanning several types cannot deadlock by visiting their types in opposite input order.
      const types = [
        ...new Set(
          batch.mutations.map((mutation) =>
            mutation.kind === 'upsert' ? mutation.document.ref.resourceType : mutation.ref.resourceType,
          ),
        ),
      ].toSorted();
      yield* Effect.forEach(
        types,
        (resourceType) => lockProjectionUnit(transaction, batch.tenantId, batch.moduleId, resourceType),
        { concurrency: 1, discard: true },
      );
      const cache = newPageReadCache();
      const admitted = yield* validateLabelDependencies(
        transaction,
        cache,
        batch.tenantId,
        batch.moduleId,
        batch.mutations.flatMap((mutation) => (mutation.kind === 'upsert' ? [mutation.document] : [])),
      );
      yield* advanceLabelBarriers(transaction, batch.tenantId, batch.moduleId, admitted, updatedAt);
      yield* Effect.forEach(batch.mutations, (mutation) => applyMutationCore(transaction, cache, mutation, updatedAt), {
        concurrency: 1,
        discard: true,
      });
    },
  );

  const queryDependentsTransaction = Effect.fn('CoreSearchPersistence.queryDependentsTransaction')(
    function* queryDependentsTransactionEffect(
      transaction: CoreTransaction,
      input: CoreSearchProjectionDependentQuery,
    ) {
      yield* installTenantScope(transaction, input.tenantId);
      // This is a private owner-background dependency scan, not a cross-owner label-table read.
      // The 10001st row detects overflow; it must never be presented as a complete first-N page.
      const predicate = yield* Effect.fromResult(
        encodeDependencyPredicate([{ ref: input.sourceRef, selectedLegalEntityId: input.selectedLegalEntityId }]),
      ).pipe(Effect.mapError((cause) => invalid('Core Search dependency predicate is invalid', cause)));
      const query = transaction
        .select()
        .from(searchIndexEntries)
        .where(
          and(
            eq(searchIndexEntries.deleted, false),
            eq(searchIndexEntries.legalEntityId, input.selectedLegalEntityId),
            eq(searchIndexEntries.sourceModuleKey, input.moduleId),
            eq(searchIndexEntries.tenantId, input.tenantId),
            sql`${searchIndexEntries.facetsJson}->'labelDependencies' @> ${predicate}::jsonb`,
          ),
        )
        .limit(CORE_SEARCH_CANDIDATE_BUDGET + 1);
      const rows = yield* query.execute.bind(query)().pipe(Effect.mapError(unavailable));
      if (rows.length > CORE_SEARCH_CANDIDATE_BUDGET) {
        return yield* unavailable();
      }
      const documents = yield* Effect.fromResult(Result.all(rows.map(decodeCoreSearchDocumentRow))).pipe(
        Effect.mapError(unavailable),
      );
      if (documents.some((document) => !coreSearchDocumentDependsOn(document, input))) {
        return yield* unavailable();
      }
      return documents.toSorted((left, right) =>
        coreSearchResourceRefKey(left.ref).localeCompare(coreSearchResourceRefKey(right.ref)),
      );
    },
  );

  const queryCandidatesTransaction = Effect.fn('CoreSearchPersistence.queryCandidatesTransaction')(
    function* queryCandidatesTransactionEffect(
      transaction: CoreTransaction,
      input: CoreSearchQuery,
      scope: OperationalScope,
    ) {
      // A query may narrow a tenant-wide scope, or select global rows under an entity scope.
      if (!coreSearchQueryMatchesScope(input, scope)) {
        return yield* unavailable();
      }
      // The scope's own authority (session setting or gateway grant) decides which rows are visible.
      yield* installOperationalScope(transaction, scope, databaseIdentities).pipe(
        Effect.catchTag('OperationContextUnavailable', (failure) => Effect.fail(unavailable(failure))),
      );
      const query = selectCoreSearchCandidates(transaction, input);
      const rows = yield* query.execute.bind(query)().pipe(Effect.mapError(unavailable));
      if (rows.length > CORE_SEARCH_CANDIDATE_BUDGET) {
        return yield* unavailable();
      }
      return yield* Effect.fromResult(Result.all(rows.map(decodeCoreSearchDocumentRow))).pipe(
        Effect.mapError(unavailable),
      );
    },
  );

  const replaceProjectionTransaction = Effect.fn('CoreSearchPersistence.replaceProjectionTransaction')(
    function* replaceProjectionTransactionEffect(
      transaction: CoreTransaction,
      replacement: CoreSearchProjectionReplacement,
      updatedAt: Date,
    ) {
      yield* installTenantScope(transaction, replacement.tenantId);
      yield* replaceProjection(transaction, replacement, updatedAt);
    },
  );

  const readBarrierRevision = Effect.fn('CoreSearchPersistence.readBarrierRevision')(
    function* readBarrierRevisionEffect(
      transaction: CoreTransaction,
      open: Pick<CoreSearchLabelRefreshOpen, 'legalEntityId' | 'moduleId' | 'sourceRef' | 'tenantId'>,
    ) {
      const query = transaction
        .select({ sourceRevision: searchLabelSourceRevisions.sourceRevision })
        .from(searchLabelSourceRevisions)
        .where(
          and(
            eq(searchLabelSourceRevisions.tenantId, open.tenantId),
            eq(searchLabelSourceRevisions.sourceModuleKey, open.moduleId),
            eq(searchLabelSourceRevisions.labelSourceModuleKey, open.sourceRef.moduleId),
            eq(searchLabelSourceRevisions.labelSourceResourceType, open.sourceRef.resourceType),
            eq(searchLabelSourceRevisions.labelSourceResourceId, open.sourceRef.resourceId),
            eq(searchLabelSourceRevisions.legalEntityId, open.legalEntityId),
          ),
        )
        .limit(1);
      const rows = yield* query.execute.bind(query)().pipe(Effect.mapError(unavailable));
      return rows[0]?.sourceRevision;
    },
  );

  const openLabelRefreshTransaction = Effect.fn('CoreSearchPersistence.openLabelRefreshTransaction')(
    function* openLabelRefreshTransactionEffect(
      transaction: CoreTransaction,
      open: CoreSearchLabelRefreshOpen,
      updatedAt: Date,
    ) {
      yield* installTenantScope(transaction, open.tenantId, open.legalEntityId);
      yield* advanceLabelBarriers(
        transaction,
        open.tenantId,
        open.moduleId,
        [{ ref: open.sourceRef, selectedLegalEntityId: open.legalEntityId, sourceRevision: open.sourceRevision }],
        updatedAt,
      );
      const barrier = yield* readBarrierRevision(transaction, open);
      if (barrier === undefined) {
        return yield* unavailable();
      }
      const existingQuery = transaction
        .select()
        .from(searchLabelRefreshJobs)
        .where(
          and(
            eq(searchLabelRefreshJobs.tenantId, open.tenantId),
            eq(searchLabelRefreshJobs.sourceModuleKey, open.moduleId),
            eq(searchLabelRefreshJobs.labelSourceModuleKey, open.sourceRef.moduleId),
            eq(searchLabelRefreshJobs.labelSourceResourceType, open.sourceRef.resourceType),
            eq(searchLabelRefreshJobs.labelSourceResourceId, open.sourceRef.resourceId),
            eq(searchLabelRefreshJobs.legalEntityId, open.legalEntityId),
          ),
        )
        .for('update')
        .limit(1);
      const existingRows = yield* existingQuery.execute.bind(existingQuery)().pipe(Effect.mapError(unavailable));
      const [existing] = existingRows;
      if (existing === undefined) {
        const insert = transaction
          .insert(searchLabelRefreshJobs)
          .values({
            casVersion: 1n,
            cursor: null,
            epoch: 1n,
            labelSourceModuleKey: open.sourceRef.moduleId,
            labelSourceResourceId: open.sourceRef.resourceId,
            labelSourceResourceType: open.sourceRef.resourceType,
            legalEntityId: open.legalEntityId,
            sourceModuleKey: open.moduleId,
            sourceRevision: barrier,
            state: 'sweeping',
            sweepCursor: null,
            tenantId: open.tenantId,
            updatedAt,
          })
          .returning();
        const inserted = yield* insert.execute.bind(insert)().pipe(Effect.mapError(unavailable));
        const [created] = inserted;
        if (created === undefined) {
          return yield* unavailable();
        }
        const createdJob = jobFromRow(created);
        if (Option.isNone(createdJob)) {
          return yield* unavailable();
        }
        return createdJob.value;
      }
      const existingJob = jobFromRow(existing);
      if (Option.isNone(existingJob)) {
        return yield* unavailable();
      }
      if (existing.sourceRevision >= barrier) {
        return existingJob.value;
      }
      const update = transaction
        .update(searchLabelRefreshJobs)
        .set({
          casVersion: existing.casVersion + 1n,
          cursor: null,
          epoch: existing.epoch + 1n,
          sourceRevision: barrier,
          state: 'sweeping',
          sweepCursor: null,
          updatedAt,
        })
        .where(and(jobIdentityWhere(existingJob.value), eq(searchLabelRefreshJobs.epoch, existing.epoch)))
        .returning();
      const updated = yield* update.execute.bind(update)().pipe(Effect.mapError(unavailable));
      const [advanced] = updated;
      if (advanced === undefined) {
        return yield* unavailable();
      }
      const advancedJob = jobFromRow(advanced);
      if (Option.isNone(advancedJob)) {
        return yield* unavailable();
      }
      return advancedJob.value;
    },
  );

  const readLabelRefreshPageTransaction = Effect.fn('CoreSearchPersistence.readLabelRefreshPageTransaction')(
    function* readLabelRefreshPageTransactionEffect(
      transaction: CoreTransaction,
      query: CoreSearchLabelRefreshPageQuery,
    ) {
      yield* installTenantScope(transaction, query.job.tenantId, query.job.legalEntityId);
      const storedQuery = transaction.select().from(searchLabelRefreshJobs).where(jobIdentityWhere(query.job)).limit(1);
      const storedRows = yield* storedQuery.execute.bind(storedQuery)().pipe(Effect.mapError(unavailable));
      const [stored] = storedRows;
      if (
        stored === undefined ||
        stored.epoch !== BigInt(query.job.epoch) ||
        stored.sourceRevision !== BigInt(query.job.sourceRevision)
      ) {
        return yield* invalid(LABEL_REFRESH_TOKEN_SUPERSEDED);
      }
      if (stored.state === 'complete') {
        return { documents: [], hasMore: false, pageEnd: Option.none() };
      }
      const limit = query.limit ?? CORE_SEARCH_LABEL_REFRESH_PAGE_LIMIT;
      const lower = Option.flatMap(decodeCoreSearchLabelRefreshCursorOption)(
        Option.fromNullOr(stored.state === 'resweep' ? stored.sweepCursor : stored.cursor),
      );
      const predicate = yield* Effect.fromResult(
        encodeDependencyPredicate([{ ref: query.job.sourceRef, selectedLegalEntityId: query.job.legalEntityId }]),
      ).pipe(Effect.mapError((cause) => invalid('Core Search dependency predicate is invalid', cause)));
      const cursorCondition = Option.map((tuple: readonly [string, string]) => {
        const [sourceResourceType, sourceResourceId] = tuple;
        return or(
          gt(searchIndexEntries.sourceResourceType, sourceResourceType),
          and(
            eq(searchIndexEntries.sourceResourceType, sourceResourceType),
            gt(searchIndexEntries.sourceResourceId, sourceResourceId),
          ),
        );
      })(lower);
      const select = transaction
        .select()
        .from(searchIndexEntries)
        .where(
          and(
            eq(searchIndexEntries.deleted, false),
            eq(searchIndexEntries.legalEntityId, query.job.legalEntityId),
            eq(searchIndexEntries.sourceModuleKey, query.job.moduleId),
            eq(searchIndexEntries.tenantId, query.job.tenantId),
            sql`${searchIndexEntries.facetsJson}->'labelDependencies' @> ${predicate}::jsonb`,
            Option.getOrUndefined(cursorCondition),
          ),
        )
        .orderBy(asc(searchIndexEntries.sourceResourceType), asc(searchIndexEntries.sourceResourceId))
        .limit(limit + 1);
      const rows = yield* select.execute.bind(select)().pipe(Effect.mapError(unavailable));
      const documents = yield* Effect.fromResult(
        Result.all(rows.slice(0, limit).map(decodeCoreSearchDocumentRow)),
      ).pipe(Effect.mapError(unavailable));
      if (
        documents.some(
          (document) =>
            !coreSearchDocumentDependsOn(document, {
              moduleId: query.job.moduleId,
              selectedLegalEntityId: query.job.legalEntityId,
              sourceRef: query.job.sourceRef,
              tenantId: query.job.tenantId,
            }),
        )
      ) {
        return yield* unavailable();
      }
      const last = documents.at(-1);
      return {
        documents,
        hasMore: rows.length > limit,
        pageEnd: last === undefined ? Option.none() : Option.some(coreSearchLabelRefreshCursorKey(last.ref)),
      } satisfies CoreSearchLabelRefreshPage;
    },
  );

  const commitLabelRefreshPageTransaction = Effect.fn('CoreSearchPersistence.commitLabelRefreshPageTransaction')(
    function* commitLabelRefreshPageTransactionEffect(
      transaction: CoreTransaction,
      commit: CoreSearchLabelRefreshCommit,
      updatedAt: Date,
    ) {
      yield* Effect.fromResult(validateCoreSearchLabelRefreshPageCommit(commit));
      yield* installTenantScope(transaction, commit.job.tenantId, commit.job.legalEntityId);
      const storedQuery = transaction
        .select()
        .from(searchLabelRefreshJobs)
        .where(jobIdentityWhere(commit.job))
        .for('update')
        .limit(1);
      const storedRows = yield* storedQuery.execute.bind(storedQuery)().pipe(Effect.mapError(unavailable));
      const [storedRow] = storedRows;
      const barrier = yield* readBarrierRevision(transaction, commit.job);
      if (storedRow === undefined) {
        return yield* invalid(LABEL_REFRESH_TOKEN_SUPERSEDED);
      }
      const storedJob = jobFromRow(storedRow);
      if (
        Option.isNone(storedJob) ||
        storedJob.value.epoch !== commit.job.epoch ||
        storedJob.value.casVersion !== commit.job.casVersion ||
        storedJob.value.sourceRevision !== commit.job.sourceRevision ||
        barrier === undefined ||
        barrier > BigInt(commit.job.sourceRevision)
      ) {
        return yield* invalid(LABEL_REFRESH_TOKEN_SUPERSEDED);
      }
      const stored = storedJob.value;
      yield* applyBatchTransaction(
        transaction,
        { moduleId: commit.job.moduleId, mutations: [...commit.mutations], tenantId: commit.job.tenantId },
        updatedAt,
        commit.job.legalEntityId,
      );
      const advance = advanceRefreshJobRow(stored, commit.pageEnd);
      const update = transaction
        .update(searchLabelRefreshJobs)
        .set({
          casVersion: storedRow.casVersion + 1n,
          cursor: advance.cursor,
          state: advance.state,
          sweepCursor: advance.sweepCursor,
          updatedAt,
        })
        .where(and(jobIdentityWhere(commit.job), eq(searchLabelRefreshJobs.casVersion, storedRow.casVersion)))
        .returning();
      const updated = yield* update.execute.bind(update)().pipe(Effect.mapError(unavailable));
      const [advanced] = updated;
      if (advanced === undefined) {
        return yield* invalid(LABEL_REFRESH_TOKEN_SUPERSEDED);
      }
      const advancedJob = jobFromRow(advanced);
      if (Option.isNone(advancedJob)) {
        return yield* unavailable();
      }
      return advancedJob.value;
    },
  );

  /**
   * Repairs only the derived shortlist representation of one accepted persisted document. Lifecycle
   * version, payload, floors, tombstones and publication generations are untouched, and the locked row
   * plus its projection_version is the compare-and-set anchor.
   */
  const repairPersistedRow = Effect.fn('CoreSearchPersistence.repairPersistedRow')(function* repairPersistedRowEffect(
    transaction: CoreTransaction,
    row: SearchIndexEntry,
  ) {
    const document = yield* Effect.fromResult(decodeCoreSearchDocumentRow(row)).pipe(Effect.mapError(unavailable));
    const derived = deriveCoreSearchRepresentation(document);
    if (
      row.searchFormatVersion === derived.searchFormatVersion &&
      row.searchSourceVersion === derived.searchSourceVersion &&
      row.searchTextV1 === derived.searchTextV1
    ) {
      return 0;
    }
    const update = transaction
      .update(searchIndexEntries)
      .set({
        searchFormatVersion: derived.searchFormatVersion,
        searchSourceVersion: derived.searchSourceVersion,
        searchTextV1: derived.searchTextV1,
      })
      .where(
        and(
          eq(searchIndexEntries.searchIndexEntryId, row.searchIndexEntryId),
          eq(searchIndexEntries.projectionVersion, row.projectionVersion),
        ),
      )
      .returning({ searchIndexEntryId: searchIndexEntries.searchIndexEntryId });
    const updated = yield* update.execute.bind(update)().pipe(Effect.mapError(unavailable));
    return updated.length;
  });

  const repairDerivedRepresentationTransaction = Effect.fn(
    'CoreSearchPersistence.repairDerivedRepresentationTransaction',
  )(function* repairDerivedRepresentationTransactionEffect(
    transaction: CoreTransaction,
    request: CoreSearchDerivedRepairRequest,
  ) {
    yield* installTenantScope(transaction, request.tenantId);
    const limit = request.limit ?? CORE_SEARCH_LABEL_REFRESH_PAGE_LIMIT;
    const lower = Option.flatMap(decodeCoreSearchLabelRefreshCursorOption)(request.cursor);
    if (Option.isSome(request.cursor) && (Option.isNone(lower) || lower.value[0] !== request.resourceType)) {
      return yield* invalid('Core Search stamp repair cursor is not canonical for its resource type');
    }
    const cursorId = Option.map(cursorResourceIdOfTuple)(lower);
    const select = transaction
      .select()
      .from(searchIndexEntries)
      .where(
        and(
          eq(searchIndexEntries.deleted, false),
          eq(searchIndexEntries.sourceModuleKey, request.moduleId),
          eq(searchIndexEntries.sourceResourceType, request.resourceType),
          eq(searchIndexEntries.tenantId, request.tenantId),
          Option.getOrUndefined(Option.map((id: string) => gt(searchIndexEntries.sourceResourceId, id))(cursorId)),
        ),
      )
      .orderBy(asc(searchIndexEntries.sourceResourceId))
      .limit(limit + 1)
      .for('update');
    const rows = yield* select.execute.bind(select)().pipe(Effect.mapError(unavailable));
    const pageRows = rows.slice(0, limit);
    const repaired = yield* Effect.reduce(
      pageRows,
      () => 0,
      (count, row) => Effect.map(repairPersistedRow(transaction, row), (delta) => count + delta),
    );
    const complete = rows.length <= limit;
    const last = pageRows.at(-1);
    const result: CoreSearchDerivedRepairResult = {
      complete,
      cursor:
        complete || last === undefined
          ? Option.none()
          : Option.some(coreSearchDerivedRepairCursor(request.resourceType, last.sourceResourceId)),
      repaired,
      resweep: request.resweep === true,
      scanned: pageRows.length,
    };
    return result;
  });

  /** Decode the phase cursor and reject one that does not belong to this resource type. */
  const repairCursorId = Effect.fn('CoreSearchPersistence.repairCursorId')(function* repairCursorIdEffect(
    job: CoreSearchDerivedRepairJob,
  ) {
    const cursor = repairPhaseCursor(job);
    if (Option.isNone(cursor)) {
      return Option.none<string>();
    }
    const decoded = decodeCoreSearchLabelRefreshCursorOption(cursor.value);
    if (Option.isNone(decoded) || decoded.value[0] !== job.resourceType) {
      return yield* invalid('Core Search stamp repair cursor is not canonical for its resource type');
    }
    return Option.some(decoded.value[1]);
  });

  const openDerivedRepairJobTransaction = Effect.fn('CoreSearchPersistence.openDerivedRepairJobTransaction')(
    function* openDerivedRepairJobTransactionEffect(
      transaction: CoreTransaction,
      open: CoreSearchDerivedRepairOpen,
      updatedAt: Date,
    ) {
      yield* installTenantScope(transaction, open.tenantId);
      const existingQuery = transaction
        .select()
        .from(searchDerivedRepairJobs)
        .where(
          and(
            eq(searchDerivedRepairJobs.tenantId, open.tenantId),
            eq(searchDerivedRepairJobs.sourceModuleKey, open.moduleId),
            eq(searchDerivedRepairJobs.sourceResourceType, open.resourceType),
          ),
        )
        .for('update')
        .limit(1);
      const existingRows = yield* existingQuery.execute.bind(existingQuery)().pipe(Effect.mapError(unavailable));
      const [existing] = existingRows;
      const persisted = existing === undefined ? Option.none<CoreSearchDerivedRepairJob>() : repairJobFromRow(existing);
      if (existing !== undefined && Option.isNone(persisted)) {
        return yield* unavailable();
      }
      // Both stores apply the one planner, so their ordinary-resume and restart semantics cannot drift.
      const plan = planCoreSearchDerivedRepairReopen(open, persisted);
      if (plan.kind === 'stale') {
        return yield* invalid('Core Search stamp repair restart request is stale');
      }
      if (plan.kind === 'resume') {
        return plan.job;
      }
      if (plan.kind === 'create') {
        // A lost race on the first open must resume the winner, never fail the request.
        const insert = transaction
          .insert(searchDerivedRepairJobs)
          .values({
            casVersion: BigInt(plan.job.casVersion),
            cursor: null,
            epoch: BigInt(plan.job.epoch),
            sourceModuleKey: open.moduleId,
            sourceResourceType: open.resourceType,
            state: plan.job.state,
            sweepCursor: null,
            tenantId: open.tenantId,
            updatedAt,
          })
          .onConflictDoNothing()
          .returning();
        const inserted = yield* insert.execute.bind(insert)().pipe(Effect.mapError(unavailable));
        const [created] = inserted;
        if (created === undefined) {
          const racedRows = yield* existingQuery.execute.bind(existingQuery)().pipe(Effect.mapError(unavailable));
          const [raced] = racedRows;
          const job = raced === undefined ? Option.none<CoreSearchDerivedRepairJob>() : repairJobFromRow(raced);
          if (Option.isNone(job)) {
            return yield* unavailable();
          }
          return job.value;
        }
        const job = repairJobFromRow(created);
        if (Option.isNone(job)) {
          return yield* unavailable();
        }
        return job.value;
      }
      // `advance`: compare-and-set on the exact observed generation. The row lock plus this predicate
      // means a delayed duplicate restart can never reset a campaign that already moved on.
      const expected = open.expectedGeneration;
      if (expected === undefined) {
        return yield* unavailable();
      }
      const update = transaction
        .update(searchDerivedRepairJobs)
        .set({
          casVersion: BigInt(plan.job.casVersion),
          cursor: null,
          epoch: BigInt(plan.job.epoch),
          state: plan.job.state,
          sweepCursor: null,
          updatedAt,
        })
        .where(
          and(
            repairJobIdentityWhere(plan.job),
            eq(searchDerivedRepairJobs.epoch, BigInt(expected.epoch)),
            eq(searchDerivedRepairJobs.casVersion, BigInt(expected.casVersion)),
          ),
        )
        .returning();
      const updated = yield* update.execute.bind(update)().pipe(Effect.mapError(unavailable));
      const [advanced] = updated;
      if (advanced === undefined) {
        return yield* invalid('Core Search stamp repair restart request is stale');
      }
      const job = repairJobFromRow(advanced);
      if (Option.isNone(job)) {
        return yield* unavailable();
      }
      return job.value;
    },
  );

  const readDerivedRepairPageTransaction = Effect.fn('CoreSearchPersistence.readDerivedRepairPageTransaction')(
    function* readDerivedRepairPageTransactionEffect(
      transaction: CoreTransaction,
      query: CoreSearchDerivedRepairCommit,
    ) {
      yield* installTenantScope(transaction, query.job.tenantId);
      const storedQuery = transaction
        .select()
        .from(searchDerivedRepairJobs)
        .where(repairJobIdentityWhere(query.job))
        .limit(1);
      const storedRows = yield* storedQuery.execute.bind(storedQuery)().pipe(Effect.mapError(unavailable));
      const [storedRow] = storedRows;
      if (storedRow === undefined) {
        return yield* invalid(STAMP_REPAIR_TOKEN_SUPERSEDED);
      }
      const stored = repairJobFromRow(storedRow);
      if (
        Option.isNone(stored) ||
        stored.value.epoch !== query.job.epoch ||
        stored.value.casVersion !== query.job.casVersion
      ) {
        return yield* invalid(STAMP_REPAIR_TOKEN_SUPERSEDED);
      }
      if (stored.value.state === 'complete') {
        return { hasMore: false, pageEnd: Option.none(), resourceIds: [] } satisfies CoreSearchDerivedRepairScan;
      }
      const limit = query.limit ?? CORE_SEARCH_LABEL_REFRESH_PAGE_LIMIT;
      const cursorId = yield* repairCursorId(stored.value);
      const select = transaction
        .select({ resourceId: searchIndexEntries.sourceResourceId })
        .from(searchIndexEntries)
        .where(
          and(
            eq(searchIndexEntries.deleted, false),
            eq(searchIndexEntries.sourceModuleKey, stored.value.moduleId),
            eq(searchIndexEntries.sourceResourceType, stored.value.resourceType),
            eq(searchIndexEntries.tenantId, stored.value.tenantId),
            Option.getOrUndefined(Option.map((id: string) => gt(searchIndexEntries.sourceResourceId, id))(cursorId)),
          ),
        )
        .orderBy(asc(searchIndexEntries.sourceResourceId))
        .limit(limit + 1);
      const rows = yield* select.execute.bind(select)().pipe(Effect.mapError(unavailable));
      const page = rows.slice(0, limit);
      const last = page.at(-1)?.resourceId;
      const resourceIds = yield* Schema.decodeUnknownEffect(CoreSearchDerivedRepairResourceIdsSchema)(
        page.map((row) => row.resourceId),
      ).pipe(
        Effect.mapError((cause) =>
          invalid('Core Search stamp repair page has a non-canonical resource identity', cause),
        ),
      );
      return {
        hasMore: rows.length > limit,
        pageEnd:
          last === undefined
            ? Option.none()
            : Option.some(coreSearchDerivedRepairCursor(stored.value.resourceType, last)),
        resourceIds,
      } satisfies CoreSearchDerivedRepairScan;
    },
  );

  const commitDerivedRepairPageTransaction = Effect.fn('CoreSearchPersistence.commitDerivedRepairPageTransaction')(
    function* commitDerivedRepairPageTransactionEffect(
      transaction: CoreTransaction,
      commit: CoreSearchDerivedRepairCommit,
      updatedAt: Date,
    ) {
      yield* installTenantScope(transaction, commit.job.tenantId);
      const storedQuery = transaction
        .select()
        .from(searchDerivedRepairJobs)
        .where(repairJobIdentityWhere(commit.job))
        .for('update')
        .limit(1);
      const storedRows = yield* storedQuery.execute.bind(storedQuery)().pipe(Effect.mapError(unavailable));
      const [storedRow] = storedRows;
      if (storedRow === undefined) {
        return yield* invalid(STAMP_REPAIR_TOKEN_SUPERSEDED);
      }
      const stored = repairJobFromRow(storedRow);
      if (
        Option.isNone(stored) ||
        stored.value.epoch !== commit.job.epoch ||
        stored.value.casVersion !== commit.job.casVersion
      ) {
        return yield* invalid(STAMP_REPAIR_TOKEN_SUPERSEDED);
      }
      if (stored.value.state === 'complete') {
        return { job: stored.value, repaired: 0, scanned: 0 } satisfies CoreSearchDerivedRepairProgress;
      }
      const limit = commit.limit ?? CORE_SEARCH_LABEL_REFRESH_PAGE_LIMIT;
      const cursorId = yield* repairCursorId(stored.value);
      const select = transaction
        .select()
        .from(searchIndexEntries)
        .where(
          and(
            eq(searchIndexEntries.deleted, false),
            eq(searchIndexEntries.sourceModuleKey, stored.value.moduleId),
            eq(searchIndexEntries.sourceResourceType, stored.value.resourceType),
            eq(searchIndexEntries.tenantId, stored.value.tenantId),
            Option.getOrUndefined(Option.map((id: string) => gt(searchIndexEntries.sourceResourceId, id))(cursorId)),
          ),
        )
        .orderBy(asc(searchIndexEntries.sourceResourceId))
        .limit(limit + 1)
        .for('update');
      const rows = yield* select.execute.bind(select)().pipe(Effect.mapError(unavailable));
      const pageRows = rows.slice(0, limit);
      const repaired = yield* Effect.reduce(
        pageRows,
        () => 0,
        (count, row) => Effect.map(repairPersistedRow(transaction, row), (delta) => count + delta),
      );
      const last = pageRows.at(-1)?.sourceResourceId;
      const pageEnd =
        last === undefined
          ? Option.none()
          : Option.some(coreSearchDerivedRepairCursor(stored.value.resourceType, last));
      const advance = advanceRefreshJobRow(stored.value, pageEnd);
      const update = transaction
        .update(searchDerivedRepairJobs)
        .set({
          casVersion: storedRow.casVersion + 1n,
          cursor: advance.cursor,
          state: advance.state,
          sweepCursor: advance.sweepCursor,
          updatedAt,
        })
        .where(and(repairJobIdentityWhere(commit.job), eq(searchDerivedRepairJobs.casVersion, storedRow.casVersion)))
        .returning();
      const updated = yield* update.execute.bind(update)().pipe(Effect.mapError(unavailable));
      const [advanced] = updated;
      if (advanced === undefined) {
        return yield* invalid(STAMP_REPAIR_TOKEN_SUPERSEDED);
      }
      const nextJob = repairJobFromRow(advanced);
      if (Option.isNone(nextJob)) {
        return yield* unavailable();
      }
      return { job: nextJob.value, repaired, scanned: pageRows.length } satisfies CoreSearchDerivedRepairProgress;
    },
  );

  return Object.freeze({
    applyBatchTransaction,
    applyMutationTransaction,
    commitDerivedRepairPageTransaction,
    commitLabelRefreshPageTransaction,
    decodeMutation,
    decodeReplacement,
    openDerivedRepairJobTransaction,
    openLabelRefreshTransaction,
    queryCandidatesTransaction,
    queryDependentsTransaction,
    readDerivedRepairPageTransaction,
    readLabelRefreshPageTransaction,
    repairDerivedRepresentationTransaction,
    replaceProjectionTransaction,
  });
};

export const makePostgresCoreSearchProjectionStore = (
  database: CoreSearchPersistenceDatabase,
  databaseIdentities: DatabaseIdentityEnrollment,
): CoreSearchProjectionStoreService & CoreSearchProjectionRefreshStoreService => {
  const transactionOperations = makeTransactionOperations(databaseIdentities);
  const runTransaction = <Value, Failure>(body: (transaction: CoreTransaction) => Effect.Effect<Value, Failure>) =>
    database.executor.transaction(body).pipe(
      Effect.catchDefect((defect) => (isSqlError(defect) ? Effect.fail(defect) : Effect.die(defect))),
      Effect.catchTag('SqlError', (failure) => Effect.fail(unavailable(failure))),
    );
  const apply: CoreSearchProjectionStoreService['apply'] = Effect.fn('CoreSearchProjectionStore.applyPostgres')(
    function* applyCoreSearchProjection(input: CoreSearchProjectionInput, context: OutboxWorkerHandlerContext) {
      const mutation = yield* transactionOperations.decodeMutation(input);
      const ref = mutation.kind === 'upsert' ? mutation.document.ref : mutation.ref;
      yield* validateCoreSearchProjectionWorkerContext(context, ref);
      const updatedAt = DateTime.toDateUtc(yield* DateTime.now);
      const transactionBody = Effect.fn('CoreSearchProjectionStore.applyFencedTransaction')(
        function* applyFencedProjectionTransaction(transaction: CoreTransaction) {
          yield* lockApplicationCompositionAuthority(transaction, context.compositionRevision, 'worker').pipe(
            Effect.mapError(unavailable),
          );
          return yield* transactionOperations.applyMutationTransaction(transaction, mutation, updatedAt);
        },
      );
      yield* runTransaction(transactionBody);
    },
  );
  const queryCandidates: CoreSearchProjectionStoreService['queryCandidates'] = Effect.fn(
    'CoreSearchProjectionStore.queryCandidatesPostgres',
  )(function* queryCoreSearchCandidates(input: CoreSearchQuery, scope: OperationalScope) {
    const transactionBody = (transaction: CoreTransaction) =>
      transactionOperations.queryCandidatesTransaction(transaction, input, scope);
    const documents = yield* runTransaction(transactionBody);
    return yield* Schema.decodeEffect(Schema.Array(CoreSearchProjectionDocumentSchema))(documents).pipe(
      Effect.mapError(unavailable),
    );
  });
  const replace: CoreSearchProjectionStoreService['replace'] = Effect.fn('CoreSearchProjectionStore.replacePostgres')(
    function* replaceCoreSearchProjection(input: CoreSearchProjectionInput, context: OutboxWorkerHandlerContext) {
      const replacement = yield* transactionOperations.decodeReplacement(input);
      yield* validateCoreSearchProjectionWorkerContext(context, replacement);
      const updatedAt = DateTime.toDateUtc(yield* DateTime.now);
      const transactionBody = Effect.fn('CoreSearchProjectionStore.replaceFencedTransaction')(
        function* replaceFencedProjectionTransaction(transaction: CoreTransaction) {
          yield* lockApplicationCompositionAuthority(transaction, context.compositionRevision, 'worker').pipe(
            Effect.mapError(unavailable),
          );
          return yield* transactionOperations.replaceProjectionTransaction(transaction, replacement, updatedAt);
        },
      );
      yield* runTransaction(transactionBody);
    },
  );
  const applyBatch: CoreSearchProjectionRefreshStoreService['applyBatch'] = Effect.fn(
    'CoreSearchProjectionStore.applyBatchPostgres',
  )(function* applyCoreSearchProjectionBatch(input: CoreSearchProjectionInput, context: OutboxWorkerHandlerContext) {
    const batch = yield* decodeCoreSearchProjectionBatch(input);
    yield* validateCoreSearchProjectionRefreshWorkerContext(context, batch);
    const updatedAt = DateTime.toDateUtc(yield* DateTime.now);
    const transactionBody = Effect.fn('CoreSearchProjectionStore.applyBatchFencedTransaction')(
      function* applyFencedBatch(transaction: CoreTransaction) {
        yield* lockApplicationCompositionAuthority(transaction, context.compositionRevision, 'worker').pipe(
          Effect.mapError(unavailable),
        );
        yield* transactionOperations.applyBatchTransaction(transaction, batch, updatedAt);
      },
    );
    yield* runTransaction(transactionBody);
  });
  const queryDependents: CoreSearchProjectionRefreshStoreService['queryDependents'] = Effect.fn(
    'CoreSearchProjectionStore.queryDependentsPostgres',
  )(function* queryCoreSearchDependents(input: CoreSearchProjectionInput, context: OutboxWorkerHandlerContext) {
    const query = yield* decodeCoreSearchProjectionDependentQuery(input);
    yield* validateCoreSearchProjectionRefreshWorkerContext(context, query);
    const transactionBody = Effect.fn('CoreSearchProjectionStore.queryDependentsFencedTransaction')(
      function* readFencedDependencies(transaction: CoreTransaction) {
        yield* lockApplicationCompositionAuthority(transaction, context.compositionRevision, 'worker').pipe(
          Effect.mapError(unavailable),
        );
        return yield* transactionOperations.queryDependentsTransaction(transaction, query);
      },
    );
    return yield* runTransaction(transactionBody);
  });
  const openLabelRefresh: CoreSearchProjectionRefreshStoreService['openLabelRefresh'] = Effect.fn(
    'CoreSearchProjectionStore.openLabelRefreshPostgres',
  )(function* openCoreSearchLabelRefresh(input, context) {
    const open = yield* decodeCoreSearchLabelRefreshOpen(input);
    yield* validateCoreSearchProjectionRefreshWorkerContext(context, open);
    const updatedAt = DateTime.toDateUtc(yield* DateTime.now);
    const transactionBody = Effect.fn('CoreSearchProjectionStore.openLabelRefreshFencedTransaction')(
      function* openLabelRefreshFencedTransaction(transaction: CoreTransaction) {
        yield* lockApplicationCompositionAuthority(transaction, context.compositionRevision, 'worker').pipe(
          Effect.mapError(unavailable),
        );
        return yield* transactionOperations.openLabelRefreshTransaction(transaction, open, updatedAt);
      },
    );
    return yield* runTransaction(transactionBody);
  });
  const readLabelRefreshPage: CoreSearchProjectionRefreshStoreService['readLabelRefreshPage'] = Effect.fn(
    'CoreSearchProjectionStore.readLabelRefreshPagePostgres',
  )(function* readCoreSearchLabelRefreshPage(input, context) {
    const query = yield* decodeCoreSearchLabelRefreshPageQuery(input);
    yield* validateCoreSearchProjectionRefreshWorkerContext(context, query.job);
    const transactionBody = Effect.fn('CoreSearchProjectionStore.readLabelRefreshPageFencedTransaction')(
      function* readLabelRefreshPageFencedTransaction(transaction: CoreTransaction) {
        yield* lockApplicationCompositionAuthority(transaction, context.compositionRevision, 'worker').pipe(
          Effect.mapError(unavailable),
        );
        return yield* transactionOperations.readLabelRefreshPageTransaction(transaction, query);
      },
    );
    return yield* runTransaction(transactionBody);
  });
  const commitLabelRefreshPage: CoreSearchProjectionRefreshStoreService['commitLabelRefreshPage'] = Effect.fn(
    'CoreSearchProjectionStore.commitLabelRefreshPagePostgres',
  )(function* commitCoreSearchLabelRefreshPage(input, context) {
    const commit = yield* decodeCoreSearchLabelRefreshCommit(input);
    yield* validateCoreSearchProjectionRefreshWorkerContext(context, commit.job);
    const updatedAt = DateTime.toDateUtc(yield* DateTime.now);
    const transactionBody = Effect.fn('CoreSearchProjectionStore.commitLabelRefreshPageFencedTransaction')(
      function* commitLabelRefreshPageFencedTransaction(transaction: CoreTransaction) {
        yield* lockApplicationCompositionAuthority(transaction, context.compositionRevision, 'worker').pipe(
          Effect.mapError(unavailable),
        );
        return yield* transactionOperations.commitLabelRefreshPageTransaction(transaction, commit, updatedAt);
      },
    );
    return yield* runTransaction(transactionBody);
  });
  const repairDerivedRepresentation: CoreSearchProjectionRefreshStoreService['repairDerivedRepresentation'] = Effect.fn(
    'CoreSearchProjectionStore.repairDerivedRepresentationPostgres',
  )(function* repairCoreSearchDerivedRepresentation(input, context) {
    const request = yield* decodeCoreSearchDerivedRepairRequest(input);
    yield* validateCoreSearchProjectionRefreshWorkerContext(context, request);
    const transactionBody = Effect.fn('CoreSearchProjectionStore.repairDerivedRepresentationFencedTransaction')(
      function* repairDerivedRepresentationFencedTransaction(transaction: CoreTransaction) {
        yield* lockApplicationCompositionAuthority(transaction, context.compositionRevision, 'worker').pipe(
          Effect.mapError(unavailable),
        );
        return yield* transactionOperations.repairDerivedRepresentationTransaction(transaction, request);
      },
    );
    return yield* runTransaction(transactionBody);
  });
  const openDerivedRepairJob: CoreSearchProjectionRefreshStoreService['openDerivedRepairJob'] = Effect.fn(
    'CoreSearchProjectionStore.openDerivedRepairJobPostgres',
  )(function* openCoreSearchDerivedRepairJob(input, context) {
    const open = yield* decodeCoreSearchDerivedRepairOpen(input);
    yield* validateCoreSearchProjectionRefreshWorkerContext(context, open);
    const updatedAt = DateTime.toDateUtc(yield* DateTime.now);
    const transactionBody = Effect.fn('CoreSearchProjectionStore.openDerivedRepairJobFencedTransaction')(
      function* openDerivedRepairJobFencedTransaction(transaction: CoreTransaction) {
        yield* lockApplicationCompositionAuthority(transaction, context.compositionRevision, 'worker').pipe(
          Effect.mapError(unavailable),
        );
        return yield* transactionOperations.openDerivedRepairJobTransaction(transaction, open, updatedAt);
      },
    );
    return yield* runTransaction(transactionBody);
  });
  const readDerivedRepairPage: CoreSearchProjectionRefreshStoreService['readDerivedRepairPage'] = Effect.fn(
    'CoreSearchProjectionStore.readDerivedRepairPagePostgres',
  )(function* readCoreSearchDerivedRepairPage(input, context) {
    const query = yield* decodeCoreSearchDerivedRepairCommit(input);
    yield* validateCoreSearchProjectionRefreshWorkerContext(context, query.job);
    const transactionBody = Effect.fn('CoreSearchProjectionStore.readDerivedRepairPageFencedTransaction')(
      function* readDerivedRepairPageFencedTransaction(transaction: CoreTransaction) {
        yield* lockApplicationCompositionAuthority(transaction, context.compositionRevision, 'worker').pipe(
          Effect.mapError(unavailable),
        );
        return yield* transactionOperations.readDerivedRepairPageTransaction(transaction, query);
      },
    );
    return yield* runTransaction(transactionBody);
  });
  const commitDerivedRepairPage: CoreSearchProjectionRefreshStoreService['commitDerivedRepairPage'] = Effect.fn(
    'CoreSearchProjectionStore.commitDerivedRepairPagePostgres',
  )(function* commitCoreSearchDerivedRepairPage(input, context) {
    const commit = yield* decodeCoreSearchDerivedRepairCommit(input);
    yield* validateCoreSearchProjectionRefreshWorkerContext(context, commit.job);
    const updatedAt = DateTime.toDateUtc(yield* DateTime.now);
    const transactionBody = Effect.fn('CoreSearchProjectionStore.commitDerivedRepairPageFencedTransaction')(
      function* commitDerivedRepairPageFencedTransaction(transaction: CoreTransaction) {
        yield* lockApplicationCompositionAuthority(transaction, context.compositionRevision, 'worker').pipe(
          Effect.mapError(unavailable),
        );
        return yield* transactionOperations.commitDerivedRepairPageTransaction(transaction, commit, updatedAt);
      },
    );
    return yield* runTransaction(transactionBody);
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

export const CoreSearchProjectionStoreLive = Layer.effect(
  CoreSearchProjectionStore,
  Effect.gen(function* makeCoreSearchProjectionStoreLive() {
    const database = yield* CoreDatabase;
    const databaseIdentities = yield* DatabaseIdentityEnrollmentContext;
    return makePostgresCoreSearchProjectionStore(database, databaseIdentities);
  }),
);

export const CoreSearchProjectionRefreshStoreLive = Layer.effect(
  CoreSearchProjectionRefreshStore,
  Effect.gen(function* makeCoreSearchProjectionRefreshStoreLive() {
    const database = yield* CoreDatabase;
    const databaseIdentities = yield* DatabaseIdentityEnrollmentContext;
    return makePostgresCoreSearchProjectionStore(database, databaseIdentities);
  }),
);

/** Query layer exposes its store requirement for composition at the application boundary. */
export const CoreSearchQueryRuntimeLive = Layer.effect(CoreSearchQueryRuntime, createCoreSearchQueryRuntime);
