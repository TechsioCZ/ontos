import {
  ContextAccess,
  ReadHandlerNotFound,
  ReadHandlerUnavailable,
  ReadInputValidationError,
  ReadPermissionDenied,
  ReadRuntime,
  TenantModuleStateService,
  defineRead,
  defineSystemModuleEntrypoint,
  withRequestPermissionDecisions,
} from '@app/core-runtime';
import { admitPeopleSystemSearch, corePeopleSystemSearchProvider } from '@app/core-runtime/people/search';
import type { PeopleSystemSearchAccess, PeopleSystemSearchAdmission } from '@app/core-runtime/people/search';
import type {
  OperationalScope,
  ReadCoreError,
  ReadFinishContext,
  ReadHandlerResult,
  TenantModuleStateRecord,
  TrustedPrincipalContext,
  TenantModuleStateServiceContract,
  makeTenantModuleStateService,
} from '@app/core-runtime';
import { makeLegalEntityNavigationExclusions } from '@app/core-runtime/modules/legal-entity-navigation-exclusions';
import { Context, Effect, Layer, Option, Result, Schema } from 'effect';

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
  ShellSearchPayload,
  ShellSearchResponse,
} from '../../shared/api.ts';
import { capturedShellCatalog } from './captured-shell-catalog.ts';
import type { ShellInstalledCatalog } from './installed-module-catalog.ts';
import { ShellCompositionFactory } from './shell-composition.ts';
import type { ShellModuleTargetResolution, ShellModuleTargetSelector } from './shell-composition.ts';
import {
  GovernedResolvedModuleTargetSchema,
  GovernedResolveModuleTargetPayloadSchema,
} from './shell-governed-read-schemas.ts';
import {
  searchProviderModuleIds,
  resolveShellOAuthSearchResourceTypes,
  shellSearchAdmittedResourceTypes,
  ShellProviderUnavailableError,
  ShellResourceServicesFactory,
  sortShellSearchResults,
} from './shell-resources.ts';
import { ShellSystemSearch, mergeShellSystemSearch } from './shell-system-search.ts';
import { withShellSearchRequestBudget } from './shell-governed-search.ts';
import { compileShellSearchPresentation } from './shell-search-presentation.ts';
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
      readonly resourceTypes?: readonly string[];
      readonly role?: 'CUSTOMER' | 'SUPPLIER';
    },
  ) => Effect.Effect<ShellSearchResponse, ReadCoreError>;
  readonly tenantModuleTarget: (
    input: ShellReadRequest & {
      readonly canonicalPath?: string;
      /** Absent: resolve against the current release; the caller compares the returned revision. */
      readonly compositionRevision?: string;
      readonly entrypointKey?: string;
      readonly moduleId?: string;
    },
  ) => Effect.Effect<ShellTenantModuleTarget, ReadCoreError>;
}

/**
 * A tenant-only module target read either resolves the target or reports that this exact page still requires a
 * selected company. The selection outcome travels in the success channel so the Shell answers 409
 * `selection_required` for exactly the pages that did not opt in, never a blanket 403.
 */
export const ShellTenantModuleTargetSchema = Schema.Union([
  Schema.Struct({ state: Schema.Literal('selection_required') }),
  Schema.Struct({ state: Schema.Literal('resolved'), target: GovernedResolvedModuleTargetSchema }),
]);
export type ShellTenantModuleTarget = Schema.Schema.Type<typeof ShellTenantModuleTargetSchema>;

/** The typed failure contract shared by both module-target Read handlers. */
type ModuleTargetHandlerFailure = ReadHandlerNotFound | ReadHandlerUnavailable | ReadPermissionDenied;

/** The Read success contract of the company module target. */
type CompanyModuleTargetHandlerResult = ReadHandlerResult<ResolvedModuleTarget>;

/** The Read success contract of the tenant-only module target. */
type TenantModuleTargetHandlerResult = ReadHandlerResult<ShellTenantModuleTarget>;

/**
 * The shared outcome mapping of a finished company module target: an unknown target is not found, a definite
 * denial is forbidden, and anything indeterminate is unavailable. A resolved target decodes to the governed schema.
 */
