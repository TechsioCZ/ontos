import type {
  AccessDeclaration,
  ApplicationCompositionModule,
  InstalledModuleCatalog,
  OperationalScope,
  TenantModuleState,
  TenantModuleStateRecord,
  TenantModuleStateServiceContract,
} from '@app/core-runtime';
import {
  decideModuleStateAccess,
  isConnectionReadAllowed,
  normalizeCoreSearchText,
  ReadInputValidationError,
  ReadPermissionDenied,
  TenantModuleStateRecordSchema,
} from '@app/core-runtime';
import type { GateInput } from '@app/core-runtime/access/enforcement';
import { corePeopleSystemSearchProvider } from '@app/core-runtime/people/search';
import { Context, DateTime, Effect, Exit, Layer, Option, Schema } from 'effect';

import {
  ResourceRefSchema as SharedResourceRefSchema,
  SHELL_SEARCH_MAX_RESOURCE_TYPES,
  shellSearchMatchedVariantHasQualifiedRef,
  ShellSearchMatchedVariantSchema,
  ShellSearchRelevanceSchema,
  ShellTimelineEntrySchema as SharedShellTimelineEntrySchema,
} from '../../shared/api.ts';
import type { ShellSearchResult as SharedShellSearchResult } from '../../shared/api.ts';
import type { ShellAccessDecision, ShellAccessGate } from './shell-access-decisions.ts';
import { shellAccessOutcome } from './shell-access-decisions.ts';
import type { InstalledModuleCatalogError, ShellInstalledCatalog } from './installed-module-catalog.ts';
import { withShellSearchRequestBudget } from './shell-governed-search.ts';
import { observeShellSearchProvider } from './shell-search-diagnostics.ts';
import { compileShellSearchPresentation } from './shell-search-presentation.ts';

const stableKey = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300));
const PartyRoleSchema = Schema.Literals(['CUSTOMER', 'SUPPLIER']);
const TenantIdSchema = Schema.String.check(Schema.isUUID()).pipe(Schema.brand('TenantId'));
const LegalEntityIdSchema = Schema.String.check(Schema.isUUID()).pipe(Schema.brand('LegalEntityId'));
type PartyRole = typeof PartyRoleSchema.Type;

export const ResourceRefSchema = SharedResourceRefSchema;
export type ResourceRef = Schema.Schema.Type<typeof ResourceRefSchema>;

const ScopedShellSearchResultSchema = Schema.Struct({
  archived: Schema.optionalKey(Schema.Boolean),
  matchedVariant: Schema.optionalKey(ShellSearchMatchedVariantSchema),
  ref: ResourceRefSchema.pipe(
    Schema.check(
      Schema.makeFilter((ref) => (ref.tenantId === undefined ? 'Search result requires Tenant identity' : undefined)),
    ),
  ),
  relevance: Schema.optionalKey(ShellSearchRelevanceSchema),
  selectedLegalEntityId: Schema.optionalKey(LegalEntityIdSchema),
  subtitle: Schema.optionalKey(stableKey),
  title: stableKey,
}).check(
  Schema.makeFilter((result) =>
    result.matchedVariant === undefined || shellSearchMatchedVariantHasQualifiedRef(result)
      ? undefined
      : 'Variant metadata requires a qualified parent ref in the selected company',
  ),
);
const PartyShellSearchResultSchema = Schema.Struct({
  archived: Schema.Boolean,
  matchedViaAlias: Schema.Boolean,
  ref: ResourceRefSchema.pipe(
    Schema.check(
      Schema.makeFilter((ref) =>
        ref.tenantId === undefined ? 'Party search result requires Tenant identity' : undefined,
      ),
    ),
  ),
  relevance: Schema.optionalKey(ShellSearchRelevanceSchema),
  // The Party name is a governed field: a caller without it receives the row without its title (O17, O58).
  title: Schema.optionalKey(stableKey),
});
const CounterpartyShellSearchResultSchema = Schema.Struct({
  collision: Schema.optionalKey(
    Schema.Struct({
      counterpartyRefs: Schema.Array(ResourceRefSchema),
      kind: Schema.Literal('CANONICAL_PARTY_COUNTERPARTY_COLLISION'),
    }),
  ),
  currentRoles: Schema.Array(PartyRoleSchema),
  legalEntity: Schema.Struct({
    legalEntityId: LegalEntityIdSchema,
    tenantId: TenantIdSchema,
  }),
  party: Schema.Struct({
    archived: Schema.Boolean,
    matchedViaAlias: Schema.Boolean,
    ref: ResourceRefSchema,
    title: Schema.optionalKey(stableKey),
  }),
  ref: ResourceRefSchema.pipe(
    Schema.check(
      Schema.makeFilter((ref) =>
        ref.tenantId === undefined ? 'Counterparty search result requires Tenant identity' : undefined,
      ),
    ),
  ),
  relevance: Schema.optionalKey(ShellSearchRelevanceSchema),
});
const RawShellSearchResultSchema = Schema.Union([
  CounterpartyShellSearchResultSchema,
  PartyShellSearchResultSchema,
  ScopedShellSearchResultSchema,
]);
export type ShellSearchResult = SharedShellSearchResult;

/** Decode the provider wire contract, including leaf/scope checks, before authorizing each current owner result. */
export const ShellSearchProviderResultsSchema = Schema.Array(RawShellSearchResultSchema);

export interface ShellSearchRequest {
  /** When supplied by a governed request it must still name the captured release. */
  readonly compositionRevision?: string;
  readonly includeArchived?: boolean;
  readonly query: string;
  /**
   * The searchable types to ask. Absent asks every eligible admitted type; an empty list asks for the admitted
   * inventory with no owner dispatch. The governed read rejects unknown or unadmitted names, and this selection only
   * narrows the fan-out: it never grants module or record permission.
   */
  readonly resourceTypes?: readonly string[];
  readonly role?: PartyRole;
}

