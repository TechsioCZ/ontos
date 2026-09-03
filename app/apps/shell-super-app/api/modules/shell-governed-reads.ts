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
  OperationalScope,
  ReadCoreError,
  ReadHandlerResult,
  TrustedPrincipalContext,
  TenantModuleStateServiceContract,
  makeTenantModuleStateService,
} from '@app/core-runtime';
import { Context, Effect, Layer, Schema } from 'effect';
import {
  ResourceRefSchema,
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
import {
  GovernedResolvedModuleTargetSchema,
  GovernedResolveModuleTargetPayloadSchema,
} from './shell-governed-read-schemas.ts';
import { ShellInstalledModuleCatalog } from './installed-module-catalog.ts';
import type { ShellInstalledModuleCatalogService } from './installed-module-catalog.ts';
import { ShellCompositionFactory, ShellCompositionFactoryLive } from './shell-composition.ts';
import {
  ShellResourceServicesFactory,
  ShellResourceServicesFactoryLive,
} from './shell-resources.ts';
import type { ShellProviderAssertionIssuer, ShellResourceGateways } from './shell-resources.ts';

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
  trailing: Trailing,
) => (condition ? { ...base, [key]: value, ...trailing } : { ...base, ...trailing });

interface ShellReadInvocation {
  readonly correlationId: string;
  readonly principal: TrustedPrincipalContext;
}

export type ShellScopedModuleStateFactory = (
  transaction: Parameters<typeof makeTenantModuleStateService>[0]['executor'],
) => TenantModuleStateServiceContract;

export interface ShellGovernedReadsService {
  readonly composition: (
    input: ShellReadInvocation,
  ) => Effect.Effect<ShellComposition, ReadCoreError>;
  readonly resourceDetail: (
    input: ShellReadInvocation & { readonly ref: ResourceRef },
  ) => Effect.Effect<ShellResourceResponse, ReadCoreError>;
  readonly moduleTarget: (
    input: ShellReadInvocation & { readonly entrypointKey?: string; readonly moduleId: string },
  ) => Effect.Effect<ResolvedModuleTarget, ReadCoreError>;
  readonly search: (
    input: ShellReadInvocation & {
      readonly includeArchived?: boolean;
      readonly query: string;
      readonly role?: 'CUSTOMER' | 'SUPPLIER';
    },
  ) => Effect.Effect<ShellSearchResponse, ReadCoreError>;
}

export class ShellGovernedReads extends Context.Service<
  ShellGovernedReads,
  ShellGovernedReadsService
>()('@app/shell-super-app/api/modules/shell-governed-reads/ShellGovernedReads') {}

const emptyInput = Schema.Struct({});
const governedShellNavigationItemSchema = Schema.Struct({
  appId: Schema.String,
  enabled: Schema.Boolean,
  groupKey: Schema.String,
  href: Schema.optionalKey(Schema.String),
  label: Schema.String,
  moduleId: Schema.String,
  order: Schema.Finite.check(Schema.isInt()),
  state: Schema.Literals(['active', 'deprecated', 'read_only']),
  unavailable: Schema.Boolean,
  writable: Schema.Boolean,
});
const governedShellCompositionSchema: Schema.Codec<ShellComposition> = Schema.Union([
  Schema.Struct({ navigation: Schema.Tuple([]), state: Schema.Literal('access_blocked') }),
  Schema.Struct({ navigation: Schema.Tuple([]), state: Schema.Literal('selection_required') }),
  Schema.Struct({
    navigation: Schema.Array(governedShellNavigationItemSchema),
    state: Schema.Literal('available'),
  }),
]);
const compositionEntrypoint = defineSystemModuleEntrypoint({
  access: 'read',
  entrypointKey: 'core.shell.composition',
  moduleKey: 'core.shell',
  role: 'api',
});
const searchEntrypoint = defineSystemModuleEntrypoint({
  access: 'read',
  entrypointKey: 'core.shell.search',
  moduleKey: 'core.shell',
  role: 'search',
});
const moduleTargetEntrypoint = defineSystemModuleEntrypoint({
  access: 'read',
  entrypointKey: 'core.shell.module-target',
  moduleKey: 'core.shell',
  role: 'api',
});
const resourceDetailEntrypoint = defineSystemModuleEntrypoint({
  access: 'read',
  entrypointKey: 'core.shell.resource-detail-timeline',
  moduleKey: 'core.shell',
  role: 'api',
});

const hasLegalEntity = (
  scope: OperationalScope,
): scope is OperationalScope & { readonly legalEntityId: string } =>
  scope.legalEntityId !== undefined;

