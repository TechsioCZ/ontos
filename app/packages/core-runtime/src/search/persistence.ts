/* oxlint-disable react-doctor/async-await-in-loop, sonarjs/no-nested-functions, typescript/return-await */
// @effect-diagnostics asyncFunction:off globalDate:off preferSchemaOverJson:off
/* eslint-disable no-await-in-loop, anti-slop/no-conditional-empty-object-spread, anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters -- Rebuild writes must remain sequential in one transaction; canonical JSON and optional fields are private persistence mechanics. */
import { eq, sql } from 'drizzle-orm';
import { Effect, Layer, Schema } from 'effect';
import { CoreDatabase } from '../db/client.ts';
import { searchIndexEntries, searchProjectionRebuilds } from '../db/schema.ts';
import type { CoreTransaction } from '../db/types.ts';
import { CorePersistenceLive } from '../runtime-infrastructure.ts';
import {
  CoreSearchAliasSchema,
  CoreSearchFacetSchema,
  CoreSearchMetadataFieldSchema,
  CoreSearchProjectionInvalid,
  CoreSearchProjectionStore,
  CoreSearchProjectionUnavailable,
  CoreSearchQueryRuntime,
  CoreSearchResourceRefSchema,
  CoreSearchTemporalFacetSchema,
  CoreSearchTemporalSearchableTextSchema,
  decodeCoreSearchProjectionMutation,
  decodeCoreSearchProjectionReplacement,
  coreSearchReplacementFingerprint,
  createCoreSearchQueryRuntime,
} from './projection.ts';
import type {
  CoreSearchProjectionDocument,
  CoreSearchProjectionMutation,
  CoreSearchProjectionReplacement,
  CoreSearchResourceRef,
  CoreSearchProjectionStoreService,
  CoreSearchQuery,
} from './projection.ts';

const PersistedDocumentPayloadSchema = Schema.Struct({
  aliases: Schema.optionalKey(Schema.Array(CoreSearchAliasSchema).check(Schema.isMaxLength(100))),
  archived: Schema.Boolean,
  facets: Schema.Array(CoreSearchFacetSchema),
  matchedRef: Schema.optionalKey(CoreSearchResourceRefSchema),
  matchedSubjectRef: Schema.optionalKey(CoreSearchResourceRefSchema),
  metadata: Schema.Array(CoreSearchMetadataFieldSchema),
  schemaVersion: Schema.Literal('1'),
  subjectRef: Schema.optionalKey(CoreSearchResourceRefSchema),
  temporalFacets: Schema.optionalKey(Schema.Array(CoreSearchTemporalFacetSchema)),
  temporalSearchableText: Schema.optionalKey(
    Schema.Array(CoreSearchTemporalSearchableTextSchema).check(Schema.isMaxLength(100)),
  ),
});
type PersistedDocumentPayload = typeof PersistedDocumentPayloadSchema.Type;

const invalid = (reason: string) =>
  new CoreSearchProjectionInvalid({ code: 'core_search_projection_invalid', reason });
const unavailable = () =>
  new CoreSearchProjectionUnavailable({
    code: 'core_search_projection_unavailable',
    reason: 'Core Search projection is temporarily unavailable',
  });

const normalize = (value: string): string => value.normalize('NFKC').toLocaleLowerCase('und');
const bodyText = (document: CoreSearchProjectionDocument): string =>
  [document.title, ...document.searchableText].map(normalize).join('\n');
const payload = (document: CoreSearchProjectionDocument): PersistedDocumentPayload => ({
  ...(document.aliases === undefined ? {} : { aliases: document.aliases }),
  archived: document.archived,
  facets: document.facets,
  ...(document.matchedRef === undefined ? {} : { matchedRef: document.matchedRef }),
  ...(document.matchedSubjectRef === undefined
    ? {}
    : { matchedSubjectRef: document.matchedSubjectRef }),
  metadata: document.metadata,
  schemaVersion: '1',
  ...(document.subjectRef === undefined ? {} : { subjectRef: document.subjectRef }),
  ...(document.temporalFacets === undefined ? {} : { temporalFacets: document.temporalFacets }),
  ...(document.temporalSearchableText === undefined
    ? {}
    : { temporalSearchableText: document.temporalSearchableText }),
});