export const ShellTimelineEntrySchema = SharedShellTimelineEntrySchema;

const ShellResourceDetailSchema = Schema.Struct({
  fields: Schema.Array(
    Schema.Struct({
      label: stableKey,
      value: Schema.String.check(Schema.isMaxLength(2000)),
    }),
  ),
  title: stableKey,
});

const ProviderFailureCauseSchema = Schema.Defect();

/** Above the number of installed search owners, so one search starts every owner at once and waits only for the slowest. */
const SHELL_SEARCH_OWNER_CONCURRENCY = 32;

export class ShellProviderUnavailableError extends Schema.TaggedError<ShellProviderUnavailableError>()(
  'ShellProviderUnavailableError',
  { cause: Schema.optionalKey(ProviderFailureCauseSchema) },
) {}

/** Every Shell resource question is asked of the trusted request scope, never of loose ids (O66). */
export type ShellResourceContext = OperationalScope;

export interface ShellProviderAssertionIssuer {
  readonly issueAssertion: (input: {
    readonly appId: string;
    readonly compositionRevision: string;
    readonly context: ShellResourceContext;
  }) => Effect.Effect<string, ShellProviderUnavailableError>;
}

export interface ShellSearchProviderRequest<Authorization extends string = string> {
  readonly appId: string;
  readonly authorization: Authorization;
  readonly correlationId: string;
  readonly includeArchived?: boolean;
  /** The approved release of the provider's owner under the captured composition revision. */
  readonly module: ApplicationCompositionModule;
  readonly query: string;
  readonly role?: PartyRole;
  readonly searchKey: string;
}

export interface ShellSearchProviderHandler {
  readonly search: (
    input: ShellSearchProviderRequest,
  ) => Effect.Effect<readonly unknown[], ShellProviderUnavailableError | ReadPermissionDenied>;
}

interface ShellResourceProviderRequest<ApiKey extends string = string, Authorization extends string = string> {
  readonly apiKey: ApiKey;
  readonly appId: string;
  readonly authorization: Authorization;
  readonly correlationId: string;
  readonly ref: ResourceRef;
}

export interface ShellResourceProviderHandler {
  readonly detail: (input: ShellResourceProviderRequest) => Effect.Effect<unknown, ShellProviderUnavailableError>;
  readonly timeline: (input: ShellResourceProviderRequest) => Effect.Effect<
    {
      readonly entries: readonly unknown[];
      readonly projectionLagging: boolean;
    },
    ShellProviderUnavailableError
  >;
}

export interface ShellResourceGateways {
  readonly resource: ShellResourceProviderHandler;
  readonly search: ShellSearchProviderHandler;
}

interface ShellResourceDependencies extends ShellProviderAssertionIssuer {
  readonly access: ShellAccessGate;
  readonly catalog: Effect.Effect<ShellInstalledCatalog, InstalledModuleCatalogError>;
  readonly moduleStates: Pick<TenantModuleStateServiceContract, 'getTenantModuleStates'>;
}

type LoadStateArguments = readonly [
  dependencies: ShellResourceDependencies,
  context: ShellResourceContext,
  moduleId: string,
];

type ProviderFailureCause = Schema.Schema.Type<typeof ProviderFailureCauseSchema>;

const unavailable = (cause?: ProviderFailureCause) =>
  new ShellProviderUnavailableError(cause === undefined ? {} : { cause });
const capture = <Success, Failure, Requirements>(
  effect: Effect.Effect<Success, Failure, Requirements>,
): Effect.Effect<{ readonly ok: false } | { readonly ok: true; readonly value: Success }, never, Requirements> =>
  Effect.exit(effect).pipe(
    Effect.map((exit) =>
      Exit.isSuccess(exit) ? ({ ok: true, value: exit.value } as const) : ({ ok: false } as const),
    ),
  );
/** Search entrypoint denial must survive fan-out; generic detail/timeline capture remains unchanged. */
const captureSearch = <A, E, R>(program: Effect.Effect<A, E, R>) =>
  Effect.exit(program).pipe(
    Effect.flatMap(
      (
        exit,
      ): Effect.Effect<{ readonly ok: false } | { readonly ok: true; readonly value: A }, ReadPermissionDenied> => {
        if (Exit.isSuccess(exit)) {
          return Effect.succeed({ ok: true, value: exit.value });
        }
        const failure = Exit.findErrorOption(exit);
        return Option.isSome(failure) && Schema.is(ReadPermissionDenied)(failure.value)
          ? Effect.fail(
              new ReadPermissionDenied({
                code: 'read_permission_denied',
                reason: 'The search provider entrypoint refused this read',
              }),
            )
          : Effect.succeed({ ok: false });
      },
    ),
  );
const resourceKey = ({ moduleId, resourceId, resourceType }: ResourceRef): string =>
  `${moduleId}:${resourceType}:${resourceId}`;

/**
 * One contribution's own declaration as the one gate question (one entrypoint, one capability).
 * Every answer stays the gate's: ALLOWED, NEEDS_APPROVAL, DENIED or UNAVAILABLE — the Shell never
 * turns a missing declaration into an allow (O62).
 */
const contributionGate = (input: {
  readonly contribution: { readonly accessDeclaration?: AccessDeclaration };
  readonly legalEntityScope: GateInput['legalEntityScope'];
  readonly now: Date;
  readonly scope: ShellResourceContext;
}): GateInput => ({
  carrier: { accessDeclaration: input.contribution.accessDeclaration },
  legalEntityScope: input.legalEntityScope,
  now: input.now,
  scope: input.scope,
});

