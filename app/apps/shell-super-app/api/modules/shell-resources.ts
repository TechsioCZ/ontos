import type {
  AccessDeclaration,
  InstalledModuleCatalog,
  OperationalScope,
  TenantModuleState,
  TenantModuleStateServiceContract,
} from '@app/core-runtime';
import { decideModuleStateAccess } from '@app/core-runtime';
import type { GateInput } from '@app/core-runtime/access/enforcement';
import { Context, DateTime, Effect, Exit, Layer, Option, Schema } from 'effect';

import {
  ResourceRefSchema as SharedResourceRefSchema,
  ShellTimelineEntrySchema as SharedShellTimelineEntrySchema,
} from '../../shared/api.ts';
import type { ShellSearchResult as SharedShellSearchResult } from '../../shared/api.ts';
import type { ShellAccessDecision, ShellAccessGate } from './shell-access-decisions.ts';
import { shellAccessOutcome } from './shell-access-decisions.ts';
import type { InstalledModuleCatalogError, ShellInstalledCatalog } from './installed-module-catalog.ts';

const stableKey = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300));
const PartyRoleSchema = Schema.Literals(['CUSTOMER', 'SUPPLIER']);
const TenantIdSchema = Schema.String.check(Schema.isUUID()).pipe(Schema.brand('TenantId'));
const LegalEntityIdSchema = Schema.String.check(Schema.isUUID()).pipe(Schema.brand('LegalEntityId'));
type PartyRole = typeof PartyRoleSchema.Type;

export const ResourceRefSchema = SharedResourceRefSchema;
export type ResourceRef = Schema.Schema.Type<typeof ResourceRefSchema>;

const LegacyShellSearchResultSchema = Schema.Struct({
  ref: ResourceRefSchema,
  title: stableKey,
});
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
});
const RawShellSearchResultSchema = Schema.Union([
  CounterpartyShellSearchResultSchema,
  PartyShellSearchResultSchema,
  LegacyShellSearchResultSchema,
]);
export type ShellSearchResult = SharedShellSearchResult;

