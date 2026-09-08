import type {
  ContextAccessResult,
  ContextAccessService,
  InstalledModuleCatalog,
  TenantModuleState,
  TenantModuleStateServiceContract,
  TrustedPrincipalContext,
} from '@app/core-runtime';
import { decideModuleStateAccess } from '@app/core-runtime';
import { Context, DateTime, Effect, Exit, Layer, Option, Schema } from 'effect';

import {
  ResourceRefSchema as SharedResourceRefSchema,
  ShellTimelineEntrySchema as SharedShellTimelineEntrySchema,
} from '../../shared/api.ts';
import type { ShellSearchResult as SharedShellSearchResult } from '../../shared/api.ts';
import type { InstalledModuleCatalogError } from './installed-module-catalog.ts';

const stableKey = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(300)
);
const PartyRoleSchema = Schema.Literals(['CUSTOMER', 'SUPPLIER']);
const TenantIdSchema = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand('TenantId')
);
const LegalEntityIdSchema = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand('LegalEntityId')
);
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
        ref.tenantId === undefined
          ? 'Party search result requires Tenant identity'
          : undefined
      )
    )
  ),
  title: stableKey,
});
const CounterpartyShellSearchResultSchema = Schema.Struct({
  collision: Schema.optionalKey(
    Schema.Struct({
      counterpartyRefs: Schema.Array(ResourceRefSchema),
      kind: Schema.Literal('CANONICAL_PARTY_COUNTERPARTY_COLLISION'),
    })
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
    title: stableKey,
  }),
  ref: ResourceRefSchema.pipe(
    Schema.check(
      Schema.makeFilter((ref) =>
        ref.tenantId === undefined
          ? 'Counterparty search result requires Tenant identity'
          : undefined
      )
    )
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
    })
  ),
  title: stableKey,
});

const ProviderFailureCauseSchema = Schema.Defect();

export class ShellProviderUnavailableError extends Schema.TaggedError<ShellProviderUnavailableError>()(
  'ShellProviderUnavailableError',
  { cause: Schema.optionalKey(ProviderFailureCauseSchema) }
) {}

interface ShellResourceRequest extends TrustedPrincipalContext {
  readonly correlationId: string;
  readonly legalEntityId?: string;
}
export type ShellResourceContext = ShellResourceRequest;