/** A resource surface is company-owned data, so a company must be selected before it is decided. */
const RESOURCE_LEGAL_ENTITY_SCOPE = 'required' as const;

const loadState = (
  ...[dependencies, context, moduleId]: LoadStateArguments
): Effect.Effect<Option.Option<TenantModuleState>, ShellProviderUnavailableError> =>
  dependencies.moduleStates.getTenantModuleStates(context.tenantId, [moduleId]).pipe(
    Effect.mapError(unavailable),
    Effect.flatMap((records) => {
      const [record, ...unexpected] = records;
      if (record === undefined) {
        return Effect.succeed(Option.none<TenantModuleState>());
      }
      return unexpected.length === 0 && record.moduleKey === moduleId
        ? Effect.succeedSome(record.state)
        : Effect.fail(unavailable());
    }),
  );

type SearchProviderIdentity = Pick<SearchProvider, 'contribution' | 'descriptor' | 'moduleId'>;

const collisionBelongsToProvider = (
  context: ShellResourceContext,
  provider: SearchProviderIdentity,
  result: Extract<ShellSearchResult, { readonly kind: 'counterparty' }>,
): boolean =>
  result.collision?.counterpartyRefs.every(
    (ref) =>
      ref.tenantId === context.tenantId &&
      ref.moduleId === provider.moduleId &&
      ref.resourceType === provider.descriptor.resourceType,
  ) ?? true;

const counterpartyBelongsToContext = (
  context: ShellResourceContext,
  result: Extract<ShellSearchResult, { readonly kind: 'counterparty' }>,
): boolean =>
  context.legalEntityId !== undefined &&
  result.ref.tenantId === context.tenantId &&
  result.party.ref.tenantId === context.tenantId &&
  result.legalEntity.tenantId === context.tenantId &&
  result.legalEntity.legalEntityId === context.legalEntityId;

const resultBelongsToProvider = (
  context: ShellResourceContext,
  provider: SearchProviderIdentity,
  result: ShellSearchResult,
): boolean => {
  if (
    result.ref.moduleId !== provider.moduleId ||
    result.ref.resourceType !== provider.descriptor.resourceType ||
    (result.ref.tenantId !== undefined && result.ref.tenantId !== context.tenantId)
  ) {
    return false;
  }
  if (result.kind === 'party') {
    return provider.descriptor.accessFiltering === 'tenant_scope' && result.ref.tenantId === context.tenantId;
  }
  if (result.kind === 'resource') {
    if (
      result.ref.tenantId !== context.tenantId ||
      (result.matchedVariant !== undefined &&
        provider.contribution.presentation?.refinement?.kind !== 'matched_variant')
    ) {
      return false;
    }
    if (provider.descriptor.accessFiltering === 'tenant_scope') {
      return result.selectedLegalEntityId === undefined;
    }
    return context.legalEntityId !== undefined && result.selectedLegalEntityId === context.legalEntityId;
  }
  return counterpartyBelongsToContext(context, result) && collisionBelongsToProvider(context, provider, result);
};

const normalizeProviderResult = (value: Schema.Schema.Type<typeof RawShellSearchResultSchema>): ShellSearchResult => {
  if (Schema.is(CounterpartyShellSearchResultSchema)(value)) {
    const { title } = value.party;
    const counterparty = {
      ...value,
      kind: 'counterparty' as const,
      legalEntity: value.legalEntity,
      party: value.party,
      ref: value.ref,
    };
    return title === undefined ? counterparty : { ...counterparty, title };
  }
  if (Schema.is(PartyShellSearchResultSchema)(value)) {
    return { ...value, kind: 'party' };
  }
  return { ...value, kind: 'resource' };
};

const decodeProviderResults = (
  values: readonly unknown[],
  provider: SearchProviderIdentity,
): Effect.Effect<readonly ShellSearchResult[], ShellProviderUnavailableError> =>
  // Project the owner's public DTO onto the shared hit contract. Additional owner fields are never returned;
  // every known identity, scope, variant and value constraint still decodes and is rechecked below.
  Schema.decodeUnknownEffect(Schema.Array(RawShellSearchResultSchema), {
    onExcessProperty: 'ignore',
  })(values).pipe(
    Effect.map((decoded) => decoded.map(normalizeProviderResult)),
    Effect.flatMap((decoded) =>
      decoded.some((value) => {
        if (value.kind === 'party') {
          return provider.descriptor.accessFiltering !== 'tenant_scope';
        }
        if (value.kind === 'counterparty') {
          return provider.descriptor.accessFiltering === 'tenant_scope';
        }
        return (
          (provider.descriptor.accessFiltering === 'tenant_scope'
            ? value.selectedLegalEntityId !== undefined
            : value.selectedLegalEntityId === undefined) ||
          (value.matchedVariant !== undefined &&
            provider.contribution.presentation?.refinement?.kind !== 'matched_variant')
        );
      })
        ? Effect.fail(unavailable())
        : Effect.succeed(decoded),
    ),
    Effect.mapError(unavailable),
  );

const searchProviders = (catalog: InstalledModuleCatalog) =>
  catalog.contracts.flatMap((contract) =>
    contract.manifest.publicSurface.shellContributions.search.flatMap((contribution) => {
      const descriptor = contract.manifest.publicSurface.search.find(({ key }) => key === contribution.searchKey);
      return descriptor === undefined
        ? []
        : [
            {
              appId: contract.deployment.appId,
              contribution,
              descriptor,
              moduleId: contract.manifest.module.id,
            },
          ];
    }),
  );

type SearchProvider = ReturnType<typeof searchProviders>[number];

