/* oxlint-disable react-doctor/js-combine-iterations */
// @effect-diagnostics preferSchemaOverJson:off schemaSyncInEffect:off nodeBuiltinImport:off
/* eslint-disable max-classes-per-file, anti-slop/no-conditional-empty-object-spread, anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters -- Public unknown inputs are decoded immediately by the declared schemas; canonical JSON and optional output fields are private representation mechanics. */
import { createHash } from 'node:crypto';
import { Clock, Context, Effect, Schema } from 'effect';

const boundedText = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300));
const stableKey = Schema.String.check(
  Schema.isMinLength(3),
  Schema.isMaxLength(200),
  Schema.isPattern(/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u),
);
const resourceId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300));
const tenantId = Schema.String.check(Schema.isUUID());
const projectionVersion = Schema.String.check(Schema.isPattern(/^[1-9][0-9]*$/u));

export const CoreSearchResourceRefSchema = Schema.Struct({
  moduleId: stableKey,
  resourceId,
  resourceType: stableKey,
  tenantId,
});
export type CoreSearchResourceRef = typeof CoreSearchResourceRefSchema.Type;

export const CoreSearchFacetSchema = Schema.Struct({
  key: stableKey,
  values: Schema.Array(boundedText).check(Schema.isMaxLength(50)),
});
export type CoreSearchFacet = typeof CoreSearchFacetSchema.Type;

export const CoreSearchMetadataFieldSchema = Schema.Union([
  Schema.Struct({ key: stableKey, kind: Schema.Literal('boolean'), value: Schema.Boolean }),
  Schema.Struct({ key: stableKey, kind: Schema.Literal('string'), value: boundedText }),
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
  matchedRef: Schema.optionalKey(CoreSearchResourceRefSchema),
  matchedSubjectRef: Schema.optionalKey(CoreSearchResourceRefSchema),
  metadata: Schema.Array(CoreSearchMetadataFieldSchema).check(Schema.isMaxLength(50)),
  projectionVersion,
  ref: CoreSearchResourceRefSchema,
  searchableText: Schema.Array(boundedText).check(Schema.isMaxLength(100)),
  selectedLegalEntityId: Schema.optionalKey(Schema.String.check(Schema.isUUID())),
  subjectRef: Schema.optionalKey(CoreSearchResourceRefSchema),
  temporalFacets: Schema.optionalKey(
    Schema.Array(CoreSearchTemporalFacetSchema).check(Schema.isMaxLength(100)),
  ),
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
  selectedLegalEntityId: Schema.optionalKey(Schema.String.check(Schema.isUUID())),
  subjectRef: Schema.optionalKey(CoreSearchResourceRefSchema),
  temporalFacets: Schema.optionalKey(
    Schema.Array(CoreSearchTemporalFacetSchema).check(Schema.isMaxLength(100)),
  ),
  title: boundedText,
});
export type CoreSearchProjectionHit = typeof CoreSearchProjectionHitSchema.Type;

export const CoreSearchQuerySchema = Schema.Struct({
  effectiveAt: Schema.optionalKey(boundedText),
  facets: Schema.optionalKey(Schema.Array(CoreSearchFacetSchema).check(Schema.isMaxLength(20))),
  includeArchived: Schema.Boolean,
  moduleId: stableKey,
  query: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  resourceType: stableKey,
  selectedLegalEntityId: Schema.optionalKey(Schema.String.check(Schema.isUUID())),
  tenantId,
});
export type CoreSearchQuery = typeof CoreSearchQuerySchema.Type;

export const CoreSearchProjectionReplacementSchema = Schema.Struct({
  documents: Schema.Array(CoreSearchProjectionDocumentSchema).check(Schema.isMaxLength(10_000)),
  moduleId: stableKey,
  rebuildVersion: projectionVersion,
  resourceType: stableKey,
  tenantId,
});
export type CoreSearchProjectionReplacement = typeof CoreSearchProjectionReplacementSchema.Type;

