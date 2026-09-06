// @effect-diagnostics anyUnknownInErrorContext:off catchUnfailableEffect:off effectSucceedWithVoid:off schemaSyncInEffect:off unnecessaryPipeChain:off
/* eslint-disable complexity, max-classes-per-file, no-negated-condition, react-doctor/js-combine-iterations, react-doctor/js-set-map-lookups, unicorn/no-array-method-this-argument, unicorn/no-negated-condition -- Search/resource/media orchestration keeps its closed gate ordering visible in one module; provider and authorization batches are bounded by the installed catalog. */
import type {
  ContextAccessResult,
  ContextAccessService,
  InstalledModuleCatalog,
  TenantModuleState,
  TenantModuleStateServiceContract,
  TrustedPrincipalContext,
} from '@app/core-runtime';
import { decideModuleStateAccess } from '@app/core-runtime';
import { Context, Effect, Exit, Layer, Redacted, Schema } from 'effect';

const stableKey = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300));

export const ResourceRefSchema = Schema.Struct({
  moduleId: stableKey,
  resourceId: stableKey,
  resourceType: stableKey,
  tenantId: Schema.optionalKey(Schema.String.check(Schema.isUUID())),
});
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
  title: stableKey,
});
const CounterpartyShellSearchResultSchema = Schema.Struct({
  collision: Schema.optionalKey(
    Schema.Struct({
      counterpartyRefs: Schema.Array(ResourceRefSchema),
      kind: Schema.Literal('CANONICAL_PARTY_COUNTERPARTY_COLLISION'),
    }),
  ),
  currentRoles: Schema.Array(Schema.Literals(['CUSTOMER', 'SUPPLIER'])),
  legalEntity: Schema.Struct({
    legalEntityId: Schema.String.check(Schema.isUUID()),
    tenantId: Schema.String.check(Schema.isUUID()),
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
          : undefined,
      ),
    ),
  ),
});
const RawShellSearchResultSchema = Schema.Union([
  CounterpartyShellSearchResultSchema,
  PartyShellSearchResultSchema,
  LegacyShellSearchResultSchema,
]);
export const ShellSearchResultSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal('resource'),
    ref: ResourceRefSchema,
    title: stableKey,
  }),
  Schema.Struct({
    archived: Schema.Boolean,
    kind: Schema.Literal('party'),
    matchedViaAlias: Schema.Boolean,
    ref: ResourceRefSchema,
    title: stableKey,
  }),
  Schema.Struct({
    collision: Schema.optionalKey(
      Schema.Struct({
        counterpartyRefs: Schema.Array(ResourceRefSchema),
        kind: Schema.Literal('CANONICAL_PARTY_COUNTERPARTY_COLLISION'),
      }),
    ),
    currentRoles: Schema.Array(Schema.Literals(['CUSTOMER', 'SUPPLIER'])),
    kind: Schema.Literal('counterparty'),
    legalEntity: Schema.Struct({
      legalEntityId: Schema.String.check(Schema.isUUID()),
      tenantId: Schema.String.check(Schema.isUUID()),
    }),
    party: Schema.Struct({
      archived: Schema.Boolean,
      matchedViaAlias: Schema.Boolean,
      ref: ResourceRefSchema,
      title: stableKey,
    }),
    ref: ResourceRefSchema,
    title: stableKey,
  }),
]);
export type ShellSearchResult = Schema.Schema.Type<typeof ShellSearchResultSchema>;

export interface ShellSearchRequest {
  readonly includeArchived?: boolean;
  readonly query: string;
  readonly role?: 'CUSTOMER' | 'SUPPLIER';
}

export const ShellTimelineEntrySchema = Schema.Struct({
  occurredAt: Schema.String.check(Schema.isMinLength(1)),
  summary: stableKey,
  timelineEntryId: stableKey,
});
export type ShellTimelineEntry = Schema.Schema.Type<typeof ShellTimelineEntrySchema>;

export const ShellResourceDetailSchema = Schema.Struct({
  fields: Schema.Array(
    Schema.Struct({
      label: stableKey,
      value: Schema.String.check(Schema.isMaxLength(2000)),
    }),
  ),
  title: stableKey,
});
export type ShellResourceDetail = Schema.Schema.Type<typeof ShellResourceDetailSchema>;

export class ShellProviderUnavailableError extends Schema.TaggedError<ShellProviderUnavailableError>()(
  'ShellProviderUnavailableError',
  {},
) {}

export interface ShellResourceContext extends TrustedPrincipalContext {
  readonly correlationId: string;
  readonly legalEntityId?: string;
}