export interface ShellSearchRequest {
  readonly includeArchived?: boolean;
  readonly query: string;
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

interface ShellSearchProviderRequest<Authorization extends string = string> {
  readonly appId: string;
  readonly authorization: Authorization;
  readonly correlationId: string;
  readonly includeArchived?: boolean;
  readonly query: string;
  readonly role?: PartyRole;
  readonly searchKey: string;
}

interface ShellSearchProviderHandler {
  readonly search: (
    input: ShellSearchProviderRequest,
  ) => Effect.Effect<readonly unknown[], ShellProviderUnavailableError>;
}

interface ShellResourceProviderRequest<ApiKey extends string = string, Authorization extends string = string> {
  readonly apiKey: ApiKey;
  readonly appId: string;
  readonly authorization: Authorization;
  readonly correlationId: string;
  readonly ref: ResourceRef;
}

interface ShellResourceProviderHandler {
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

interface SearchProviderIdentity {
  readonly descriptor: { readonly resourceType: string };
  readonly moduleId: string;
}

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
    return result.ref.tenantId === context.tenantId;
  }
  if (result.kind !== 'counterparty') {
    return true;
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

/** A row whose governed name is not visible sorts after every named row. */
const compareSearchTitles = (left: string | undefined, right: string | undefined): number => {
  if (left === undefined || right === undefined) {
    return Number(left === undefined) - Number(right === undefined);
  }
  return left.localeCompare(right);
};

const decodeProviderResults = (
  values: readonly unknown[],
): Effect.Effect<readonly ShellSearchResult[], ShellProviderUnavailableError> =>
  Schema.decodeUnknownEffect(Schema.Array(RawShellSearchResultSchema), {
    onExcessProperty: 'error',
  })(values).pipe(
    Effect.map((decoded) => decoded.map(normalizeProviderResult)),
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

/**
 * The scope a provider is decided in (O7, O12, O78). The search descriptor states it directly as
 * `legalEntityScope`, the same vocabulary as the provider read's own declaration, so the Shell never
 * infers a scope from a coarse filter. A descriptor that has not been migrated yet is company-owned
 * business data, exactly as it was before the coarse filter was retired.
 */
const providerLegalEntityScope = (provider: SearchProvider): GateInput['legalEntityScope'] =>
  provider.descriptor.legalEntityScope ?? 'required';

type ShellSearchArguments = readonly [dependencies: ShellResourceDependencies, gateway: ShellSearchProviderHandler];

export const makeShellSearch = (...[dependencies, gateway]: ShellSearchArguments) => ({
  search: Effect.fn('ShellSearch.search')(function* shellSearch(
    context: ShellResourceContext,
    request: ShellSearchRequest | string,
  ) {
    const searchRequest = Schema.is(Schema.String)(request) ? { query: request } : request;
    const normalizedQuery = searchRequest.query.trim();
    if (normalizedQuery.length === 0) {
      return { partial: false, results: [] } as const;
    }
    const catalog = yield* dependencies.catalog.pipe(Effect.mapError(unavailable));
    const providers = searchProviders(catalog);
    const moduleIds = [...new Set(providers.map(({ moduleId }) => moduleId))].toSorted();
    if (moduleIds.length === 0) {
      return { partial: false, results: [] } as const;
    }
    const states = yield* dependencies.moduleStates
      .getTenantModuleStates(context.tenantId, moduleIds)
      .pipe(Effect.mapError(unavailable));
    const stateKeys = states.map(({ moduleKey }) => moduleKey);
    const moduleIdSet = new Set(moduleIds);
    if (new Set(stateKeys).size !== stateKeys.length || stateKeys.some((moduleId) => !moduleIdSet.has(moduleId))) {
      return yield* unavailable();
    }
    const stateByModule = new Map(states.map(({ moduleKey, state }) => [moduleKey, state]));
    const stateEligible = providers.filter(({ contribution, moduleId }) => {
      const state = stateByModule.get(moduleId);
      return state !== undefined && decideModuleStateAccess(state, contribution.entrypoint.access) === 'allow';
    });
    if (stateEligible.length === 0) {
      return { partial: false, results: [] } as const;
    }
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
    if (eligible.length === 0) {
      return { partial: false, results: [] } as const;
    }
    const attempts = yield* Effect.forEach(
      eligible,
      (provider) =>
        dependencies
          .issueAssertion({ appId: provider.appId, compositionRevision: catalog.composition.revision, context })
          .pipe(
            Effect.flatMap((authorization) => {
              const requestFilters = new Set(provider.descriptor.requestFilters);
              const providerRequest: ShellSearchProviderRequest = {
                appId: provider.appId,
                authorization,
                correlationId: context.correlationId,
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
              return gateway.search(roleFiltered);
            }),
            Effect.flatMap(decodeProviderResults),
            capture,
            Effect.map((result) => ({ provider, result })),
          ),
      { concurrency: 1 },
    );
    const succeeded = attempts.filter(({ result }) => result.ok);
    if (succeeded.length === 0) {
      return yield* unavailable();
    }
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
    // Every provider filters its own rows through the list predicate of its search read (O25), so a
    // result that reached the Shell is already the caller's to read: the Shell never re-checks rows.
    const results = uniqueCandidates
      .map(({ value }) => value)
      .toSorted((left, right) => {
        const titleOrder = compareSearchTitles(left.title, right.title);
        return titleOrder === 0 ? left.ref.resourceId.localeCompare(right.ref.resourceId) : titleOrder;
      });
    return {
      partial: succeeded.length !== attempts.length,
      results,
    } as const;
  }),
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
    const contract = catalogResult.value.getByModuleId(ref.moduleId);
    if (contract === undefined) {
      return { outcome: 'forbidden' } as const;
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
      decideModuleStateAccess(stateResult.value.value, detailBinding.entrypoint.access) === 'deny'
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