/** Modules whose state a Shell search consults: every module that contributes a search provider. */
export const searchProviderModuleIds = (catalog: InstalledModuleCatalog): readonly string[] =>
  [...new Set(searchProviders(catalog).map(({ moduleId }) => moduleId))].toSorted();

const validSearchStates = (states: readonly TenantModuleStateRecord[], moduleIds: readonly string[]): boolean => {
  const keys = states.map(({ moduleKey }) => moduleKey);
  const moduleIdSet = new Set(moduleIds);
  return (
    Schema.is(Schema.Array(TenantModuleStateRecordSchema))(states) &&
    new Set(keys).size === keys.length &&
    keys.every((key) => moduleIdSet.has(key))
  );
};

/**
 * The searchable types the captured catalog and the tenant module states admit. A type is admitted while its
 * contributing module state allows the search entrypoint; hidden, inactive or unknown modules are not. The Core
 * people provider stays outside business-module admission and is added by its own system branch.
 */
export const shellSearchAdmittedResourceTypes = (
  catalog: InstalledModuleCatalog,
  states: readonly TenantModuleStateRecord[],
): readonly string[] => {
  const stateByModule = new Map(states.map(({ moduleKey, state }) => [moduleKey, state]));
  return [
    ...new Set(
      searchProviders(catalog).flatMap(({ contribution, descriptor, moduleId }: SearchProvider) => {
        const state = stateByModule.get(moduleId);
        return state !== undefined && decideModuleStateAccess(state, contribution.entrypoint.access) === 'allow'
          ? [descriptor.resourceType]
          : [];
      }),
    ),
  ].toSorted();
};

/** OAuth selectors name business owners only; never infer authority from a type prefix or a requested selector. */
const oauthSearchTypeAdmission = (
  catalog: ShellInstalledCatalog,
  context: ShellResourceContext,
  states: readonly TenantModuleStateRecord[],
): ReadonlyMap<string, boolean> => {
  const stateByModule = new Map(states.map(({ moduleKey, state }) => [moduleKey, state]));
  const grants = context.connection?.modules;
  const allowed = new Map<string, boolean>();
  for (const { appId, contribution, descriptor, moduleId } of searchProviders(catalog)) {
    const release = catalog.composition.modules.find(
      (module) => module.moduleId === moduleId && module.deployment.appId === appId,
    );
    const resource = catalog
      .getByModuleId(moduleId)
      ?.manifest.publicSurface.resourceTypes.find(({ key }) => key === descriptor.resourceType);
    const state = stateByModule.get(moduleId);
    const admitted =
      (grants === 'all' || grants?.some((grant) => grant.moduleId === moduleId) === true) &&
      release?.allowedContributions.includes(contribution.contributionKey) === true &&
      contribution.entrypoint.scope === 'tenant' &&
      contribution.entrypoint.moduleKey === moduleId &&
      descriptor.owningModuleId === moduleId &&
      resource?.owningModuleId === moduleId &&
      resource.capabilities.searchable &&
      descriptor.resourceType !== corePeopleSystemSearchProvider.resource.key &&
      (descriptor.accessFiltering !== 'tenant_scope' || context.legalEntityId === undefined) &&
      state !== undefined &&
      decideModuleStateAccess(state, contribution.entrypoint.access) === 'allow';
    // A selector fans out by type. Every owner of a colliding type must be admitted, not merely the first one.
    allowed.set(descriptor.resourceType, admitted && allowed.get(descriptor.resourceType) !== false);
  }
  return allowed;
};

/**
 * Mandatory host admission for both direct governed searches and MCP. Context is Core's verified OperationalScope,
 * catalog ownership is from the captured release, and states are the read's committed snapshot. Canonical module,
 * tenant and resource gates still run in the orchestrator before releasing owner results. No OAuth system grant
 * exists here: `all` means admitted business providers only, and omission always becomes an explicit selector.
 */
export const resolveShellOAuthSearchResourceTypes = Effect.fn('ShellSearch.resolveOAuthResourceTypes')(
  function* resolveOAuthResourceTypes(
    context: ShellResourceContext,
    request: ShellSearchRequest,
    catalog: ShellInstalledCatalog,
    states: readonly TenantModuleStateRecord[],
  ) {
    if (context.authMethod !== 'oauth_connection') {
      return request.resourceTypes;
    }
    if (!isConnectionReadAllowed(context, { owningModuleKey: 'core.shell', readKey: 'core.shell.search' })) {
      return yield* new ReadPermissionDenied({
        code: 'read_permission_denied',
        reason: 'The OAuth connection has no business-search admission',
      });
    }
    if (request.compositionRevision !== undefined && request.compositionRevision !== catalog.composition.revision) {
      return yield* new ReadInputValidationError({
        code: 'read_input_invalid',
        reason: 'The search composition is no longer current',
      });
    }
    if (!validSearchStates(states, searchProviderModuleIds(catalog))) {
      return yield* unavailable();
    }
    const admission = oauthSearchTypeAdmission(catalog, context, states);
    const selected =
      request.resourceTypes === undefined
        ? [...admission].flatMap(([type, admitted]) => (admitted ? [type] : [])).toSorted()
        : [...new Set(request.resourceTypes)];
    if (selected.some((type) => !admission.has(type))) {
      return yield* new ReadInputValidationError({
        code: 'read_input_invalid',
        reason: 'The requested search resource types are not admitted business types',
      });
    }
    if (selected.some((type) => admission.get(type) !== true)) {
      return yield* new ReadPermissionDenied({
        code: 'read_permission_denied',
        reason: 'The OAuth connection may not search the requested business types',
      });
    }
    if (selected.length > SHELL_SEARCH_MAX_RESOURCE_TYPES) {
      return yield* new ReadInputValidationError({
        code: 'read_input_invalid',
        reason: 'Choose an explicit business-search subset within the resource-type limit',
      });
    }
    return selected;
  },
);