export interface ShellProviderAssertionIssuer {
  readonly issueAssertion: (input: {
    readonly appId: string;
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
    input: ShellSearchProviderRequest
  ) => Effect.Effect<readonly unknown[], ShellProviderUnavailableError>;
}

interface ShellResourceProviderRequest<
  ApiKey extends string = string,
  Authorization extends string = string,
> {
  readonly apiKey: ApiKey;
  readonly appId: string;
  readonly authorization: Authorization;
  readonly correlationId: string;
  readonly ref: ResourceRef;
}

interface ShellResourceProviderHandler {
  readonly detail: (
    input: ShellResourceProviderRequest
  ) => Effect.Effect<unknown, ShellProviderUnavailableError>;
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
  readonly catalog: Effect.Effect<
    InstalledModuleCatalog,
    InstalledModuleCatalogError
  >;
  readonly contextAccess: ContextAccessService;
  readonly moduleStates: Pick<
    TenantModuleStateServiceContract,
    'getTenantModuleStates'
  >;
}

type LoadStateArguments = readonly [
  dependencies: ShellResourceDependencies,
  context: ShellResourceContext,
  moduleId: string,
];
type ModuleDecisionArguments = readonly [
  dependencies: ShellResourceDependencies,
  context: ShellResourceContext,
  moduleId: string,
];
type ResourceDecisionArguments = readonly [
  dependencies: ShellResourceDependencies,
  context: ShellResourceContext,
  ref: ResourceRef,
];

type ProviderFailureCause = Schema.Schema.Type<
  typeof ProviderFailureCauseSchema
>;

const unavailable = (cause?: ProviderFailureCause) =>
  new ShellProviderUnavailableError(cause === undefined ? {} : { cause });
const capture = <Success, Failure, Requirements>(
  effect: Effect.Effect<Success, Failure, Requirements>
): Effect.Effect<
  { readonly ok: false } | { readonly ok: true; readonly value: Success },
  never,
  Requirements
> =>
  Effect.exit(effect).pipe(
    Effect.map((exit) =>
      Exit.isSuccess(exit)
        ? ({ ok: true, value: exit.value } as const)
        : ({ ok: false } as const)
    )
  );
const resourceKey = ({
  moduleId,
  resourceId,
  resourceType,
}: ResourceRef): string => `${moduleId}:${resourceType}:${resourceId}`;

const loadState = (
  ...[dependencies, context, moduleId]: LoadStateArguments
): Effect.Effect<
  Option.Option<TenantModuleState>,
  ShellProviderUnavailableError
> =>
  dependencies.moduleStates
    .getTenantModuleStates(context.tenantId, [moduleId])
    .pipe(
      Effect.mapError(unavailable),
      Effect.flatMap((records) => {
        const [record, ...unexpected] = records;
        if (record === undefined) {
          return Effect.succeed(Option.none<TenantModuleState>());
        }
        return unexpected.length === 0 && record.moduleKey === moduleId
          ? Effect.succeedSome(record.state)
          : Effect.fail(unavailable());
      })
    );

const moduleDecision = (
  ...[dependencies, context, moduleId]: ModuleDecisionArguments
) =>
  context.legalEntityId === undefined
    ? Effect.succeed([{ decision: 'unavailable' as const, key: moduleId }])
    : dependencies.contextAccess.modules({
        legalEntityId: context.legalEntityId,
        moduleIds: [moduleId],
        principalId: context.principalId,
        tenantId: context.tenantId,
      });

const resourceDecision = (
  ...[dependencies, context, ref]: ResourceDecisionArguments
) =>
  context.legalEntityId === undefined
    ? Effect.succeed([
        { decision: 'unavailable' as const, key: resourceKey(ref) },
      ])
    : dependencies.contextAccess.resources({
        legalEntityId: context.legalEntityId,
        principalId: context.principalId,
        resources: [ref],
        tenantId: context.tenantId,
      });

interface SearchProviderIdentity {
  readonly descriptor: { readonly resourceType: string };
  readonly moduleId: string;
}

const collisionBelongsToProvider = (
  context: ShellResourceContext,
  provider: SearchProviderIdentity,
  result: Extract<ShellSearchResult, { readonly kind: 'counterparty' }>
): boolean =>
  result.collision?.counterpartyRefs.every(
    (ref) =>
      ref.tenantId === context.tenantId &&
      ref.moduleId === provider.moduleId &&
      ref.resourceType === provider.descriptor.resourceType
  ) ?? true;

const counterpartyBelongsToContext = (
  context: ShellResourceContext,
  result: Extract<ShellSearchResult, { readonly kind: 'counterparty' }>
): boolean =>
  context.legalEntityId !== undefined &&
  result.ref.tenantId === context.tenantId &&
  result.party.ref.tenantId === context.tenantId &&
  result.legalEntity.tenantId === context.tenantId &&
  result.legalEntity.legalEntityId === context.legalEntityId;

const resultBelongsToProvider = (
  context: ShellResourceContext,
  provider: SearchProviderIdentity,
  result: ShellSearchResult
): boolean => {
  if (
    result.ref.moduleId !== provider.moduleId ||
    result.ref.resourceType !== provider.descriptor.resourceType ||
    (result.ref.tenantId !== undefined &&
      result.ref.tenantId !== context.tenantId)
  ) {
    return false;
  }
  if (result.kind === 'party') {
    return result.ref.tenantId === context.tenantId;
  }
  if (result.kind !== 'counterparty') {
    return true;
  }
  return (
    counterpartyBelongsToContext(context, result) &&
    collisionBelongsToProvider(context, provider, result)
  );
};

const normalizeProviderResult = (
  value: Schema.Schema.Type<typeof RawShellSearchResultSchema>
): ShellSearchResult => {
  if (Schema.is(CounterpartyShellSearchResultSchema)(value)) {
    return {
      ...value,
      kind: 'counterparty',
      legalEntity: value.legalEntity,
      party: value.party,
      ref: value.ref,
      title: value.party.title,
    };
  }
  if (Schema.is(PartyShellSearchResultSchema)(value)) {
    return { ...value, kind: 'party' };
  }
  return { ...value, kind: 'resource' };
};

const decodeProviderResults = (
  values: readonly unknown[]
): Effect.Effect<readonly ShellSearchResult[], ShellProviderUnavailableError> =>
  Schema.decodeUnknownEffect(Schema.Array(RawShellSearchResultSchema), {
    onExcessProperty: 'error',
  })(values).pipe(
    Effect.map((decoded) => decoded.map(normalizeProviderResult)),
    Effect.mapError(unavailable)
  );

const searchProviders = (catalog: InstalledModuleCatalog) =>
  catalog.contracts.flatMap((contract) =>
    contract.manifest.publicSurface.shellContributions.search.flatMap(
      (contribution) => {
        const descriptor = contract.manifest.publicSurface.search.find(
          ({ key }) => key === contribution.searchKey
        );
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
      }
    )
  );

interface SearchCandidate {
  readonly provider: ReturnType<typeof searchProviders>[number];
  readonly value: ShellSearchResult;
}

const authorizeSearchCandidates = Effect.fn('ShellSearch.authorizeCandidates')(
  function* authorizeSearchCandidates(
    ...[dependencies, context, uniqueCandidates]: readonly [
      ShellResourceDependencies,
      ShellResourceContext,
      readonly SearchCandidate[],
    ]
  ) {
    const resourceCandidates = uniqueCandidates.filter(
      ({ provider }) =>
        provider.descriptor.accessFiltering === 'resource_permission'
    );
    const candidateResourceRefs = resourceCandidates.flatMap(({ value }) => [
      value.ref,
      ...(value.kind === 'counterparty'
        ? (value.collision?.counterpartyRefs ?? [])
        : []),
    ]);
    const resourcesToAuthorize = [
      ...new Map(
        candidateResourceRefs.map((ref) => [resourceKey(ref), ref])
      ).values(),
    ];
    let resourcePermissions: readonly ContextAccessResult[] = [];
    if (resourceCandidates.length > 0) {
      const { legalEntityId } = context;
      if (legalEntityId === undefined) {
        return yield* unavailable();
      }
      resourcePermissions = yield* dependencies.contextAccess.resources({
        legalEntityId,
        principalId: context.principalId,
        resources: resourcesToAuthorize,
        tenantId: context.tenantId,
      });
    }
    if (
      resourcePermissions.length !== resourcesToAuthorize.length ||
      resourcePermissions.some(({ decision, key }, index) => {
        const candidate = resourcesToAuthorize[index];
        return (
          candidate === undefined ||
          key !== resourceKey(candidate) ||
          decision === 'unavailable'
        );
      })
    ) {
      return yield* unavailable();
    }
    const allowedKeys = new Set(
      resourcePermissions.flatMap(({ decision, key }) =>
        decision === 'allowed' ? [key] : []
      )
    );
    return allowedKeys;
  }
);

type ShellSearchArguments = readonly [
  dependencies: ShellResourceDependencies,
  gateway: ShellSearchProviderHandler,
];

export const makeShellSearch = (
  ...[dependencies, gateway]: ShellSearchArguments
) => ({
  search: Effect.fn('ShellSearch.search')(function* shellSearch(
    context: ShellResourceContext,
    request: ShellSearchRequest | string
  ) {
    const searchRequest = Schema.is(Schema.String)(request)
      ? { query: request }
      : request;
    const normalizedQuery = searchRequest.query.trim();
    if (normalizedQuery.length === 0) {
      return { partial: false, results: [] } as const;
    }
    const catalog = yield* dependencies.catalog.pipe(
      Effect.mapError(unavailable)
    );
    const providers = searchProviders(catalog);
    const moduleIds = [
      ...new Set(providers.map(({ moduleId }) => moduleId)),
    ].toSorted();
    if (moduleIds.length === 0) {
      return { partial: false, results: [] } as const;
    }
    const states = yield* dependencies.moduleStates
      .getTenantModuleStates(context.tenantId, moduleIds)
      .pipe(Effect.mapError(unavailable));
    const stateKeys = states.map(({ moduleKey }) => moduleKey);
    const moduleIdSet = new Set(moduleIds);
    if (
      new Set(stateKeys).size !== stateKeys.length ||
      stateKeys.some((moduleId) => !moduleIdSet.has(moduleId))
    ) {
      return yield* unavailable();
    }
    const stateByModule = new Map(
      states.map(({ moduleKey, state }) => [moduleKey, state])
    );
    const stateEligible = providers.filter(({ contribution, moduleId }) => {
      const state = stateByModule.get(moduleId);
      return (
        state !== undefined &&
        decideModuleStateAccess(state, contribution.entrypoint.access) ===
          'allow'
      );
    });
    const permissionOutcomes = yield* Effect.forEach(
      stateEligible,
      (provider) => {
        if (provider.descriptor.accessFiltering === 'tenant_scope') {
          const permission = provider.descriptor.tenantPermission;
          if (permission === undefined) {
            return Effect.succeed({
              decision: 'unavailable' as const,
              provider,
            });
          }
          return dependencies.contextAccess
            .tenants({
              permission,
              principalId: context.principalId,
              tenantIds: [context.tenantId],
            })
            .pipe(
              Effect.map((decisions) => ({
                decision:
                  decisions.length === 1 &&
                  decisions[0]?.key === context.tenantId
                    ? decisions[0].decision
                    : ('unavailable' as const),
                provider,
              }))
            );
        }
        if (context.legalEntityId === undefined) {
          return Effect.succeed({ decision: 'denied' as const, provider });
        }
        return dependencies.contextAccess
          .modules({
            legalEntityId: context.legalEntityId,
            moduleIds: [provider.moduleId],
            principalId: context.principalId,
            tenantId: context.tenantId,
          })
          .pipe(
            Effect.map((decisions) => ({
              decision:
                decisions.length === 1 &&
                decisions[0]?.key === provider.moduleId
                  ? decisions[0].decision
                  : ('unavailable' as const),
              provider,
            }))
          );
      },
      { concurrency: 1 }
    );
    if (permissionOutcomes.some(({ decision }) => decision === 'unavailable')) {
      return yield* unavailable();
    }
    const eligible = permissionOutcomes.flatMap(({ decision, provider }) =>
      decision === 'allowed' ? [provider] : []
    );
    if (eligible.length === 0) {
      return { partial: false, results: [] } as const;
    }
    const attempts = yield* Effect.forEach(
      eligible,
      (provider) =>
        dependencies.issueAssertion({ appId: provider.appId, context }).pipe(
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
              requestFilters.has('includeArchived') &&
              searchRequest.includeArchived !== undefined
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
          Effect.map((result) => ({ provider, result }))
        ),
      { concurrency: 1 }
    );
    const succeeded = attempts.filter(({ result }) => result.ok);
    if (succeeded.length === 0) {
      return yield* unavailable();
    }
    const candidates = succeeded.flatMap(({ provider, result }) =>
      result.ok
        ? result.value.flatMap((value) =>
            resultBelongsToProvider(context, provider, value)
              ? [{ provider, value }]
              : []
          )
        : []
    );
    const uniqueCandidates = [
      ...new Map(
        candidates.map(({ provider, value }) => [
          `${value.ref.tenantId ?? context.tenantId}:${resourceKey(value.ref)}`,
          { provider, value },
        ])
      ).values(),
    ];
    if (uniqueCandidates.length === 0) {
      return {
        partial: succeeded.length !== attempts.length,
        results: [],
      } as const;
    }
    const allowedKeys = yield* authorizeSearchCandidates(
      dependencies,
      context,
      uniqueCandidates
    );
    const results = uniqueCandidates
      .flatMap<ShellSearchResult>(({ provider, value }) => {
        if (
          provider.descriptor.accessFiltering === 'resource_permission' &&
          !allowedKeys.has(resourceKey(value.ref))
        ) {
          return [];
        }
        if (value.kind !== 'counterparty' || value.collision === undefined) {
          return [value];
        }
        const { collision, ...visible } = value;
        const counterpartyRefs = collision.counterpartyRefs.filter((ref) =>
          allowedKeys.has(resourceKey(ref))
        );
        return [
          counterpartyRefs.length < 2
            ? visible
            : {
                ...visible,
                collision: { ...collision, counterpartyRefs },
              },
        ];
      })
      .toSorted((left, right) => {
        const titleOrder = left.title.localeCompare(right.title);
        return titleOrder === 0
          ? left.ref.resourceId.localeCompare(right.ref.resourceId)
          : titleOrder;
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

const mediaAffordance = (
  state: TenantModuleState,
  attachable: boolean
): MediaAffordance => {
  if (attachable) {
    return state === 'active'
      ? { enabled: false, reason: 'unavailable' }
      : { enabled: false, reason: 'read_only' };
  }
  return { enabled: false, reason: 'absent' };
};

const hasMediaBinding = <Binding>(
  attachable: boolean,
  binding: Binding | undefined
): boolean => attachable && binding !== undefined;

const accessOutcome = (
  decisions: readonly ContextAccessResult[],
  expectedKey: string
) => {
  const [decision, ...unexpected] = decisions;
  if (
    unexpected.length > 0 ||
    decision?.key !== expectedKey ||
    decision.decision === 'unavailable'
  ) {
    return { outcome: 'unavailable' } as const;
  }
  return decision.decision === 'denied'
    ? ({ outcome: 'forbidden' } as const)
    : ({ outcome: 'allowed' } as const);
};

const resourceAccessOutcome = Effect.fn('ShellResourceDetail.accessOutcome')(
  function* resourceAccessOutcome(
    ...[dependencies, context, ref]: ResourceDecisionArguments
  ) {
    const moduleAccess = accessOutcome(
      yield* moduleDecision(dependencies, context, ref.moduleId),
      ref.moduleId
    );
    if (moduleAccess.outcome !== 'allowed') {
      return moduleAccess;
    }
    return accessOutcome(
      yield* resourceDecision(dependencies, context, ref),
      resourceKey(ref)
    );
  }
);

type ShellResourceDetailArguments = readonly [
  dependencies: ShellResourceDependencies,
  gateway: ShellResourceProviderHandler,
];

export const makeShellResourceDetail = (
  ...[dependencies, gateway]: ShellResourceDetailArguments
) => {
  const resolveGate = Effect.fn('ShellResourceDetail.resolveGate')(
    function* shellResourceGate(
      context: ShellResourceContext,
      ref: ResourceRef
    ) {
      const catalogResult = yield* capture(dependencies.catalog);
      if (!catalogResult.ok) {
        return { outcome: 'unavailable' } as const;
      }
      const contract = catalogResult.value.getByModuleId(ref.moduleId);
      const resourceType = contract?.manifest.publicSurface.resourceTypes.find(
        ({ key }) => key === ref.resourceType
      );
      if (contract === undefined || resourceType === undefined) {
        return { outcome: 'not_found' } as const;
      }
      const contributions = contract.manifest.publicSurface.shellContributions;
      const detailBinding = contributions.resourceDetails.find(
        ({ resourceType: key }) => key === ref.resourceType
      );
      if (detailBinding === undefined) {
        return { outcome: 'not_found' } as const;
      }
      const stateResult = yield* capture(
        loadState(dependencies, context, ref.moduleId)
      );
      if (!stateResult.ok) {
        return { outcome: 'unavailable' } as const;
      }
      if (
        Option.isNone(stateResult.value) ||
        decideModuleStateAccess(
          stateResult.value.value,
          detailBinding.entrypoint.access
        ) === 'deny'
      ) {
        return { outcome: 'not_found' } as const;
      }
      const access = yield* resourceAccessOutcome(dependencies, context, ref);
      if (access.outcome !== 'allowed') {
        return access;
      }
      const mediaBinding = contributions.mediaAttachments.find(
        ({ resourceType: key }) => key === ref.resourceType
      );
      const timelineBinding = contributions.timelines.find(
        ({ resourceType: key }) => key === ref.resourceType
      );
      const media = mediaAffordance(
        stateResult.value.value,
        hasMediaBinding(resourceType.capabilities.mediaAttachable, mediaBinding)
      );
      return {
        appId: contract.deployment.appId,
        detailApiKey: detailBinding.apiKey,
        media,
        outcome: 'allowed',
        timelineApiKey: timelineBinding?.apiKey,
        timelineVisible: resourceType.capabilities.timelineVisible,
      } as const;
    }
  );

  return {
    resolve: Effect.fn('ShellResourceDetail.resolve')(
      function* shellResourceDetail(
        context: ShellResourceContext,
        ref: ResourceRef
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
          dependencies.issueAssertion({ appId: gate.appId, context }).pipe(
            Effect.flatMap((authorization) =>
              gateway.detail({
                apiKey: gate.detailApiKey,
                appId: gate.appId,
                authorization,
                correlationId: context.correlationId,
                ref,
              })
            ),
            Effect.flatMap((detail) =>
              Schema.decodeUnknownEffect(ShellResourceDetailSchema, {
                onExcessProperty: 'error',
              })(detail).pipe(Effect.mapError(unavailable))
            )
          )
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
          dependencies.issueAssertion({ appId: gate.appId, context }).pipe(
            Effect.flatMap((authorization) =>
              gateway.timeline({
                apiKey: timelineApiKey,
                appId: gate.appId,
                authorization,
                correlationId: context.correlationId,
                ref,
              })
            ),
            Effect.flatMap(({ entries, projectionLagging }) =>
              Schema.decodeUnknownEffect(
                Schema.Array(ShellTimelineEntrySchema),
                {
                  onExcessProperty: 'error',
                }
              )(entries).pipe(
                Effect.map((timeline) => ({
                  projectionLagging,
                  timeline: timeline.toSorted((left, right) => {
                    const occurredAtOrder =
                      DateTime.toEpochMillis(right.occurredAt) -
                      DateTime.toEpochMillis(left.occurredAt);
                    return occurredAtOrder === 0
                      ? left.timelineEntryId.localeCompare(
                          right.timelineEntryId
                        )
                      : occurredAtOrder;
                  }),
                })),
                Effect.mapError(unavailable)
              )
            )
          )
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
      }
    ),
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
  _ref: ResourceRef
): Effect.Effect<ShellMediaAttachmentResolution> =>
  Effect.succeed({ outcome: 'unavailable' as const });

export interface ShellResourceServicesFactoryService {
  readonly createResourceDetail: typeof makeShellResourceDetail;
  readonly createSearch: typeof makeShellSearch;
}

const shellResourceServicesFactory = Object.freeze({
  createResourceDetail: makeShellResourceDetail,
  createSearch: makeShellSearch,
});

export const ShellResourceServicesFactory =
  Context.Reference<ShellResourceServicesFactoryService>(
    '@app/shell-super-app/api/modules/shell-resources/ShellResourceServicesFactory',
    { defaultValue: () => shellResourceServicesFactory }
  );

export const ShellResourceServicesFactoryLive = Layer.succeed(
  ShellResourceServicesFactory,
  shellResourceServicesFactory
);
