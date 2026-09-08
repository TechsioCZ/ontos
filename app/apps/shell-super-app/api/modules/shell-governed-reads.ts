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
import { ShellInstalledModuleCatalog } from './installed-module-catalog.ts';
import { ShellCompositionFactory } from './shell-composition.ts';
import {
  GovernedResolvedModuleTargetSchema,
  GovernedResolveModuleTargetPayloadSchema,
} from './shell-governed-read-schemas.ts';
import { ShellResourceServicesFactory } from './shell-resources.ts';
import type {
  ShellProviderAssertionIssuer,
  ShellResourceGateways,
} from './shell-resources.ts';

const withOptionalProperty = <
  Base extends object,
  Key extends PropertyKey,
  Value,
  Trailing extends object,
>(
  base: Base,
  condition: boolean,
  key: Key,
  value: Value,
  trailing: Trailing
) =>
  condition ? { ...base, [key]: value, ...trailing } : { ...base, ...trailing };

interface ShellReadRequest {
  readonly correlationId: string;
  readonly principal: TrustedPrincipalContext;
}

export type ShellScopedModuleStateFactory = (
  transaction: Parameters<typeof makeTenantModuleStateService>[0]['executor']
) => TenantModuleStateServiceContract;

export interface ShellGovernedReadsService {
  readonly composition: (
    input: ShellReadRequest
  ) => Effect.Effect<ShellComposition, ReadCoreError>;
  readonly moduleTarget: (
    input: ShellReadRequest & {
      readonly entrypointKey?: string;
      readonly moduleId: string;
    }
  ) => Effect.Effect<ResolvedModuleTarget, ReadCoreError>;
  readonly resourceDetail: (
    input: ShellReadRequest & { readonly ref: ResourceRef }
  ) => Effect.Effect<ShellResourceResponse, ReadCoreError>;
  readonly search: (
    input: ShellReadRequest & {
      readonly includeArchived?: boolean;
      readonly query: string;
      readonly role?: 'CUSTOMER' | 'SUPPLIER';
    }
  ) => Effect.Effect<ShellSearchResponse, ReadCoreError>;
}

export class ShellGovernedReads extends Context.Service<
  ShellGovernedReads,
  ShellGovernedReadsService
