import { createHash } from 'node:crypto';

import { Clock, DateTime, Effect, Option, Predicate, Result, Schema } from 'effect';

import { CoreSearchProjectionStore } from './projection-store.ts';
import type { CoreSearchProjectionStoreService } from './projection-store.ts';
import type { CoreSearchQueryRuntimeService } from './query-runtime.ts';

export { CoreSearchProjectionStore } from './projection-store.ts';
export { CoreSearchQueryRuntime } from './query-runtime.ts';
export type { CoreSearchProjectionStoreService } from './projection-store.ts';
export type { CoreSearchQueryRuntimeService } from './query-runtime.ts';

const boundedText = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300));
const stableKey = Schema.String.check(
  Schema.isMinLength(3),
  Schema.isMaxLength(200),
  Schema.isPattern(/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u),
);
const moduleId = stableKey.pipe(Schema.brand('ModuleId'));
const resourceId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300)).pipe(
  Schema.brand('ResourceId'),
);
const resourceType = stableKey.pipe(Schema.brand('ResourceType'));
const selectedLegalEntityId = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand('SelectedLegalEntityId'),
);
const tenantId = Schema.String.check(Schema.isUUID()).pipe(Schema.brand('TenantId'));
const projectionVersion = Schema.String.check(Schema.isPattern(/^[1-9][0-9]*$/u));
type UnparsedCoreSearchInput = typeof Schema.Unknown.Type;

export const CoreSearchResourceRefSchema = Schema.Struct({
  moduleId,
  resourceId,
  resourceType,
  tenantId,
});
export type CoreSearchResourceRef = typeof CoreSearchResourceRefSchema.Type;

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
  matchedRef: Schema.optionalKey(CoreSearchResourceRefSchema),
  matchedSubjectRef: Schema.optionalKey(CoreSearchResourceRefSchema),
  metadata: Schema.Array(CoreSearchMetadataFieldSchema).check(Schema.isMaxLength(50)),
  projectionVersion,
  ref: CoreSearchResourceRefSchema,
  searchableText: Schema.Array(boundedText).check(Schema.isMaxLength(100)),
  selectedLegalEntityId: Schema.optionalKey(selectedLegalEntityId),
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
  selectedLegalEntityId: Schema.optionalKey(selectedLegalEntityId),
  subjectRef: Schema.optionalKey(CoreSearchResourceRefSchema),
  temporalFacets: Schema.optionalKey(
    Schema.Array(CoreSearchTemporalFacetSchema).check(Schema.isMaxLength(100)),
  ),
  title: boundedText,
});
export type CoreSearchProjectionHit = typeof CoreSearchProjectionHitSchema.Type;

export const CoreSearchQuerySchema = Schema.Struct({
  effectiveAt: Schema.optionalKey(Schema.DateTimeUtcFromString),
  facets: Schema.optionalKey(Schema.Array(CoreSearchFacetSchema).check(Schema.isMaxLength(20))),
  includeArchived: Schema.Boolean,
  moduleId,
  query: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  resourceType,
  selectedLegalEntityId: Schema.optionalKey(selectedLegalEntityId),
  tenantId,
});
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
export type CoreSearchProjectionUnavailableError =
  typeof CoreSearchProjectionUnavailableSchema.Type;
export const CoreSearchProjectionUnavailable =
  Schema.TaggedError<CoreSearchProjectionUnavailableError>()(
    'CoreSearchProjectionUnavailable',
    projectionUnavailableFields,
  );
const projectionUnitKeyCodec = Schema.fromJsonString(
  Schema.Tuple([Schema.String, Schema.String, Schema.String]),
);
const encodeProjectionUnitKey = Schema.encodeUnknownResult(projectionUnitKeyCodec);
const projectionUnitKey = (tenant: string, module: string, type: string): string =>
  Result.getOrThrow(encodeProjectionUnitKey([tenant, module, type]));
const documentKey = ({ ref }: CoreSearchProjectionDocument): string => ref.resourceId;
const normalize = (value: string): string => value.normalize('NFKC').toLocaleLowerCase('und');

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

const invalidPeriod = ({
  validFrom,
  validTo,
}: Readonly<{ validFrom: string; validTo?: string }>): boolean => {
  const from = toEpochMillis(validFrom);
  const to = validTo === undefined ? undefined : toEpochMillis(validTo);
  return from === undefined || (validTo !== undefined && (to === undefined || to <= from));
};

const hasForeignDocumentReference = (
  document: CoreSearchProjectionDocument,
  tenant: string,
): boolean =>
  [document.matchedRef, document.subjectRef, document.matchedSubjectRef].some(
    (ref) => ref !== undefined && ref.tenantId !== tenant,
  );

