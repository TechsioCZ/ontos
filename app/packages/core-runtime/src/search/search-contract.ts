import { Result, Schema } from 'effect';

// `toLowerCase()` is the root-locale mapping that `toLocaleLowerCase('und')` also uses. The two were verified equal for
// every Unicode scalar and for randomized multi-character strings (final sigma, dotted I), and the locale-aware call
// costs about 9x more per value on the search hot path.
export const normalizeCoreSearchText = (value: string): string =>
  value
    .normalize('NFKD')
    .replaceAll(/\p{M}+/gu, '')
    .normalize('NFKC')
    .toLowerCase();

export const coreSearchTokens = (query: string): readonly string[] => [
  ...new Set(normalizeCoreSearchText(query).trim().split(/\s+/u).filter(Boolean)),
];

/** One optional multi-type selector is capped so a broad query stays a bounded work request. */
export const CORE_SEARCH_MAX_RESOURCE_TYPES = 64;

/** Accept the legacy single type and the additive multi-type selector, without duplicate predicates. */
export const coreSearchResourceTypes = (
  query: Readonly<{ readonly resourceType?: string; readonly resourceTypes?: readonly string[] }>,
): readonly string[] => [
  ...new Set([...(query.resourceType === undefined ? [] : [query.resourceType]), ...(query.resourceTypes ?? [])]),
];

export const CORE_SEARCH_RELEVANCE_VERSION = '1' as const;
export const CORE_SEARCH_RELEVANCE_MAX_SCORE = 1000;

/** Optional wire relevance. A higher score is better; it is never a raw rank tier. */
export const CoreSearchRelevanceSchema = Schema.Struct({
  score: Schema.Int.check(Schema.isBetween({ maximum: CORE_SEARCH_RELEVANCE_MAX_SCORE, minimum: 0 })),
  version: Schema.Literal(CORE_SEARCH_RELEVANCE_VERSION),
});
export type CoreSearchRelevance = typeof CoreSearchRelevanceSchema.Type;

const queryText = Schema.Trim.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(200),
  Schema.makeFilter((value) => coreSearchTokens(value).length > 0),
);

export const CoreSearchQueryTextSchema = queryText;

/** Shared validated interpretation; normalization-only input must never become match-all. */
export const parseCoreSearchQuery = (text: string) =>
  Schema.decodeUnknownResult(queryText)(text).pipe(
    Result.map((value) => ({
      phrase: normalizeCoreSearchText(value).trim().split(/\s+/u).join(' '),
      tokens: coreSearchTokens(value),
    })),
  );

/**
 * Builds the same membership test as `matchesCoreSearchValues`, reusing each distinct value's normalization across
 * calls. Values are normalized only when a token reaches them, so a match never normalizes its later values.
 */
export const createCoreSearchValueMatcher = (tokens: readonly string[]) => {
  const normalized = new Map<string, string>();
  return (values: readonly string[]): boolean => {
    if (tokens.length === 0) {
      return false;
    }
    return tokens.every((token) =>
      values.some((value) => {
        let text = normalized.get(value);
        if (text === undefined) {
          text = normalizeCoreSearchText(value);
          normalized.set(value, text);
        }
        return text.includes(token);
      }),
    );
  };
};

export const matchesCoreSearchValues = (values: readonly string[], tokens: readonly string[]): boolean =>
  createCoreSearchValueMatcher(tokens)(values);

/** PostgreSQL LIKE must treat pasted identifiers as text, never as wildcard syntax. */
export const escapeCoreSearchLike = (value: string): string => value.replaceAll(/[\\%_]/gu, String.raw`\$&`);

/**
 * Bounded, non-executable presentation schemas shared by owner manifests, the Shell's captured
 * composition wire and browser-safe consumers. This leaf imports only Effect: no Node, BFF,
 * private owner or executable runtime may ever become reachable from here.
 */