const compareSearchText = (left: string, right: string): number => {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
};
const normalizedSearchTitle = (title: string | undefined): string =>
  title === undefined ? '' : normalizeCoreSearchText(title).trim().split(/\s+/u).join(' ');
const searchScore = (result: ShellSearchResult): number => result.relevance?.score ?? 0;

/**
 * The one Shell-wide result order, applied only after authorization, deduplication and collision sanitization:
 * verified relevance descending, then the normalized title, then the complete typed reference. Results from owners
 * that omit relevance keep the existing title-first default and never receive a fabricated score.
 */
export const compareShellSearchResults = (left: ShellSearchResult, right: ShellSearchResult): number =>
  searchScore(right) - searchScore(left) ||
  // A row whose governed name is not visible sorts after every named row (O17, O58).
  Number(left.title === undefined) - Number(right.title === undefined) ||
  compareSearchText(normalizedSearchTitle(left.title), normalizedSearchTitle(right.title)) ||
  compareSearchText(left.ref.tenantId ?? '', right.ref.tenantId ?? '') ||
  compareSearchText(left.ref.moduleId, right.ref.moduleId) ||
  compareSearchText(left.ref.resourceType, right.ref.resourceType) ||
  compareSearchText(left.ref.resourceId, right.ref.resourceId);

export const sortShellSearchResults = (results: readonly ShellSearchResult[]): readonly ShellSearchResult[] =>
  results.toSorted(compareShellSearchResults);

/**
 * The scope a provider is decided in (O7, O12, O78). The search descriptor states it directly as
 * `legalEntityScope`, the same vocabulary as the provider read's own declaration, so the Shell never
 * infers a scope from a coarse filter. A descriptor that has not been migrated yet is company-owned
 * business data, exactly as it was before the coarse filter was retired.
 */
const providerLegalEntityScope = (provider: SearchProvider): GateInput['legalEntityScope'] =>
  provider.descriptor.legalEntityScope ?? 'required';

/** The same request without a caller selector; used only to read the connection's granted inventory. */
const withoutResourceTypes = ({ resourceTypes: _resourceTypes, ...request }: ShellSearchRequest): ShellSearchRequest =>
  request;

/**
 * The provider selection for one answer. An explicit empty selector asks for the inventory of every admitted provider
 * (an OAuth connection is still narrowed to its granted types); any other selector narrows to exactly the requested
 * types. The selection only narrows the fan-out: it never grants a module or a record.
 */
const resolveSearchProviderSelection = Effect.fn('ShellSearch.resolveProviderSelection')(
  function* resolveProviderSelection(
    ...[dependencies, context, request, catalog, providers]: SearchSelectionArguments
  ) {
    // OAuth grants are enforced here too, not only in the MCP adapter or the governed system-search branch.
    const committedStates =
      context.authMethod === 'oauth_connection'
        ? yield* dependencies.moduleStates
            .getTenantModuleStates(context.tenantId, searchProviderModuleIds(catalog))
            .pipe(Effect.mapError(unavailable))
        : undefined;
    // The requested types only narrow which admitted owners are asked; they never replace a permission decision.
    const requested = request.resourceTypes === undefined ? undefined : new Set(request.resourceTypes);
    // An explicit empty selector asks for the admitted inventory alone: it evaluates every admitted provider (an
    // OAuth connection is still narrowed to its granted types) but dispatches no owner and mints no assertion.
    const inventoryOnly = requested !== undefined && requested.size === 0;
    // OAuth resolves the selector against its grants; a session keeps the wire selector unchanged.
    const oauthSelection =
      committedStates === undefined
        ? undefined
        : new Set(
            yield* resolveShellOAuthSearchResourceTypes(
              context,
              inventoryOnly ? withoutResourceTypes(request) : request,
              catalog,
              committedStates,
            ),
          );
    const selection = oauthSelection ?? (inventoryOnly ? undefined : requested);
    const selectedProviders =
      selection === undefined
        ? providers
        : providers.filter(({ descriptor }) => selection.has(descriptor.resourceType));
    const moduleIds = [...new Set(selectedProviders.map(({ moduleId }) => moduleId))].toSorted();
    return { committedStates, inventoryOnly, moduleIds, selectedProviders };
  },
);

/**
 * The admitted providers of one answer and its release-bound presentation. Module, company, tenant and committed-state
 * admission still run here; the selection only narrowed which providers were considered. An inventory-only answer
 * keeps the admitted presentation but dispatches no owner, so no assertion is minted and no hit is fabricated.
 */
