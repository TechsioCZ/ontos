import { eq, sql } from 'drizzle-orm';
import { DateTime, Effect, Layer, Option, Result, Schema } from 'effect';
import { isSqlError } from 'effect/unstable/sql/SqlError';

import { CoreDatabase } from '../db/client.ts';
import { searchIndexEntries, searchProjectionRebuilds } from '../db/schema.ts';
import type { CoreDatabaseExecutor, CoreTransaction } from '../db/types.ts';
import type {
  CoreSearchProjectionDocument,
  CoreSearchProjectionMutation,
  CoreSearchProjectionReplacement,
  CoreSearchProjectionStoreService,
  CoreSearchQuery,
  CoreSearchResourceRef,
} from './projection.ts';
import {
  CoreSearchAliasSchema,
  CoreSearchFacetSchema,
  CoreSearchMetadataFieldSchema,
  CoreSearchProjectionDocumentSchema,
  CoreSearchProjectionInvalid,
  CoreSearchProjectionStore,
  CoreSearchProjectionUnavailable,
  CoreSearchQueryRuntime,
  CoreSearchResourceRefSchema,
  CoreSearchTemporalFacetSchema,
  CoreSearchTemporalSearchableTextSchema,
  coreSearchReplacementFingerprint,
  createCoreSearchQueryRuntime,
  decodeCoreSearchProjectionMutation,
  decodeCoreSearchProjectionReplacement,
} from './projection.ts';

const PersistedDocumentPayloadSchema = Schema.Struct({
  aliases: Schema.optionalKey(
    Schema.Array(CoreSearchAliasSchema).check(Schema.isMaxLength(100))
  ),
  archived: Schema.Boolean,
  facets: Schema.Array(CoreSearchFacetSchema),
  matchedRef: Schema.optionalKey(CoreSearchResourceRefSchema),
  matchedSubjectRef: Schema.optionalKey(CoreSearchResourceRefSchema),
  metadata: Schema.Array(CoreSearchMetadataFieldSchema),
  schemaVersion: Schema.Literal('1'),
  subjectRef: Schema.optionalKey(CoreSearchResourceRefSchema),
  temporalFacets: Schema.optionalKey(
    Schema.Array(CoreSearchTemporalFacetSchema)
  ),
  temporalSearchableText: Schema.optionalKey(
    Schema.Array(CoreSearchTemporalSearchableTextSchema).check(
      Schema.isMaxLength(100)
    )
  ),
});
const ProjectionUnitKeySchema = Schema.fromJsonString(
  Schema.Tuple([Schema.String, Schema.String, Schema.String])
);

type PersistedDocumentPayload = typeof PersistedDocumentPayloadSchema.Type;
type MutablePersistedDocumentPayload = {
  -readonly [
    Key in keyof PersistedDocumentPayload
  ]: PersistedDocumentPayload[Key];
};
type CoreSearchPersistenceDatabase = Readonly<{
  executor: CoreDatabaseExecutor;
}>;
type CoreSearchProjectionInput = Parameters<
  CoreSearchProjectionStoreService['apply']