/** Native Shell screens and ingress prefixes are never installable module page roots. */
const coreShellRouteParameterPattern = /^:(?<name>[a-z][A-Za-z0-9]*)$/u;
const coreShellRouteLocalePrefixPattern = /^[a-z]{2}(?:-[a-z]{2})?$/u;
const coreSearchReservedParameterNames = new Set(['__proto__', 'constructor', 'prototype']);

export const CoreShellNavigationTextSchema = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(80),
  Schema.isTrimmed(),
);

/** Czech and English text the Shell shows for an owner contribution; the Shell never names a module's destinations. */
export const CoreShellLabelSchema = Schema.Struct({
  cs: CoreShellNavigationTextSchema,
  en: CoreShellNavigationTextSchema,
});
export type CoreShellLabel = typeof CoreShellLabelSchema.Type;

/** Iconify utility class of the destination, e.g. `icon-[mdi--home-outline]`. */
export const CoreShellIconSchema = Schema.TemplateLiteral(['icon-[', Schema.String, ']']).check(
  Schema.isMaxLength(120),
  Schema.isPattern(/^icon-\[[a-z0-9]+--[a-z0-9-]+\]$/u),
);

/** Stable owner key: lowercase dotted or hyphenated segments, never a free-text label. */
export const CoreShellStableKeySchema = Schema.String.check(
  Schema.isMinLength(3),
  Schema.isMaxLength(200),
  Schema.isPattern(/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u),
).pipe(Schema.brand('CoreShellStableKey'), Schema.decodeTo(Schema.String));

/** Existing owner page templates: no locale, query, fragment, wildcard or repeated/reserved parameter. */
export const CoreShellPageRoutePathSchema = Schema.String.check(
  Schema.isMinLength(2),
  Schema.isMaxLength(200),
  Schema.isPattern(
    /^\/(?:[a-z][a-z0-9]*(?:-[a-z0-9]+)*|:[a-z][A-Za-z0-9]*)(?:\/(?:[a-z][a-z0-9]*(?:-[a-z0-9]+)*|:[a-z][A-Za-z0-9]*))*$/u,
  ),
).pipe(
  Schema.check(
    Schema.makeFilter((value) => {
      const segments = value.slice(1).split('/');
      if (coreShellRouteLocalePrefixPattern.test(segments[0] ?? '')) {
        return 'page contribution routePath must not include a locale prefix';
      }
      const parameterNames = segments.flatMap((segment) => {
        const name = coreShellRouteParameterPattern.exec(segment)?.groups?.['name'];
        return name === undefined ? [] : [name];
      });
      if (parameterNames.some((name) => coreSearchReservedParameterNames.has(name))) {
        return 'page contribution routePath must not use reserved parameter names';
      }
      return new Set(parameterNames).size === parameterNames.length
        ? undefined
        : 'page contribution routePath must not repeat a parameter name';
    }),
  ),
);

/** Exact named parameters of an existing page template, in declaration order. */
export const coreShellRouteParameterNames = (routePath: string): readonly string[] =>
  routePath
    .slice(1)
    .split('/')
    .flatMap((segment) => {
      const name = coreShellRouteParameterPattern.exec(segment)?.groups?.['name'];
      return name === undefined ? [] : [name];
    });

/** A bounded generic family or group key; camelCase is intentionally allowed, no taxonomy is hardcoded. */
export const CoreSearchPresentationGroupKeySchema = Schema.String.check(
  Schema.isMinLength(2),
  Schema.isMaxLength(64),
  Schema.isPattern(/^[a-z][A-Za-z0-9]*$/u),
).pipe(Schema.brand('CoreSearchPresentationGroupKey'), Schema.decodeTo(Schema.String));

export const CoreSearchPresentationOrderSchema = Schema.Finite.check(
  Schema.isInt(),
  Schema.isBetween({ maximum: 10_000, minimum: 0 }),
);

/** Owner-declared family/group presentation metadata; labels and icons stay data, never executable code. */
export const CoreSearchPresentationMetadataSchema = Schema.Struct({
  icon: CoreShellIconSchema,
  key: CoreSearchPresentationGroupKeySchema,
  label: CoreShellLabelSchema,
  order: CoreSearchPresentationOrderSchema,
});
export type CoreSearchPresentationMetadata = typeof CoreSearchPresentationMetadataSchema.Type;