export interface ShellProviderAssertionIssuer {
  readonly issueAssertion: (input: {
    readonly appId: string;
    readonly context: ShellResourceContext;
  }) => Effect.Effect<Redacted.Redacted<string>, ShellProviderUnavailableError>;
}

export interface ShellSearchProviderGateway {
  readonly search: (input: {
    readonly appId: string;
    readonly authorization: Redacted.Redacted<string>;
    readonly correlationId: string;
    readonly includeArchived?: boolean;
    readonly query: string;
    readonly role?: 'CUSTOMER' | 'SUPPLIER';
    readonly searchKey: string;
  }) => Effect.Effect<readonly unknown[], ShellProviderUnavailableError>;
}

export interface ShellResourceProviderGateway {
  readonly detail: (input: {
    readonly apiKey: string;
    readonly appId: string;
    readonly authorization: Redacted.Redacted<string>;
    readonly correlationId: string;
    readonly ref: ResourceRef;
  }) => Effect.Effect<unknown, ShellProviderUnavailableError>;
  readonly timeline: (input: {
    readonly apiKey: string;
    readonly appId: string;
    readonly authorization: Redacted.Redacted<string>;
    readonly correlationId: string;
    readonly ref: ResourceRef;
  }) => Effect.Effect<
    { readonly entries: readonly unknown[]; readonly projectionLagging: boolean },
    ShellProviderUnavailableError
  >;
}

export interface ShellResourceGateways {
  readonly resource: ShellResourceProviderGateway;
  readonly search: ShellSearchProviderGateway;
}

interface ShellResourceDependencies extends ShellProviderAssertionIssuer {
  readonly catalog: Effect.Effect<InstalledModuleCatalog, unknown>;
  readonly contextAccess: ContextAccessService;
  readonly moduleStates: Pick<TenantModuleStateServiceContract, 'getTenantModuleStates'>;
}

const unavailable = () => new ShellProviderUnavailableError();
const capture = <Success, Failure, Requirements>(
  effect: Effect.Effect<Success, Failure, Requirements>,
): Effect.Effect<
  { readonly ok: false } | { readonly ok: true; readonly value: Success },
  never,
  Requirements
> =>
  Effect.exit(effect).pipe(
    Effect.map((exit) =>
      Exit.isSuccess(exit) ? ({ ok: true, value: exit.value } as const) : ({ ok: false } as const),
    ),
  );
const resourceKey = ({ moduleId, resourceId, resourceType }: ResourceRef): string =>
  `${moduleId}:${resourceType}:${resourceId}`;

const loadState = (
  dependencies: ShellResourceDependencies,
  context: ShellResourceContext,
  moduleId: string,
): Effect.Effect<TenantModuleState | undefined, ShellProviderUnavailableError> =>
  dependencies.moduleStates.getTenantModuleStates(context.tenantId, [moduleId]).pipe(
    Effect.mapError(unavailable),
    Effect.flatMap((records) => {
      const [record, ...unexpected] = records;
      if (record === undefined) {
        // eslint-disable-next-line unicorn/no-useless-undefined -- The Effect success channel distinguishes a missing state record from a failed acquisition.
        return Effect.succeed<TenantModuleState | undefined>(undefined);
      }
      return unexpected.length === 0 && record.moduleKey === moduleId
        ? Effect.succeed(record.state)
        : Effect.fail(unavailable());
    }),
  );

const moduleDecision = (
  dependencies: ShellResourceDependencies,
  context: ShellResourceContext,
  moduleId: string,
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
  dependencies: ShellResourceDependencies,
  context: ShellResourceContext,
  ref: ResourceRef,
) =>
  context.legalEntityId === undefined
    ? Effect.succeed([{ decision: 'unavailable' as const, key: resourceKey(ref) }])
    : dependencies.contextAccess.resources({
        legalEntityId: context.legalEntityId,
        principalId: context.principalId,
        resources: [ref],
        tenantId: context.tenantId,
      });

const resultBelongsToProvider = (
  context: ShellResourceContext,
  provider: {
    readonly descriptor: { readonly resourceType: string };
    readonly moduleId: string;
  },
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
  return (
    context.legalEntityId !== undefined &&
    result.ref.tenantId === context.tenantId &&
    result.party.ref.tenantId === context.tenantId &&
    result.legalEntity.tenantId === context.tenantId &&
    result.legalEntity.legalEntityId === context.legalEntityId &&
    (result.collision?.counterpartyRefs.every(
      (ref) =>
        ref.tenantId === context.tenantId &&
        ref.moduleId === provider.moduleId &&
        ref.resourceType === provider.descriptor.resourceType,
    ) ??
      true)
  );
};