>()(
  '@app/shell-super-app/api/modules/shell-governed-reads/ShellGovernedReads'
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

const makeRegistrations = Effect.fn('ShellGovernedReads.makeRegistrations')(
  function* makeShellRegistrations(
    ...[gateways, assertionIssuer, scopedModuleStateFactory]: readonly [
      ShellResourceGateways,
      ShellProviderAssertionIssuer,
      ShellScopedModuleStateFactory,
    ]
  ) {
    const catalog = yield* ShellInstalledModuleCatalog;
    const contextAccess = yield* ContextAccess;
    const moduleStates = yield* TenantModuleStateService;
    const compositionFactory = yield* ShellCompositionFactory;
    const resourceServicesFactory = yield* ShellResourceServicesFactory;
    const dependencies = {
      ...assertionIssuer,
      catalog: catalog.load,
      contextAccess,
      moduleStates,
    };
    const serviceFactory = (
      transaction: Parameters<
        typeof makeTenantModuleStateService
      >[0]['executor']
    ) => {
      const scopedDependencies = {
        ...dependencies,
        moduleStates: scopedModuleStateFactory(transaction),
      };
      return Effect.succeed(
        Object.freeze({
          composition: compositionFactory.create(scopedDependencies),
          resourceDetail: resourceServicesFactory.createResourceDetail(
            scopedDependencies,
            gateways.resource
          ),
          search: resourceServicesFactory.createSearch(
            scopedDependencies,
            gateways.search
          ),
        })
      );
    };
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
      (_input, context) =>
        context.services.composition.compose(context.scope).pipe(
          Effect.map((result) => ({
            evidence: { resultCount: result.navigation.length },
            result,
          })),
          Effect.catchTag('ShellCompositionUnavailableError', () =>
            Effect.fail(
              new ReadHandlerUnavailable({
                code: 'read_handler_unavailable',
                reason: 'Shell composition is temporarily unavailable',
              })
            )
          )
        ),
      serviceFactory,
      () => ({ kind: 'legal_entity' })
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
      (request, context) =>
        context.services.search.search(context.scope, request).pipe(
          Effect.map((result) => ({
            evidence: { resultCount: result.results.length },
            result,
          })),
          Effect.catchTag('ShellProviderUnavailableError', () =>
            Effect.fail(
              new ReadHandlerUnavailable({
                code: 'read_handler_unavailable',
                reason: 'Shell search is temporarily unavailable',
              })
            )
          )
        ),
      serviceFactory,
      // Provider-specific Party tenant and Counterparty resource checks run inside the orchestrator.
      () => ({ kind: 'tenant', permission: 'access' }),
      () => []
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
        permissionTarget: 'module',
        policies: [],
        readKey: 'core.shell.module-target',
        resultSchema: GovernedResolvedModuleTargetSchema,
        schemaVersion: '1',
      },
      ({ entrypointKey, moduleId }, context) =>
        context.services.composition
          .resolveModuleTarget(
            context.scope,
            withOptionalProperty(
              {},
              entrypointKey !== undefined,
              'entrypointKey',
              entrypointKey,
              {
                moduleId,
              }
            )
          )
          .pipe(
            Effect.catchTag('ShellCompositionUnavailableError', () =>
              Effect.fail(
                new ReadHandlerUnavailable({
                  code: 'read_handler_unavailable',
                  reason: 'The Shell module target is temporarily unavailable',
                })
              )
            ),
            Effect.flatMap(
              (
                resolution
              ): Effect.Effect<
                ReadHandlerResult<ResolvedModuleTarget>,
                | ReadHandlerNotFound
                | ReadHandlerUnavailable
                | ReadPermissionDenied
              > => {
                if (resolution.outcome === 'not_found') {
                  return Effect.fail(
                    new ReadHandlerNotFound({
                      code: 'read_handler_not_found',
                      reason: 'The requested module target was not found',
                    })
                  );
                }
                if (resolution.outcome === 'forbidden') {
                  return Effect.fail(
                    new ReadPermissionDenied({
                      code: 'read_permission_denied',
                      reason: 'The requested module target is forbidden',
                    })
                  );
                }
                if (resolution.outcome !== 'resolved') {
                  return Effect.fail(
                    new ReadHandlerUnavailable({
                      code: 'read_handler_unavailable',
                      reason:
                        'The Shell module target is temporarily unavailable',
                    })
                  );
                }
                return Schema.decodeUnknownEffect(
                  GovernedResolvedModuleTargetSchema
                )({
                  appId: resolution.appId,
                  componentKey: resolution.page.componentKey,
                  entrypointKey: resolution.page.entrypoint.entrypointKey,
                  moduleId: resolution.moduleId,
                  writable: resolution.writable,
                }).pipe(
                  Effect.map((result) => ({
                    evidence: { resultCount: 1 },
                    result,
                  })),
                  Effect.mapError((cause) => {
                    const error = new ReadHandlerUnavailable({
                      code: 'read_handler_unavailable',
                      reason:
                        'The Shell module target is temporarily unavailable',
                    });
                    Object.defineProperty(error, 'cause', {
                      configurable: true,
                      value: cause,
                    });
                    return error;
                  })
                );
              }
            )
          ),
      serviceFactory,
      ({ moduleId }) => ({ kind: 'module', moduleId })
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
        permissionTarget: 'resource',
        policies: [],
        readKey: 'core.shell.resource-detail-timeline',
        resultSchema: ShellResourceResponseSchema,
        schemaVersion: '1',
      },
      (ref, context) => {
        const { legalEntityId } = context.scope;
        if (legalEntityId === undefined) {
          return Effect.fail(
            new ReadHandlerUnavailable({
              code: 'read_handler_unavailable',
              reason: 'Shell resource scope is unavailable',
            })
          );
        }
        return context.services.resourceDetail
          .resolve({ ...context.scope, legalEntityId }, ref)
          .pipe(
            Effect.flatMap(
              (
                resolution
              ): Effect.Effect<
                ReadHandlerResult<ShellResourceResponse>,
                | ReadHandlerNotFound
                | ReadHandlerUnavailable
                | ReadPermissionDenied
              > => {
                if (resolution.outcome === 'not_found') {
                  return Effect.fail(
                    new ReadHandlerNotFound({
                      code: 'read_handler_not_found',
                      reason: 'The requested Shell resource was not found',
                    })
                  );
                }
                if (resolution.outcome === 'forbidden') {
                  return Effect.fail(
                    new ReadPermissionDenied({
                      code: 'read_permission_denied',
                      reason: 'The requested Shell resource is forbidden',
                    })
                  );
                }
                if (resolution.outcome !== 'resolved') {
                  return Effect.fail(
                    new ReadHandlerUnavailable({
                      code: 'read_handler_unavailable',
                      reason:
                        'The Shell resource provider is temporarily unavailable',
                    })
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
              }
            )
          );
      },
      serviceFactory,
      (ref) => ({ kind: 'resource', resource: ref })
    );
    return { composition, moduleTarget, resourceDetail, search } as const;
  }
);

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
      const registrations = yield* makeRegistrations(
        gateways,
        assertionIssuer,
        scopedModuleStateFactory
      );
      return {
        composition: (request) =>
          runtime.runRead({
            input: {},
            principal: request.principal,
            registration: registrations.composition,
            transport: { correlationId: request.correlationId },
          }),
        moduleTarget: (request) =>
          runtime.runRead({
            input: withOptionalProperty(
              {},
              request.entrypointKey !== undefined,
              'entrypointKey',
              request.entrypointKey,
              {
                moduleId: request.moduleId,
              }
            ),
            principal: request.principal,
            registration: registrations.moduleTarget,
            transport: {
              correlationId: request.correlationId,
              targetModuleKey: request.moduleId,
            },
          }),
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
          const { includeArchived, query, role } = request;
          return runtime.runRead({
            input: withOptionalProperty(
              withOptionalProperty(
                { query },
                includeArchived !== undefined,
                'includeArchived',
                includeArchived,
                {}
              ),
              role !== undefined,
              'role',
              role,
              {}
            ),
            principal: request.principal,
            registration: registrations.search,
            transport: { correlationId: request.correlationId },
          });
        },
      };
    })
  );