const admitSearchProviders = Effect.fn('ShellSearch.admitProviders')(function* admitSearchProviders(
  ...[
    dependencies,
    context,
    catalog,
    committedStates,
    moduleIds,
    selectedProviders,
    inventoryOnly,
  ]: SearchAdmissionArguments
) {
  const moduleIdSet = new Set(moduleIds);
  const states =
    committedStates === undefined
      ? yield* dependencies.moduleStates
          .getTenantModuleStates(context.tenantId, moduleIds)
          .pipe(Effect.mapError(unavailable))
      : committedStates.filter(({ moduleKey }) => moduleIdSet.has(moduleKey));
  if (!validSearchStates(states, moduleIds)) {
    return yield* unavailable();
  }
  const stateByModule = new Map(states.map(({ moduleKey, state }) => [moduleKey, state]));
  const stateEligible = selectedProviders.filter(({ contribution, moduleId }) => {
    const state = stateByModule.get(moduleId);
    // A selected company does not remove canonical tenant access; tenant rows retain tenant ownership only.
    return state !== undefined && decideModuleStateAccess(state, contribution.entrypoint.access) === 'allow';
  });
  const now = yield* DateTime.nowAsDate;
  // A provider that names record selectors is admitted through the LIST gate (R5b-4): the engine
  // answers a predicate instead of refusing `deny.target_required`, and the owner read applies its
  // own list gate to the rows. A scope-wide provider keeps the one batched engine snapshot (E-BATCH).
  const scopeWide: { readonly index: number; readonly provider: SearchProvider }[] = [];
  const recordScoped: { readonly index: number; readonly provider: SearchProvider }[] = [];
  for (const [index, provider] of stateEligible.entries()) {
    const target = (provider.contribution.accessDeclaration?.selectors.length ?? 0) === 0 ? scopeWide : recordScoped;
    target.push({ index, provider });
  }
  const batched = yield* dependencies.access.decideMany(
    scopeWide.map(({ provider }) =>
      contributionGate({
        contribution: provider.contribution,
        legalEntityScope: providerLegalEntityScope(provider),
        now,
        scope: context,
      }),
    ),
  );
  if (batched.length !== scopeWide.length) {
    return yield* unavailable();
  }
  const listed = yield* Effect.forEach(
    recordScoped,
    ({ provider }) =>
      dependencies.access
        .list(
          contributionGate({
            contribution: provider.contribution,
            legalEntityScope: providerLegalEntityScope(provider),
            now,
            scope: context,
          }),
        )
        .pipe(Effect.map(({ decision }) => decision)),
    { concurrency: 1 },
  );
  const decisionByIndex = new Map<number, ShellAccessDecision>();
  for (const [position, { index }] of scopeWide.entries()) {
    const decision = batched[position];
    if (decision !== undefined) {
      decisionByIndex.set(index, decision);
    }
  }
  for (const [position, { index }] of recordScoped.entries()) {
    const decision = listed[position];
    if (decision !== undefined) {
      decisionByIndex.set(index, decision);
    }
  }
  if (
    decisionByIndex.size !== stateEligible.length ||
    [...decisionByIndex.values()].some(({ outcome }) => outcome === 'UNAVAILABLE')
  ) {
    return yield* unavailable();
  }
  const eligible = stateEligible.filter((_provider, index) => decisionByIndex.get(index)?.outcome === 'ALLOWED');
  const presentation = yield* Effect.fromResult(
    compileShellSearchPresentation({
      admitted: eligible.map(({ contribution, descriptor, moduleId }) => ({
        ownerModuleId: moduleId,
        resourceType: descriptor.resourceType,
        searchKey: contribution.searchKey,
      })),
      catalog,
      compositionRevision: catalog.composition.revision,
    }),
  ).pipe(Effect.mapError(unavailable));
  return { dispatchable: inventoryOnly ? [] : eligible, presentation };
});

type SearchSelectionArguments = readonly [
  dependencies: ShellResourceDependencies,
  context: ShellResourceContext,
  request: ShellSearchRequest,
  catalog: ShellInstalledCatalog,
  providers: readonly SearchProvider[],
];

type SearchAdmissionArguments = readonly [
  dependencies: ShellResourceDependencies,
  context: ShellResourceContext,
  catalog: ShellInstalledCatalog,
  committedStates: readonly TenantModuleStateRecord[] | undefined,
  moduleIds: readonly string[],
  selectedProviders: readonly SearchProvider[],
  inventoryOnly: boolean,
];

type ShellSearchArguments = readonly [dependencies: ShellResourceDependencies, gateway: ShellSearchProviderHandler];

