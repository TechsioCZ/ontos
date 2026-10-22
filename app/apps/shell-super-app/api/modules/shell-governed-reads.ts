import {
  ContextAccess,
  ReadHandlerNotFound,
  ReadHandlerUnavailable,
  ReadPermissionDenied,
  ReadRuntime,
  TenantModuleStateService,
  defineRead,
  defineSystemModuleEntrypoint,
} from '@app/core-runtime';
import type {
  ReadCoreError,
  ReadHandlerResult,
  TrustedPrincipalContext,
  TenantModuleStateServiceContract,
  makeTenantModuleStateService,
} from '@app/core-runtime';
import { makeLegalEntityNavigationExclusions } from '@app/core-runtime/modules/legal-entity-navigation-exclusions';
import { Context, Effect, Layer, Schema } from 'effect';

import {
  ResourceRefSchema,
  ShellCompositionSchema,
  ShellResourceResponseSchema,
  ShellSearchPayloadSchema,
  ShellSearchResponseSchema,
} from '../../shared/api.ts';
import type {
  ResourceRef,
  ResolvedModuleTarget,
  ShellComposition,
  ShellResourceResponse,
  ShellSearchResponse,
} from '../../shared/api.ts';
import { capturedShellCatalog } from './captured-shell-catalog.ts';
import { ShellCompositionFactory } from './shell-composition.ts';
import type { ShellModuleTargetSelector } from './shell-composition.ts';
import {
  GovernedResolvedModuleTargetSchema,
  GovernedResolveModuleTargetPayloadSchema,
} from './shell-governed-read-schemas.ts';
import { searchProviderModuleIds, ShellResourceServicesFactory } from './shell-resources.ts';
import type { ShellProviderAssertionIssuer, ShellResourceGateways } from './shell-resources.ts';

const withOptionalProperty = <Base extends object, Key extends PropertyKey, Value, Trailing extends object>(
  base: Base,
  condition: boolean,
  key: Key,
  value: Value,
  trailing: Trailing,
) => (condition ? { ...base, [key]: value, ...trailing } : { ...base, ...trailing });

type MutableModuleTargetSelector = {
  -readonly [Key in keyof ShellModuleTargetSelector]: ShellModuleTargetSelector[Key];
};

interface ShellReadRequest {
  readonly correlationId: string;
  readonly principal: TrustedPrincipalContext;
}

export type ShellScopedModuleStateFactory = (
  transaction: Parameters<typeof makeTenantModuleStateService>[0]['executor'],
) => TenantModuleStateServiceContract;

export interface ShellGovernedReadsService {
  readonly composition: (input: ShellReadRequest) => Effect.Effect<ShellComposition, ReadCoreError>;
  readonly moduleTarget: (
    input: ShellReadRequest & {
      readonly canonicalPath?: string;
      /** Absent: resolve against the current release; the caller compares the returned revision. */
      readonly compositionRevision?: string;
      readonly entrypointKey?: string;
      readonly moduleId?: string;
    },
  ) => Effect.Effect<ResolvedModuleTarget, ReadCoreError>;
  readonly resourceDetail: (
    input: ShellReadRequest & { readonly ref: ResourceRef },
  ) => Effect.Effect<ShellResourceResponse, ReadCoreError>;
  readonly search: (
    input: ShellReadRequest & {
      readonly compositionRevision: string;
      readonly includeArchived?: boolean;
      readonly query: string;
      readonly role?: 'CUSTOMER' | 'SUPPLIER';
    },
  ) => Effect.Effect<ShellSearchResponse, ReadCoreError>;
}

export class ShellGovernedReads extends Context.Service<ShellGovernedReads, ShellGovernedReadsService>()(
  '@app/shell-super-app/api/modules/shell-governed-reads/ShellGovernedReads',
) {}