const normalizeProviderResult = (
  value: Schema.Schema.Type<typeof RawShellSearchResultSchema>,
): ShellSearchResult => {
  if ('currentRoles' in value) {
    return {
      ...value,
      kind: 'counterparty',
      legalEntity: value.legalEntity,
      party: value.party,
      ref: value.ref,
      title: value.party.title,
    };
  }
  if ('archived' in value) {
    return { ...value, kind: 'party' };
  }
  return { ...value, kind: 'resource' };
};

export const makeShellSearch = (
  dependencies: ShellResourceDependencies,
  gateway: ShellSearchProviderGateway,
) => ({
  search: (
    context: ShellResourceContext,
    request: ShellSearchRequest | string,
  ): Effect.Effect<
    { readonly partial: boolean; readonly results: readonly ShellSearchResult[] },
    ShellProviderUnavailableError
  > =>
    Effect.gen(function* shellSearchEffect() {
      const searchRequest = Schema.is(Schema.String)(request) ? { query: request } : request;
      const normalizedQuery = searchRequest.query.trim();
      if (normalizedQuery.length === 0) {
        return { partial: false, results: [] } as const;
      }
      const catalog = yield* dependencies.catalog.pipe(Effect.mapError(unavailable));
      const providers = catalog.contracts.flatMap((contract) =>
        contract.manifest.publicSurface.shellContributions.search.flatMap((contribution) => {
          const descriptor = contract.manifest.publicSurface.search.find(
            ({ key }) => key === contribution.searchKey,
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
        }),
      );
      const moduleIds = [...new Set(providers.map(({ moduleId }) => moduleId))].toSorted();
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
      const stateByModule = new Map(states.map(({ moduleKey, state }) => [moduleKey, state]));
      const stateEligible = providers.filter(({ contribution, moduleId }) => {
        const state = stateByModule.get(moduleId);
        return (
          state !== undefined &&
          decideModuleStateAccess(state, contribution.entrypoint.access) === 'allow'
        );
      });
      const permissionOutcomes = yield* Effect.forEach(stateEligible, (provider) => {
        if (provider.descriptor.accessFiltering === 'tenant_scope') {
          const permission = provider.descriptor.tenantPermission;
          if (permission === undefined) {
            return Effect.succeed({ decision: 'unavailable' as const, provider });
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
                  decisions.length === 1 && decisions[0]?.key === context.tenantId
                    ? decisions[0].decision
                    : ('unavailable' as const),
                provider,
              })),
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
                decisions.length === 1 && decisions[0]?.key === provider.moduleId
                  ? decisions[0].decision
                  : ('unavailable' as const),
              provider,
            })),
          );
      });
      if (permissionOutcomes.some(({ decision }) => decision === 'unavailable')) {
        return yield* unavailable();
      }
      const eligible = permissionOutcomes.flatMap(({ decision, provider }) =>
        decision === 'allowed' ? [provider] : [],
      );
      if (eligible.length === 0) {
        return { partial: false, results: [] } as const;
      }
      const attempts = yield* Effect.forEach(eligible, (provider) =>
        dependencies
          .issueAssertion({ appId: provider.appId, context })
          .pipe(
            Effect.flatMap((authorization) => {
              const providerRequest: Parameters<ShellSearchProviderGateway['search']>[0] = {
                appId: provider.appId,
                authorization,
                correlationId: context.correlationId,
                query: normalizedQuery,
                searchKey: provider.contribution.searchKey,
              };
              const archiveFiltered =
                provider.descriptor.requestFilters?.includes('includeArchived') === true &&
                searchRequest.includeArchived !== undefined
                  ? { ...providerRequest, includeArchived: searchRequest.includeArchived }
                  : providerRequest;
              const roleFiltered =
                provider.descriptor.requestFilters?.includes('role') === true &&
                searchRequest.role !== undefined
                  ? { ...archiveFiltered, role: searchRequest.role }
                  : archiveFiltered;
              return gateway.search(roleFiltered);
            }),
          )
          .pipe(
            Effect.flatMap((values) =>
              Effect.try({
                catch: unavailable,
                try: () =>
                  values.map((value) =>
                    normalizeProviderResult(
                      Schema.decodeUnknownSync(RawShellSearchResultSchema, {
                        onExcessProperty: 'error',
                      })(value),
                    ),
                  ),
              }),
            ),
            capture,
            Effect.map((result) => ({ provider, result })),
          ),
      );
      const succeeded = attempts.filter(({ result }) => result.ok);
      if (succeeded.length === 0) {
        return yield* unavailable();
      }
      const candidates = succeeded.flatMap(({ provider, result }) =>
        result.ok
          ? result.value
              .filter((value) => resultBelongsToProvider(context, provider, value))
              .map((value) => ({ provider, value }))
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
        return { partial: succeeded.length !== attempts.length, results: [] } as const;
      }
      const resourceCandidates = uniqueCandidates.filter(
        ({ provider }) => provider.descriptor.accessFiltering === 'resource_permission',
      );
      const resourcesToAuthorize = [
        ...new Map(
          resourceCandidates
            .flatMap(({ value }) => [
              value.ref,
              ...(value.kind === 'counterparty' ? (value.collision?.counterpartyRefs ?? []) : []),
            ])
            .map((ref) => [resourceKey(ref), ref]),
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
            candidate === undefined || key !== resourceKey(candidate) || decision === 'unavailable'
          );
        })
      ) {
        return yield* unavailable();
      }
      const allowedKeys = new Set(
        resourcePermissions.flatMap(({ decision, key }) => (decision === 'allowed' ? [key] : [])),
      );
      const results = uniqueCandidates
        .filter(
          ({ provider, value }) =>
            provider.descriptor.accessFiltering !== 'resource_permission' ||
            allowedKeys.has(resourceKey(value.ref)),
        )
        .map(({ value }) => {
          if (value.kind !== 'counterparty' || value.collision === undefined) {
            return value;
          }
          const { collision, ...visible } = value;
          const counterpartyRefs = collision.counterpartyRefs.filter((ref) =>
            allowedKeys.has(resourceKey(ref)),
          );
          return counterpartyRefs.length < 2
            ? visible
            : {
                ...visible,
                collision: { ...collision, counterpartyRefs },
              };
        })
        .toSorted(
          (left, right) =>
            left.title.localeCompare(right.title) ||
            left.ref.resourceId.localeCompare(right.ref.resourceId),
        );
      return {
        partial: succeeded.length !== attempts.length,
        results,
      } as const;
    }),
});