export const CoreSearchProjectionMutationSchema = Schema.Union([
  Schema.Struct({ document: CoreSearchProjectionDocumentSchema, kind: Schema.Literal('upsert') }),
  Schema.Struct({
    kind: Schema.Literal('delete'),
    projectionVersion,
    ref: CoreSearchResourceRefSchema,
  }),
]);
export type CoreSearchProjectionMutation = typeof CoreSearchProjectionMutationSchema.Type;

export class CoreSearchProjectionInvalid extends Schema.TaggedError<CoreSearchProjectionInvalid>()(
  'CoreSearchProjectionInvalid',
  {
    code: Schema.Literal('core_search_projection_invalid'),
    reason: Schema.String,
  },
) {}

export class CoreSearchProjectionUnavailable extends Schema.TaggedError<CoreSearchProjectionUnavailable>()(
  'CoreSearchProjectionUnavailable',
  {
    code: Schema.Literal('core_search_projection_unavailable'),
    reason: Schema.String,
  },
) {}

export interface CoreSearchProjectionStoreService {
  /** Applies one idempotent versioned lifecycle observation. */
  readonly apply: (
    input: unknown,
  ) => Effect.Effect<void, CoreSearchProjectionInvalid | CoreSearchProjectionUnavailable>;
  /** Candidate access is Core-private: the query runtime strips searchable evidence before return. */
  readonly queryCandidates: (
    input: CoreSearchQuery,
  ) => Effect.Effect<readonly CoreSearchProjectionDocument[], CoreSearchProjectionUnavailable>;
  /**
   * Replaces one tenant/module/resource projection as one physical rebuild unit. Implementations
   * must leave the prior unit intact when validation or persistence fails.
   */
  readonly replace: (
    input: unknown,
  ) => Effect.Effect<void, CoreSearchProjectionInvalid | CoreSearchProjectionUnavailable>;
}

/** Production persistence implements this Core-owned port; business modules never own an index. */
export class CoreSearchProjectionStore extends Context.Service<
  CoreSearchProjectionStore,
  CoreSearchProjectionStoreService
>()('@app/core-runtime/search/projection/CoreSearchProjectionStore') {}

export interface CoreSearchQueryRuntimeService {
  readonly search: (
    input: unknown,
  ) => Effect.Effect<
    readonly CoreSearchProjectionHit[],
    CoreSearchProjectionInvalid | CoreSearchProjectionUnavailable
  >;
}

export class CoreSearchQueryRuntime extends Context.Service<
  CoreSearchQueryRuntime,
  CoreSearchQueryRuntimeService
>()('@app/core-runtime/search/projection/CoreSearchQueryRuntime') {}

const projectionUnitKey = (tenant: string, moduleId: string, resourceType: string): string =>
  JSON.stringify([tenant, moduleId, resourceType]);
const documentKey = ({ ref }: CoreSearchProjectionDocument): string => ref.resourceId;
const normalize = (value: string): string => value.normalize('NFKC').toLocaleLowerCase('und');

const invalid = (reason: string) =>
  new CoreSearchProjectionInvalid({ code: 'core_search_projection_invalid', reason });
const unavailable = () =>
  new CoreSearchProjectionUnavailable({
    code: 'core_search_projection_unavailable',
    reason: 'Core Search projection is temporarily unavailable',
  });

const hasUniqueKeys = (values: readonly { readonly key: string }[]): boolean =>
  new Set(values.map(({ key }) => key)).size === values.length;

const invalidPeriod = ({
  validFrom,
  validTo,
}: Readonly<{ validFrom: string; validTo?: string }>): boolean => {
  const from = Date.parse(validFrom);
  const to = validTo === undefined ? undefined : Date.parse(validTo);
  return !Number.isFinite(from) || (to !== undefined && (!Number.isFinite(to) || to <= from));
};