const emptyInput = Schema.Struct({});
const compositionEntrypoint = defineSystemModuleEntrypoint({
  access: 'read',
  authorization: { kind: 'context_permission', permission: 'module.access' },
  entrypointKey: 'core.shell.composition',
  moduleKey: 'core.shell',
  role: 'api',
});
const searchEntrypoint = defineSystemModuleEntrypoint({
  access: 'read',
  authorization: { kind: 'context_permission', permission: 'module.access' },
  entrypointKey: 'core.shell.search',
  moduleKey: 'core.shell',
  role: 'search',
});
const moduleTargetEntrypoint = defineSystemModuleEntrypoint({
  access: 'read',
  authorization: { kind: 'context_permission', permission: 'module.access' },
  entrypointKey: 'core.shell.module-target',
  moduleKey: 'core.shell',
  role: 'api',
});
const resourceDetailEntrypoint = defineSystemModuleEntrypoint({
  access: 'read',
  authorization: { kind: 'context_permission', permission: 'module.access' },
  entrypointKey: 'core.shell.resource-detail-timeline',
  moduleKey: 'core.shell',
  role: 'api',
});

const makeRegistrations = Effect.fn('ShellGovernedReads.makeRegistrations')(function* makeShellRegistrations(
  ...[gateways, assertionIssuer, scopedModuleStateFactory]: readonly [
    ShellResourceGateways,
    ShellProviderAssertionIssuer,
    ShellScopedModuleStateFactory,
  ]
) {
  const contextAccess = yield* ContextAccess;
  const moduleStates = yield* TenantModuleStateService;
  const compositionFactory = yield* ShellCompositionFactory;
  const resourceServicesFactory = yield* ShellResourceServicesFactory;
  const dependencies = {
    ...assertionIssuer,
    catalog: capturedShellCatalog,
    contextAccess,
    moduleStates,
  };
  // Catalog and SpiceDB decisions run before and after the governed-read transaction; it holds tenant data only.
  const compositionAccess = compositionFactory.access(dependencies);
  const serviceFactory = (transaction: Parameters<typeof makeTenantModuleStateService>[0]['executor']) => {
    const moduleStatesInTransaction = scopedModuleStateFactory(transaction);
    return Effect.succeed(
      Object.freeze({
        composition: compositionFactory.data({
          moduleStates: moduleStatesInTransaction,
          navigationExclusions: makeLegalEntityNavigationExclusions({ executor: transaction }),
        }),
        moduleStates: moduleStatesInTransaction,
      }),
    );
  };
  const unavailableBecause = (reason: string) => (cause: unknown) =>
    Object.defineProperty(new ReadHandlerUnavailable({ code: 'read_handler_unavailable', reason }), 'cause', {
      configurable: true,
      value: cause,
    });
  /**
   * Search and resource detail read only module states in the transaction. Their provider calls and SpiceDB
   * checks run after commit against exactly the states that transaction read.
   */
  const loadModuleStates = (
    services: Effect.Success<ReturnType<typeof serviceFactory>>,
    tenantId: string,
    moduleIds: readonly string[],
  ) =>
    services.moduleStates
      .getTenantModuleStates(tenantId, moduleIds)
      .pipe(Effect.mapError(unavailableBecause('Shell module states are temporarily unavailable')));
  const committedModuleStates = (records: Effect.Success<ReturnType<typeof loadModuleStates>>) => ({
    getTenantModuleStates: (_tenantId: string, moduleIds: readonly string[]) => {
      const requested = new Set(moduleIds);
      return Effect.succeed(records.filter((record) => requested.has(record.moduleKey)));
    },
  });
  const compositionUnavailable = unavailableBecause('Shell composition is temporarily unavailable');
  const moduleTargetUnavailable = unavailableBecause('The Shell module target is temporarily unavailable');
  const composition = defineRead(
    {
      accessKind: 'list',
      entrypoint: compositionEntrypoint,
      evidencePolicy: {
        captureMode: 'metadata_only',
        policyKey: 'core.shell.composition.evidence.v1',
      },
      inputSchema: emptyInput,
      legalEntityScope: 'required',
      owningModuleKey: 'core.shell',
      permissionTarget: 'legal_entity',
      policies: [],
      readKey: 'core.shell.composition',
      resultSchema: ShellCompositionSchema,
      schemaVersion: '1',
    },
    {
      // oxlint-disable perfectionist/sort-objects -- Read steps stay in execution order; each step's types infer from the previous one.
      prepare: (_input, context) =>
        compositionAccess.authorizeComposition(context.scope).pipe(Effect.mapError(compositionUnavailable)),
      load: (_input, context) =>
        context.services.composition
          .loadComposition(context.scope, context.prepared)
          .pipe(Effect.mapError(compositionUnavailable)),
      finish: (_input, context) =>
        compositionAccess.finishComposition(context.prepared, context.loaded).pipe(
          Effect.map((result) => ({
            evidence: { resultCount: result.navigation.length },
            result,
          })),
          Effect.mapError(compositionUnavailable),
        ),
      // oxlint-enable perfectionist/sort-objects
    },
    serviceFactory,
    () => ({ kind: 'legal_entity' }),
  );
  const search = defineRead(
    {
      accessKind: 'search',
      entrypoint: searchEntrypoint,
      evidencePolicy: {
        captureMode: 'metadata_only',
        policyKey: 'core.shell.search.evidence.v1',
      },
      inputSchema: ShellSearchPayloadSchema,
      legalEntityScope: 'optional',
      owningModuleKey: 'core.shell',
      permissionTarget: 'tenant',
      policies: [],
      readKey: 'core.shell.search',
      resultSchema: ShellSearchResponseSchema,
      schemaVersion: '1',
    },
    {
      // oxlint-disable perfectionist/sort-objects -- Read steps stay in execution order; each step's types infer from the previous one.
      load: (_request, context) =>
        capturedShellCatalog.pipe(
          Effect.map(searchProviderModuleIds),
          // An unavailable catalog fails the search itself after commit.
          Effect.orElseSucceed((): readonly string[] => []),
          Effect.flatMap((moduleIds) => loadModuleStates(context.services, context.scope.tenantId, moduleIds)),
        ),
      finish: (request, context) =>
        resourceServicesFactory
          .createSearch({ ...dependencies, moduleStates: committedModuleStates(context.loaded) }, gateways.search)
          .search(context.scope, request)
          .pipe(
            Effect.map((result) => ({
              evidence: { resultCount: result.results.length },
              result,
            })),
            Effect.catchTag('ShellProviderUnavailableError', () =>
              Effect.fail(
                new ReadHandlerUnavailable({
                  code: 'read_handler_unavailable',
                  reason: 'Shell search is temporarily unavailable',
                }),
              ),
            ),
          ),
      // oxlint-enable perfectionist/sort-objects
    },
    serviceFactory,
    // Provider-specific Party tenant and Counterparty resource checks run inside the orchestrator.
    () => ({ kind: 'tenant', permission: 'access' }),
    () => [],
  );
  const moduleTarget = defineRead(
    {
      accessKind: 'detail',
      entrypoint: moduleTargetEntrypoint,
      evidencePolicy: {
        captureMode: 'metadata_only',
        policyKey: 'core.shell.module-target.evidence.v1',
      },
      inputSchema: GovernedResolveModuleTargetPayloadSchema,
      legalEntityScope: 'required',
      owningModuleKey: 'core.shell',
      permissionTarget: 'legal_entity',
      policies: [],
      readKey: 'core.shell.module-target',
      resultSchema: GovernedResolvedModuleTargetSchema,
      schemaVersion: '1',
    },
    {
      // oxlint-disable perfectionist/sort-objects -- Read steps stay in execution order; each step's types infer from the previous one.
      prepare: (input, context) =>
        compositionAccess.authorizeModuleTarget(context.scope, input).pipe(Effect.mapError(moduleTargetUnavailable)),
      load: (_input, context) =>
        context.services.composition
          .loadModuleTarget(context.scope, context.prepared)
          .pipe(Effect.mapError(moduleTargetUnavailable)),
      finish: (_input, context) =>
        Effect.succeed(compositionAccess.finishModuleTarget(context.prepared, context.loaded)).pipe(
          Effect.flatMap(
            (
              resolution,
            ): Effect.Effect<
              ReadHandlerResult<ResolvedModuleTarget>,
              ReadHandlerNotFound | ReadHandlerUnavailable | ReadPermissionDenied
            > => {
              if (resolution.outcome === 'not_found') {
                return Effect.fail(
                  new ReadHandlerNotFound({
                    code: 'read_handler_not_found',
                    reason: 'The requested module target was not found',
                  }),
                );
              }
              if (resolution.outcome === 'forbidden') {
                return Effect.fail(
                  new ReadPermissionDenied({
                    code: 'read_permission_denied',
                    reason: 'The requested module target is forbidden',
                  }),
                );
              }
              if (resolution.outcome !== 'resolved') {
                return Effect.fail(
                  new ReadHandlerUnavailable({
                    code: 'read_handler_unavailable',
                    reason: 'The Shell module target is temporarily unavailable',
                  }),
                );
              }
              return Schema.decodeEffect(GovernedResolvedModuleTargetSchema)({
                appId: resolution.appId,
                componentKey: resolution.page.componentKey,
                compositionRevision: resolution.compositionRevision,
                entrypointKey: resolution.page.entrypoint.entrypointKey,
                federation: resolution.federation,
                moduleId: resolution.moduleId,
                routeParameters: resolution.routeParameters,
                writable: resolution.writable,
              }).pipe(
                Effect.map((result) => ({
                  evidence: { resultCount: 1 },
                  result,
                })),
                Effect.mapError((cause) => {
                  const error = new ReadHandlerUnavailable({
                    code: 'read_handler_unavailable',
                    reason: 'The Shell module target is temporarily unavailable',
                  });
                  Object.defineProperty(error, 'cause', {
                    configurable: true,
                    value: cause,
                  });
                  return error;
                }),
              );
            },
          ),
        ),
      // oxlint-enable perfectionist/sort-objects
    },
    serviceFactory,
    () => ({ kind: 'legal_entity' }),
  );
  const resourceDetail = defineRead(
    {
      accessKind: 'detail',
      entrypoint: resourceDetailEntrypoint,
      evidencePolicy: {
        captureMode: 'metadata_only',
        policyKey: 'core.shell.resource-detail-timeline.evidence.v1',
      },
      inputSchema: ResourceRefSchema,
      legalEntityScope: 'required',
      owningModuleKey: 'core.shell',
      // The handler decides module access, then record existence and record access, so an unknown record of
      // an allowed agenda is "not found" while a denied agenda stays "forbidden".
      permissionTarget: 'legal_entity',
      policies: [],
      readKey: 'core.shell.resource-detail-timeline',
      resultSchema: ShellResourceResponseSchema,
      schemaVersion: '1',
    },
    {
      // oxlint-disable perfectionist/sort-objects -- Read steps stay in execution order; each step's types infer from the previous one.
      load: (ref, context) => loadModuleStates(context.services, context.scope.tenantId, [ref.moduleId]),
      finish: (ref, context) => {
        const { legalEntityId } = context.scope;
        if (legalEntityId === undefined) {
          return Effect.fail(
            new ReadHandlerUnavailable({
              code: 'read_handler_unavailable',
              reason: 'Shell resource scope is unavailable',
            }),
          );
        }
        return resourceServicesFactory
          .createResourceDetail(
            { ...dependencies, moduleStates: committedModuleStates(context.loaded) },
            gateways.resource,
          )
          .resolve({ ...context.scope, legalEntityId }, ref)
          .pipe(
            Effect.flatMap(
              (
                resolution,
              ): Effect.Effect<
                ReadHandlerResult<ShellResourceResponse>,
                ReadHandlerNotFound | ReadHandlerUnavailable | ReadPermissionDenied
              > => {
                if (resolution.outcome === 'not_found') {
                  return Effect.fail(
                    new ReadHandlerNotFound({
                      code: 'read_handler_not_found',
                      reason: 'The requested Shell resource was not found',
                    }),
                  );
                }
                if (resolution.outcome === 'forbidden') {
                  return Effect.fail(
                    new ReadPermissionDenied({
                      code: 'read_permission_denied',
                      reason: 'The requested Shell resource is forbidden',
                    }),
                  );
                }
                if (resolution.outcome !== 'resolved') {
                  return Effect.fail(
                    new ReadHandlerUnavailable({
                      code: 'read_handler_unavailable',
                      reason: 'The Shell resource provider is temporarily unavailable',
                    }),
                  );
                }
                return Effect.succeed({
                  evidence: { resultCount: 1 },
                  result: {
                    detail: resolution.detail,
                    media: resolution.media,
                    projectionLagging: resolution.projectionLagging,
                    ref,
                    timeline: resolution.timeline,
                  },
                });
              },
            ),
          );
      },
      // oxlint-enable perfectionist/sort-objects
    },
    serviceFactory,
    () => ({ kind: 'legal_entity' }),
  );
  return { composition, moduleTarget, resourceDetail, search } as const;
});