export type ShellResourceResolution =
  | { readonly outcome: 'forbidden' | 'not_found' | 'unavailable' }
  | {
      readonly detail: ShellResourceDetail;
      readonly media: MediaAffordance;
      readonly outcome: 'resolved';
      readonly projectionLagging: boolean;
      readonly timeline: readonly ShellTimelineEntry[];
    };

export const makeShellResourceDetail = (
  dependencies: ShellResourceDependencies,
  gateway: ShellResourceProviderGateway,
) => ({
  resolve: (
    context: ShellResourceContext,
    ref: ResourceRef,
  ): Effect.Effect<ShellResourceResolution> =>
    Effect.gen(function* shellResourceDetailEffect() {
      const catalogResult = yield* capture(dependencies.catalog);
      if (!catalogResult.ok) {
        return { outcome: 'unavailable' } as const;
      }
      const contract = catalogResult.value.getByModuleId(ref.moduleId);
      const resourceType = contract?.manifest.publicSurface.resourceTypes.find(
        ({ key }) => key === ref.resourceType,
      );
      if (contract === undefined || resourceType === undefined) {
        return { outcome: 'not_found' } as const;
      }
      const contributions = contract.manifest.publicSurface.shellContributions;
      const detailBinding = contributions.resourceDetails.find(
        ({ resourceType: key }) => key === ref.resourceType,
      );
      if (detailBinding === undefined) {
        return { outcome: 'not_found' } as const;
      }
      const stateResult = yield* capture(loadState(dependencies, context, ref.moduleId));
      if (!stateResult.ok) {
        return { outcome: 'unavailable' } as const;
      }
      if (
        stateResult.value === undefined ||
        decideModuleStateAccess(stateResult.value, detailBinding.entrypoint.access) === 'deny'
      ) {
        return { outcome: 'not_found' } as const;
      }
      const [moduleAccess, ...unexpectedModules] = yield* moduleDecision(
        dependencies,
        context,
        ref.moduleId,
      );
      if (
        unexpectedModules.length > 0 ||
        moduleAccess?.key !== ref.moduleId ||
        moduleAccess.decision === 'unavailable'
      ) {
        return { outcome: 'unavailable' } as const;
      }
      if (moduleAccess.decision === 'denied') {
        return { outcome: 'forbidden' } as const;
      }
      const [resourceAccess, ...unexpectedResources] = yield* resourceDecision(
        dependencies,
        context,
        ref,
      );
      if (
        unexpectedResources.length > 0 ||
        resourceAccess?.key !== resourceKey(ref) ||
        resourceAccess.decision === 'unavailable'
      ) {
        return { outcome: 'unavailable' } as const;
      }
      if (resourceAccess.decision === 'denied') {
        return { outcome: 'forbidden' } as const;
      }
      let media: MediaAffordance = { enabled: false, reason: 'absent' };
      const mediaBinding = contributions.mediaAttachments.find(
        ({ resourceType: key }) => key === ref.resourceType,
      );
      if (resourceType.capabilities.mediaAttachable && mediaBinding !== undefined) {
        media =
          stateResult.value !== 'active'
            ? { enabled: false, reason: 'read_only' }
            : { enabled: false, reason: 'unavailable' };
      }
      const detailAuthorization = yield* capture(
        dependencies.issueAssertion({ appId: contract.deployment.appId, context }),
      );
      if (!detailAuthorization.ok) {
        return { outcome: 'unavailable' } as const;
      }
      const detailResult = yield* capture(
        gateway.detail({
          apiKey: detailBinding.apiKey,
          appId: contract.deployment.appId,
          authorization: detailAuthorization.value,
          correlationId: context.correlationId,
          ref,
        }),
      );
      if (!detailResult.ok) {
        return { outcome: 'unavailable' } as const;
      }
      const decodedDetail = yield* capture(
        Effect.try({
          catch: unavailable,
          try: () =>
            Schema.decodeUnknownSync(ShellResourceDetailSchema, {
              onExcessProperty: 'error',
            })(detailResult.value),
        }),
      );
      if (!decodedDetail.ok) {
        return { outcome: 'unavailable' } as const;
      }
      const timelineBinding = contributions.timelines.find(
        ({ resourceType: key }) => key === ref.resourceType,
      );
      if (timelineBinding === undefined || !resourceType.capabilities.timelineVisible) {
        return {
          detail: decodedDetail.value,
          media,
          outcome: 'resolved',
          projectionLagging: false,
          timeline: [],
        } as const;
      }
      const timelineAuthorization = yield* capture(
        dependencies.issueAssertion({ appId: contract.deployment.appId, context }),
      );
      if (!timelineAuthorization.ok) {
        return { outcome: 'unavailable' } as const;
      }
      const timelineResult = yield* capture(
        gateway.timeline({
          apiKey: timelineBinding.apiKey,
          appId: contract.deployment.appId,
          authorization: timelineAuthorization.value,
          correlationId: context.correlationId,
          ref,
        }),
      );
      if (!timelineResult.ok) {
        return { outcome: 'unavailable' } as const;
      }
      const timeline = yield* capture(
        Effect.try({
          catch: unavailable,
          try: () =>
            timelineResult.value.entries
              .map((entry) =>
                Schema.decodeUnknownSync(ShellTimelineEntrySchema, {
                  onExcessProperty: 'error',
                })(entry),
              )
              .toSorted(
                (left, right) =>
                  right.occurredAt.localeCompare(left.occurredAt) ||
                  left.timelineEntryId.localeCompare(right.timelineEntryId),
              ),
        }),
      );
      return timeline.ok
        ? ({
            detail: decodedDetail.value,
            media,
            outcome: 'resolved',
            projectionLagging: timelineResult.value.projectionLagging,
            timeline: timeline.value,
          } as const)
        : ({ outcome: 'unavailable' } as const);
    }).pipe(Effect.orElseSucceed(() => ({ outcome: 'unavailable' as const }))),
});