const validateDocument = (
  document: CoreSearchProjectionDocument,
  expected: Readonly<{
    readonly moduleId: string;
    readonly resourceType: string;
    readonly tenantId: string;
  }>,
): CoreSearchProjectionInvalid | undefined => {
  if (
    document.ref.tenantId !== expected.tenantId ||
    document.ref.moduleId !== expected.moduleId ||
    document.ref.resourceType !== expected.resourceType ||
    (document.matchedRef !== undefined && document.matchedRef.tenantId !== expected.tenantId) ||
    (document.subjectRef !== undefined && document.subjectRef.tenantId !== expected.tenantId) ||
    (document.matchedSubjectRef !== undefined &&
      document.matchedSubjectRef.tenantId !== expected.tenantId) ||
    !hasUniqueKeys(document.facets) ||
    !hasUniqueKeys(document.metadata) ||
    document.facets.some(
      ({ values }) => values.length === 0 || new Set(values).size !== values.length,
    ) ||
    (document.temporalFacets ?? []).some(invalidPeriod) ||
    (document.temporalSearchableText ?? []).some(invalidPeriod) ||
    (document.aliases ?? []).some(
      (alias) =>
        alias.ref.tenantId !== expected.tenantId ||
        (alias.temporalSearchableText ?? []).some(invalidPeriod),
    )
  ) {
    return invalid('Core Search replacement contains an inconsistent document');
  }
  return undefined;
};

const validateReplacement = (
  input: typeof CoreSearchProjectionReplacementSchema.Type,
): CoreSearchProjectionInvalid | undefined => {
  const seen = new Set<string>();
  const rebuildVersion = BigInt(input.rebuildVersion);
  for (const document of input.documents) {
    const error = validateDocument(document, input);
    if (error !== undefined) {
      return error;
    }
    if (BigInt(document.projectionVersion) > rebuildVersion) {
      return invalid('Core Search replacement contains an inconsistent document');
    }
    const key = documentKey(document);
    if (seen.has(key)) {
      return invalid('Core Search replacement contains a duplicate resource');
    }
    seen.add(key);
  }
  return undefined;
};

export const decodeCoreSearchProjectionReplacement = (
  input: unknown,
): CoreSearchProjectionReplacement => {
  const replacement = Schema.decodeUnknownSync(CoreSearchProjectionReplacementSchema, {
    onExcessProperty: 'error',
  })(input);
  const error = validateReplacement(replacement);
  if (error !== undefined) {
    throw error;
  }
  return replacement;
};

export const decodeCoreSearchProjectionMutation = (
  input: unknown,
): CoreSearchProjectionMutation => {
  const mutation = Schema.decodeUnknownSync(CoreSearchProjectionMutationSchema, {
    onExcessProperty: 'error',
  })(input);
  if (mutation.kind === 'upsert') {
    const error = validateDocument(mutation.document, mutation.document.ref);
    if (error !== undefined) {
      throw error;
    }
  }
  return mutation;
};

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

/** Private Core persistence identity, independent of transport object/document ordering. */
export const coreSearchReplacementFingerprint = (
  replacement: CoreSearchProjectionReplacement,
): string =>
  createHash('sha256')
    .update(
      stableJson({
        ...replacement,
        documents: replacement.documents.toSorted((left, right) =>
          left.ref.resourceId.localeCompare(right.ref.resourceId),
        ),
      }),
    )
    .digest('hex');