>[0];
type CoreSearchPersistenceCause = typeof Schema.Unknown.Type;
type SearchIndexEntry = typeof searchIndexEntries.$inferSelect;
interface PersistedDocumentInput {
  aliases?: PersistedDocumentPayload['aliases'];
  archived: boolean;
  facets: PersistedDocumentPayload['facets'];
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

const invalid = (
  reason: string,
  cause?: CoreSearchPersistenceCause
): CoreSearchProjectionInvalid =>
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

const normalize = (value: string): string =>
  value.normalize('NFKC').toLocaleLowerCase('und');
const bodyText = (document: CoreSearchProjectionDocument): string =>
  [document.title, ...document.searchableText].map(normalize).join('\n');
const payload = (
  document: CoreSearchProjectionDocument
): PersistedDocumentPayload => {
  const persisted: MutablePersistedDocumentPayload = {
    archived: document.archived,
    facets: document.facets,
    metadata: document.metadata,
    schemaVersion: '1',
  };
  if (document.aliases !== undefined) {
    persisted.aliases = document.aliases;
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

const persistedPayloadEquivalence = Schema.toEquivalence(
  PersistedDocumentPayloadSchema
);
const decodePersistedPayload = Schema.decodeUnknownResult(
  PersistedDocumentPayloadSchema,
  {
    onExcessProperty: 'error',
  }
);
const encodeProjectionUnitKey = Schema.encodeUnknownResult(
  ProjectionUnitKeySchema
);

const projectionUnitKey = (
  tenantId: string,
  moduleId: string,
  resourceType: string
): string =>
  Result.getOrThrow(
    encodeProjectionUnitKey([tenantId, moduleId, resourceType]).pipe(
      Result.mapError((cause) =>
        invalid('Core Search projection unit is invalid', cause)
      )
    )
  );

const rowMatchesDocument = (
  row: SearchIndexEntry,
  document: CoreSearchProjectionDocument
): Result.Result<boolean, CoreSearchProjectionInvalid> =>
  decodePersistedPayload(row.facetsJson).pipe(
    Result.map(
      (persistedPayload) =>
        !row.deleted &&
        row.legalEntityId === (document.selectedLegalEntityId ?? null) &&
        row.title === document.title &&
        row.bodyText === bodyText(document) &&
        persistedPayloadEquivalence(persistedPayload, payload(document))
    ),
    Result.mapError((cause) =>
      invalid('Core Search persisted payload is invalid', cause)
    )
  );

const makeTransactionOperations = () => {
  const installTenantScope = Effect.fn(
    'CoreSearchPersistence.installTenantScope'
  )(function* installTenantScopeEffect(
    transaction: CoreTransaction,
    tenantId: string,
    legalEntityId?: string
  ) {
    const result = yield* transaction
      .execute(
        sql`
        select
          set_config('ontos.tenant_id', ${tenantId}, true) as tenant_id,
          set_config('ontos.legal_entity_id', ${legalEntityId ?? ''}, true) as legal_entity_id
      `,
        'objects'
      )
      .pipe(Effect.mapError(unavailable));
    const verified = Schema.decodeUnknownOption(
      Schema.Struct({
        legal_entity_id: Schema.String,
        tenant_id: Schema.String,
      })
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

  const lockProjectionUnit = Effect.fn(
    'CoreSearchPersistence.lockProjectionUnit'
  )(function* lockProjectionUnitEffect(
    transaction: CoreTransaction,
    tenantId: string,
    moduleId: string,
    resourceType: string
  ) {
    yield* transaction
      .execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${projectionUnitKey(
          tenantId,
          moduleId,
          resourceType
        )}, 0))`
      )
      .pipe(Effect.mapError(unavailable));
  });

  const currentRow = Effect.fn('CoreSearchPersistence.currentRow')(
    function* currentRowEffect(
      transaction: CoreTransaction,
      ref: CoreSearchResourceRef
    ) {
      const query = transaction.query.searchIndexEntries.findFirst({
        where: {
          sourceModuleKey: ref.moduleId,
          sourceResourceId: ref.resourceId,
          sourceResourceType: ref.resourceType,
          tenantId: ref.tenantId,
        },
      });
      const row = yield* query.execute
        .bind(query)()
        .pipe(Effect.mapError(unavailable));
      return Option.fromNullishOr(row);
    }
  );

  const currentRebuild = Effect.fn('CoreSearchPersistence.currentRebuild')(
    function* currentRebuildEffect(
      transaction: CoreTransaction,
      unit: Readonly<{
        moduleId: string;
        resourceType: string;
        tenantId: string;
      }>
    ) {
      const query = transaction.query.searchProjectionRebuilds.findFirst({
        where: {
          sourceModuleKey: unit.moduleId,
          sourceResourceType: unit.resourceType,
          tenantId: unit.tenantId,
        },
      });
      const rebuild = yield* query.execute
        .bind(query)()
        .pipe(Effect.mapError(unavailable));
      return Option.fromNullishOr(rebuild);
    }
  );

  const persistUpsert = Effect.fn('CoreSearchPersistence.persistUpsert')(
    function* persistUpsertEffect(
      transaction: CoreTransaction,
      document: CoreSearchProjectionDocument,
      updatedAt: Date
    ) {
      const current = yield* currentRow(transaction, document.ref);
      const version = BigInt(document.projectionVersion);
      if (Option.isSome(current)) {
        const existing = current.value;
        if (existing.projectionVersion > version) {
          return yield* Effect.void;
        }
        if (existing.projectionVersion === version) {
          if (!Result.getOrThrow(rowMatchesDocument(existing, document))) {
            return yield* invalid(
              'Core Search mutation reuses a version for different content'
            );
          }
          return yield* Effect.void;
        }
        const query = transaction
          .update(searchIndexEntries)
          .set({
            bodyText: bodyText(document),
            deleted: false,
            facetsJson: payload(document),
            legalEntityId: document.selectedLegalEntityId ?? null,
            projectionVersion: version,
            title: document.title,
            updatedAt,
          })
          .where(
            eq(
              searchIndexEntries.searchIndexEntryId,
              existing.searchIndexEntryId
            )
          );
        yield* query.execute.bind(query)().pipe(Effect.mapError(unavailable));
        return yield* Effect.void;
      }
      const query = transaction.insert(searchIndexEntries).values({
        bodyText: bodyText(document),
        deleted: false,
        facetsJson: payload(document),
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
    }
  );

  const persistDelete = Effect.fn('CoreSearchPersistence.persistDelete')(
    function* persistDeleteEffect(
      transaction: CoreTransaction,
      mutation: Extract<
        CoreSearchProjectionMutation,
        { readonly kind: 'delete' }
      >,
      updatedAt: Date
    ) {
      const current = yield* currentRow(transaction, mutation.ref);
      const version = BigInt(mutation.projectionVersion);
      if (Option.isSome(current) && current.value.projectionVersion > version) {
        return yield* Effect.void;
      }
      if (
        Option.isSome(current) &&
        current.value.projectionVersion === version
      ) {
        if (!current.value.deleted) {
          return yield* invalid(
            'Core Search mutation reuses a version for different content'
          );
        }
        return yield* Effect.void;
      }
      if (Option.isNone(current)) {
        const query = transaction.insert(searchIndexEntries).values({
          bodyText: '',
          deleted: true,
          facetsJson: { schemaVersion: '1' },
          projectionVersion: version,
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
          facetsJson: { schemaVersion: '1' },
          legalEntityId: null,
          projectionVersion: version,
          title: '',
          updatedAt,
        })
        .where(
          eq(
            searchIndexEntries.searchIndexEntryId,
            current.value.searchIndexEntryId
          )
        );
      yield* query.execute.bind(query)().pipe(Effect.mapError(unavailable));
      return yield* Effect.void;
    }
  );

  const persistedDeleteMutation = (
    row: SearchIndexEntry,
    projectionVersion: string
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

  const persistRebuildFloor = Effect.fn(
    'CoreSearchPersistence.persistRebuildFloor'
  )(function* persistRebuildFloorEffect(
    transaction: CoreTransaction,
    replacement: CoreSearchProjectionReplacement,
    fingerprint: string,
    updatedAt: Date
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
  });

  const replacementRows = Effect.fn('CoreSearchPersistence.replacementRows')(
    function* replacementRowsEffect(
      transaction: CoreTransaction,
      replacement: CoreSearchProjectionReplacement
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
          return yield* invalid(
            'Core Search rebuild reuses a version for different content'
          );
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
      const existing = yield* query.execute
        .bind(query)()
        .pipe(Effect.mapError(unavailable));
      return Option.some({ existing, fingerprint });
    }
  );

  const replaceProjection = Effect.fn(
    'CoreSearchPersistence.replaceProjection'
  )(function* replaceProjectionEffect(
    transaction: CoreTransaction,
    replacement: CoreSearchProjectionReplacement,
    updatedAt: Date
  ) {
    yield* lockProjectionUnit(
      transaction,
      replacement.tenantId,
      replacement.moduleId,
      replacement.resourceType
    );
    const work = yield* replacementRows(transaction, replacement);
    if (Option.isNone(work)) {
      return;
    }
    const { existing, fingerprint } = work.value;
    yield* Effect.forEach(
      replacement.documents,
      (document) => persistUpsert(transaction, document, updatedAt),
      { concurrency: 1, discard: true }
    );
    const nextIds = new Set<string>(
      replacement.documents.map(({ ref }) => ref.resourceId)
    );
    const staleRows = existing.filter(
      (row) =>
        !nextIds.has(row.sourceResourceId) &&
        row.projectionVersion < BigInt(replacement.rebuildVersion)
    );
    yield* Effect.forEach(
      staleRows,
      (row) =>
        persistDelete(
          transaction,
          persistedDeleteMutation(row, replacement.rebuildVersion),
          updatedAt
        ),
      { concurrency: 1, discard: true }
    );
    yield* persistRebuildFloor(
      transaction,
      replacement,
      fingerprint,
      updatedAt
    );
  });

  const decodeRow = (row: SearchIndexEntry): CoreSearchProjectionDocument => {
    const decoded = Result.getOrThrow(
      decodePersistedPayload(row.facetsJson).pipe(
        Result.mapError((cause) =>
          invalid('Core Search persisted payload is invalid', cause)
        )
      )
    );
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
      searchableText: [row.bodyText],
      title: row.title,
    };
    if (decoded.aliases !== undefined) {
      document.aliases = decoded.aliases;
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
    const mutation = decodeCoreSearchProjectionMutation({
      document,
      kind: 'upsert',
    });
    if (mutation.kind !== 'upsert') {
      throw invalid('Core Search persisted document is invalid');
    }
    return mutation.document;
  };

  const decodeMutation = (input: CoreSearchProjectionInput) =>
    Effect.try({
      catch: (error) =>
        Schema.is(CoreSearchProjectionInvalid)(error)
          ? error
          : invalid(
              'Core Search mutation does not match its declared contract',
              error
            ),
      try: () => decodeCoreSearchProjectionMutation(input),
    });

  const decodeReplacement = (input: CoreSearchProjectionInput) =>
    Effect.try({
      catch: (error) =>
        Schema.is(CoreSearchProjectionInvalid)(error)
          ? error
          : invalid(
              'Core Search replacement does not match its declared contract',
              error
            ),
      try: () => decodeCoreSearchProjectionReplacement(input),
    });

  const applyMutationTransaction = Effect.fn(
    'CoreSearchPersistence.applyMutationTransaction'
  )(function* applyMutationTransactionEffect(
    transaction: CoreTransaction,
    mutation: CoreSearchProjectionMutation,
    updatedAt: Date
  ) {
    const ref =
      mutation.kind === 'upsert' ? mutation.document.ref : mutation.ref;
    yield* installTenantScope(transaction, ref.tenantId);
    yield* lockProjectionUnit(
      transaction,
      ref.tenantId,
      ref.moduleId,
      ref.resourceType
    );
    const rebuild = yield* currentRebuild(transaction, ref);
    const version = BigInt(
      mutation.kind === 'upsert'
        ? mutation.document.projectionVersion
        : mutation.projectionVersion
    );
    if (Option.isSome(rebuild) && version <= rebuild.value.rebuildVersion) {
      return;
    }
    if (mutation.kind === 'upsert') {
      yield* persistUpsert(transaction, mutation.document, updatedAt);
      return;
    }
    yield* persistDelete(transaction, mutation, updatedAt);
  });

  const queryCandidatesTransaction = Effect.fn(
    'CoreSearchPersistence.queryCandidatesTransaction'
  )(function* queryCandidatesTransactionEffect(
    transaction: CoreTransaction,
    input: CoreSearchQuery
  ) {
    yield* installTenantScope(
      transaction,
      input.tenantId,
      input.selectedLegalEntityId
    );
    const query = transaction.query.searchIndexEntries.findMany({
      // Match the bounded rebuild unit; never silently truncate before evidence filtering.
      limit: 10_001,
      orderBy: (table, { asc }) => [
        asc(table.title),
        asc(table.sourceResourceId),
      ],
      where: {
        deleted: false,
        legalEntityId: input.selectedLegalEntityId ?? { isNull: true },
        sourceModuleKey: input.moduleId,
        sourceResourceType: input.resourceType,
        tenantId: input.tenantId,
      },
    });
    const rows = yield* query.execute
      .bind(query)()
      .pipe(Effect.mapError(unavailable));
    if (rows.length > 10_000) {
      return yield* unavailable();
    }
    return rows.map(decodeRow);
  });

  const replaceProjectionTransaction = Effect.fn(
    'CoreSearchPersistence.replaceProjectionTransaction'
  )(function* replaceProjectionTransactionEffect(
    transaction: CoreTransaction,
    replacement: CoreSearchProjectionReplacement,
    updatedAt: Date
  ) {
    yield* installTenantScope(transaction, replacement.tenantId);
    yield* replaceProjection(transaction, replacement, updatedAt);
  });

  return Object.freeze({
    applyMutationTransaction,
    decodeMutation,
    decodeReplacement,
    queryCandidatesTransaction,
    replaceProjectionTransaction,
  });
};

const transactionOperations = makeTransactionOperations();

export const makePostgresCoreSearchProjectionStore = (
  database: CoreSearchPersistenceDatabase
): CoreSearchProjectionStoreService => {
  const runTransaction = <Value, Failure>(
    body: (transaction: CoreTransaction) => Effect.Effect<Value, Failure>
  ) =>
    database.executor.transaction(body).pipe(
      Effect.catchDefect((defect) =>
        isSqlError(defect) ? Effect.fail(defect) : Effect.die(defect)
      ),
      Effect.catchTag('SqlError', (failure) =>
        Effect.fail(unavailable(failure))
      )
    );
  const apply: CoreSearchProjectionStoreService['apply'] = Effect.fn(
    'CoreSearchProjectionStore.applyPostgres'
  )(function* applyCoreSearchProjection(input: CoreSearchProjectionInput) {
    const mutation = yield* transactionOperations.decodeMutation(input);
    const updatedAt = DateTime.toDateUtc(yield* DateTime.now);
    const transactionBody = (transaction: CoreTransaction) =>
      transactionOperations.applyMutationTransaction(
        transaction,
        mutation,
        updatedAt
      );
    yield* runTransaction(transactionBody);
  });
  const queryCandidates: CoreSearchProjectionStoreService['queryCandidates'] =
    Effect.fn('CoreSearchProjectionStore.queryCandidatesPostgres')(
      function* queryCoreSearchCandidates(input: CoreSearchQuery) {
        const transactionBody = (transaction: CoreTransaction) =>
          transactionOperations.queryCandidatesTransaction(transaction, input);
        const documents = yield* runTransaction(transactionBody);
        return yield* Schema.decodeEffect(
          Schema.Array(CoreSearchProjectionDocumentSchema)
        )(documents).pipe(Effect.mapError(unavailable));
      }
    );
  const replace: CoreSearchProjectionStoreService['replace'] = Effect.fn(
    'CoreSearchProjectionStore.replacePostgres'
  )(function* replaceCoreSearchProjection(input: CoreSearchProjectionInput) {
    const replacement = yield* transactionOperations.decodeReplacement(input);
    const updatedAt = DateTime.toDateUtc(yield* DateTime.now);
    const transactionBody = (transaction: CoreTransaction) =>
      transactionOperations.replaceProjectionTransaction(
        transaction,
        replacement,
        updatedAt
      );
    yield* runTransaction(transactionBody);
  });
  return Object.freeze({ apply, queryCandidates, replace });
};

export const CoreSearchProjectionStoreLive = Layer.effect(
  CoreSearchProjectionStore,
  Effect.gen(function* makeCoreSearchProjectionStoreLive() {
    const database = yield* CoreDatabase;
    return makePostgresCoreSearchProjectionStore(database);
  })
);

/** Query layer exposes its store requirement for composition at the application boundary. */
export const CoreSearchQueryRuntimeLive = Layer.effect(
  CoreSearchQueryRuntime,
  createCoreSearchQueryRuntime
);