/** A concrete path or query parameter name; reserved names can never become object-prototype keys. */
export const CoreSearchPresentationParameterNameSchema = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(64),
  Schema.isPattern(/^[a-z][A-Za-z0-9]*$/u),
  Schema.makeFilter((value) =>
    coreSearchReservedParameterNames.has(value) ? 'search presentation parameter name is reserved' : undefined,
  ),
);

export const CoreSearchPresentationIdFormatSchema = Schema.Literals(['opaque', 'uuid']);
export type CoreSearchPresentationIdFormat = typeof CoreSearchPresentationIdFormatSchema.Type;

/**
 * `native` passes the owner's encoded ID unchanged. `selected_company_dot_prefix` strips exactly one
 * verified selected-company UUID prefix; it never guesses or strips any other prefix.
 */
export const CoreSearchPresentationIdEncodingSchema = Schema.Literals(['native', 'selected_company_dot_prefix']);
export type CoreSearchPresentationIdEncoding = typeof CoreSearchPresentationIdEncodingSchema.Type;

/**
 * Bounded opaque owner ID: nonempty and at most 300 characters. It deliberately imposes no ASCII
 * grammar: real owner variant IDs may contain Unicode and reserved URI characters. The unchanged
 * value is encoded by the path/query renderer at the destination boundary.
 */
export const CORE_SEARCH_PRESENTATION_MAX_OPAQUE_ID_LENGTH = 300;

export const CoreSearchPresentationOpaqueIdSchema = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(CORE_SEARCH_PRESENTATION_MAX_OPAQUE_ID_LENGTH),
).pipe(Schema.brand('CoreSearchPresentationOpaqueId'), Schema.decodeTo(Schema.String));

/** Runtime predicate for the erased decoded side of the opaque-ID schema. */
export const isCoreSearchPresentationOpaqueId = (value: string): boolean =>
  value.length >= 1 && value.length <= CORE_SEARCH_PRESENTATION_MAX_OPAQUE_ID_LENGTH;

export const CoreSearchPresentationUuidSchema = Schema.String.check(Schema.isUUID());

export const CoreSearchPresentationPathSelectorSchema = Schema.Struct({
  idEncoding: CoreSearchPresentationIdEncodingSchema,
  idFormat: CoreSearchPresentationIdFormatSchema,
  kind: Schema.Literal('path'),
  parameterName: CoreSearchPresentationParameterNameSchema,
});
export const CoreSearchPresentationQuerySelectorSchema = Schema.Struct({
  idEncoding: CoreSearchPresentationIdEncodingSchema,
  idFormat: CoreSearchPresentationIdFormatSchema,
  kind: Schema.Literal('query'),
  parameterName: CoreSearchPresentationParameterNameSchema,
});
export const CoreSearchPresentationSelectorSchema = Schema.Union([
  CoreSearchPresentationPathSelectorSchema,
  CoreSearchPresentationQuerySelectorSchema,
]);
export type CoreSearchPresentationSelector = typeof CoreSearchPresentationSelectorSchema.Type;

/** Exact existing same-owner page plus the exact declared selector for the record ID. */
export const CoreSearchPresentationRecordSchema = Schema.Struct({
  pageKey: CoreShellStableKeySchema,
  selector: CoreSearchPresentationSelectorSchema,
});
export type CoreSearchPresentationRecord = typeof CoreSearchPresentationRecordSchema.Type;

/** The only supported refinement is the owner-verified current product variant, under the parent record. */
export const CoreSearchPresentationRefinementSchema = Schema.Struct({
  kind: Schema.Literal('matched_variant'),
  parameterName: CoreSearchPresentationParameterNameSchema,
});
export type CoreSearchPresentationRefinement = typeof CoreSearchPresentationRefinementSchema.Type;