const makeRegistrations = (
  catalog: ShellInstalledModuleCatalogService,
  contextAccess: (typeof ContextAccess)['Service'],
  moduleStates: (typeof TenantModuleStateService)['Service'],
  gateways: ShellResourceGateways,
  assertionIssuer: ShellProviderAssertionIssuer,
  scopedModuleStateFactory: ShellScopedModuleStateFactory,
  compositionFactory: (typeof ShellCompositionFactory)['Service'],
  resourceServicesFactory: (typeof ShellResourceServicesFactory)['Service'],
) => {
  const dependencies = { ...assertionIssuer, catalog: catalog.load, contextAccess, moduleStates };
  const serviceFactory = (
    transaction: Parameters<typeof makeTenantModuleStateService>[0]['executor'],
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
          gateways.resource,
        ),
        search: resourceServicesFactory.createSearch(scopedDependencies, gateways.search),
      }),
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
      resultSchema: governedShellCompositionSchema,
      schemaVersion: '1',
    },
    (_input, context) =>
      context.services.composition.compose(context.scope).pipe(
        Effect.map((result) => ({
          evidence: { resultCount: result.navigation.length },
          result,
        })),
        Effect.mapError(
          () =>
            new ReadHandlerUnavailable({
              code: 'read_handler_unavailable',
              reason: 'Shell composition is temporarily unavailable',
            }),
        ),
      ),
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
    (request, context) =>
      context.services.search.search(context.scope, request).pipe(
        Effect.map((result) => ({
          evidence: { resultCount: result.results.length },
          result,
        })),
        Effect.mapError(
          () =>
            new ReadHandlerUnavailable({
              code: 'read_handler_unavailable',
              reason: 'Shell search is temporarily unavailable',
            }),
        ),
      ),
    serviceFactory,
    // Provider-specific Party tenant and Counterparty resource checks run inside the orchestrator.
    () => ({ kind: 'tenant', permission: 'access' }),
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
          withOptionalProperty({}, !(entrypointKey === undefined), 'entrypointKey', entrypointKey, {
            moduleId,
          }),
        )
        .pipe(
          Effect.mapError(
            () =>
              new ReadHandlerUnavailable({
                code: 'read_handler_unavailable',
                reason: 'The Shell module target is temporarily unavailable',
              }),
          ),
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
              return Effect.succeed({
                evidence: { resultCount: 1 },
                result: {
                  appId: resolution.appId,
                  componentKey: resolution.page.componentKey,
                  entrypointKey: resolution.page.entrypoint.entrypointKey,
                  moduleId: resolution.moduleId,
                  writable: resolution.writable,
                },
              });
            },
          ),
        ),
    serviceFactory,
    ({ moduleId }) => ({ kind: 'module', moduleId }),
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
      if (!hasLegalEntity(context.scope)) {
        return Effect.fail(
          new ReadHandlerUnavailable({
            code: 'read_handler_unavailable',
            reason: 'Shell resource scope is unavailable',
          }),
        );
      }
      return context.services.resourceDetail.resolve(context.scope, ref).pipe(
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
    serviceFactory,
    (ref) => ({ kind: 'resource', resource: ref }),
  );
  return { composition, moduleTarget, resourceDetail, search } as const;
};

export const createShellGovernedReadsLayer = (
  gateways: ShellResourceGateways,
  assertionIssuer: ShellProviderAssertionIssuer,
  scopedModuleStateFactory: ShellScopedModuleStateFactory,
) =>
  Layer.effect(
    ShellGovernedReads,
    Effect.gen(function* makeShellGovernedReads() {
      const runtime = yield* ReadRuntime;
      const catalog = yield* ShellInstalledModuleCatalog;
      const contextAccess = yield* ContextAccess;
      const moduleStates = yield* TenantModuleStateService;
      const compositionFactory = yield* ShellCompositionFactory;
      const resourceServicesFactory = yield* ShellResourceServicesFactory;
      const registrations = makeRegistrations(
        catalog,
        contextAccess,
        moduleStates,
        gateways,
        assertionIssuer,
        scopedModuleStateFactory,
        compositionFactory,
        resourceServicesFactory,
      );
      return {
        composition: ({ correlationId, principal }) =>
          runtime.runRead({
            input: {},
            principal,
            registration: registrations.composition,
            transport: { correlationId },
          }),
        moduleTarget: ({ correlationId, entrypointKey, moduleId, principal }) =>
          runtime.runRead({
            input: withOptionalProperty(
              {},
              !(entrypointKey === undefined),
              'entrypointKey',
              entrypointKey,
              {
                moduleId,
              },
            ),
            principal,
            registration: registrations.moduleTarget,
            transport: { correlationId, targetModuleKey: moduleId },
          }),
        resourceDetail: ({ correlationId, principal, ref }) =>
          runtime.runRead({
            input: ref,
            principal,
            registration: registrations.resourceDetail,
            transport: {
              correlationId,
              targetModuleKey: ref.moduleId,
              targetResourceId: ref.resourceId,
              targetResourceType: ref.resourceType,
            },
          }),
        search: ({ correlationId, principal, ...input }) =>
          runtime.runRead({
            input,
            principal,
            registration: registrations.search,
            transport: { correlationId },
          }),
      };
    }),
  ).pipe(
    Layer.provide(ShellCompositionFactoryLive),
    Layer.provide(ShellResourceServicesFactoryLive),
  );
