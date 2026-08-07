/* eslint-disable complexity, max-classes-per-file, no-negated-condition, promise/prefer-await-to-then, unicorn/no-array-method-this-argument, unicorn/no-negated-condition -- Search/resource/media orchestration keeps its closed gate ordering visible in one module. */
import type {
  ContextAccessShape,
  InstalledModuleCatalog,
  TenantModuleState,
  TenantModuleStateServiceShape,
} from '@app/core-runtime';
import { decideModuleStateAccess } from '@app/core-runtime';
import { Effect, Exit, Schema } from 'effect';

const stableKey = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300));

export const ResourceRefSchema = Schema.Struct({
  moduleId: stableKey,
  resourceId: stableKey,
  resourceType: stableKey,
});
export type ResourceRef = Schema.Schema.Type<typeof ResourceRefSchema>;

export const ShellSearchResultSchema = Schema.Struct({
  ref: ResourceRefSchema,
  title: stableKey,
});
export type ShellSearchResult = Schema.Schema.Type<typeof ShellSearchResultSchema>;

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

export class ShellProviderUnavailableError extends Schema.TaggedErrorClass<ShellProviderUnavailableError>()(
  'ShellProviderUnavailableError',
  {},
) {}

export interface ShellResourceContext {
  readonly correlationId: string;
  readonly legalEntityId: string;
  readonly principalId: string;
  readonly tenantId: string;
}

export interface ShellSearchProviderGateway {
  readonly search: (input: {
    readonly appId: string;
    readonly context: ShellResourceContext;
    readonly query: string;
    readonly searchKey: string;
  }) => Effect.Effect<readonly unknown[], ShellProviderUnavailableError>;
}

export interface ShellResourceProviderGateway {
  readonly attachMedia?: (input: {
    readonly apiKey: string;
    readonly appId: string;
    readonly context: ShellResourceContext;
    readonly ref: ResourceRef;
  }) => Effect.Effect<{ readonly attached: true }, ShellProviderUnavailableError>;
  readonly detail: (input: {
    readonly apiKey: string;
    readonly appId: string;
    readonly context: ShellResourceContext;
    readonly ref: ResourceRef;
  }) => Effect.Effect<unknown, ShellProviderUnavailableError>;
  readonly timeline: (input: {
    readonly apiKey: string;
    readonly appId: string;
    readonly context: ShellResourceContext;
    readonly ref: ResourceRef;
  }) => Effect.Effect<
    { readonly entries: readonly unknown[]; readonly projectionLagging: boolean },
    ShellProviderUnavailableError
  >;
}