const moduleTargetHandlerResult = (
  resolution: ShellModuleTargetResolution,
): Effect.Effect<CompanyModuleTargetHandlerResult, ModuleTargetHandlerFailure> => {
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
    Effect.map((result) => ({ evidence: { resultCount: 1 }, result })),
    Effect.mapError((cause) => {
      const error = new ReadHandlerUnavailable({
        code: 'read_handler_unavailable',
        reason: 'The Shell module target is temporarily unavailable',
      });
      Object.defineProperty(error, 'cause', { configurable: true, value: cause });
      return error;
    }),
  );
};

/**
 * The tenant-only counterpart: a page that did not opt in reports `selection_required` in the success channel (the
 * Shell answers 409 for exactly that page), and every other outcome maps exactly as the company target does.
 */
const tenantModuleTargetHandlerResult = (
  resolution: ShellModuleTargetResolution,
): Effect.Effect<TenantModuleTargetHandlerResult, ModuleTargetHandlerFailure> =>
  resolution.outcome === 'selection_required'
    ? Effect.succeed({
        evidence: { resultCount: 0 },
        result: { state: 'selection_required' as const },
      })
    : moduleTargetHandlerResult(resolution).pipe(
        Effect.map(({ evidence, result }) => ({
          evidence,
          result: { state: 'resolved' as const, target: result },
        })),
      );

export class ShellGovernedReads extends Context.Service<ShellGovernedReads, ShellGovernedReadsService>()(
  '@app/shell-super-app/api/modules/shell-governed-reads/ShellGovernedReads',
) {}