export const makeInMemoryCoreSearchProjectionStore = (): CoreSearchProjectionStoreService => {
  type Stored = Readonly<{
    readonly document?: CoreSearchProjectionDocument;
    readonly projectionVersion: string;
  }>;
  const units = new Map<string, Map<string, Stored>>();
  const rebuilds = new Map<string, { readonly fingerprint: string; readonly version: bigint }>();
  const apply: CoreSearchProjectionStoreService['apply'] = (input: unknown) =>
    Effect.gen(function* applyProjectionMutation() {
      const mutation = yield* Schema.decodeUnknownEffect(CoreSearchProjectionMutationSchema, {
        onExcessProperty: 'error',
      })(input).pipe(
        Effect.mapError(() => invalid('Core Search mutation does not match its declared contract')),
      );
      if (mutation.kind === 'upsert') {
        const error = validateDocument(mutation.document, mutation.document.ref);
        if (error !== undefined) {
          return yield* error;
        }
      }
      const ref = mutation.kind === 'upsert' ? mutation.document.ref : mutation.ref;
      const version =
        mutation.kind === 'upsert'
          ? mutation.document.projectionVersion
          : mutation.projectionVersion;
      const unitKey = projectionUnitKey(ref.tenantId, ref.moduleId, ref.resourceType);
      const rebuild = rebuilds.get(unitKey);
      if (rebuild !== undefined && BigInt(version) <= rebuild.version) {
        return;
      }
      const unit = units.get(unitKey) ?? new Map<string, Stored>();
      const current = unit.get(ref.resourceId);
      if (current !== undefined) {
        const order = BigInt(version) - BigInt(current.projectionVersion);
        if (order < 0n) {
          return;
        }
        if (order === 0n) {
          const next = mutation.kind === 'upsert' ? mutation.document : undefined;
          if (JSON.stringify(current.document) !== JSON.stringify(next)) {
            return yield* invalid('Core Search mutation reuses a version for different content');
          }
          return;
        }
      }
      unit.set(
        ref.resourceId,
        mutation.kind === 'upsert'
          ? { document: mutation.document, projectionVersion: version }
          : { projectionVersion: version },
      );
      units.set(unitKey, unit);
    });
  const queryCandidates: CoreSearchProjectionStoreService['queryCandidates'] = (input) =>
    Effect.sync(() =>
      [
        ...(units
          .get(projectionUnitKey(input.tenantId, input.moduleId, input.resourceType))
          ?.values() ?? []),
      ].flatMap(({ document }) => (document === undefined ? [] : [document])),
    ).pipe(Effect.mapError(unavailable));
  const replace: CoreSearchProjectionStoreService['replace'] = (input: unknown) =>
    Effect.gen(function* replaceProjection() {
      const replacement = yield* Schema.decodeUnknownEffect(CoreSearchProjectionReplacementSchema, {
        onExcessProperty: 'error',
      })(input).pipe(
        Effect.mapError(() =>
          invalid('Core Search replacement does not match its declared contract'),
        ),
      );
      const error = validateReplacement(replacement);
      if (error !== undefined) {
        return yield* error;
      }
      const unitKey = projectionUnitKey(
        replacement.tenantId,
        replacement.moduleId,
        replacement.resourceType,
      );
      const prior = rebuilds.get(unitKey);
      const version = BigInt(replacement.rebuildVersion);
      const fingerprint = coreSearchReplacementFingerprint(replacement);
      if (prior !== undefined) {
        if (version < prior.version) {
          return;
        }
        if (version === prior.version) {
          if (fingerprint !== prior.fingerprint) {
            return yield* invalid('Core Search rebuild reuses a version for different content');
          }
          return;
        }
      }
      const current = new Map(units.get(unitKey));
      const nextIds = new Set(replacement.documents.map(({ ref }) => ref.resourceId));
      for (const document of replacement.documents) {
        const existing = current.get(document.ref.resourceId);
        if (
          existing === undefined ||
          BigInt(existing.projectionVersion) < BigInt(document.projectionVersion)
        ) {
          current.set(document.ref.resourceId, {
            document,
            projectionVersion: document.projectionVersion,
          });
        } else if (
          existing.projectionVersion === document.projectionVersion &&
          JSON.stringify(existing.document) !== JSON.stringify(document)
        ) {
          return yield* invalid('Core Search rebuild reuses a version for different content');
        }
      }
      for (const [id, existing] of current) {
        if (
          !nextIds.has(id) &&
          BigInt(existing.projectionVersion) < BigInt(replacement.rebuildVersion)
        ) {
          current.set(id, { projectionVersion: replacement.rebuildVersion });
        }
      }
      units.set(unitKey, current);
      rebuilds.set(unitKey, { fingerprint, version });
    });
  return Object.freeze({ apply, queryCandidates, replace });
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
        const from = Date.parse(temporal.validFrom);
        const to = temporal.validTo === undefined ? undefined : Date.parse(temporal.validTo);
        if (temporal.key === key && from <= effectiveAt && (to === undefined || effectiveAt < to)) {
          available.add(temporal.value);
        }
      }
    }
    return values.every((value) => available.has(value));
  });