export const createShellGovernedReadsLayer = (
  ...[gateways, assertionIssuer, scopedModuleStateFactory]: readonly [
    ShellResourceGateways,
    ShellProviderAssertionIssuer,
    ShellScopedModuleStateFactory,
  ]
) =>
  Layer.effect(
    ShellGovernedReads,
    Effect.gen(function* makeShellGovernedReads() {
      const runtime = yield* ReadRuntime;
      const registrations = yield* makeRegistrations(gateways, assertionIssuer, scopedModuleStateFactory);
      return {
        composition: (request) =>
          runtime.runRead({
            input: {},
            principal: request.principal,
            registration: registrations.composition,
            transport: { correlationId: request.correlationId },
          }),
        moduleTarget: (request) => {
          const input: MutableModuleTargetSelector = {};
          if (request.compositionRevision !== undefined) {
            input.compositionRevision = request.compositionRevision;
          }
          if (request.canonicalPath !== undefined) {
            input.canonicalPath = request.canonicalPath;
          }
          if (request.entrypointKey !== undefined) {
            input.entrypointKey = request.entrypointKey;
          }
          if (request.moduleId !== undefined) {
            input.moduleId = request.moduleId;
          }
          const transport =
            request.moduleId === undefined
              ? { correlationId: request.correlationId }
              : { correlationId: request.correlationId, targetModuleKey: request.moduleId };
          return runtime.runRead({
            input,
            principal: request.principal,
            registration: registrations.moduleTarget,
            transport,
          });
        },
        resourceDetail: (request) =>
          runtime.runRead({
            input: request.ref,
            principal: request.principal,
            registration: registrations.resourceDetail,
            transport: {
              correlationId: request.correlationId,
              targetModuleKey: request.ref.moduleId,
              targetResourceId: request.ref.resourceId,
              targetResourceType: request.ref.resourceType,
            },
          }),
        search: (request) => {
          const { compositionRevision, includeArchived, query, role } = request;
          return runtime.runRead({
            input: withOptionalProperty(
              withOptionalProperty(
                { compositionRevision, query },
                includeArchived !== undefined,
                'includeArchived',
                includeArchived,
                {},
              ),
              role !== undefined,
              'role',
              role,
              {},
            ),
            principal: request.principal,
            registration: registrations.search,
            transport: { correlationId: request.correlationId },
          });
        },
      };
    }),
  );