const stableJson = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
};
const rowMatchesDocument = (
  row: typeof searchIndexEntries.$inferSelect,
  document: CoreSearchProjectionDocument,
): boolean =>
  !row.deleted &&
  row.legalEntityId === (document.selectedLegalEntityId ?? null) &&
  row.title === document.title &&
  row.bodyText === bodyText(document) &&
  stableJson(row.facetsJson) === stableJson(payload(document));

const installTenantScope = async (
  transaction: CoreTransaction,
  tenantId: string,
  legalEntityId?: string,
): Promise<void> => {
  const result = await transaction.execute<{ legal_entity_id: string; tenant_id: string }>(sql`
    select
      set_config('ontos.tenant_id', ${tenantId}, true) as tenant_id,
      set_config('ontos.legal_entity_id', ${legalEntityId ?? ''}, true) as legal_entity_id
  `);
  const [verified] = result.rows;
  if (verified?.tenant_id !== tenantId || verified.legal_entity_id !== (legalEntityId ?? '')) {
    throw unavailable();
  }
};

const lockProjectionUnit = (
  transaction: CoreTransaction,
  tenantId: string,
  moduleId: string,
  resourceType: string,
) =>
  transaction.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify([
      tenantId,
      moduleId,
      resourceType,
    ])}, 0))`,
  );

const currentRow = (transaction: CoreTransaction, ref: CoreSearchResourceRef) =>
  transaction.query.searchIndexEntries.findFirst({
    where: {
      sourceModuleKey: ref.moduleId,
      sourceResourceId: ref.resourceId,
      sourceResourceType: ref.resourceType,
      tenantId: ref.tenantId,
    },
  });

const currentRebuild = (
  transaction: CoreTransaction,
  unit: Readonly<{ moduleId: string; resourceType: string; tenantId: string }>,
) =>
  transaction.query.searchProjectionRebuilds.findFirst({
    where: {
      sourceModuleKey: unit.moduleId,
      sourceResourceType: unit.resourceType,
      tenantId: unit.tenantId,
    },
  });

const persistUpsert = async (
  transaction: CoreTransaction,
  document: CoreSearchProjectionDocument,
): Promise<void> => {
  const existing = await currentRow(transaction, document.ref);
  const version = BigInt(document.projectionVersion);
  if (existing !== undefined) {
    if (existing.projectionVersion > version) {
      return;
    }
    if (existing.projectionVersion === version) {
      if (!rowMatchesDocument(existing, document)) {
        throw invalid('Core Search mutation reuses a version for different content');
      }
      return;
    }
    await transaction
      .update(searchIndexEntries)
      .set({
        bodyText: bodyText(document),
        deleted: false,
        facetsJson: payload(document),
        legalEntityId: document.selectedLegalEntityId ?? null,
        projectionVersion: version,
        title: document.title,
        updatedAt: new Date(),
      })
      .where(eq(searchIndexEntries.searchIndexEntryId, existing.searchIndexEntryId));
    return;
  }
  await transaction.insert(searchIndexEntries).values({
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
};

const persistDelete = async (
  transaction: CoreTransaction,
  mutation: Extract<CoreSearchProjectionMutation, { readonly kind: 'delete' }>,
): Promise<void> => {
  const existing = await currentRow(transaction, mutation.ref);
  const version = BigInt(mutation.projectionVersion);
  if (existing !== undefined && existing.projectionVersion > version) {
    return;
  }
  if (existing !== undefined && existing.projectionVersion === version) {
    if (!existing.deleted) {
      throw invalid('Core Search mutation reuses a version for different content');
    }
    return;
  }
  if (existing === undefined) {
    await transaction.insert(searchIndexEntries).values({
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
    return;
  }
  await transaction
    .update(searchIndexEntries)
    .set({
      bodyText: '',
      deleted: true,
      facetsJson: { schemaVersion: '1' },
      legalEntityId: null,
      projectionVersion: version,
      title: '',
      updatedAt: new Date(),
    })
    .where(eq(searchIndexEntries.searchIndexEntryId, existing.searchIndexEntryId));
};

const replaceProjection = async (
  transaction: CoreTransaction,
  replacement: CoreSearchProjectionReplacement,
): Promise<void> => {
  await lockProjectionUnit(
    transaction,
    replacement.tenantId,
    replacement.moduleId,
    replacement.resourceType,
  );
  const prior = await currentRebuild(transaction, replacement);
  const version = BigInt(replacement.rebuildVersion);
  const fingerprint = coreSearchReplacementFingerprint(replacement);
  if (prior !== undefined) {
    if (version < prior.rebuildVersion) {
      return;
    }
    if (version === prior.rebuildVersion) {
      if (fingerprint !== prior.fingerprint) {
        throw invalid('Core Search rebuild reuses a version for different content');
      }
      return;
    }
  }
  const existing = await transaction.query.searchIndexEntries.findMany({
    where: {
      sourceModuleKey: replacement.moduleId,
      sourceResourceType: replacement.resourceType,
      tenantId: replacement.tenantId,
    },
  });
  for (const document of replacement.documents) {
    await persistUpsert(transaction, document);
  }
  const nextIds = new Set(replacement.documents.map(({ ref }) => ref.resourceId));
  for (const row of existing) {
    if (
      !nextIds.has(row.sourceResourceId) &&
      row.projectionVersion < BigInt(replacement.rebuildVersion)
    ) {
      await persistDelete(transaction, {
        kind: 'delete',
        projectionVersion: replacement.rebuildVersion,
        ref: {
          moduleId: row.sourceModuleKey,
          resourceId: row.sourceResourceId,
          resourceType: row.sourceResourceType,
          tenantId: row.tenantId,
        },
      });
    }
  }
  await transaction
    .insert(searchProjectionRebuilds)
    .values({
      fingerprint,
      rebuildVersion: version,
      sourceModuleKey: replacement.moduleId,
      sourceResourceType: replacement.resourceType,
      tenantId: replacement.tenantId,
    })
    .onConflictDoUpdate({
      set: { fingerprint, rebuildVersion: version, updatedAt: new Date() },
      target: [
        searchProjectionRebuilds.tenantId,
        searchProjectionRebuilds.sourceModuleKey,
        searchProjectionRebuilds.sourceResourceType,
      ],
    });
};

const decodeRow = (row: typeof searchIndexEntries.$inferSelect): CoreSearchProjectionDocument => {
  const decoded = Schema.decodeUnknownSync(PersistedDocumentPayloadSchema, {
    onExcessProperty: 'error',
  })(row.facetsJson);
  return {
    ...(decoded.aliases === undefined ? {} : { aliases: decoded.aliases }),
    archived: decoded.archived,
    facets: decoded.facets,
    ...(decoded.matchedRef === undefined ? {} : { matchedRef: decoded.matchedRef }),
    ...(decoded.matchedSubjectRef === undefined
      ? {}
      : { matchedSubjectRef: decoded.matchedSubjectRef }),
    metadata: decoded.metadata,
    projectionVersion: row.projectionVersion.toString(),
    ref: {
      moduleId: row.sourceModuleKey,
      resourceId: row.sourceResourceId,
      resourceType: row.sourceResourceType,
      tenantId: row.tenantId,
    },
    searchableText: [row.bodyText],
    ...(row.legalEntityId === null ? {} : { selectedLegalEntityId: row.legalEntityId }),
    ...(decoded.subjectRef === undefined ? {} : { subjectRef: decoded.subjectRef }),
    ...(decoded.temporalFacets === undefined ? {} : { temporalFacets: decoded.temporalFacets }),
    ...(decoded.temporalSearchableText === undefined
      ? {}
      : { temporalSearchableText: decoded.temporalSearchableText }),
    title: row.title,
  };
};

export const makePostgresCoreSearchProjectionStore = (
  database: (typeof CoreDatabase)['Service'],
): CoreSearchProjectionStoreService => ({
  apply: (input) =>
    Effect.try({
      catch: (error) =>
        Schema.is(CoreSearchProjectionInvalid)(error)
          ? error
          : invalid('Core Search mutation does not match its declared contract'),
      try: () => decodeCoreSearchProjectionMutation(input),
    }).pipe(
      Effect.flatMap((mutation) =>
        Effect.tryPromise({
          catch: (error) => (Schema.is(CoreSearchProjectionInvalid)(error) ? error : unavailable()),
          try: async () =>
            database.executor.transaction(async (transaction) => {
              const ref = mutation.kind === 'upsert' ? mutation.document.ref : mutation.ref;
              await installTenantScope(transaction, ref.tenantId);
              await lockProjectionUnit(transaction, ref.tenantId, ref.moduleId, ref.resourceType);
              const rebuild = await currentRebuild(transaction, ref);
              const version = BigInt(
                mutation.kind === 'upsert'
                  ? mutation.document.projectionVersion
                  : mutation.projectionVersion,
              );
              if (rebuild !== undefined && version <= rebuild.rebuildVersion) {
                return;
              }
              await (mutation.kind === 'upsert'
                ? persistUpsert(transaction, mutation.document)
                : persistDelete(transaction, mutation));
            }),
        }),
      ),
    ),
  queryCandidates: (input: CoreSearchQuery) =>
    Effect.tryPromise({
      catch: () => unavailable(),
      try: async () =>
        database.executor.transaction(async (transaction) => {
          await installTenantScope(transaction, input.tenantId, input.selectedLegalEntityId);
          const rows = await transaction.query.searchIndexEntries.findMany({
            // Match the bounded rebuild unit; never silently truncate before evidence filtering.
            limit: 10_001,
            orderBy: (table, { asc }) => [asc(table.title), asc(table.sourceResourceId)],
            where: {
              deleted: false,
              legalEntityId: input.selectedLegalEntityId ?? { isNull: true },
              sourceModuleKey: input.moduleId,
              sourceResourceType: input.resourceType,
              tenantId: input.tenantId,
            },
          });
          if (rows.length > 10_000) {
            throw unavailable();
          }
          return rows.map(decodeRow);
        }),
    }),
  replace: (input) =>
    Effect.try({
      catch: (error) =>
        Schema.is(CoreSearchProjectionInvalid)(error)
          ? error
          : invalid('Core Search replacement does not match its declared contract'),
      try: () => decodeCoreSearchProjectionReplacement(input),
    }).pipe(
      Effect.flatMap((replacement) =>
        Effect.tryPromise({
          catch: (error) => (Schema.is(CoreSearchProjectionInvalid)(error) ? error : unavailable()),
          try: async () =>
            database.executor.transaction(async (transaction) => {
              await installTenantScope(transaction, replacement.tenantId);
              await replaceProjection(transaction, replacement);
            }),
        }),
      ),
    ),
});

export const CoreSearchProjectionStoreLive = Layer.effect(
  CoreSearchProjectionStore,
  Effect.gen(function* makeCoreSearchProjectionStoreLive() {
    const database = yield* CoreDatabase;
    return makePostgresCoreSearchProjectionStore(database);
  }),
).pipe(Layer.provide(CorePersistenceLive));

/** Fully composed production query layer; owner adapters never import Core database capabilities. */
export const CoreSearchQueryRuntimeLive = Layer.effect(
  CoreSearchQueryRuntime,
  Effect.gen(function* makeCoreSearchQueryRuntimeLive() {
    const store = yield* CoreSearchProjectionStore;
    return createCoreSearchQueryRuntime(store);
  }),
).pipe(Layer.provide(CoreSearchProjectionStoreLive));