const toHit = (document: CoreSearchProjectionDocument): CoreSearchProjectionHit => ({
  archived: document.archived,
  facets: document.facets,
  ...(document.aliases !== undefined || document.matchedRef === undefined
    ? {}
    : { matchedRef: document.matchedRef }),
  ...(document.aliases !== undefined || document.matchedSubjectRef === undefined
    ? {}
    : { matchedSubjectRef: document.matchedSubjectRef }),
  metadata: document.metadata,
  ref: document.ref,
  ...(document.selectedLegalEntityId === undefined
    ? {}
    : { selectedLegalEntityId: document.selectedLegalEntityId }),
  ...(document.subjectRef === undefined ? {} : { subjectRef: document.subjectRef }),
  ...(document.temporalFacets === undefined ? {} : { temporalFacets: document.temporalFacets }),
  title: document.title,
});

const matchDocument = (
  document: CoreSearchProjectionDocument,
  needle: string,
  effectiveAt: number,
): CoreSearchProjectionHit | undefined => {
  const hit = toHit(document);
  const matches = (values: readonly string[]) =>
    values.some((value) => normalize(value).includes(needle));
  const activeValues = (
    values: readonly (typeof CoreSearchTemporalSearchableTextSchema.Type)[] = [],
  ) =>
    values
      .filter(
        ({ validFrom, validTo }) =>
          Date.parse(validFrom) <= effectiveAt &&
          (validTo === undefined || effectiveAt < Date.parse(validTo)),
      )
      .map(({ value }) => value);
  if (
    matches([
      document.title,
      ...document.searchableText,
      ...activeValues(document.temporalSearchableText),
    ])
  ) {
    return hit;
  }
  const alias = document.aliases?.find((candidate) =>
    matches([...candidate.searchableText, ...activeValues(candidate.temporalSearchableText)]),
  );
  if (alias === undefined) {
    return undefined;
  }
  return alias.kind === 'resource'
    ? { ...hit, matchedRef: alias.ref }
    : { ...hit, matchedSubjectRef: alias.ref };
};

export const makeCoreSearchQueryRuntime = (
  store: CoreSearchProjectionStoreService,
): CoreSearchQueryRuntimeService => {
  const search: CoreSearchQueryRuntimeService['search'] = (input: unknown) =>
    Effect.gen(function* coreSearchQueryEffect() {
      const query = yield* Schema.decodeUnknownEffect(CoreSearchQuerySchema)(input).pipe(
        Effect.mapError(() => invalid('Core Search query does not match its declared contract')),
      );
      if (query.effectiveAt !== undefined && !Number.isFinite(Date.parse(query.effectiveAt))) {
        return yield* invalid('Core Search effective time is invalid');
      }
      const documents = yield* store.queryCandidates(query);
      const needle = normalize(query.query);
      const requestedFacets = query.facets ?? [];
      const effectiveAt =
        query.effectiveAt === undefined
          ? yield* Clock.currentTimeMillis
          : Date.parse(query.effectiveAt);
      return documents
        .filter(
          (document) =>
            (query.includeArchived || !document.archived) &&
            document.selectedLegalEntityId === query.selectedLegalEntityId &&
            matchesFacets(document, requestedFacets, effectiveAt),
        )
        .flatMap((document) => {
          const hit = matchDocument(document, needle, effectiveAt);
          return hit === undefined ? [] : [hit];
        })
        .toSorted(
          (left, right) =>
            left.title.localeCompare(right.title) ||
            left.ref.resourceId.localeCompare(right.ref.resourceId),
        );
    });
  return Object.freeze({ search });
};

export const createCoreSearchQueryRuntime = makeCoreSearchQueryRuntime;