export const CoreSearchPresentationScopeSchema = Schema.Literals(['company', 'tenant']);
export type CoreSearchPresentationScope = typeof CoreSearchPresentationScopeSchema.Type;

export const CORE_SEARCH_PRESENTATION_SCHEMA_VERSION = '1' as const;
export const CORE_SEARCH_PRESENTATION_MAX_ENTRIES = 64;
export const CORE_SEARCH_PRESENTATION_MAX_AGENDA_PAGES = 8;

interface CoreSearchPresentationDeclarationFields {
  readonly agendaPageKeys?: readonly string[];
  readonly record?: {
    readonly pageKey: string;
    readonly selector: {
      readonly idEncoding?: 'native' | 'selected_company_dot_prefix';
      readonly parameterName: string;
    };
  };
  readonly refinement?: { readonly parameterName: string };
  readonly scope?: 'company' | 'tenant';
}

const coreSearchPresentationDeclarationIssue = (
  declaration: CoreSearchPresentationDeclarationFields,
): string | undefined => {
  const { agendaPageKeys } = declaration;
  if (agendaPageKeys !== undefined) {
    if (new Set(agendaPageKeys).size !== agendaPageKeys.length) {
      return 'search presentation agenda page keys must be unique';
    }
    if (declaration.record !== undefined && agendaPageKeys.includes(declaration.record.pageKey)) {
      return 'search presentation record page must not also be an agenda page';
    }
  }
  if (declaration.scope === 'tenant' && declaration.record?.selector.idEncoding === 'selected_company_dot_prefix') {
    return 'tenant search presentation must not use selected-company ID encoding';
  }
  if (declaration.scope === 'tenant' && declaration.refinement !== undefined) {
    return 'tenant search presentation must not declare a company variant refinement';
  }
  if (declaration.refinement === undefined) {
    return undefined;
  }
  if (declaration.record === undefined) {
    return 'search presentation refinement requires a record target';
  }
  return declaration.refinement.parameterName === declaration.record.selector.parameterName
    ? 'search presentation refinement must use a distinct query parameter'
    : undefined;
};

/** One owner's optional presentation for its exact declared search descriptor. */
export const CoreSearchPresentationDeclarationSchema = Schema.Struct({
  agendaPageKeys: Schema.optionalKey(
    Schema.Array(CoreShellStableKeySchema).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(CORE_SEARCH_PRESENTATION_MAX_AGENDA_PAGES),
    ),
  ),
  family: CoreSearchPresentationMetadataSchema,
  group: CoreSearchPresentationMetadataSchema,
  record: Schema.optionalKey(CoreSearchPresentationRecordSchema),
  refinement: Schema.optionalKey(CoreSearchPresentationRefinementSchema),
  scope: CoreSearchPresentationScopeSchema,
}).check(Schema.makeFilter((declaration) => coreSearchPresentationDeclarationIssue(declaration)));
export type CoreSearchPresentationDeclaration = typeof CoreSearchPresentationDeclarationSchema.Type;

export const CoreSearchPresentationCompositionRevisionSchema = Schema.String.check(Schema.isPattern(/^[\da-f]{64}$/u));

/** One resolved wire entry: owner/resource/search binding plus bounded presentation data. */
export const CoreSearchPresentationEntrySchema = Schema.Struct({
  ownerModuleId: CoreShellStableKeySchema,
  presentation: CoreSearchPresentationDeclarationSchema,
  resourceType: CoreShellStableKeySchema,
  searchKey: CoreShellStableKeySchema,
});
export type CoreSearchPresentationEntry = typeof CoreSearchPresentationEntrySchema.Type;

interface CoreSearchPresentationCatalogEntryFields {
  readonly presentation: {
    readonly family: {
      readonly icon: `icon-[${string}]`;
      readonly key: string;
      readonly label: { readonly cs: string; readonly en: string };
      readonly order: number;
    };
    readonly group: {
      readonly icon: `icon-[${string}]`;
      readonly key: string;
      readonly label: { readonly cs: string; readonly en: string };
      readonly order: number;
    };
  };
  readonly searchKey: string;
}