const hasInvalidDocumentFacets = (document: CoreSearchProjectionDocument): boolean =>
  !hasUniqueKeys(document.facets) ||
  !hasUniqueKeys(document.metadata) ||
  document.facets.some(
    ({ values }) => values.length === 0 || new Set(values).size !== values.length,
  );

const hasInvalidDocumentPeriods = (document: CoreSearchProjectionDocument): boolean =>
  (document.temporalFacets ?? []).some(invalidPeriod) ||
  (document.temporalSearchableText ?? []).some(invalidPeriod);

const hasInvalidDocumentAliases = (
  document: CoreSearchProjectionDocument,
  tenant: string,
): boolean =>
  (document.aliases ?? []).some(
    (alias) =>
      alias.ref.tenantId !== tenant || (alias.temporalSearchableText ?? []).some(invalidPeriod),
  );

const validateDocument = (
  document: CoreSearchProjectionDocument,
  expected: Readonly<{ moduleId: string; resourceType: string; tenantId: string }>,
): Result.Result<true, CoreSearchProjectionInvalid> => {
  if (
    document.ref.tenantId !== expected.tenantId ||
    document.ref.moduleId !== expected.moduleId ||
    document.ref.resourceType !== expected.resourceType ||
    hasForeignDocumentReference(document, expected.tenantId) ||
    hasInvalidDocumentFacets(document) ||
    hasInvalidDocumentPeriods(document) ||
    hasInvalidDocumentAliases(document, expected.tenantId)
  ) {
    return Result.fail(invalid('Core Search replacement contains an inconsistent document'));
  }
  return Result.succeed(true);
};

const validateReplacement = (
  input: typeof CoreSearchProjectionReplacementSchema.Type,
): Result.Result<
  typeof CoreSearchProjectionReplacementSchema.Type,
  CoreSearchProjectionInvalid
> => {
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

export const decodeCoreSearchProjectionMutation = (
  input: UnparsedCoreSearchInput,
): CoreSearchProjectionMutation =>
  Result.getOrThrow(
    Result.flatMap(
      Schema.decodeUnknownResult(CoreSearchProjectionMutationSchema, {
        onExcessProperty: 'error',
      })(input),
      validateMutation,
    ),
  );

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

const projectionDocumentEquivalence = Schema.toEquivalence(CoreSearchProjectionDocumentSchema);

const decodeMutationEffect = (input: UnparsedCoreSearchInput) =>
  Schema.decodeUnknownEffect(CoreSearchProjectionMutationSchema, {
    onExcessProperty: 'error',
  })(input).pipe(
    Effect.mapError((cause) =>
      invalid('Core Search mutation does not match its declared contract', cause),
    ),
    Effect.flatMap((mutation) => Effect.fromResult(validateMutation(mutation))),
  );

const decodeReplacementEffect = (input: UnparsedCoreSearchInput) =>
  Schema.decodeUnknownEffect(CoreSearchProjectionReplacementSchema, {
    onExcessProperty: 'error',
  })(input).pipe(
    Effect.mapError((cause) =>
      invalid('Core Search replacement does not match its declared contract', cause),
    ),
    Effect.flatMap((replacement) => Effect.fromResult(validateReplacement(replacement))),
  );

type Stored = Readonly<{
  readonly document?: CoreSearchProjectionDocument;
  readonly projectionVersion: string;
}>;

const sameStoredDocument = (
  current: Stored,
  next: CoreSearchProjectionDocument | undefined,
): boolean =>
  current.document === undefined
    ? next === undefined
    : next !== undefined && projectionDocumentEquivalence(current.document, next);

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
      !sameStoredDocument(existing, document)
    ) {
      return Result.fail(invalid('Core Search rebuild reuses a version for different content'));
    }
  }
  return Result.succeed(true);
};

const retireMissingDocuments = (
  current: Map<string, Stored>,
  replacement: CoreSearchProjectionReplacement,
): void => {
  const nextIds = new Set<string>(replacement.documents.map(({ ref }) => ref.resourceId));
  for (const [id, existing] of current) {
    if (
      !nextIds.has(id) &&
      BigInt(existing.projectionVersion) < BigInt(replacement.rebuildVersion)
    ) {
      current.set(id, { projectionVersion: replacement.rebuildVersion });
    }
  }
};