export const makeShellSearch = (...[dependencies, gateway]: ShellSearchArguments) => ({
  search: Effect.fn('ShellSearch.search')(
    function* shellSearch(context: ShellResourceContext, request: ShellSearchRequest | string) {
      const searchRequest = Schema.is(Schema.String)(request) ? { query: request } : request;
      const normalizedQuery = searchRequest.query.trim();
      if (normalizedQuery.length === 0) {
        return { partial: false, results: [] } as const;
      }
      const catalog = yield* dependencies.catalog.pipe(Effect.mapError(unavailable));
      const providers = searchProviders(catalog);
      const { committedStates, inventoryOnly, moduleIds, selectedProviders } = yield* resolveSearchProviderSelection(
        dependencies,
        context,
        searchRequest,
        catalog,
        providers,
      );
      if (moduleIds.length === 0) {
        return { partial: false, results: [] } as const;
      }
      const { dispatchable, presentation } = yield* admitSearchProviders(
        dependencies,
        context,
        catalog,
        committedStates,
        moduleIds,
        selectedProviders,
        inventoryOnly,
      );
      if (dispatchable.length === 0) {
        return { partial: false, presentation, results: [] } as const;
      }
      const attempts = yield* Effect.forEach(
        dispatchable,
        (provider) => {
          const module = catalog.composition.modules.find(({ deployment }) => deployment.appId === provider.appId);
          if (module === undefined) {
            return captureSearch(Effect.fail(unavailable())).pipe(Effect.map((result) => ({ provider, result })));
          }
          return Effect.suspend(() =>
            dependencies.issueAssertion({
              appId: provider.appId,
              compositionRevision: catalog.composition.revision,
              context,
            }),
          ).pipe(
            observeShellSearchProvider({
              moduleId: provider.moduleId,
              phase: 'assertion',
              searchKey: provider.contribution.searchKey,
            }),
            Effect.flatMap((authorization) => {
              const requestFilters = new Set(provider.descriptor.requestFilters);
              const providerRequest: ShellSearchProviderRequest = {
                appId: provider.appId,
                authorization,
                correlationId: context.correlationId,
                module,
                query: normalizedQuery,
                searchKey: provider.contribution.searchKey,
              };
              const archiveFiltered =
                requestFilters.has('includeArchived') && searchRequest.includeArchived !== undefined
                  ? {
                      ...providerRequest,
                      includeArchived: searchRequest.includeArchived,
                    }
                  : providerRequest;
              const roleFiltered =
                requestFilters.has('role') && searchRequest.role !== undefined
                  ? { ...archiveFiltered, role: searchRequest.role }
                  : archiveFiltered;
              return gateway.search(roleFiltered).pipe(
                observeShellSearchProvider({
                  moduleId: provider.moduleId,
                  phase: 'owner',
                  searchKey: provider.contribution.searchKey,
                }),
              );
            }),
            Effect.flatMap((result) =>
              decodeProviderResults(result, provider).pipe(
                observeShellSearchProvider({
                  moduleId: provider.moduleId,
                  phase: 'decode',
                  searchKey: provider.contribution.searchKey,
                }),
              ),
            ),
            // Retry only this read with a fresh single-use assertion, inside the unchanged request deadline.
            Effect.retry({ times: 1, while: (failure) => !Schema.is(ReadPermissionDenied)(failure) }),
            captureSearch,
            Effect.map((result) => ({ provider, result })),
          );
        },
        // Every admitted owner starts at once: the answer waits for the slowest owner, never for queued waves.
        { concurrency: SHELL_SEARCH_OWNER_CONCURRENCY },
      );
      const succeeded = attempts.filter(({ result }) => result.ok);
      // One unavailable owner never hides every other owner's results: its hits are omitted and the answer is marked
      // partial. Only an answer with no available owner at all is unavailable.
      if (succeeded.length === 0 && attempts.length > 0) {
        return yield* unavailable();
      }
      const partial = succeeded.length !== attempts.length;
      const candidates = succeeded.flatMap(({ provider, result }) =>
        result.ok
          ? result.value.flatMap((value) =>
              resultBelongsToProvider(context, provider, value) ? [{ provider, value }] : [],
            )
          : [],
      );
      const uniqueCandidates = [
        ...new Map(
          candidates.map(({ provider, value }) => [
            `${value.ref.tenantId ?? context.tenantId}:${resourceKey(value.ref)}`,
            { provider, value },
          ]),
        ).values(),
      ];
      if (uniqueCandidates.length === 0) {
        return {
          partial,
          presentation,
          results: [],
        } as const;
      }
      // Every provider filters its own rows through the list predicate of its search read (O25), so a
      // result that reached the Shell is already the caller's to read: the Shell never re-checks rows.
      const results = sortShellSearchResults(uniqueCandidates.map(({ value }) => value));
      return {
        partial,
        presentation,
        results,
      } as const;
    },
    (program) => withShellSearchRequestBudget(program, unavailable),
  ),
});

export type MediaAffordance =
  | { readonly enabled: true; readonly reason: 'available' }
  | {
      readonly enabled: false;
      readonly reason: 'absent' | 'forbidden' | 'read_only' | 'unavailable';
    };

const mediaAffordance = (state: TenantModuleState, attachable: boolean): MediaAffordance => {
  if (attachable) {
    return state === 'active' ? { enabled: false, reason: 'unavailable' } : { enabled: false, reason: 'read_only' };
  }
  return { enabled: false, reason: 'absent' };
};

const hasMediaBinding = <Binding>(attachable: boolean, binding: Binding | undefined): boolean =>
  attachable && binding !== undefined;

type ShellResourceDetailArguments = readonly [
  dependencies: ShellResourceDependencies,
  gateway: ShellResourceProviderHandler,
];