const encodePresentationMetadata = Schema.encodeResult(Schema.fromJsonString(CoreSearchPresentationMetadataSchema));
const metadataIdentity = (metadata: CoreSearchPresentationMetadata): string => {
  const encoded = encodePresentationMetadata(metadata);
  return Result.isSuccess(encoded) ? encoded.success : `invalid-presentation-metadata:${metadata.key}`;
};

const coreSearchPresentationMetadataIssue = (
  claimed: Map<string, string>,
  metadata: CoreSearchPresentationCatalogEntryFields['presentation']['group'],
  kind: 'family' | 'group',
): string | undefined => {
  const identity = metadataIdentity(metadata);
  const previous = claimed.get(metadata.key);
  if (previous !== undefined && previous !== identity) {
    return `search presentation ${kind} label/icon/order must agree for key ${metadata.key}`;
  }
  claimed.set(metadata.key, identity);
  return undefined;
};

const coreSearchPresentationCatalogIssue = (
  entries: readonly CoreSearchPresentationCatalogEntryFields[],
): string | undefined => {
  const claimedSearchKeys = new Set<string>();
  const claimedFamilies = new Map<string, string>();
  const claimedGroups = new Map<string, string>();
  for (const entry of entries) {
    if (claimedSearchKeys.has(entry.searchKey)) {
      return `duplicate search presentation binding ${entry.searchKey}`;
    }
    claimedSearchKeys.add(entry.searchKey);
    const familyIssue = coreSearchPresentationMetadataIssue(claimedFamilies, entry.presentation.family, 'family');
    if (familyIssue !== undefined) {
      return familyIssue;
    }
    const groupIssue = coreSearchPresentationMetadataIssue(claimedGroups, entry.presentation.group, 'group');
    if (groupIssue !== undefined) {
      return groupIssue;
    }
  }
  return undefined;
};

/** Resolved, bounded wire catalog: serialized once per Search response, never once per hit. */
export const CoreSearchPresentationCatalogSchema = Schema.Struct({
  compositionRevision: CoreSearchPresentationCompositionRevisionSchema,
  entries: Schema.Array(CoreSearchPresentationEntrySchema).check(
    Schema.isMaxLength(CORE_SEARCH_PRESENTATION_MAX_ENTRIES),
  ),
  schemaVersion: Schema.Literal(CORE_SEARCH_PRESENTATION_SCHEMA_VERSION),
}).check(Schema.makeFilter((catalog) => coreSearchPresentationCatalogIssue(catalog.entries)));
export type CoreSearchPresentationCatalog = typeof CoreSearchPresentationCatalogSchema.Type;

/** One exact presenter detail for a generic resource-detail/not-supported destination. */
export const CoreSearchPresentationDetailSchema = Schema.Struct({
  compositionRevision: CoreSearchPresentationCompositionRevisionSchema,
  entry: CoreSearchPresentationEntrySchema,
  schemaVersion: Schema.Literal(CORE_SEARCH_PRESENTATION_SCHEMA_VERSION),
});
export type CoreSearchPresentationDetail = typeof CoreSearchPresentationDetailSchema.Type;

export const CoreSearchPresentationIssueCodeSchema = Schema.Literals([
  'ambiguous_binding',
  'binding_mismatch',
  'catalog_invalid',
  'invalid_record_id',
  'invalid_refinement',
  'missing_selected_company',
  'no_record_target',
  'selected_company_prefix_mismatch',
  'system_binding_mismatch',
  'unsupported_refinement',
]);
export type CoreSearchPresentationIssueCode = typeof CoreSearchPresentationIssueCodeSchema.Type;

export interface CoreSearchPresentationIssue {
  readonly code: CoreSearchPresentationIssueCode;
  readonly message: string;
}

const presentationIssue = (code: CoreSearchPresentationIssueCode, message: string): CoreSearchPresentationIssue => ({
  code,
  message,
});