export const makeInMemoryCoreSearchProjectionStore = (): CoreSearchProjectionStoreService => {
  const units = new Map<string, Map<string, Stored>>();
  const rebuilds = new Map<string, { readonly fingerprint: string; readonly version: bigint }>();
  const apply: CoreSearchProjectionStoreService['apply'] = Effect.fn(
    'CoreSearchProjectionStore.apply',
  )(function* applyCoreSearchProjection(input: UnparsedCoreSearchInput) {
    const mutation = yield* decodeMutationEffect(input);
    const ref = mutation.kind === 'upsert' ? mutation.document.ref : mutation.ref;
    const version =
      mutation.kind === 'upsert' ? mutation.document.projectionVersion : mutation.projectionVersion;
    const unitKey = projectionUnitKey(ref.tenantId, ref.moduleId, ref.resourceType);
    const rebuild = rebuilds.get(unitKey);
    if (rebuild !== undefined && BigInt(version) <= rebuild.version) {
      return yield* Effect.void;
    }
    const unit = units.get(unitKey) ?? new Map<string, Stored>();
    const next: Stored =
      mutation.kind === 'upsert'
        ? { document: mutation.document, projectionVersion: version }
        : { projectionVersion: version };
    const shouldApply = yield* Effect.fromResult(
      shouldApplyMutation(unit.get(ref.resourceId), next),
    );
    if (!shouldApply) {
      return yield* Effect.void;
    }
    unit.set(ref.resourceId, next);
    units.set(unitKey, unit);
    return yield* Effect.void;
  });
  const queryCandidates: CoreSearchProjectionStoreService['queryCandidates'] = (input) =>
    Effect.sync(() =>
      [
        ...(units
          .get(projectionUnitKey(input.tenantId, input.moduleId, input.resourceType))
          ?.values() ?? []),
      ].flatMap(({ document }) => (document === undefined ? [] : [document])),
    );
  const replace: CoreSearchProjectionStoreService['replace'] = Effect.fn(
    'CoreSearchProjectionStore.replace',
  )(function* replaceCoreSearchProjection(input: UnparsedCoreSearchInput) {
    const replacement = yield* decodeReplacementEffect(input);
    const unitKey = projectionUnitKey(
      replacement.tenantId,
      replacement.moduleId,
      replacement.resourceType,
    );
    const prior = rebuilds.get(unitKey);
    const version = BigInt(replacement.rebuildVersion);
    const fingerprint = coreSearchReplacementFingerprint(replacement);
    const shouldReplace = yield* Effect.fromResult(
      shouldReplaceProjection(prior, version, fingerprint),
    );
    if (!shouldReplace) {
      return yield* Effect.void;
    }
    const current = new Map(units.get(unitKey));
    yield* Effect.fromResult(mergeReplacementDocuments(current, replacement.documents));
    retireMissingDocuments(current, replacement);
    units.set(unitKey, current);
    rebuilds.set(unitKey, { fingerprint, version });
    return yield* Effect.void;
  });
  return Object.freeze({ apply, queryCandidates, replace });
};

const isEffectiveTemporalFacet = (
  temporal: CoreSearchTemporalFacet,
  key: string,
  effectiveAt: number,
): boolean => {
  const from = toEpochMillis(temporal.validFrom);
  const to = temporal.validTo === undefined ? undefined : toEpochMillis(temporal.validTo);
  return (
    temporal.key === key &&
    from !== undefined &&
    from <= effectiveAt &&
    (to === undefined || effectiveAt < to)
  );
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
  needle: string,
  effectiveAt: number,
): CoreSearchProjectionHit | undefined => {
  const hit = toHit(document);
  const matches = (values: readonly string[]) =>
    values.some((value) => normalize(value).includes(needle));
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

export const createCoreSearchQueryRuntime: Effect.Effect<
  CoreSearchQueryRuntimeService,
  never,
  CoreSearchProjectionStore
> = Effect.gen(function* createCoreSearchQueryRuntimeService() {
  const store = yield* CoreSearchProjectionStore;
  const search: CoreSearchQueryRuntimeService['search'] = Effect.fn(
    'CoreSearchQueryRuntime.search',
  )(function* searchCoreSearchProjection(input: UnparsedCoreSearchInput) {
    const query = yield* Schema.decodeUnknownEffect(CoreSearchQuerySchema)(input).pipe(
      Effect.mapError((cause) =>
        invalid('Core Search query does not match its declared contract', cause),
      ),
    );
    const documents = yield* store.queryCandidates(query);
    const needle = normalize(query.query);
    const requestedFacets = query.facets ?? [];
    const effectiveAt =
      query.effectiveAt === undefined
        ? yield* Clock.currentTimeMillis
        : DateTime.toEpochMillis(query.effectiveAt);
    const hits: CoreSearchProjectionHit[] = [];
    for (const document of documents) {
      if (
        (query.includeArchived || !document.archived) &&
        document.selectedLegalEntityId === query.selectedLegalEntityId &&
        matchesFacets(document, requestedFacets, effectiveAt)
      ) {
        const hit = matchDocument(document, needle, effectiveAt);
        if (hit !== undefined) {
          hits.push(hit);
        }
      }
    }
    return hits.toSorted(
      (left, right) =>
        left.title.localeCompare(right.title) ||
        left.ref.resourceId.localeCompare(right.ref.resourceId),
    );
  });
  return Object.freeze({ search });
});