export const makeShellResourceDetail = (...[dependencies, gateway]: ShellResourceDetailArguments) => {
  const resolveGate = Effect.fn('ShellResourceDetail.resolveGate')(function* shellResourceGate(
    context: ShellResourceContext,
    ref: ResourceRef,
  ) {
    const catalogResult = yield* capture(dependencies.catalog);
    if (!catalogResult.ok) {
      return { outcome: 'unavailable' } as const;
    }
    // Unknown modules and resource types are "not found": module and type names are public catalog facts.
    const contract = catalogResult.value.getByModuleId(ref.moduleId);
    if (contract === undefined) {
      return { outcome: 'not_found' } as const;
    }
    const resourceType = contract.manifest.publicSurface.resourceTypes.find(({ key }) => key === ref.resourceType);
    if (resourceType === undefined) {
      return { outcome: 'not_found' } as const;
    }
    const contributions = contract.manifest.publicSurface.shellContributions;
    const detailBinding = contributions.resourceDetails.find(({ resourceType: key }) => key === ref.resourceType);
    if (detailBinding === undefined) {
      return { outcome: 'not_found' } as const;
    }
    const stateResult = yield* capture(loadState(dependencies, context, ref.moduleId));
    if (!stateResult.ok) {
      return { outcome: 'unavailable' } as const;
    }
    if (
      Option.isNone(stateResult.value) ||
      decideModuleStateAccess(stateResult.value.value, detailBinding?.entrypoint.access ?? 'read') === 'deny'
    ) {
      return { outcome: 'not_found' } as const;
    }
    const now = yield* DateTime.nowAsDate;
    const outcome = shellAccessOutcome(
      yield* dependencies.access.decide(
        contributionGate({
          contribution: detailBinding,
          legalEntityScope: RESOURCE_LEGAL_ENTITY_SCOPE,
          now,
          scope: context,
        }),
      ),
    );
    if (outcome === 'forbidden') {
      return { outcome: 'forbidden' } as const;
    }
    if (outcome === 'unavailable') {
      return { outcome: 'unavailable' } as const;
    }
    if (outcome !== 'allowed') {
      // `selection_required`: the resource read is company-scoped, so a missing company is an
      // unavailable surface here rather than a new page outcome.
      return { outcome: 'unavailable' } as const;
    }
    const mediaBinding = contributions.mediaAttachments.find(({ resourceType: key }) => key === ref.resourceType);
    const timelineBinding = contributions.timelines.find(({ resourceType: key }) => key === ref.resourceType);
    const media = mediaAffordance(
      stateResult.value.value,
      hasMediaBinding(resourceType.capabilities.mediaAttachable, mediaBinding),
    );
    // The timeline is its own protected contribution (O62): its provider runs only when its own
    // declaration allows, so a module can govern the timeline separately from the record detail. An
    // unreadable timeline authority is retryable, never a silent omission (O48b).
    const timelineOutcome =
      timelineBinding === undefined || !resourceType.capabilities.timelineVisible
        ? ('absent' as const)
        : shellAccessOutcome(
            yield* dependencies.access.decide(
              contributionGate({
                contribution: timelineBinding,
                legalEntityScope: RESOURCE_LEGAL_ENTITY_SCOPE,
                now,
                scope: context,
              }),
            ),
          );
    if (timelineOutcome === 'unavailable') {
      return { outcome: 'unavailable' } as const;
    }
    return {
      appId: contract.deployment.appId,
      compositionRevision: catalogResult.value.composition.revision,
      detailApiKey: detailBinding.apiKey,
      media,
      outcome: 'allowed',
      timelineApiKey: timelineOutcome === 'allowed' ? timelineBinding?.apiKey : undefined,
      timelineVisible: resourceType.capabilities.timelineVisible,
    } as const;
  });

  return {
    resolve: Effect.fn('ShellResourceDetail.resolve')(function* shellResourceDetail(
      context: ShellResourceContext,
      ref: ResourceRef,
    ) {
      const gate = yield* resolveGate(context, ref);
      if (gate.outcome === 'forbidden') {
        return { outcome: 'forbidden' } as const;
      }
      if (gate.outcome === 'not_found') {
        return { outcome: 'not_found' } as const;
      }
      if (gate.outcome === 'unavailable') {
        return { outcome: 'unavailable' } as const;
      }
      const decodedDetail = yield* capture(
        dependencies.issueAssertion({ appId: gate.appId, compositionRevision: gate.compositionRevision, context }).pipe(
          Effect.flatMap((authorization) =>
            gateway.detail({
              apiKey: gate.detailApiKey,
              appId: gate.appId,
              authorization,
              correlationId: context.correlationId,
              ref,
            }),
          ),
          Effect.flatMap((detail) =>
            Schema.decodeUnknownEffect(ShellResourceDetailSchema, {
              onExcessProperty: 'error',
            })(detail).pipe(Effect.mapError(unavailable)),
          ),
        ),
      );
      if (!decodedDetail.ok) {
        return { outcome: 'unavailable' } as const;
      }
      const { timelineApiKey } = gate;
      if (timelineApiKey === undefined || !gate.timelineVisible) {
        return {
          detail: decodedDetail.value,
          media: gate.media,
          outcome: 'resolved',
          projectionLagging: false,
          timeline: [],
        } as const;
      }
      const timelineResult = yield* capture(
        dependencies.issueAssertion({ appId: gate.appId, compositionRevision: gate.compositionRevision, context }).pipe(
          Effect.flatMap((authorization) =>
            gateway.timeline({
              apiKey: timelineApiKey,
              appId: gate.appId,
              authorization,
              correlationId: context.correlationId,
              ref,
            }),
          ),
          Effect.flatMap(({ entries, projectionLagging }) =>
            Schema.decodeUnknownEffect(Schema.Array(ShellTimelineEntrySchema), {
              onExcessProperty: 'error',
            })(entries).pipe(
              Effect.map((timeline) => ({
                projectionLagging,
                timeline: timeline.toSorted((left, right) => {
                  const occurredAtOrder =
                    DateTime.toEpochMillis(right.occurredAt) - DateTime.toEpochMillis(left.occurredAt);
                  return occurredAtOrder === 0
                    ? left.timelineEntryId.localeCompare(right.timelineEntryId)
                    : occurredAtOrder;
                }),
              })),
              Effect.mapError(unavailable),
            ),
          ),
        ),
      );
      return timelineResult.ok
        ? ({
            detail: decodedDetail.value,
            media: gate.media,
            outcome: 'resolved',
            projectionLagging: timelineResult.value.projectionLagging,
            timeline: timelineResult.value.timeline,
          } as const)
        : ({ outcome: 'unavailable' } as const);
    }),
  };
};

export type ShellMediaAttachmentResolution =
  | { readonly outcome: 'forbidden' | 'not_found' | 'unavailable' }
  | {
      readonly outcome: 'resolved';
      readonly result: { readonly attached: true };
    };

export const attachShellMedia = (
  _context: ShellResourceContext,
  _ref: ResourceRef,
): Effect.Effect<ShellMediaAttachmentResolution> => Effect.succeed({ outcome: 'unavailable' as const });

export interface ShellResourceServicesFactoryService {
  readonly createResourceDetail: typeof makeShellResourceDetail;
  readonly createSearch: typeof makeShellSearch;
}

const shellResourceServicesFactory = Object.freeze({
  createResourceDetail: makeShellResourceDetail,
  createSearch: makeShellSearch,
});

export const ShellResourceServicesFactory = Context.Reference<ShellResourceServicesFactoryService>(
  '@app/shell-super-app/api/modules/shell-resources/ShellResourceServicesFactory',
  { defaultValue: () => shellResourceServicesFactory },
);

export const ShellResourceServicesFactoryLive = Layer.succeed(
  ShellResourceServicesFactory,
  shellResourceServicesFactory,
);