export interface CoreSearchPresentationBinding {
  readonly compositionRevision: string;
  readonly ownerModuleId: string;
  readonly resourceType: string;
  readonly searchKey: string;
}

/** Reject a stale revision, a foreign owner/resource/search tuple, or an ambiguous in-memory catalog. */
const matchesPresentationBinding = (
  entry: CoreSearchPresentationEntry,
  binding: CoreSearchPresentationBinding,
): boolean =>
  entry.ownerModuleId === binding.ownerModuleId &&
  entry.resourceType === binding.resourceType &&
  entry.searchKey === binding.searchKey;

export const coreSearchPresentationBindingIssue = (
  catalog: CoreSearchPresentationCatalog,
  binding: CoreSearchPresentationBinding,
): CoreSearchPresentationIssue | undefined => {
  if (catalog.compositionRevision !== binding.compositionRevision) {
    return presentationIssue('binding_mismatch', 'search presentation catalog revision does not match the capture');
  }
  const entry = catalog.entries.find((candidate) => matchesPresentationBinding(candidate, binding));
  if (entry === undefined) {
    return presentationIssue('binding_mismatch', 'search presentation catalog has no matching owner/resource/search');
  }
  const ambiguous = catalog.entries.some(
    (candidate) => candidate !== entry && matchesPresentationBinding(candidate, binding),
  );
  return ambiguous
    ? presentationIssue('ambiguous_binding', 'search presentation catalog matches more than one binding')
    : undefined;
};

/** Decode and validate exactly one captured catalog; overflow and conflicts fail, never truncate. */
export const resolveCoreSearchPresentationCatalog = <Value>(
  input: Value,
): Result.Result<CoreSearchPresentationCatalog, CoreSearchPresentationIssue> => {
  const decoded = Schema.decodeUnknownResult(CoreSearchPresentationCatalogSchema, {
    onExcessProperty: 'error',
  })(input);
  if (Result.isFailure(decoded)) {
    return Result.fail(presentationIssue('catalog_invalid', String(decoded.failure)));
  }
  return Result.succeed(Object.freeze(decoded.success));
};

/** Resolve the one detail presentation from an already captured catalog at the exact binding. */
export const resolveCoreSearchPresentationDetail = (
  catalog: CoreSearchPresentationCatalog,
  binding: CoreSearchPresentationBinding,
): Result.Result<CoreSearchPresentationDetail, CoreSearchPresentationIssue> => {
  const issue = coreSearchPresentationBindingIssue(catalog, binding);
  if (issue !== undefined) {
    return Result.fail(issue);
  }
  const entry = catalog.entries.find(
    (candidate) =>
      candidate.ownerModuleId === binding.ownerModuleId &&
      candidate.resourceType === binding.resourceType &&
      candidate.searchKey === binding.searchKey,
  );
  return entry === undefined
    ? Result.fail(presentationIssue('binding_mismatch', 'search presentation catalog has no matching detail'))
    : Result.succeed(
        Object.freeze({
          compositionRevision: catalog.compositionRevision,
          entry,
          schemaVersion: CORE_SEARCH_PRESENTATION_SCHEMA_VERSION,
        }),
      );
};

export interface CoreSearchPresentationSubject {
  readonly matchedVariantId?: string;
  readonly recordId: string;
  readonly selectedLegalEntityId?: string;
}

export interface CoreSearchPresentationNamedParameter {
  readonly name: string;
  readonly value: string;
}

export interface CoreSearchPresentationRecordTarget {
  readonly familyKey: string;
  readonly groupKey: string;
  readonly kind: 'record';
  readonly pageKey: string;
  readonly pathParameters: readonly CoreSearchPresentationNamedParameter[];
  readonly queryParameters: readonly CoreSearchPresentationNamedParameter[];
  readonly selectorKind: 'path' | 'query';
}