interface ShellResourceDependencies {
  readonly catalog: Effect.Effect<InstalledModuleCatalog, unknown>;
  readonly contextAccess: ContextAccessShape;
  readonly moduleStates: Pick<TenantModuleStateServiceShape, 'getTenantModuleStates'>;
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
  dependencies.contextAccess.modules({
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
  dependencies.contextAccess.resources({
    legalEntityId: context.legalEntityId,
    principalId: context.principalId,
    resources: [ref],
    tenantId: context.tenantId,
  });

export const makeShellSearch = (
  dependencies: ShellResourceDependencies,
  gateway: ShellSearchProviderGateway,
) => ({
  search: (
    context: ShellResourceContext,
    query: string,
  ): Effect.Effect<
    { readonly partial: boolean; readonly results: readonly ShellSearchResult[] },
    ShellProviderUnavailableError
  > =>
    Effect.gen(function* shellSearchEffect() {
      const normalizedQuery = query.trim();
      if (normalizedQuery.length === 0) {
        return { partial: false, results: [] } as const;
      }
      const catalog = yield* dependencies.catalog.pipe(Effect.mapError(unavailable));
      const providers = catalog.contracts.flatMap((contract) =>
        contract.manifest.publicSurface.shellContributions.search.map((contribution) => ({
          appId: contract.deployment.appId,
          contribution,
          moduleId: contract.manifest.module.id,
        })),
      );
      const moduleIds = [...new Set(providers.map(({ moduleId }) => moduleId))].toSorted();
      if (moduleIds.length === 0) {
        return { partial: false, results: [] } as const;
      }
      const [states, permissions] = yield* Effect.all([
        dependencies.moduleStates
          .getTenantModuleStates(context.tenantId, moduleIds)
          .pipe(Effect.mapError(unavailable)),
        dependencies.contextAccess.modules({
          legalEntityId: context.legalEntityId,
          moduleIds,
          principalId: context.principalId,
          tenantId: context.tenantId,
        }),
      ]);
      const stateKeys = states.map(({ moduleKey }) => moduleKey);
      if (
        new Set(stateKeys).size !== stateKeys.length ||
        stateKeys.some((moduleId) => !moduleIds.includes(moduleId))
      ) {
        return yield* unavailable();
      }
      const stateByModule = new Map(states.map(({ moduleKey, state }) => [moduleKey, state]));
      const permissionByModule = new Map(permissions.map(({ decision, key }) => [key, decision]));
      if (
        permissions.length !== moduleIds.length ||
        permissions.some(({ key }, index) => key !== moduleIds[index])
      ) {
        return yield* unavailable();
      }
      const stateEligible = providers.filter(({ contribution, moduleId }) => {
        const state = stateByModule.get(moduleId);
        return (
          state !== undefined &&
          decideModuleStateAccess(state, contribution.entrypoint.access) === 'allow'
        );
      });
      if (
        stateEligible.some(({ moduleId }) => permissionByModule.get(moduleId) === 'unavailable')
      ) {
        return yield* unavailable();
      }
      const eligible = stateEligible.filter(
        ({ moduleId }) => permissionByModule.get(moduleId) === 'allowed',
      );
      if (eligible.length === 0) {
        return { partial: false, results: [] } as const;
      }
      const attempts = yield* Effect.forEach(eligible, (provider) =>
        gateway
          .search({
            appId: provider.appId,
            context,
            query: normalizedQuery,
            searchKey: provider.contribution.searchKey,
          })
          .pipe(
            Effect.flatMap((values) =>
              Effect.try({
                catch: unavailable,
                try: () =>
                  values.map((value) =>
                    Schema.decodeUnknownSync(ShellSearchResultSchema, {
                      onExcessProperty: 'error',
                    })(value),
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
          ? result.value.filter(
              ({ ref }) =>
                ref.moduleId === provider.moduleId &&
                ref.resourceType ===
                  catalog
                    .getByModuleId(provider.moduleId)
                    ?.manifest.publicSurface.search.find(
                      ({ key }) => key === provider.contribution.searchKey,
                    )?.resourceType,
            )
          : [],
      );
      const uniqueCandidates = [
        ...new Map(candidates.map((candidate) => [resourceKey(candidate.ref), candidate])).values(),
      ];
      if (uniqueCandidates.length === 0) {
        return { partial: succeeded.length !== attempts.length, results: [] } as const;
      }
      const resourcePermissions = yield* dependencies.contextAccess.resources({
        legalEntityId: context.legalEntityId,
        principalId: context.principalId,
        resources: uniqueCandidates.map(({ ref }) => ref),
        tenantId: context.tenantId,
      });
      if (
        resourcePermissions.length !== uniqueCandidates.length ||
        resourcePermissions.some(({ decision, key }, index) => {
          const candidate = uniqueCandidates[index];
          return (
            candidate === undefined ||
            key !== resourceKey(candidate.ref) ||
            decision === 'unavailable'
          );
        })
      ) {
        return yield* unavailable();
      }
      const allowedKeys = new Set(
        resourcePermissions.flatMap(({ decision, key }) => (decision === 'allowed' ? [key] : [])),
      );
      const results = uniqueCandidates
        .filter(({ ref }) => allowedKeys.has(resourceKey(ref)))
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
        if (stateResult.value !== 'active') {
          media = { enabled: false, reason: 'read_only' };
        } else if (gateway.attachMedia === undefined) {
          media = { enabled: false, reason: 'unavailable' };
        } else {
          const [writeAccess, ...unexpectedWrites] = yield* dependencies.contextAccess.resources({
            legalEntityId: context.legalEntityId,
            permission: 'write',
            principalId: context.principalId,
            resources: [ref],
            tenantId: context.tenantId,
          });
          if (
            unexpectedWrites.length > 0 ||
            writeAccess === undefined ||
            writeAccess.key !== resourceKey(ref) ||
            writeAccess.decision === 'unavailable'
          ) {
            media = { enabled: false, reason: 'unavailable' };
          } else if (writeAccess.decision === 'allowed') {
            media = { enabled: true, reason: 'available' };
          } else {
            media = { enabled: false, reason: 'forbidden' };
          }
        }
      }
      const detailResult = yield* capture(
        gateway.detail({
          apiKey: detailBinding.apiKey,
          appId: contract.deployment.appId,
          context,
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
      const timelineResult = yield* capture(
        gateway.timeline({
          apiKey: timelineBinding.apiKey,
          appId: contract.deployment.appId,
          context,
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
    }).pipe(Effect.catch(() => Effect.succeed({ outcome: 'unavailable' as const }))),
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

export const makeShellMediaAttachment = (
  dependencies: ShellResourceDependencies,
  gateway: ShellResourceProviderGateway,
) => ({
  attach: (
    context: ShellResourceContext,
    ref: ResourceRef,
  ): Effect.Effect<ShellMediaAttachmentResolution> =>
    Effect.gen(function* shellMediaAttachmentEffect() {
      const catalogResult = yield* capture(dependencies.catalog);
      if (!catalogResult.ok) {
        return { outcome: 'unavailable' } as const;
      }
      const contract = catalogResult.value.getByModuleId(ref.moduleId);
      const resourceType = contract?.manifest.publicSurface.resourceTypes.find(
        ({ key }) => key === ref.resourceType,
      );
      const binding = contract?.manifest.publicSurface.shellContributions.mediaAttachments.find(
        ({ resourceType: key }) => key === ref.resourceType,
      );
      if (
        contract === undefined ||
        resourceType?.capabilities.mediaAttachable !== true ||
        binding === undefined
      ) {
        return { outcome: 'not_found' } as const;
      }
      if (gateway.attachMedia === undefined) {
        return { outcome: 'unavailable' } as const;
      }
      const stateResult = yield* capture(loadState(dependencies, context, ref.moduleId));
      if (!stateResult.ok) {
        return { outcome: 'unavailable' } as const;
      }
      if (stateResult.value === undefined) {
        return { outcome: 'not_found' } as const;
      }
      if (decideModuleStateAccess(stateResult.value, binding.entrypoint.access) === 'deny') {
        return { outcome: 'forbidden' } as const;
      }
      const [moduleAccess, ...unexpectedModules] = yield* moduleDecision(
        dependencies,
        context,
        ref.moduleId,
      );
      const [writeAccess, ...unexpectedWrites] = yield* dependencies.contextAccess.resources({
        legalEntityId: context.legalEntityId,
        permission: 'write',
        principalId: context.principalId,
        resources: [ref],
        tenantId: context.tenantId,
      });
      if (
        unexpectedModules.length > 0 ||
        unexpectedWrites.length > 0 ||
        moduleAccess === undefined ||
        writeAccess === undefined ||
        moduleAccess.key !== ref.moduleId ||
        writeAccess.key !== resourceKey(ref) ||
        moduleAccess.decision === 'unavailable' ||
        writeAccess.decision === 'unavailable'
      ) {
        return { outcome: 'unavailable' } as const;
      }
      if (moduleAccess.decision === 'denied' || writeAccess.decision === 'denied') {
        return { outcome: 'forbidden' } as const;
      }
      const result = yield* capture(
        gateway.attachMedia({
          apiKey: binding.apiKey,
          appId: contract.deployment.appId,
          context,
          ref,
        }),
      );
      return result.ok
        ? ({ outcome: 'resolved', result: result.value } as const)
        : ({ outcome: 'unavailable' } as const);
    }).pipe(Effect.catch(() => Effect.succeed({ outcome: 'unavailable' as const }))),
});