const emptyInput = Schema.Struct({});
const compositionEntrypoint = defineSystemModuleEntrypoint({
  access: 'read',
  // The frame is company-admission metadata; module/page capabilities still filter its contents below.
  authorization: { kind: 'authenticated_principal' },
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
/**
 * Tenant-only counterpart of the module target. Its frame is the authenticated principal; the target page's owning
 * module is gated by a genuine tenant `module.access` context permission in the handler, and the read is
 * `legalEntityScope: 'optional'` so a verified tenant session without a selected company can be admitted.
 */
const tenantModuleTargetEntrypoint = defineSystemModuleEntrypoint({
  access: 'read',
  authorization: { kind: 'authenticated_principal' },
  entrypointKey: 'core.shell.tenant-module-target',
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

const searchBudgetUnavailable = () =>
  new ReadHandlerUnavailable({
    code: 'read_handler_unavailable',
    reason: 'Shell search is temporarily unavailable',
  });

const unavailableBecause = (reason: string) => (cause: unknown) =>
  Object.defineProperty(new ReadHandlerUnavailable({ code: 'read_handler_unavailable', reason }), 'cause', {
    configurable: true,
    value: cause,
  });
const committedModuleStates = (
  records: Effect.Success<ReturnType<TenantModuleStateServiceContract['getTenantModuleStates']>>,
) => ({
  getTenantModuleStates: (_tenantId: string, moduleIds: readonly string[]) => {
    const requested = new Set(moduleIds);
    return Effect.succeed(records.filter((record) => requested.has(record.moduleKey)));
  },
});

/**
 * A search request may name only an eligible admitted type. An unknown or unadmitted name is an invalid request
 * (`read_input_invalid`, HTTP 400), never a permission grant: the selection still narrows authorized owners only.
 */
export const validateShellSearchResourceTypes = (
  requested: readonly string[] | undefined,
  admitted: ReadonlySet<string>,
): Effect.Effect<void, ReadInputValidationError> =>
  requested === undefined || requested.every((resourceType) => admitted.has(resourceType))
    ? Effect.void
    : Effect.fail(
        new ReadInputValidationError({
          code: 'read_input_invalid',
          reason: 'The requested search resource types are not admitted',
        }),
      );

/** The one Core-owned system search declaration. The governed caller supplies it; raw result bodies never do. */
const corePeopleSystemSearchPresentation = {
  authority: {
    entrypointKey: corePeopleSystemSearchProvider.entrypoint.entrypointKey,
    navigationPath: corePeopleSystemSearchProvider.navigationPath,
    ownerModuleId: corePeopleSystemSearchProvider.descriptor.owningModuleId,
    resourceType: corePeopleSystemSearchProvider.resource.key,
    searchKey: corePeopleSystemSearchProvider.descriptor.key,
  },
  presentation: corePeopleSystemSearchProvider.presentation,
} as const;

/**
 * Compile the release-bound inventory from an already-authorized business presentation, adding the Core system branch
 * when this answer admits it. Compilation grants nothing and calls no provider: the business entries were already
 * admitted by the orchestrator, and the system declaration is the Core-owned authority.
 */
const compileShellSearchInventory = ({
  businessPresentation,
  catalog,
  compositionRevision,
  system,
}: {
  readonly businessPresentation: ShellSearchResponse['presentation'];
  readonly catalog: ShellInstalledCatalog;
  readonly compositionRevision: string;
  readonly system: boolean;
}) => {
  const admitted = (businessPresentation?.business.entries ?? []).map(({ ownerModuleId, resourceType, searchKey }) => ({
    ownerModuleId,
    resourceType,
    searchKey,
  }));
  const compiled = system
    ? compileShellSearchPresentation({
        admitted,
        catalog,
        compositionRevision,
        system: corePeopleSystemSearchPresentation,
      })
    : compileShellSearchPresentation({ admitted, catalog, compositionRevision });
  return Effect.fromResult(compiled).pipe(
    Effect.mapError(unavailableBecause('Shell search presentation is temporarily unavailable')),
  );
};

/** Whether this answer considers the Core people system branch at all, and if so what its own coarse admission decided. */
type CoreSystemSearchAdmission = PeopleSystemSearchAdmission | 'inapplicable';

/**
 * The Core people system branch is considered only for a non-OAuth session with a selected company and a real query;
 * otherwise it is `inapplicable` and simply omitted. When it is considered, the Core people read's own coarse
 * principal authorization decides: `module.access` and the directory alternative `read_people` are independent gates,
 * so a definite denial of either is a definite denial. Per-record filtering and the data read stay with the provider.
 */
const coreSystemSearchAdmission = Effect.fn('ShellGovernedReads.coreSystemSearchAdmission')(function* admittedCore(
  scope: OperationalScope,
  request: ShellSearchPayload,
  access: PeopleSystemSearchAccess,
  hasSystemSearch: boolean,
) {
  if (
    !hasSystemSearch ||
    scope.authMethod === 'oauth_connection' ||
    scope.legalEntityId === undefined ||
    request.query.trim().length === 0
  ) {
    return 'inapplicable' as const;
  }
  return yield* admitPeopleSystemSearch(scope, access);
});

/**
 * Resolve a considered branch: a definite denial omits it from a complete answer, while an indeterminate or malformed
 * admission is not a definite denial and fails the governed read as unavailable instead of silently dropping People.
 */
const resolveCoreSystemSearchBranch = (
  admission: CoreSystemSearchAdmission,
): Effect.Effect<boolean, ReadHandlerUnavailable> => {
  if (admission === 'unavailable') {
    return Effect.fail(
      new ReadHandlerUnavailable({
        code: 'read_handler_unavailable',
        reason: 'Shell search People admission is temporarily unavailable',
      }),
    );
  }
  return Effect.succeed(admission === 'allowed');
};

const makeRegistrations = Effect.fn('ShellGovernedReads.makeRegistrations')(function* makeShellRegistrations(
  ...[gateways, assertionIssuer, scopedModuleStateFactory]: readonly [
    ShellResourceGateways,
    ShellProviderAssertionIssuer,
    ShellScopedModuleStateFactory,
  ]
) {
  const contextAccess = yield* ContextAccess;
  const systemSearch = yield* Effect.serviceOption(ShellSystemSearch);
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
      finish: Effect.fn('ShellSearch.finish')(function* finishShellSearch(
        request: ShellSearchPayload,
        context: ReadFinishContext<undefined, readonly TenantModuleStateRecord[]>,
      ) {
        const catalog = yield* capturedShellCatalog.pipe(
          Effect.mapError(unavailableBecause('Shell search is temporarily unavailable')),
        );
        let requested = request.resourceTypes;
        if (context.scope.authMethod === 'oauth_connection') {
          requested = yield* resolveShellOAuthSearchResourceTypes(context.scope, request, catalog, context.loaded);
          if (requested === undefined) {
            return yield* new ReadPermissionDenied({
              code: 'read_permission_denied',
              reason: 'OAuth search requires explicit business-provider admission',
            });
          }
        }
        if (requested !== undefined && requested.length > 0) {
          const admitted = new Set(shellSearchAdmittedResourceTypes(catalog, context.loaded));
          // Core people search is one exact system contract outside business-module admission; its own guard
          // still authorizes every person after the owner answers.
          if (context.scope.authMethod !== 'oauth_connection' && Option.isSome(systemSearch)) {
            admitted.add(corePeopleSystemSearchProvider.resource.key);
          }
          yield* validateShellSearchResourceTypes(requested, admitted);
        }
        const business = resourceServicesFactory
          .createSearch(
            { ...dependencies, catalog: Effect.succeed(catalog), moduleStates: committedModuleStates(context.loaded) },
            gateways.search,
          )
          .search(context.scope, requested === undefined ? request : { ...request, resourceTypes: requested });
        // An explicit empty list asks for the admitted inventory alone: the orchestrator evaluates every admitted
        // provider without dispatching an owner, and the Core system branch contributes its declaration without a
        // data call. No owner assertion is minted and no result count is fabricated. This is keyed on the caller's
        // own selector, never on an OAuth resolution that happens to admit no business type.
        if (request.resourceTypes !== undefined && request.resourceTypes.length === 0) {
          const admission = yield* coreSystemSearchAdmission(
            context.scope,
            request,
            contextAccess,
            Option.isSome(systemSearch),
          );
          // An indeterminate People admission fails the whole inventory read before any owner work; a definite denial
          // only omits the branch from the complete inventory.
          const system = yield* resolveCoreSystemSearchBranch(admission);
          const inventory = yield* business;
          const presentation = yield* compileShellSearchInventory({
            businessPresentation: inventory.presentation,
            catalog,
            compositionRevision: request.compositionRevision,
            system,
          });
          return { evidence: { resultCount: 0 }, result: { partial: false as const, presentation, results: [] } };
        }
        const system = Option.isSome(systemSearch) ? systemSearch.value : undefined;
        // A business-only selector does not use the People branch, so its admission is never evaluated and cannot
        // fail an answer that does not include People. An unfiltered request and one that names the People type do
        // evaluate it: a definite denial omits the branch, an indeterminate admission fails the read unavailable.
        const wantsCoreSystem =
          requested === undefined || requested.includes(corePeopleSystemSearchProvider.resource.key);
        const admittedCoreSystem = wantsCoreSystem
          ? yield* resolveCoreSystemSearchBranch(
              yield* coreSystemSearchAdmission(context.scope, request, contextAccess, Option.isSome(systemSearch)),
            )
          : false;
        const includeSystem = admittedCoreSystem && system !== undefined;
        // People search runs beside the business fan-out instead of after it. A refused business selection
        // (validation or permission) still fails in its genuine channel and the People answer is discarded;
        // the merge adapter owns provider unavailability only.
        const combined =
          includeSystem && system !== undefined
            ? Effect.gen(function* searchWithPeople() {
                const [businessOutcome, systemOutcome] = yield* Effect.all(
                  [Effect.result(business), Effect.result(system.search(context.scope, request.query))],
                  { concurrency: 2 },
                );
                if (
                  Result.isFailure(businessOutcome) &&
                  !Schema.is(ShellProviderUnavailableError)(businessOutcome.failure)
                ) {
                  return yield* businessOutcome.failure;
                }
                const presentation = yield* compileShellSearchInventory({
                  businessPresentation: Result.isSuccess(businessOutcome)
                    ? businessOutcome.success.presentation
                    : undefined,
                  catalog,
                  compositionRevision: request.compositionRevision,
                  system: true,
                });
                return yield* mergeShellSystemSearch(
                  Result.isSuccess(businessOutcome)
                    ? Effect.succeed(businessOutcome.success)
                    : Effect.fail(new ShellProviderUnavailableError({})),
                  Effect.fromResult(systemOutcome),
                  presentation,
                );
              })
            : business;
        return yield* combined.pipe(
          Effect.map((result) => ({
            evidence: { resultCount: result.results.length },
            // One Shell-wide order after every authorization, dedupe and collision-sanitization step above.
            result: { ...result, results: sortShellSearchResults(result.results) },
          })),
          Effect.catchTag('ShellProviderUnavailableError', (cause) =>
            Effect.fail(
              Object.defineProperty(
                new ReadHandlerUnavailable({
                  code: 'read_handler_unavailable',
                  reason: 'Shell search is temporarily unavailable',
                }),
                'cause',
                { value: cause },
              ),
            ),
          ),
        );
      }),
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
        moduleTargetHandlerResult(compositionAccess.finishModuleTarget(context.prepared, context.loaded)),
      // oxlint-enable perfectionist/sort-objects
    },
    serviceFactory,
    () => ({ kind: 'legal_entity' }),
  );
  const tenantModuleTarget = defineRead(
    {
      accessKind: 'detail',
      entrypoint: tenantModuleTargetEntrypoint,
      evidencePolicy: {
        captureMode: 'metadata_only',
        policyKey: 'core.shell.tenant-module-target.evidence.v1',
      },
      inputSchema: GovernedResolveModuleTargetPayloadSchema,
      legalEntityScope: 'optional',
      owningModuleKey: 'core.shell',
      // A tenant-only read has no company target to ask; the handler checks the owning module's tenant permission.
      permissionTarget: 'tenant',
      policies: [],
      readKey: 'core.shell.tenant-module-target',
      resultSchema: ShellTenantModuleTargetSchema,
      schemaVersion: '1',
    },
    {
      // oxlint-disable perfectionist/sort-objects -- Read steps stay in execution order; each step's types infer from the previous one.
      prepare: (input, context) =>
        compositionAccess
          .authorizeTenantModuleTarget(context.scope, input)
          .pipe(Effect.mapError(moduleTargetUnavailable)),
      load: (_input, context) =>
        context.services.composition
          .loadModuleTarget(context.scope, context.prepared)
          .pipe(Effect.mapError(moduleTargetUnavailable)),
      finish: (_input, context): Effect.Effect<TenantModuleTargetHandlerResult, ModuleTargetHandlerFailure> =>
        tenantModuleTargetHandlerResult(compositionAccess.finishModuleTarget(context.prepared, context.loaded)),
      // oxlint-enable perfectionist/sort-objects
    },
    serviceFactory,
    () => ({ kind: 'tenant', permission: 'access' }),
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
      finish: Effect.fn('ShellResourceDetail.finish')(function* finishResourceDetail(
        ref: ResourceRef,
        context: ReadFinishContext<undefined, readonly TenantModuleStateRecord[]>,
      ) {
        const { legalEntityId } = context.scope;
        if (legalEntityId === undefined) {
          return yield* new ReadHandlerUnavailable({
            code: 'read_handler_unavailable',
            reason: 'Shell resource scope is unavailable',
          });
        }
        const catalog = yield* capturedShellCatalog.pipe(
          Effect.mapError(unavailableBecause('Shell resource presentation is temporarily unavailable')),
        );
        const resolution = yield* resourceServicesFactory
          .createResourceDetail(
            { ...dependencies, catalog: Effect.succeed(catalog), moduleStates: committedModuleStates(context.loaded) },
            gateways.resource,
          )
          .resolve({ ...context.scope, legalEntityId }, ref);
        if (resolution.outcome === 'not_found') {
          return yield* new ReadHandlerNotFound({
            code: 'read_handler_not_found',
            reason: 'The requested Shell resource was not found',
          });
        }
        if (resolution.outcome === 'forbidden') {
          return yield* new ReadPermissionDenied({
            code: 'read_permission_denied',
            reason: 'The requested Shell resource is forbidden',
          });
        }
        if (resolution.outcome !== 'resolved' && resolution.outcome !== 'detail_not_supported') {
          return yield* new ReadHandlerUnavailable({
            code: 'read_handler_unavailable',
            reason: 'The Shell resource provider is temporarily unavailable',
          });
        }
        // The real detail gate has admitted this exact owner and record. A tenant search declaration additionally
        // retains its canonical tenant permission; a selected company does not stand in for that permission.
        const descriptors = catalog.contracts.flatMap(({ manifest }) =>
          manifest.module.id === ref.moduleId
            ? manifest.publicSurface.search.filter(
                (descriptor) =>
                  descriptor.owningModuleId === ref.moduleId && descriptor.resourceType === ref.resourceType,
              )
            : [],
        );
        const admitted = yield* Effect.forEach(
          descriptors,
          (descriptor) => {
            const binding = { ownerModuleId: ref.moduleId, resourceType: ref.resourceType, searchKey: descriptor.key };
            if (descriptor.accessFiltering !== 'tenant_scope') {
              return Effect.succeed([binding]);
            }
            if (descriptor.tenantPermission === undefined) {
              return Effect.succeed([]);
            }
            return dependencies.contextAccess
              .tenants({
                permission: descriptor.tenantPermission,
                principalId: context.scope.principalId,
                tenantIds: [context.scope.tenantId],
              })
              .pipe(
                Effect.flatMap((decisions) => {
                  const [decision] = decisions;
                  if (
                    decisions.length !== 1 ||
                    decision?.key !== context.scope.tenantId ||
                    decision.decision === 'unavailable'
                  ) {
                    return Effect.fail(
                      new ReadHandlerUnavailable({
                        code: 'read_handler_unavailable',
                        reason: 'Shell resource tenant admission is unavailable',
                      }),
                    );
                  }
                  return Effect.succeed(decision.decision === 'allowed' ? [binding] : []);
                }),
              );
          },
          { concurrency: 4 },
        );
        const presentation = yield* Effect.fromResult(
          compileShellSearchPresentation({
            admitted: admitted.flat(),
            catalog,
            compositionRevision: catalog.composition.revision,
          }),
        ).pipe(Effect.mapError(unavailableBecause('Shell resource presentation is temporarily unavailable')));
        if (resolution.outcome === 'detail_not_supported') {
          return {
            evidence: { resultCount: 0 },
            result: { outcome: 'detail_not_supported' as const, presentation, ref },
          };
        }
        return {
          evidence: { resultCount: 1 },
          result: {
            detail: resolution.detail,
            media: resolution.media,
            presentation,
            projectionLagging: resolution.projectionLagging,
            ref,
            timeline: resolution.timeline,
          },
        };
      }),
      // oxlint-enable perfectionist/sort-objects
    },
    serviceFactory,
    () => ({ kind: 'legal_entity' }),
  );
  return {
    composition,
    moduleTarget,
    prefetchCompositionDecisions: (principal: TrustedPrincipalContext) =>
      compositionAccess.prefetchCompositionDecisions(
        principal.legalEntityId === undefined
          ? { principalId: principal.principalId, tenantId: principal.tenantId }
          : {
              legalEntityId: principal.legalEntityId,
              principalId: principal.principalId,
              tenantId: principal.tenantId,
            },
      ),
    prefetchModuleTargetDecisions: (principal: TrustedPrincipalContext, selector: MutableModuleTargetSelector) =>
      compositionAccess.prefetchModuleTargetDecisions(
        principal.legalEntityId === undefined
          ? { principalId: principal.principalId, tenantId: principal.tenantId }
          : {
              legalEntityId: principal.legalEntityId,
              principalId: principal.principalId,
              tenantId: principal.tenantId,
            },
        selector,
        moduleTargetEntrypoint.moduleKey,
      ),
    resourceDetail,
    search,
    tenantModuleTarget,
  } as const;
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
        // The read's SpiceDB checks join decisions asked for beside it, in one round trip with the read's own start.
        composition: (request) =>
          withRequestPermissionDecisions(
            Effect.all(
              [
                registrations.prefetchCompositionDecisions(request.principal),
                runtime.runRead({
                  input: {},
                  principal: request.principal,
                  registration: registrations.composition,
                  transport: { correlationId: request.correlationId },
                }),
              ],
              { concurrency: 2 },
            ).pipe(Effect.map(([, composition]) => composition)),
          ),
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
          return withRequestPermissionDecisions(
            Effect.all(
              [
                registrations.prefetchModuleTargetDecisions(request.principal, input),
                runtime.runRead({
                  input,
                  principal: request.principal,
                  registration: registrations.moduleTarget,
                  transport,
                }),
              ],
              { concurrency: 2 },
            ).pipe(Effect.map(([, target]) => target)),
          );
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
          const { compositionRevision, includeArchived, query, resourceTypes, role } = request;
          return runtime
            .runRead({
              input: withOptionalProperty(
                withOptionalProperty(
                  withOptionalProperty(
                    { compositionRevision, query },
                    includeArchived !== undefined,
                    'includeArchived',
                    includeArchived,
                    {},
                  ),
                  resourceTypes !== undefined,
                  'resourceTypes',
                  resourceTypes,
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
            })
            .pipe((program) => withShellSearchRequestBudget(program, searchBudgetUnavailable));
        },
        // A verified tenant session without a selected company uses the tenant-only registration, which admits only
        // an explicitly opted-in page and gates its module by a genuine tenant `module.access` permission.
        tenantModuleTarget: (request) => {
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
          return withRequestPermissionDecisions(
            runtime.runRead({
              input,
              principal: request.principal,
              registration: registrations.tenantModuleTarget,
              transport,
            }),
          );
        },
      };
    }),
  );