const coreSearchPresentationRecordId = (
  selector: CoreSearchPresentationSelector,
  subject: CoreSearchPresentationSubject,
): Result.Result<string, CoreSearchPresentationIssue> => {
  let value = subject.recordId;
  if (selector.idEncoding === 'selected_company_dot_prefix') {
    const { selectedLegalEntityId } = subject;
    if (selectedLegalEntityId === undefined || !Schema.is(CoreSearchPresentationUuidSchema)(selectedLegalEntityId)) {
      return Result.fail(
        presentationIssue('missing_selected_company', 'selected-company ID encoding requires the selected company'),
      );
    }
    const prefix = `${selectedLegalEntityId}.`;
    if (!value.startsWith(prefix) || value.length === prefix.length) {
      return Result.fail(
        presentationIssue(
          'selected_company_prefix_mismatch',
          'record ID does not carry exactly the selected-company prefix',
        ),
      );
    }
    value = value.slice(prefix.length);
  }
  const valid =
    selector.idFormat === 'uuid'
      ? Schema.is(CoreSearchPresentationUuidSchema)(value)
      : isCoreSearchPresentationOpaqueId(value);
  return valid
    ? Result.succeed(value)
    : Result.fail(presentationIssue('invalid_record_id', 'record ID does not match the declared ID format'));
};

/**
 * Finite, browser-safe interpreter for one resolved entry. It only maps explicit named parameters
 * and the owner-verified variant refinement; it never evaluates expressions or resolves other leaves.
 */
export const interpretCoreSearchPresentationEntry = (
  entry: CoreSearchPresentationEntry,
  subject: CoreSearchPresentationSubject,
): Result.Result<CoreSearchPresentationRecordTarget, CoreSearchPresentationIssue> => {
  const { record } = entry.presentation;
  if (record === undefined) {
    return Result.fail(presentationIssue('no_record_target', 'search presentation has no record destination'));
  }
  const decoded = coreSearchPresentationRecordId(record.selector, subject);
  if (Result.isFailure(decoded)) {
    return Result.fail(decoded.failure);
  }
  const variantId = subject.matchedVariantId;
  if (variantId !== undefined && entry.presentation.refinement === undefined) {
    return Result.fail(
      presentationIssue('unsupported_refinement', 'search presentation does not declare a variant refinement'),
    );
  }
  const refinementParameter =
    variantId === undefined || entry.presentation.refinement === undefined
      ? undefined
      : { name: entry.presentation.refinement.parameterName, value: variantId };
  if (refinementParameter !== undefined && !isCoreSearchPresentationOpaqueId(variantId ?? '')) {
    return Result.fail(presentationIssue('invalid_refinement', 'variant refinement is not a bounded opaque ID'));
  }
  const value = decoded.success;
  const pathParameters = record.selector.kind === 'path' ? [{ name: record.selector.parameterName, value }] : [];
  const queryParameters = record.selector.kind === 'query' ? [{ name: record.selector.parameterName, value }] : [];
  return Result.succeed(
    Object.freeze({
      familyKey: entry.presentation.family.key,
      groupKey: entry.presentation.group.key,
      kind: 'record' as const,
      pageKey: record.pageKey,
      pathParameters: Object.freeze(pathParameters),
      queryParameters: Object.freeze(
        refinementParameter === undefined ? queryParameters : [...queryParameters, refinementParameter],
      ),
      selectorKind: record.selector.kind,
    }),
  );
};

/** Resolve one catalog entry by exact revision/owner/resource/search binding, then interpret it. */
export const interpretCoreSearchPresentation = (
  catalog: CoreSearchPresentationCatalog,
  binding: CoreSearchPresentationBinding,
  subject: CoreSearchPresentationSubject,
): Result.Result<CoreSearchPresentationRecordTarget, CoreSearchPresentationIssue> => {
  const issue = coreSearchPresentationBindingIssue(catalog, binding);
  if (issue !== undefined) {
    return Result.fail(issue);
  }
  const entry = catalog.entries.find((candidate) => matchesPresentationBinding(candidate, binding));
  return entry === undefined
    ? Result.fail(presentationIssue('binding_mismatch', 'search presentation catalog has no matching entry'))
    : interpretCoreSearchPresentationEntry(entry, subject);
};