export type MediaAffordance =
  | { readonly enabled: true; readonly reason: 'available' }
  | {
      readonly enabled: false;
      readonly reason: 'absent' | 'forbidden' | 'read_only' | 'unavailable';
    };

export type ShellMediaAttachmentResolution =
  | { readonly outcome: 'forbidden' | 'not_found' | 'unavailable' }
  | { readonly outcome: 'resolved'; readonly result: { readonly attached: true } };

export const attachShellMedia = (
  _context: ShellResourceContext,
  _ref: ResourceRef,
): Effect.Effect<ShellMediaAttachmentResolution> =>
  Effect.succeed({ outcome: 'unavailable' as const });

export interface ShellResourceServicesFactoryService {
  readonly createResourceDetail: typeof makeShellResourceDetail;
  readonly createSearch: typeof makeShellSearch;
}

export class ShellResourceServicesFactory extends Context.Service<
  ShellResourceServicesFactory,
  ShellResourceServicesFactoryService
>()('@app/shell-super-app/api/modules/shell-resources/ShellResourceServicesFactory') {}

export const ShellResourceServicesFactoryLive = Layer.succeed(
  ShellResourceServicesFactory,
  Object.freeze({
    createResourceDetail: makeShellResourceDetail,
    createSearch: makeShellSearch,
  }),
);