/**
 * Core Person is an existing explicit system provider outside the installed business catalog. Its
 * separate bounded branch keeps the real native path and query contract and never invents a page key.
 */
export const CoreSystemNavigationPathSchema = Schema.String.check(
  Schema.isMinLength(2),
  Schema.isMaxLength(200),
  Schema.isPattern(/^\/(?:[a-z][a-z0-9]*(?:-[a-z0-9]+)*)(?:\/(?:[a-z][a-z0-9]*(?:-[a-z0-9]+)*))*$/u),
  Schema.makeFilter((value) =>
    coreShellRouteLocalePrefixPattern.test(value.slice(1).split('/')[0] ?? '')
      ? 'system navigation path must not include a locale prefix'
      : undefined,
  ),
);
export type CoreSystemNavigationPath = typeof CoreSystemNavigationPathSchema.Type;

export const CORE_SYSTEM_SEARCH_PRESENTATION_SCHEMA_VERSION = '1' as const;

export const CoreSystemSearchPresentationSchema = Schema.Struct({
  entrypointKey: CoreShellStableKeySchema,
  family: CoreSearchPresentationMetadataSchema,
  group: CoreSearchPresentationMetadataSchema,
  idEncoding: Schema.Literal('native'),
  idFormat: Schema.Literal('opaque'),
  kind: Schema.Literal('system'),
  navigationPath: CoreSystemNavigationPathSchema,
  ownerModuleId: CoreShellStableKeySchema,
  queryParameterName: CoreSearchPresentationParameterNameSchema,
  resourceType: CoreShellStableKeySchema,
  schemaVersion: Schema.Literal(CORE_SYSTEM_SEARCH_PRESENTATION_SCHEMA_VERSION),
  scope: Schema.Literal('company'),
  searchKey: CoreShellStableKeySchema,
});
export type CoreSystemSearchPresentation = typeof CoreSystemSearchPresentationSchema.Type;

/** The actual system authority the Host compares against before admitting a system presentation. */
export interface CoreSystemSearchPresentationAuthority {
  readonly entrypointKey: string;
  readonly navigationPath: string;
  readonly ownerModuleId: string;
  readonly resourceType: string;
  readonly searchKey: string;
}

export const coreSystemSearchPresentationBindingIssue = (
  presentation: CoreSystemSearchPresentation,
  authority: CoreSystemSearchPresentationAuthority,
): CoreSearchPresentationIssue | undefined => {
  const exact =
    presentation.entrypointKey === authority.entrypointKey &&
    presentation.navigationPath === authority.navigationPath &&
    presentation.ownerModuleId === authority.ownerModuleId &&
    presentation.resourceType === authority.resourceType &&
    presentation.searchKey === authority.searchKey;
  return exact
    ? undefined
    : presentationIssue('system_binding_mismatch', 'system presentation does not match the actual system authority');
};

export interface CoreSystemSearchPresentationSubject {
  readonly recordId: string;
}

export interface CoreSystemSearchPresentationTarget {
  readonly kind: 'system_record';
  readonly navigationPath: string;
  readonly queryParameters: readonly CoreSearchPresentationNamedParameter[];
}

/** System targets keep the full native ID, including the company-qualified person ID, unchanged. */
export const interpretCoreSystemSearchPresentation = (
  presentation: CoreSystemSearchPresentation,
  subject: CoreSystemSearchPresentationSubject,
): Result.Result<CoreSystemSearchPresentationTarget, CoreSearchPresentationIssue> =>
  isCoreSearchPresentationOpaqueId(subject.recordId)
    ? Result.succeed(
        Object.freeze({
          kind: 'system_record' as const,
          navigationPath: presentation.navigationPath,
          queryParameters: Object.freeze([{ name: presentation.queryParameterName, value: subject.recordId }]),
        }),
      )
    : Result.fail(presentationIssue('invalid_record_id', 'system record ID is not a bounded opaque ID'));
