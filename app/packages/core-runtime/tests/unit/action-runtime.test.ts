import { historicalOwnerContract, historicalOwnerTarget } from '../support/historical-owner-targets.ts';
import type { OperationalScope } from '../../src/operations/context.ts';
import { remainingPermissionBaselines } from './owner-permission-baseline.ts';
import {
  fixtureOwnerContract,
  fixtureOwnerCreatePermission,
  fixtureOwnerEndPermission,
  fixtureOwnerReadPermission,
  ownerPermissionTarget,
} from '../support/owner-permission-target.ts';
import type { VerticalRuntimeRegistration } from '../../src/modules/runtime-registration.ts';
import {
  freshOutboxWorkerCompositionSnapshot,
  makeOutboxWorkerComposition,
} from '../support/outbox-worker-composition.ts';
import type { ActiveApplicationCompositionServiceContract } from '../../src/modules/active-application-composition.ts';
import { ActiveApplicationCompositionUnavailableError } from '../../src/modules/active-application-composition-errors.ts';
import { requireModuleOperation } from '../../src/modules/module-operation-requirement.ts';
import { withModuleOperationExecution } from '../../src/modules/module-operation-execution.ts';
import { ModuleOperationRequirementError } from '../../src/modules/module-operation-requirement-error.ts';
import { defineOntosModuleManifest } from '../../src/modules/manifest.ts';
import { defineVerticalRuntimeRegistration } from '../../src/modules/runtime-registration.ts';
import { makeModuleContractFixture } from '../../src/testing/module-contract.ts';
import { NodeCrypto } from '@effect/platform-node';
import {
  Cause,
  Context,
  Crypto,
  DateTime,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Logger,
  Match,
  Option,
  Predicate,
  Schema,
  Struct,
} from 'effect';
import { expect, it } from 'effect-rstest';
import { ConnectionError, SqlError, isSqlError } from 'effect/sql/SqlError';
import {
  defineAction,
  defineActionOwnerPermissions,
  defineActionResourcePermission,
  getActionHandler,
} from '../../src/actions/definition.ts';
import { commitActionThenReject } from '../../src/actions/context.ts';
import { TrustedPrincipalContextSchema } from '../../src/actions/principal-context.ts';
import {
  ActionInvocationPersistenceError,
  ActionInvocationStateError,
  ActionPermissionCheckError,
  ActionPermissionDenied,
  ActionPolicyDenied,
  ActionTransactionError,
} from '../../src/actions/errors.ts';
import { defineGlobalPolicy, defineMicroverticalPolicy, denyPolicy } from '../../src/actions/policy.ts';
import type {
  ActionInvocationRecord,
  ActionRecordedRejection,
  ActionRepositoryService,
  FinalizeActionPolicyDenialInput,
  FlushActionSuccessInput,
  RejectPermissionDeniedInput,
} from '../../src/actions/repository.ts';
import { OperationContextUnavailable } from '../../src/operations/errors.ts';
import {
  computeActionRequestHash,
  computeCanonicalValueHash,
  getActionInvocationPersistenceFailureCause,
  getActionTransactionFailureCause,
  makeActionRepository,
} from '../../src/actions/repository.ts';
import type { ActionRuntimeOptions, ActionRuntimeStage } from '../../src/actions/runtime.ts';
import { ACTION_RUNTIME_STAGES, makeActionRuntime } from '../../src/actions/runtime.ts';
import { makeScriptedBoundAccessGate } from '../../src/testing/access-gate.ts';
import type { TestAccessOutcome } from '../../src/testing/access-gate.ts';
import { makeActionAuthorizationPreflightPermit } from '../../src/actions/owner-proof-preflight.ts';
import type { ActionAuthorizationPreflightService } from '../../src/actions/owner-proof-preflight.ts';
import {
  allowOwnerAuthorizationOverlay,
  ownerAuthorizationDenial,
} from '../../src/access/enforcement/owner-overlay.ts';
import type {
  OwnerAuthorizationInput,
  OwnerAuthorizationOutcome,
  OwnerAuthorizationOverlayService,
} from '../../src/access/enforcement/owner-overlay.ts';
import type { PrincipalManagementRepositoryService } from '../../src/auth/principal-management.ts';
import { PrincipalManagementRepository } from '../../src/auth/principal-management.ts';
import { supportRecoveryPrincipalContextResolverFromRepository } from '../../src/auth/support-recovery-principal-context.ts';
import { trustVerifiedGatewayPrincipalContext } from '../../src/auth/system-principal-context-provenance.ts';
import { CoreDatabase } from '../../src/db/client.ts';
import { recordSupportImpersonationAction } from '../../src/modules/actions/record-support-impersonation.action.ts';
import { makeModuleEntrypointGateway } from '../../src/modules/module-entrypoint-gateway.ts';
import type { ModuleEntrypointDescriptor } from '../../src/modules/module-entrypoint.ts';
import { defineSystemModuleEntrypoint, defineTenantModuleEntrypoint } from '../../src/modules/module-entrypoint.ts';
import {
  ModuleStateCheckUnavailableError,
  ModuleStateDeniedError,
} from '../../src/modules/module-state-gate-errors.ts';
import { checkModuleEntrypoint, makeModuleStateSnapshot } from '../../src/modules/module-state-gate.ts';
import type { TenantModuleState } from '../../src/modules/tenant-module-state-service.ts';
import type { ActionPermissionDecision, CheckActionPermissionInput } from '../../src/permissions/service.ts';
import { testOperationalScopeResolver } from '../fixtures/operational-scope.ts';
import { makeTestDatabase } from '../support/database.ts';
import { FIXTURE_DATABASE_IDENTITY_ENROLLMENT } from '../support/database-identities.ts';
import { fixtureActionAccess } from '../support/access-declaration-fixtures.ts';

const historicalActionPermissions = <Payload>(
  permission: string,
  resolver: (
    payload: Payload,
    scope: OperationalScope,
  ) => Readonly<{ readonly permission: string; readonly target: object }>,
) =>
  defineActionOwnerPermissions(historicalOwnerContract(permission), (payload: Payload, scope) => {
    const resolved = resolver(payload, scope);
    return [historicalOwnerTarget(resolved.permission, resolved.target)];
  });

const FixturePermissionCodeSchema = Schema.String;

const principal = Schema.decodeSync(TrustedPrincipalContextSchema)({
  authBindingId: '00000000-0000-4000-8000-000000000004',
  authContextRef: 'better-auth-session:test-session',
  authenticationNamespaceId: 'core-identity',
  authMethod: 'session',
  legalEntityId: '00000000-0000-4000-8000-000000000002',
  principalId: '00000000-0000-4000-8000-000000000003',
  tenantId: '00000000-0000-4000-8000-000000000001',
});
if (principal.authBindingId === undefined || principal.legalEntityId === undefined) {
  throw new Error('Action runtime fixture requires a session binding and legal entity');
}
const principalAuthBindingId = principal.authBindingId;
const principalLegalEntityId = principal.legalEntityId;
const pricingCatalogId = '50000000-0000-4000-8000-000000000001';
const priceGroupId = '60000000-0000-4000-8000-000000000001';
const otherPriceGroupId = '60000000-0000-4000-8000-000000000002';

const transport = (idempotencyKey = 'intent-1') => ({
  correlationId: `correlation-${idempotencyKey}`,
  idempotencyKey,
  targetModuleKey: 'core.shell',
  targetResourceId: 'primary',
  targetResourceType: 'counter',
});

const CounterpartyIdSchema = Schema.String.pipe(Schema.brand('CounterpartyId'));
type CounterpartyId = typeof CounterpartyIdSchema.Type;
const RetailProfileIdSchema = Schema.String.pipe(Schema.brand('RetailProfileId'));
type RetailProfileId = typeof RetailProfileIdSchema.Type;
type RetainedCauseError = ActionTransactionError | ActionInvocationPersistenceError;

const expectSameJson = (actual: RetainedCauseError, expected: RetainedCauseError) => {
  expect(JSON.stringify(actual)).toBe(JSON.stringify(expected));
};

const completionTime = () => DateTime.toDateUtc(DateTime.makeUnsafe(0));

const forEachSequential = <Item, E, R>(items: readonly Item[], run: (item: Item) => Effect.Effect<void, E, R>) =>
  Effect.forEach(items, run, { discard: true });

const unusedPrincipalManagementOperation = () =>
  Effect.die('The ambient PrincipalManagementRepository must not be used by the Action runtime');
const ambientPrincipalManagementRepository: PrincipalManagementRepositoryService = {
  bindApiKey: unusedPrincipalManagementOperation,
  changePrincipalStatus: unusedPrincipalManagementOperation,
  createNonHumanPrincipal: unusedPrincipalManagementOperation,
  setApiKeyBindingStatus: unusedPrincipalManagementOperation,
  validateSupportImpersonation: unusedPrincipalManagementOperation,
};
const providePrincipalManagementRepository = Effect.provideService(
  PrincipalManagementRepository,
  ambientPrincipalManagementRepository,
);

const PermissionDecisionSchema = Schema.Literals(['allowed', 'denied', 'unavailable']);
type PermissionDecision = typeof PermissionDecisionSchema.Type;
const transactionOperationAt = DateTime.toDateUtc(DateTime.makeUnsafe(Date.parse('2026-09-28T09:00:00.000Z')));
const approvedCompositionRevision = 'a'.repeat(64);
const installAndReadScopeSql =
  "select current_user::text as role, set_config('ontos.tenant_id', $1, true) as tenant_id, set_config('ontos.legal_entity_id', $2, true) as legal_entity_id";

interface TestCompositionAuthority {
  readonly phase: 'active' | 'draining';
  readonly revision: string;
  readonly unexpired: boolean;
}

interface HarnessOptions {
  /** A scripted gate answer for this run: `denied` proves the reduction exemption is real (O71). */
  readonly access?: TestAccessOutcome;
  readonly applicationComposition?: ActiveApplicationCompositionServiceContract;
  readonly authorizationPreflight?: ActionAuthorizationPreflightService;
  readonly businessPermissionDecision?: PermissionDecision;
  readonly commit?: Effect.Effect<readonly object[], SqlError>;
  readonly commitFailureCode?: string;
  readonly compositionAuthority?: TestCompositionAuthority | 'missing';
  readonly compositionIsolation?: 'read committed' | 'repeatable read' | 'serializable';
  readonly createRecord?: ActionInvocationRecord & { readonly actionKey?: string };
  readonly expectedDeployment?: ActionRuntimeOptions['expectedDeployment'];
  readonly failCompositionAuthorityLock?: boolean;
  readonly failTransactionTimestamp?: boolean;
  readonly legalEntityPermissionDecision?: PermissionDecision;
  readonly lockedModuleState?: 'active' | 'denied' | 'unavailable';
  readonly moduleState?: TenantModuleState | 'missing' | 'unavailable';
  readonly omitCompositionRevisionResolver?: boolean;
  readonly omitOwnerAuthorizationOverlay?: boolean;
  readonly omitOwnerRegistration?: boolean;
  readonly onBusinessPermissionCheck?: () => void;
  readonly onOwnerPermissionCheck?: (targets: readonly unknown[]) => void;
  readonly onResourcePermissionCheck?: () => void;
  readonly ownerAuthorizationOverlay?: OwnerAuthorizationOverlayService;
  readonly ownerPermissionDecision?: PermissionDecision;
  readonly ownerPermissionDecisions?: readonly PermissionDecision[];
  readonly ownerRegistration?: VerticalRuntimeRegistration;
  readonly permissionDecision?: ActionPermissionDecision;
  readonly permissionFailure?: boolean;
  readonly policyFinalizationFailure?: boolean;
  /** Simulates a concurrent request whose rejection committed before this one finalizes. */
  readonly recordedByConcurrentRequest?: ActionRecordedRejection;
  readonly rejectionFailure?: boolean;
  readonly resolutionUnavailable?: boolean;
  readonly resolveCommitted?: boolean;
  readonly resolveCompositionRevision?: Effect.Effect<string, ActionTransactionError>;
  readonly resourcePermissionDecision?: PermissionDecision;
  readonly tenantPermissionDecision?: PermissionDecision;
  readonly transactionMode?: 'commit-definite' | 'definite-failure' | 'normal' | 'uncertain';
}

/** These local registrations are synthetic Core infrastructure probes, with no business-provider implementation. */
const historicalFixtureOwner = (moduleId: string) => {
  const base = makeModuleContractFixture({ appId: moduleId.replaceAll('.', '-'), moduleId }).manifest;
  const manifest = defineOntosModuleManifest({
    ...base,
    publicSurface: { ...base.publicSurface, actions: [], api: {}, components: {} },
  });
  return defineVerticalRuntimeRegistration({ actions: [], manifest, outboxWorkers: [] });
};

interface HistoricalPermissionCheckObservation {
  readonly principal: { readonly principalId: string; readonly tenantId: string };
  readonly targets: readonly { readonly permission: string; readonly target: object }[];
  trustedStorefrontId?: string;
}

const makeHarness = Effect.fn(function* makeHarness(options: HarnessOptions = {}) {
  const finalized: FinalizeActionPolicyDenialInput[] = [];
  const flushed: FlushActionSuccessInput[] = [];
  const businessPermissionChecks: unknown[] = [];
  const ownerPermissionChecks: unknown[] = [];
  const ownerPermissionInputs: unknown[] = [];
  const legalEntityChecks: unknown[] = [];
  const permissionChecks: CheckActionPermissionInput[] = [];
  const rejections: RejectPermissionDeniedInput[] = [];
  const requestHashes: string[] = [];
  const resourceChecks: unknown[] = [];
  const stages: ActionRuntimeStage[] = [];
  const tenantChecks: unknown[] = [];
  let createCount = 0;
  let lockCount = 0;
  let permissionCheckCount = 0;
  let moduleStateReadCount = 0;
  let moduleStateRecheckCount = 0;
  let handlerResolutionCount = 0;
  let rejectionCount = 0;
  let transitionCount = 0;
  let transactionTimestampReadCount = 0;
  let transactionCount = 0;
  let committedTransactionCount = 0;
  let rolledBackTransactionCount = 0;
  let compositionAuthorityLockCount = 0;
  let compositionAuthorityLockHeld = false;
  const transactionSteps: string[] = [];
  const invocation: ActionInvocationRecord & { readonly actionKey: string } =
    options.createRecord === undefined
      ? {
          actionInvocationId: 'invocation-1',
          actionKey: 'shell.counter.write',
          completedAt: null,
          requestHash: '',
          status: 'received',
        }
      : { actionKey: 'shell.counter.write', ...options.createRecord };
  let currentInvocation = invocation;
  let preparedHash = '';

  const repository: ActionRepositoryService = {
    createOrResolveInvocation: (_executor, input) => {
      createCount += 1;
      requestHashes.push(input.requestHash);
      preparedHash = input.requestHash;
      return Effect.succeed({
        ...currentInvocation,
        requestHash: currentInvocation.requestHash || input.requestHash,
      });
    },
    finalizePolicyDenial: (_executor, input) => {
      if (options.policyFinalizationFailure === true) {
        return Effect.fail(
          new ActionInvocationPersistenceError({
            code: 'action_invocation_persistence_failed',
            reason: 'test rejection persistence failed',
          }),
        );
      }
      finalized.push(input);
      currentInvocation = {
        ...currentInvocation,
        completedAt: completionTime(),
        status: 'rejected',
      };
      return Effect.succeed(Option.fromNullishOr(options.recordedByConcurrentRequest));
    },
    flushSuccess: (_transaction, input) => {
      transactionSteps.push('evidence_flushed');
      flushed.push(input);
      return Effect.void;
    },
    loadRecordedRejection: () => {
      const [policyDenial] = finalized;
      if (policyDenial !== undefined) {
        return Effect.succeedSome({ policyReasonCode: policyDenial.reasonCode, stage: 'policy' as const });
      }
      const [rejection] = rejections;
      return Effect.succeed(
        rejection === undefined
          ? Option.none()
          : Option.some({ reasons: rejection.reasonCodes ?? [], stage: 'authz' as const }),
      );
    },
    lockInvocation: () => {
      transactionSteps.push('invocation_locked');
      lockCount += 1;
      return Effect.succeed({
        ...currentInvocation,
        requestHash: currentInvocation.requestHash || preparedHash,
      });
    },
    rejectPermissionDenied: (_executor, input) => {
      rejectionCount += 1;
      rejections.push(input);
      if (options.rejectionFailure === true) {
        return Effect.fail(
          new ActionTransactionError({
            code: 'action_transaction_failed',
            reason: 'test denial evidence transaction failed',
          }),
        );
      }
      currentInvocation = {
        ...currentInvocation,
        completedAt: completionTime(),
        status: 'rejected',
      };
      return Effect.succeed(Option.fromNullishOr(options.recordedByConcurrentRequest));
    },
    resolveInvocation: () =>
      options.resolutionUnavailable === true
        ? Effect.fail(
            new ActionInvocationPersistenceError({
              code: 'action_invocation_persistence_failed',
              reason: 'test database unavailable',
            }),
          )
        : Effect.succeed({
            ...currentInvocation,
            requestHash: currentInvocation.requestHash || preparedHash,
            status: options.resolveCommitted === true ? 'succeeded' : currentInvocation.status,
          }),
    transitionInvocationToRunning: () => {
      transitionCount += 1;
      if (
        (currentInvocation.status === 'received' || currentInvocation.status === 'running') &&
        currentInvocation.completedAt === null
      ) {
        currentInvocation = { ...currentInvocation, status: 'running' };
      }
      return Effect.succeed({
        ...currentInvocation,
        requestHash: currentInvocation.requestHash || preparedHash,
      });
    },
  };

  let installedTenantId: string = principal.tenantId;
  let installedLegalEntityId: string = principalLegalEntityId;
  const commitTransaction = () =>
    Effect.gen(function* commitTransactionEffect() {
      const defaultCommitCodes = {
        'commit-definite': '40001',
        uncertain: '08007',
      };
      const defaultCode =
        options.transactionMode === 'uncertain' || options.transactionMode === 'commit-definite'
          ? defaultCommitCodes[options.transactionMode]
          : undefined;
      const code = options.commitFailureCode ?? defaultCode;
      if (code !== undefined) {
        return yield* new SqlError({
          reason: new ConnectionError({ cause: { code } }),
        });
      }
      if (options.commit !== undefined) {
        return yield* options.commit;
      }
      return [];
    });
  /** Records the scope any `set_config` statement installs; answers the row of the one-statement install. */
  const installTestScope = (text: string, values: readonly unknown[]) => {
    if (!text.includes('set_config')) {
      return Option.none();
    }
    const [tenantId, legalEntityId] = values;
    if (Predicate.isString(tenantId) && Predicate.isString(legalEntityId)) {
      installedTenantId = tenantId;
      installedLegalEntityId = legalEntityId;
    }
    // A session-setting role installs its scope and reads back the connected role in one statement.
    return text === installAndReadScopeSql
      ? Option.some([{ legal_entity_id: installedLegalEntityId, role: 'ontos_runtime', tenant_id: installedTenantId }])
      : Option.none();
  };
  const query = Effect.fn(function* executeQuery(statement: string, values: readonly unknown[]) {
    const text = statement.toLowerCase();
    const installedScopeRows = installTestScope(text, values);
    if (Option.isSome(installedScopeRows)) {
      return installedScopeRows.value;
    }
    if (text === 'begin') {
      transactionSteps.push('begin');
      transactionCount += 1;
      if (options.transactionMode === 'definite-failure') {
        return yield* new SqlError({
          reason: new ConnectionError({
            cause: new Error('transaction unavailable'),
          }),
        });
      }
    }
    if (text === 'commit') {
      transactionSteps.push('commit_started');
      const committed = yield* commitTransaction();
      compositionAuthorityLockHeld = false;
      transactionSteps.push('commit_settled');
      committedTransactionCount += 1;
      return committed;
    }
    if (text === 'rollback') {
      compositionAuthorityLockHeld = false;
      transactionSteps.push('rollback');
      rolledBackTransactionCount += 1;
      return [];
    }
    if (text.includes('pg_advisory_xact_lock_shared')) {
      // The guarded fence only acquires its lock under READ COMMITTED; the CASE never takes it in an
      // unsupported isolation, so an unsuitable transaction counts no lock and never holds one.
      if ((options.compositionIsolation ?? 'read committed') === 'read committed') {
        compositionAuthorityLockCount += 1;
        transactionSteps.push('composition_authority_locked');
        if (options.failCompositionAuthorityLock === true) {
          return yield* new SqlError({
            reason: new ConnectionError({ cause: new Error('composition authority lock unavailable') }),
          });
        }
        compositionAuthorityLockHeld = true;
      }
      // The canonical fence is one combined statement (isolation probe + guarded lock), so it also
      // answers the isolation read below. The separate-statement form returns here and the following
      // statement answers it.
      if (!text.includes("current_setting('transaction_isolation')")) {
        return [];
      }
    }
    if (text.includes('application_composition_authority')) {
      const authority = options.compositionAuthority ?? {
        phase: 'active',
        revision: approvedCompositionRevision,
        unexpired: true,
      };
      return authority === 'missing'
        ? []
        : [
            {
              phase: authority.phase,
              revision: authority.revision,
              subscriptionsJson: [],
              unexpired: authority.unexpired,
            },
          ];
    }
    if (text.includes("current_setting('transaction_isolation')")) {
      return [{ isolation: options.compositionIsolation ?? 'read committed' }];
    }
    if (text.includes('current_setting')) {
      return [
        {
          legal_entity_id: installedLegalEntityId,
          role: 'ontos_runtime',
          tenant_id: installedTenantId,
        },
      ];
    }
    if (text.includes('transaction_timestamp')) {
      transactionTimestampReadCount += 1;
      if (options.failTransactionTimestamp === true) {
        return yield* new SqlError({
          reason: new ConnectionError({ cause: new Error('transaction clock unavailable') }),
        });
      }
      return [{ operation_at: transactionOperationAt }];
    }
    if (text.startsWith('select')) {
      return [{ authBindingId: principalAuthBindingId }];
    }
    return [];
  });
  const database = { executor: yield* makeTestDatabase(query) };

  const permission = {
    checkActionPermission: (input: CheckActionPermissionInput) => {
      permissionCheckCount += 1;
      permissionChecks.push(input);
      return options.permissionFailure === true
        ? Effect.fail(
            new ActionPermissionCheckError({
              code: 'action_permission_check_failed',
              reason: 'test authorization service unavailable',
            }),
          )
        : Effect.succeed(options.permissionDecision ?? 'allowed');
    },
  };

  const moduleStateGate = {
    check: checkModuleEntrypoint,
    prepareSnapshot: (tenantId: string, entrypoints: readonly ModuleEntrypointDescriptor[]) => {
      const moduleKeys = entrypoints
        .filter((entrypoint) => entrypoint.scope === 'tenant')
        .map((entrypoint) => entrypoint.moduleKey);
      if (moduleKeys.length > 0) {
        moduleStateReadCount += 1;
      }
      if (options.moduleState === 'unavailable') {
        return Effect.fail(
          new ModuleStateCheckUnavailableError({
            code: 'module_state_check_unavailable',
            reason: 'controlled unavailable state read',
          }),
        );
      }
      const availableState: TenantModuleState =
        options.moduleState === undefined || options.moduleState === 'missing' ? 'active' : options.moduleState;
      return Effect.succeed(
        makeModuleStateSnapshot(
          tenantId,
          entrypoints,
          options.moduleState === 'missing'
            ? []
            : moduleKeys.map((moduleKey) => ({
                moduleKey,
                state: availableState,
              })),
        ),
      );
    },
    recheckWrite: () => {
      moduleStateRecheckCount += 1;
      if (options.lockedModuleState === 'denied') {
        return Effect.fail(
          new ModuleStateDeniedError({
            code: 'module_state_denied',
            reason: 'controlled locked denial',
          }),
        );
      }
      if (options.lockedModuleState === 'unavailable') {
        return Effect.fail(
          new ModuleStateCheckUnavailableError({
            code: 'module_state_check_unavailable',
            reason: 'controlled locked unavailable check',
          }),
        );
      }
      return Effect.void;
    },
  } as const;
  const ownerAuthorizationOptions =
    options.omitOwnerAuthorizationOverlay === true
      ? {}
      : {
          ownerAuthorizationOverlay: options.ownerAuthorizationOverlay ?? allowOwnerAuthorizationOverlay,
        };
  let runtimeOptions: ActionRuntimeOptions = {
    contextAccess: {
      legalEntities: (input) => {
        legalEntityChecks.push(input);
        return Effect.succeed(
          input.legalEntityIds.map((key) => ({
            decision: options.legalEntityPermissionDecision ?? ('allowed' as const),
            key,
          })),
        );
      },
      modules: () => Effect.succeed([]),
      ownerPermissions: (input) => {
        if (input.targets.every(({ target }) => target.contract.targetResourceType === 'historical_owner_permission')) {
          options.onBusinessPermissionCheck?.();
          const projected: HistoricalPermissionCheckObservation = {
            principal: input.principal,
            targets: input.targets.map(({ target }) => ({ permission: target.definition.key, target: target.target })),
          };
          if (input.trustedStorefrontId !== undefined) {
            projected.trustedStorefrontId = input.trustedStorefrontId;
          }
          businessPermissionChecks.push(projected);
          return Effect.succeed(
            input.targets.map(({ target }) => ({
              decision: options.businessPermissionDecision ?? ('allowed' as const),
              key: target.key,
            })),
          );
        }
        ownerPermissionChecks.push(...input.targets);
        ownerPermissionInputs.push(input);
        options.onOwnerPermissionCheck?.(input.targets);
        return Effect.succeed(
          input.targets.map((target, index) => ({
            decision:
              options.ownerPermissionDecisions?.[index] ?? options.ownerPermissionDecision ?? ('allowed' as const),
            key: target.target.key,
          })),
        );
      },
      resources: (input) => {
        options.onResourcePermissionCheck?.();
        resourceChecks.push(input);
        return Effect.succeed(
          input.resources.map(({ moduleId, resourceId, resourceType }) => ({
            decision: options.resourcePermissionDecision ?? ('allowed' as const),
            key: `${moduleId}:${resourceType}:${resourceId}`,
          })),
        );
      },
      tenants: (input) => {
        tenantChecks.push(input);
        return Effect.succeed(
          input.tenantIds.map((key) => ({
            decision: options.tenantPermissionDecision ?? ('allowed' as const),
            key,
          })),
        );
      },
    },
    databaseIdentities: FIXTURE_DATABASE_IDENTITY_ENROLLMENT,
    moduleEntrypointGateway: makeModuleEntrypointGateway(moduleStateGate),
    moduleStateGate,
    ...ownerAuthorizationOptions,
    onStage: (stage) => {
      stages.push(stage);
    },
    resolveHandler: (action) => {
      handlerResolutionCount += 1;
      return getActionHandler(action);
    },
  };
  if (options.applicationComposition !== undefined) {
    runtimeOptions = { ...runtimeOptions, applicationComposition: options.applicationComposition };
  }
  if (options.expectedDeployment !== undefined) {
    runtimeOptions = { ...runtimeOptions, expectedDeployment: options.expectedDeployment };
  }
  if (options.ownerRegistration !== undefined) {
    runtimeOptions = { ...runtimeOptions, ownerRegistration: options.ownerRegistration };
  }
  if (options.omitCompositionRevisionResolver !== true) {
    runtimeOptions = {
      ...runtimeOptions,
      resolveCompositionRevision: () =>
        options.resolveCompositionRevision ?? Effect.succeed(approvedCompositionRevision),
    };
  }
  if (options.authorizationPreflight !== undefined) {
    runtimeOptions = { ...runtimeOptions, authorizationPreflight: options.authorizationPreflight };
  }
  const scriptedAccess = options.access === undefined ? undefined : makeScriptedBoundAccessGate(options.access);
  if (scriptedAccess !== undefined) {
    runtimeOptions = { ...runtimeOptions, accessDecision: scriptedAccess.bound };
  }
  const baseRuntime = makeActionRuntime(database, repository, permission, testOperationalScopeResolver, runtimeOptions);
  const runAction: typeof baseRuntime.runAction = (input) =>
    options.omitOwnerRegistration === true || options.ownerRegistration !== undefined
      ? baseRuntime.runAction(input)
      : makeActionRuntime(database, repository, permission, testOperationalScopeResolver, {
          ...runtimeOptions,
          ownerRegistration: historicalFixtureOwner(input.registration.descriptor.owningModuleKey),
        }).runAction(input);
  const runtime = { resolveActionCommit: baseRuntime.resolveActionCommit, runAction };

  return {
    accessQuestions: () => scriptedAccess?.accessDecision.askedDecisions ?? [],
    businessPermissionChecks,
    compositionAuthority: () => ({
      lockCount: compositionAuthorityLockCount,
      lockHeld: compositionAuthorityLockHeld,
    }),
    counts: () => ({
      createCount,
      lockCount,
      transactionCount,
      transitionCount,
    }),
    finalized,
    flushed,
    gateCounts: () => ({
      handlerResolutionCount,
      moduleStateReadCount,
      moduleStateRecheckCount,
    }),
    invocationState: () => currentInvocation,
    legalEntityChecks,
    ownerPermissionChecks,
    ownerPermissionInputs,
    permissionChecks,
    permissionCounts: () => ({ permissionCheckCount, rejectionCount }),
    rejections,
    requestHashes,
    resourceChecks,
    runtime,
    stages,
    tenantChecks,
    transactionOutcomes: () => ({
      committedTransactionCount,
      rolledBackTransactionCount,
    }),
    transactionSteps,
    transactionTimestampReads: () => transactionTimestampReadCount,
  };
});

const makeRepositoryFailures = Effect.fn(function* testProgram1() {
  const cause = new SqlError({
    reason: new ConnectionError({
      cause: new Error('private repository defect'),
    }),
  });
  const executor = yield* makeTestDatabase(() => Effect.fail(cause));
  const repository = makeActionRepository(yield* Crypto.Crypto);
  const input = {
    actionInvocationId: 'invocation-1',
    actionKey: 'shell.counter.denied',
    auditProfile: 'sensitive',
    principal,
    transport: transport('denied'),
  } as const;
  const transactionFailure = yield* Effect.flip(repository.rejectPermissionDenied(executor, input));
  const persistenceFailure = yield* Effect.flip(
    repository.finalizePolicyDenial(executor, {
      ...input,
      policy: { policyKey: 'global.counter-locked.v1', scope: 'global' },
      reasonCode: 'counter_locked',
    }),
  );
  expect(Schema.is(ActionTransactionError)(transactionFailure)).toBe(true);
  if (!Schema.is(ActionTransactionError)(transactionFailure)) {
    throw new Error('Expected typed test outcome');
  }
  expect(Schema.is(ActionInvocationPersistenceError)(persistenceFailure)).toBe(true);
  if (!Schema.is(ActionInvocationPersistenceError)(persistenceFailure)) {
    throw new Error('Expected typed test outcome');
  }
  return { cause, persistenceFailure, transactionFailure };
});

it('public error classes expose no retained-cause accessors', () => {
  for (const errorClass of [ActionTransactionError, ActionInvocationPersistenceError]) {
    expect('withCause' in errorClass).toBe(false);
    expect('causeOf' in errorClass).toBe(false);
  }
});

it.layer(NodeCrypto.layer)('Action repository failure causes', (suite) => {
  suite.effect(
    'repository constructors retain original causes across Effect Cause propagation',
    Effect.fn(function* testProgram2() {
      const { cause, persistenceFailure, transactionFailure } = yield* makeRepositoryFailures();
      const propagatedTransaction = yield* Effect.flip(Effect.failCause(Cause.fail(transactionFailure)));
      const propagatedPersistence = yield* Effect.flip(Effect.failCause(Cause.fail(persistenceFailure)));
      expect(propagatedTransaction).toBe(transactionFailure);
      expect(propagatedPersistence).toBe(persistenceFailure);
      expect(getActionTransactionFailureCause(propagatedTransaction)).toEqual(Cause.die(cause));
      expect(getActionInvocationPersistenceFailureCause(propagatedPersistence)).toEqual(Cause.die(cause));
    }),
  );

  suite.effect(
    'repository causes are absent from reflection, JSON, and Schema encoding',
    Effect.fn(function* testProgram3() {
      const { persistenceFailure, transactionFailure } = yield* makeRepositoryFailures();
      const publicTransaction = new ActionTransactionError({
        code: transactionFailure.code,
        reason: transactionFailure.reason,
      });
      const publicPersistence = new ActionInvocationPersistenceError({
        code: persistenceFailure.code,
        reason: persistenceFailure.reason,
      });
      expect(Object.keys(transactionFailure)).toEqual(Object.keys(publicTransaction));
      expect(Object.keys(persistenceFailure)).toEqual(Object.keys(publicPersistence));
      expect(Reflect.ownKeys(transactionFailure)).toEqual(Reflect.ownKeys(publicTransaction));
      expect(Reflect.ownKeys(persistenceFailure)).toEqual(Reflect.ownKeys(publicPersistence));
      expectSameJson(transactionFailure, publicTransaction);
      expectSameJson(persistenceFailure, publicPersistence);
      const encodedTransactionFailure = yield* Schema.encodeEffect(ActionTransactionError)(transactionFailure);
      expect(Schema.is(Schema.toEncoded(ActionTransactionError))(encodedTransactionFailure)).toBe(true);
      expect(Struct.omit(encodedTransactionFailure, ['_tag'])).toEqual({
        code: transactionFailure.code,
        reason: transactionFailure.reason,
      });
      const encodedPersistenceFailure = yield* Schema.encodeEffect(ActionInvocationPersistenceError)(
        persistenceFailure,
      );
      expect(Schema.is(Schema.toEncoded(ActionInvocationPersistenceError))(encodedPersistenceFailure)).toBe(true);
      expect(Struct.omit(encodedPersistenceFailure, ['_tag'])).toEqual({
        code: persistenceFailure.code,
        reason: persistenceFailure.reason,
      });
    }),
  );
});

it('repository cause readers reject foreign objects carrying the former cause property', () => {
  const formerCauseProperty = ['ontos', 'Repository', 'Failure', 'Cause'].join('');
  const cause = new Error('foreign defect');
  const transactionFailure = Object.assign(
    new ActionTransactionError({
      code: 'action_transaction_failed',
      reason: 'foreign failure',
    }),
    { [formerCauseProperty]: cause },
  );
  const persistenceFailure = Object.assign(
    new ActionInvocationPersistenceError({
      code: 'action_invocation_persistence_failed',
      reason: 'foreign failure',
    }),
    { [formerCauseProperty]: cause },
  );
  expect(getActionTransactionFailureCause(transactionFailure)).toBe(undefined);
  expect(getActionInvocationPersistenceFailureCause(persistenceFailure)).toBe(undefined);
});

const registration = () =>
  defineAction(
    {
      accessDeclaration: fixtureActionAccess('core.shell'),
      accessEvidencePolicy: {
        captureMode: 'metadata_only',
        policyKey: 'counter.read.v1',
      },
      actionKey: 'shell.counter.change',
      auditProfile: 'standard',
      domainErrorSchema: Schema.Never,
      domainEvents: {
        'counter.changed': Schema.Struct({ amount: Schema.Finite }),
      },
      entrypoint: defineSystemModuleEntrypoint({
        access: 'write',
        authorization: {
          kind: 'action_execution',
          provisioning: 'tenant_membership_default',
        },
        entrypointKey: 'shell.counter.change',
        moduleKey: 'core.shell',
        role: 'action',
      }),
      idempotency: 'required',
      legalEntityScope: 'optional',
      owningModuleKey: 'core.shell',
      payloadSchema: Schema.Struct({ amount: Schema.Finite }),
      policies: [],
      resultSchema: Schema.Struct({ total: Schema.Finite }),
      schemaVersion: '1',
    },
    Effect.fn(function* changeCounter(payload, context) {
      expect(context.actionInvocationId).toBe('invocation-1');
      expect(context.compositionRevision).toBe(approvedCompositionRevision);
      expect(Object.isFrozen(context)).toBe(true);
      expect('transaction' in context).toBe(false);
      expect(context.services).toEqual({});
      yield* context.recordDataAccess({
        accessKind: 'read',
        queryHash: `counter-${payload.amount}`,
        resultCount: 1,
        servingModuleKey: 'core.shell',
      });
      const domainEvent = yield* context.addDomainEvent({
        eventType: 'counter.changed',
        payloadJson: { amount: payload.amount },
        producerModuleKey: 'core.shell',
        subjectModuleKey: 'core.shell',
        subjectResourceId: 'primary',
        subjectResourceType: 'counter',
      });
      yield* context.addOutboxMessage(
        domainEvent,
        {
          payloadJson: { amount: payload.amount },
          producerModuleKey: 'core.shell',
          topic: 'counter.project',
        },
        { consumerModuleKey: 'party.registry' },
      );
      return { total: payload.amount };
    }),
  );

it.effect('runs the decoded-success hook before evidence flush and rolls back its typed failure', () =>
  Effect.gen(function* decodedSuccessHook() {
    const calls: string[] = [];
    const descriptor = {
      accessDeclaration: fixtureActionAccess('core.shell'),
      accessEvidencePolicy: { captureMode: 'metadata_only', policyKey: 'counter.read.v1' },
      actionKey: 'shell.counter.snapshot',
      auditProfile: 'standard',
      domainErrorSchema: Schema.Never,
      domainEvents: {},
      entrypoint: defineSystemModuleEntrypoint({
        access: 'write',
        authorization: { kind: 'action_execution', provisioning: 'tenant_membership_default' },
        entrypointKey: 'shell.counter.snapshot',
        moduleKey: 'core.shell',
        role: 'action',
      }),
      idempotency: 'required',
      legalEntityScope: 'optional',
      owningModuleKey: 'core.shell',
      payloadSchema: Schema.Struct({ amount: Schema.Finite }),
      policies: [],
      resultSchema: Schema.Struct({ total: Schema.Finite }),
      schemaVersion: '1',
    } as const;
    const action = (fail: boolean) =>
      defineAction(
        descriptor,
        ({ amount }) => Effect.succeed({ total: amount }),
        () => Effect.succeed({ marker: 'scoped-service' }),
        ({ actionInvocationId, result, scope, services }) =>
          Effect.gen(function* persistSnapshot() {
            expect(actionInvocationId).toBe('invocation-1');
            expect(result).toEqual({ total: 3 });
            expect(scope.tenantId).toBe(principal.tenantId);
            expect(services.marker).toBe('scoped-service');
            calls.push('hook');
            if (fail) {
              return yield* new ActionTransactionError({
                code: 'action_transaction_failed',
                reason: 'snapshot write failed',
              });
            }
            return yield* Effect.void;
          }),
      );
    const success = yield* makeHarness();
    const result = yield* success.runtime.runAction({
      payload: { amount: 3 },
      principal,
      registration: action(false),
      transport: transport('snapshot-success'),
    });
    expect(result).toEqual({ total: 3 });
    expect(calls).toEqual(['hook']);
    expect(success.flushed).toHaveLength(1);
    expect(success.transactionOutcomes().committedTransactionCount).toBe(1);

    const failed = yield* makeHarness();
    const failure = yield* Effect.flip(
      failed.runtime.runAction({
        payload: { amount: 3 },
        principal,
        registration: action(true),
        transport: transport('snapshot-failure'),
      }),
    );
    expect(Schema.is(ActionTransactionError)(failure)).toBe(true);
    expect(failed.flushed).toHaveLength(0);
    expect(failed.transactionOutcomes().rolledBackTransactionCount).toBe(1);

    const replay = yield* makeHarness({
      createRecord: {
        actionInvocationId: 'committed',
        completedAt: null,
        requestHash: '',
        status: 'succeeded',
      },
    });
    yield* Effect.flip(
      replay.runtime.runAction({
        payload: { amount: 3 },
        principal,
        registration: action(false),
        transport: transport('snapshot-replay'),
      }),
    );
    expect(calls).toEqual(['hook', 'hook']);

    const invalid = yield* makeHarness();
    const invalidAction = defineAction(
      descriptor,
      () => Effect.succeed({ total: Number.NaN }),
      () => Effect.succeed({ marker: 'scoped-service' }),
      () =>
        Effect.sync(() => {
          calls.push('invalid-hook');
        }),
    );
    yield* Effect.flip(
      invalid.runtime.runAction({
        payload: { amount: 3 },
        principal,
        registration: invalidAction,
        transport: transport('snapshot-invalid'),
      }),
    );
    expect(invalid.flushed).toHaveLength(0);
    expect(calls).toEqual(['hook', 'hook']);

    const rejected = yield* makeHarness();
    const SnapshotRejectedContract = Schema.TaggedStruct('SnapshotRejected', { reason: Schema.String });
    const SnapshotRejected = Schema.TaggedError<typeof SnapshotRejectedContract.Type>()('SnapshotRejected', {
      reason: Schema.String,
    });
    const rejectionAction = defineAction(
      { ...descriptor, domainErrorSchema: SnapshotRejected },
      () => Effect.succeed(commitActionThenReject(new SnapshotRejected({ reason: 'stale' }))),
      () => Effect.succeed({ marker: 'scoped-service' }),
      () =>
        Effect.sync(() => {
          calls.push('rejection-hook');
        }),
    );
    yield* Effect.flip(
      rejected.runtime.runAction({
        payload: { amount: 3 },
        principal,
        registration: rejectionAction,
        transport: transport('snapshot-rejection'),
      }),
    );
    expect(rejected.flushed).toHaveLength(1);
    expect(calls).toEqual(['hook', 'hook']);
  }),
);

it.effect(
  'executes the complete stage order with transaction ownership and success evidence',
  Effect.fn(function* testProgram4() {
    const harness = yield* makeHarness();
    const result = yield* harness.runtime.runAction({
      payload: { amount: 3 },
      principal,
      registration: registration(),
      transport: transport(),
    });

    expect(result).toEqual({ total: 3 });
    expect(harness.stages).toEqual(ACTION_RUNTIME_STAGES);
    expect(harness.counts()).toEqual({
      createCount: 1,
      lockCount: 1,
      transactionCount: 1,
      transitionCount: 1,
    });
    expect(harness.flushed.length).toBe(1);
    expect(harness.flushed[0]?.evidence.dataAccessEvents.length).toBe(1);
    expect(harness.flushed[0]?.evidence.domainEvents.length).toBe(1);
    expect(harness.flushed[0]?.evidence.outboxMessages.length).toBe(1);
    expect(harness.flushed[0]?.evidence.outboxMessages[0]?.completion).toEqual({
      consumerModuleKey: 'party.registry',
      originalRevision: approvedCompositionRevision,
    });
    expect(harness.flushed[0]?.allowedPolicies).toEqual([]);
    // The trusted scope's own tenant and legal entity ride every permission check (ScopedActionIdentity);
    // the check never derives them from the payload.
    expect(harness.permissionChecks).toEqual([
      {
        actionKey: 'shell.counter.change',
        correlationId: 'correlation-intent-1',
        legalEntityId: principal.legalEntityId,
        principalId: principal.principalId,
        tenantId: principal.tenantId,
      },
    ]);
    expect(harness.gateCounts()).toEqual({
      handlerResolutionCount: 1,
      moduleStateReadCount: 0,
      moduleStateRecheckCount: 0,
    });
  }),
);

it.effect('rejects missing, stale, draining, and expired composition authority before any owner work', () =>
  Effect.gen(function* rejectUnapprovedComposition() {
    const authorityCases = [
      'missing',
      { phase: 'active', revision: 'b'.repeat(64), unexpired: true },
      { phase: 'draining', revision: approvedCompositionRevision, unexpired: true },
      { phase: 'active', revision: approvedCompositionRevision, unexpired: false },
    ] as const;
    for (const compositionAuthority of authorityCases) {
      let ownerAuthorizationCalls = 0;
      const harness = yield* makeHarness({
        compositionAuthority,
        ownerAuthorizationOverlay: {
          authorize: () => {
            ownerAuthorizationCalls += 1;
            return Effect.succeed('allowed' as const);
          },
        },
      });
      const failure = yield* Effect.flip(
        harness.runtime.runAction({
          payload: { amount: 1 },
          principal,
          registration: registration(),
          transport: transport('unapproved-composition'),
        }),
      );
      expect(Schema.is(ActionTransactionError)(failure)).toBe(true);
      expect(ownerAuthorizationCalls).toBe(0);
      expect(harness.gateCounts().handlerResolutionCount).toBe(0);
      expect(harness.counts().lockCount).toBe(0);
      expect(harness.flushed).toHaveLength(0);
      expect(harness.compositionAuthority()).toEqual({ lockCount: 1, lockHeld: false });
      expect(harness.transactionOutcomes()).toEqual({
        committedTransactionCount: 0,
        rolledBackTransactionCount: 1,
      });
    }
  }),
);

it.effect('rejects a release replaced after admission and before owner transaction entry', () =>
  Effect.gen(function* changedCompositionAfterAdmission() {
    const authority = { phase: 'active' as const, revision: approvedCompositionRevision, unexpired: true };
    let admissionCount = 0;
    const harness = yield* makeHarness({
      compositionAuthority: authority,
      resolveCompositionRevision: Effect.sync(() => {
        admissionCount += 1;
        authority.revision = 'b'.repeat(64);
        return approvedCompositionRevision;
      }),
    });
    const failure = yield* Effect.flip(
      harness.runtime.runAction({
        payload: { amount: 1 },
        principal,
        registration: registration(),
        transport: transport('replaced-after-admission'),
      }),
    );
    expect(Schema.is(ActionTransactionError)(failure)).toBe(true);
    expect(admissionCount).toBe(1);
    expect(harness.compositionAuthority()).toEqual({ lockCount: 1, lockHeld: false });
    expect(harness.counts().lockCount).toBe(0);
    expect(harness.gateCounts().handlerResolutionCount).toBe(0);
    expect(harness.flushed).toHaveLength(0);
  }),
);

it.effect('rejects owner transactions whose isolation could conceal a newly promoted release', () =>
  Effect.gen(function* unsuitableCompositionIsolation() {
    for (const compositionIsolation of ['repeatable read', 'serializable'] as const) {
      const harness = yield* makeHarness({ compositionIsolation });
      const failure = yield* Effect.flip(
        harness.runtime.runAction({
          payload: { amount: 1 },
          principal,
          registration: registration(),
          transport: transport(`composition-${compositionIsolation}`),
        }),
      );
      expect(Schema.is(ActionTransactionError)(failure)).toBe(true);
      expect(harness.compositionAuthority()).toEqual({ lockCount: 0, lockHeld: false });
      expect(harness.counts().lockCount).toBe(0);
      expect(harness.gateCounts().handlerResolutionCount).toBe(0);
      expect(harness.flushed).toHaveLength(0);
      expect(harness.transactionOutcomes().rolledBackTransactionCount).toBe(1);
    }
  }),
);

it.effect('fails closed if no receiving composition revision is supplied', () =>
  Effect.gen(function* missingCompositionResolver() {
    const harness = yield* makeHarness({ omitCompositionRevisionResolver: true });
    const failure = yield* Effect.flip(
      harness.runtime.runAction({
        payload: { amount: 1 },
        principal,
        registration: registration(),
        transport: transport('missing-composition-resolver'),
      }),
    );
    expect(Schema.is(ActionTransactionError)(failure)).toBe(true);
    expect(harness.counts().transactionCount).toBe(0);
    expect(harness.gateCounts().handlerResolutionCount).toBe(0);
    expect(harness.flushed).toHaveLength(0);
  }),
);

it.effect('fails closed when the database cannot acquire the composition fence', () =>
  Effect.gen(function* unavailableCompositionLock() {
    const harness = yield* makeHarness({ failCompositionAuthorityLock: true });
    const failure = yield* Effect.flip(
      harness.runtime.runAction({
        payload: { amount: 1 },
        principal,
        registration: registration(),
        transport: transport('unavailable-composition-lock'),
      }),
    );
    expect(Schema.is(ActionTransactionError)(failure)).toBe(true);
    expect(harness.counts().lockCount).toBe(0);
    expect(harness.gateCounts().handlerResolutionCount).toBe(0);
    expect(harness.flushed).toHaveLength(0);
    expect(harness.transactionOutcomes().rolledBackTransactionCount).toBe(1);
  }),
);

it.effect('retains the composition fence through owner evidence and delayed commit settlement', () =>
  Effect.gen(function* delayedOwnerCommitFence() {
    const commitStarted = Deferred.makeUnsafe<null>();
    const commitSettlement = Deferred.makeUnsafe<readonly object[]>();
    const harness = yield* makeHarness({
      commit: Deferred.succeed(commitStarted, null).pipe(Effect.andThen(Deferred.await(commitSettlement))),
    });
    const actionFiber = yield* harness.runtime
      .runAction({
        payload: { amount: 2 },
        principal,
        registration: registration(),
        transport: transport('delayed-composition-commit'),
      })
      .pipe(Effect.forkChild);
    yield* Deferred.await(commitStarted);
    expect(harness.compositionAuthority()).toEqual({ lockCount: 1, lockHeld: true });
    expect(harness.flushed).toHaveLength(1);
    expect(harness.flushed[0]?.evidence.outboxMessages).toHaveLength(1);
    expect(harness.transactionSteps).toEqual([
      'begin',
      'composition_authority_locked',
      'invocation_locked',
      'evidence_flushed',
      'commit_started',
    ]);
    expect(actionFiber.pollUnsafe()).toBeUndefined();
    yield* Deferred.succeed(commitSettlement, []);
    expect(yield* Fiber.join(actionFiber)).toEqual({ total: 2 });
    expect(harness.compositionAuthority()).toEqual({ lockCount: 1, lockHeld: false });
    expect(harness.transactionSteps.at(-1)).toBe('commit_settled');
  }),
);

it.effect(
  'runs the owner overlay inside the transaction and persists an owner denial before the handler',
  Effect.fn(function* testOwnerOverlayDenial() {
    const ownerInputs: OwnerAuthorizationInput[] = [];
    const harness = yield* makeHarness({
      ownerAuthorizationOverlay: {
        authorize: (_transaction, input) => {
          ownerInputs.push(input);
          return Effect.succeed('denied' as const);
        },
      },
    });
    const failure = yield* Effect.flip(
      harness.runtime.runAction({
        payload: { amount: 3 },
        principal,
        registration: registration(),
        transport: transport('owner-denied'),
      }),
    );

    expect(Schema.is(ActionPermissionDenied)(failure)).toBe(true);
    // A bare owner denial still names the rule that refused: "Proč?" cannot see an owner rule.
    expect(failure).toMatchObject({ code: 'action_permission_denied', reasons: ['deny.owner_rule'] });
    expect(ownerInputs).toHaveLength(1);
    expect(ownerInputs[0]?.operationAt).toEqual(DateTime.makeUnsafe(Date.parse('2026-09-28T09:00:00.000Z')));
    expect(harness.transactionTimestampReads()).toBe(1);
    expect(harness.gateCounts().handlerResolutionCount).toBe(0);
    expect(harness.counts()).toEqual({
      createCount: 1,
      lockCount: 1,
      transactionCount: 1,
      transitionCount: 0,
    });
    expect(harness.permissionCounts().rejectionCount).toBe(1);
  }),
);

it.effect(
  "carries the owner overlay's own refusal codes, and an unavailable answer stays unavailable",
  Effect.fn(function* testOwnerOverlayReasons() {
    const answers: readonly (readonly [string, OwnerAuthorizationOutcome])[] = [
      [
        'owner-reasons-denied',
        ownerAuthorizationDenial('deny.owner.counterparty_grant_missing', 'requires.counterparty.address_book.manage'),
      ],
      ['owner-reasons-unavailable', 'unavailable'],
    ];
    const [reasoned, unavailable] = yield* Effect.forEach(
      answers,
      Effect.fn(function* refusalOf([key, outcome]) {
        const harness = yield* makeHarness({
          ownerAuthorizationOverlay: { authorize: () => Effect.succeed(outcome) },
        });
        return yield* Effect.flip(
          harness.runtime.runAction({
            payload: { amount: 3 },
            principal,
            registration: registration(),
            transport: transport(key),
          }),
        );
      }),
      { concurrency: 1 },
    );

    expect(reasoned).toMatchObject({
      _tag: 'ActionPermissionDenied',
      code: 'action_permission_denied',
      reasons: ['deny.owner.counterparty_grant_missing', 'requires.counterparty.address_book.manage'],
    });
    expect(unavailable).toMatchObject({ _tag: 'ActionPermissionCheckError', code: 'action_permission_check_failed' });
  }),
);

const capturedLogs = (entries: string[]) =>
  Logger.layer([
    Logger.make((options) => {
      entries.push(JSON.stringify(Logger.formatStructured.log(options)));
    }),
  ]);

/**
 * Answers outside the owner contract, as a type escape or a separately built owner unit could send:
 * untyped values the compiler cannot vet. Each is unavailable, never an allow, and nothing runs or commits.
 */
const outOfContract = Schema.decodeUnknownEffect(Schema.Any);
const OUT_OF_CONTRACT_OWNER_ANSWERS: readonly (readonly [string, () => Effect.Effect<OwnerAuthorizationOutcome>])[] = [
  ['ALLOWED', () => outOfContract('ALLOWED').pipe(Effect.orDie)],
  ['{}', () => outOfContract({}).pipe(Effect.orDie)],
  ['{decision: allowed}', () => outOfContract({ decision: 'allowed' }).pipe(Effect.orDie)],
  ['null', () => outOfContract(null).pipe(Effect.orDie)],
  ['undefined', () => outOfContract(globalThis.undefined).pipe(Effect.orDie)],
  ['a thrown defect', () => Effect.die(new Error('owner rule defect'))],
];

for (const [label, answer] of OUT_OF_CONTRACT_OWNER_ANSWERS) {
  it.effect(`answers an owner overlay's ${label} as unavailable on the Action path`, () =>
    Effect.gen(function* outOfContractOwnerAction() {
      const harness = yield* makeHarness({
        ownerAuthorizationOverlay: {
          authorize: answer,
        },
      });
      const failure = yield* Effect.flip(
        harness.runtime.runAction({
          payload: { amount: 3 },
          principal,
          registration: registration(),
          transport: transport(`owner-odd-${label}`),
        }),
      );
      expect(failure).toMatchObject({ _tag: 'ActionPermissionCheckError', code: 'action_permission_check_failed' });
      expect(harness.gateCounts().handlerResolutionCount).toBe(0);
      expect(harness.counts().transitionCount).toBe(0);
      expect(harness.flushed).toHaveLength(0);
      expect(harness.permissionCounts().rejectionCount).toBe(0);
    }),
  );
}

it.effect('a synchronous throw inside the owner overlay is unavailable with one warning, never a 500', () =>
  Effect.gen(function* synchronousOwnerThrow() {
    const entries: string[] = [];
    const harness = yield* makeHarness({
      ownerAuthorizationOverlay: {
        authorize: () => {
          throw new TypeError('owner rule private detail');
        },
      },
    });
    const failure = yield* Effect.flip(
      harness.runtime.runAction({
        payload: { amount: 3 },
        principal,
        registration: registration(),
        transport: transport('owner-sync-throw'),
      }),
      // @effect-diagnostics-next-line strictEffectProvide:off -- Test-owned diagnostic logger capture.
    ).pipe(Effect.provide(capturedLogs(entries)));
    expect(failure).toMatchObject({ _tag: 'ActionPermissionCheckError', code: 'action_permission_check_failed' });
    expect(harness.gateCounts().handlerResolutionCount).toBe(0);
    const warning = entries.find((entry) => entry.includes('Owner authorization overlay failed'));
    expect(warning).toContain('"failure":"TypeError"');
    expect(warning).toContain('"operationKey":"shell.counter.change"');
    expect(warning).toContain('"owningModuleKey":"core.shell"');
    expect(warning).not.toContain('private detail');
  }),
);

it.effect('an owner answer outside the contract is unavailable with one warning naming its kind, never its value', () =>
  Effect.gen(function* outOfContractWarning() {
    const entries: string[] = [];
    const harness = yield* makeHarness({
      ownerAuthorizationOverlay: { authorize: () => outOfContract({ secret: 'value' }).pipe(Effect.orDie) },
    });
    yield* Effect.flip(
      harness.runtime.runAction({
        payload: { amount: 3 },
        principal,
        registration: registration(),
        transport: transport('owner-odd-warning'),
      }),
      // @effect-diagnostics-next-line strictEffectProvide:off -- Test-owned diagnostic logger capture.
    ).pipe(Effect.provide(capturedLogs(entries)));
    const warning = entries.find((entry) => entry.includes('Owner authorization answer outside the contract'));
    expect(warning).toContain('"answerKind":"object"');
    expect(warning).toContain('"capabilityKey":');
    expect(warning).toContain('"operationKey":"shell.counter.change"');
    expect(warning).not.toContain('secret');
  }),
);

it.effect('reports only reason codes Core may report; anything else collapses to deny.owner_rule (R3)', () =>
  Effect.gen(function* ownerReasonsChecked() {
    const unreportable: readonly (readonly [string, ...string[]])[] = [
      ['Deny.Owner.Upper'],
      ['deny.owner.someone@example.test'],
      ['deny owner spaces'],
      [`deny.owner.${'x'.repeat(130)}`],
      ['deny.owner.code_0', ...Array.from({ length: 8 }, (_, index) => `deny.owner.code_${index + 1}`)],
      ['undotted'],
    ];
    for (const [index, reasons] of unreportable.entries()) {
      const harness = yield* makeHarness({
        ownerAuthorizationOverlay: {
          authorize: () => Effect.succeed({ decision: 'denied' as const, reasons }),
        },
      });
      const failure = yield* Effect.flip(
        harness.runtime.runAction({
          payload: { amount: 3 },
          principal,
          registration: registration(),
          transport: transport(`owner-unreportable-${index}`),
        }),
      );
      expect(failure).toMatchObject({ _tag: 'ActionPermissionDenied', reasons: ['deny.owner_rule'] });
    }
  }),
);

it.effect('writes one refusal warning with the refusing check and no payload values', () =>
  Effect.gen(function* refusalWarning() {
    const entries: string[] = [];
    const harness = yield* makeHarness({
      ownerAuthorizationOverlay: {
        authorize: () => Effect.succeed(ownerAuthorizationDenial('deny.owner.counterparty_grant_missing')),
      },
    });
    yield* Effect.flip(
      harness.runtime.runAction({
        payload: { amount: 31_337 },
        principal,
        registration: registration(),
        transport: transport('refusal-warning'),
      }),
      // @effect-diagnostics-next-line strictEffectProvide:off -- Test-owned diagnostic logger capture.
    ).pipe(Effect.provide(capturedLogs(entries)));
    const warnings = entries.filter((entry) => entry.includes('Action refused'));
    expect(warnings).toHaveLength(1);
    const [warning] = warnings;
    for (const field of [
      '"refusedAction":"shell.counter.change"',
      '"code":"action_permission_denied"',
      '"reasons":"deny.owner.counterparty_grant_missing"',
      `"refusalTenant":"${principal.tenantId}"`,
      `"refusalCompany":"${principalLegalEntityId}"`,
      '"reason":"The owner-local authorization state denies this Action"',
    ]) {
      expect(warning).toContain(field);
    }
    expect(warning).not.toContain('31337');
    expect(warning).not.toContain('amount');
    expect(warning).not.toContain(principal.principalId);
  }),
);

it.effect('records the refusal codes and answers a same-key retry with them', () =>
  Effect.gen(function* retryKeepsCodes() {
    const harness = yield* makeHarness({
      ownerAuthorizationOverlay: {
        authorize: () =>
          Effect.succeed(
            ownerAuthorizationDenial(
              'deny.owner.counterparty_grant_missing',
              'requires.counterparty.address_book.manage',
            ),
          ),
      },
    });
    const run = () =>
      Effect.flip(
        harness.runtime.runAction({
          payload: { amount: 3 },
          principal,
          registration: registration(),
          transport: transport('retry-keeps-codes'),
        }),
      );
    const first = yield* run();
    const retried = yield* run();
    const codes = ['deny.owner.counterparty_grant_missing', 'requires.counterparty.address_book.manage'];
    expect(harness.rejections[0]?.reasonCodes).toEqual(codes);
    expect(first).toMatchObject({ _tag: 'ActionPermissionDenied', reasons: codes });
    expect(retried).toMatchObject({ _tag: 'ActionPermissionDenied', reasons: codes });
    expect(harness.permissionCounts().rejectionCount).toBe(1);
  }),
);

it.effect('a propose request to a result-only endpoint is refused without naming tenant or company', () =>
  Effect.gen(function* proposeRefusedBeforeValidation() {
    const entries: string[] = [];
    const harness = yield* makeHarness();
    const failure = yield* Effect.flip(
      harness.runtime.runAction({
        payload: { amount: 3 },
        principal,
        registration: registration(),
        transport: { ...transport('propose-result-only'), intent: 'propose' as const },
      }),
      // @effect-diagnostics-next-line strictEffectProvide:off -- Test-owned diagnostic logger capture.
    ).pipe(Effect.provide(capturedLogs(entries)));
    expect(failure).toMatchObject({ _tag: 'ActionPermissionDenied', code: 'action_permission_denied' });
    const warning = entries.find((entry) => entry.includes('Action refused'));
    expect(warning).toContain('"refusalTenant":"unverified"');
    expect(warning).toContain('"refusalCompany":"unverified"');
    expect(warning).not.toContain(principal.tenantId);
    expect(warning).not.toContain(principalLegalEntityId);
  }),
);

it.effect('fails closed before owner authorization when PostgreSQL cannot provide transaction time', () =>
  Effect.gen(function* transactionTimeUnavailable() {
    let overlayCalls = 0;
    const harness = yield* makeHarness({
      failTransactionTimestamp: true,
      ownerAuthorizationOverlay: {
        authorize: () => {
          overlayCalls += 1;
          return Effect.succeed('allowed' as const);
        },
      },
    });
    const failure = yield* Effect.flip(
      harness.runtime.runAction({
        payload: { amount: 3 },
        principal,
        registration: registration(),
        transport: transport('clock-unavailable'),
      }),
    );

    expect(Schema.is(OperationContextUnavailable)(failure)).toBe(true);
    expect(overlayCalls).toBe(0);
    expect(harness.gateCounts().handlerResolutionCount).toBe(0);
    expect(harness.transactionTimestampReads()).toBe(1);
  }),
);

it.effect('keeps owner-neutral Actions available without an owner adapter', () =>
  Effect.gen(function* ownerNeutralActionWithoutOverlay() {
    const harness = yield* makeHarness({ omitOwnerAuthorizationOverlay: true });
    const result = yield* harness.runtime.runAction({
      payload: { amount: 2 },
      principal,
      registration: registration(),
      transport: transport('owner-neutral-without-overlay'),
    });
    expect(result).toEqual({ total: 2 });
    expect(harness.rejections).toHaveLength(0);
  }),
);

it.effect(
  'hashes the encoded representation of decoded DateTime and Option values',
  Effect.fn(function* testProgram5() {
    const occurredAt = '2026-09-07T10:30:00.000Z';
    const payloadSchema = Schema.Struct({
      note: Schema.OptionFromNullOr(Schema.String),
      occurredAt: Schema.DateTimeUtcFromString,
    });
    const action = defineAction(
      {
        accessDeclaration: fixtureActionAccess('core.shell'),
        accessEvidencePolicy: {
          captureMode: 'metadata_only',
          policyKey: 'shell.temporal.v1',
        },
        actionKey: 'shell.temporal.change',
        auditProfile: 'standard',
        domainErrorSchema: Schema.Never,
        domainEvents: {},
        entrypoint: defineSystemModuleEntrypoint({
          access: 'write',
          authorization: {
            kind: 'action_execution',
            provisioning: 'tenant_membership_default',
          },
          entrypointKey: 'shell.temporal.change',
          moduleKey: 'core.shell',
          role: 'action',
        }),
        idempotency: 'required',
        legalEntityScope: 'optional',
        owningModuleKey: 'core.shell',
        payloadSchema,
        policies: [],
        resultSchema: payloadSchema,
        schemaVersion: '1',
      },
      (payload) => {
        expect(DateTime.formatIso(payload.occurredAt)).toBe(occurredAt);
        expect(Option.isNone(payload.note)).toBe(true);
        return Effect.succeed(payload);
      },
    );
    const harness = yield* makeHarness();

    const result = yield* harness.runtime.runAction({
      payload: { note: null, occurredAt },
      principal,
      registration: action,
      transport: transport('temporal-payload'),
    });

    expect(harness.requestHashes).toEqual([
      computeActionRequestHash({
        actionKey: 'shell.temporal.change',
        normalizedPayload: { note: null, occurredAt },
        owningModuleKey: 'core.shell',
        principal,
        schemaVersion: '1',
        target: {
          targetModuleKey: 'core.shell',
          targetResourceId: 'primary',
          targetResourceType: 'counter',
        },
      }),
    ]);
    expect(DateTime.formatIso(result.occurredAt)).toBe(occurredAt);
    expect(Option.isNone(result.note)).toBe(true);
    expect(harness.flushed[0]?.resultHash).toBe(computeCanonicalValueHash({ note: null, occurredAt }));
  }),
);

it.effect(
  'uses a resolver-branded recovery only for the exact support-stop Action and still checks permission',
  Effect.fn(function* testProgram6() {
    const recoveryPrincipal = yield* supportRecoveryPrincipalContextResolverFromRepository({
      load: () =>
        Effect.succeedSome({
          authenticationNamespaceId: 'core-identity',
          bindingPrincipalId: principal.principalId,
          bindingTenantId: principal.tenantId,
          principalKind: 'human' as const,
          principalTenantId: principal.tenantId,
          tenantId: principal.tenantId,
        }),
    }).resolveStoppedImpersonation({
      originalAuthBindingId: principalAuthBindingId,
      originalPrincipalId: principal.principalId,
      originalSessionId: 'expired-original-session',
      tenantId: principal.tenantId,
    });
    const harness = yield* makeHarness({ access: 'denied', permissionDecision: 'allowed' });

    const result = yield* harness.runtime
      .runAction({
        payload: {
          checkpoint: 'stopped',
          originalPrincipalId: principal.principalId,
          reason: 'Securely terminate support access',
          sessionRef: 'better-auth-session:impersonated-session',
          targetPrincipalId: '00000000-0000-4000-8000-000000000099',
        },
        principal: recoveryPrincipal,
        registration: recordSupportImpersonationAction,
        transport: transport('support-recovery'),
      })
      .pipe(providePrincipalManagementRepository);

    expect(result).toEqual({ checkpoint: 'stopped', recorded: true });
    // Ending an impersonation only takes authority away, so the grant is never asked (O35, O71):
    // the denying composition above still runs the stop and records it.
    expect(harness.accessQuestions()).toEqual([]);
    expect(harness.permissionCounts()).toEqual({ permissionCheckCount: 0, rejectionCount: 0 });

    // The same denied gate does refuse a start, because a start is not a reduction.
    const deniedStart = yield* Effect.flip(
      harness.runtime
        .runAction({
          payload: {
            checkpoint: 'requested',
            originalPrincipalId: principal.principalId,
            reason: 'Start an impersonation without a grant',
            targetPrincipalId: '00000000-0000-4000-8000-000000000099',
          },
          principal,
          registration: recordSupportImpersonationAction,
          transport: transport('support-start-denied'),
        })
        .pipe(providePrincipalManagementRepository),
    );
    expect(Predicate.isTagged(deniedStart, 'ActionPermissionDenied')).toBe(true);
    expect(harness.accessQuestions().length).toBe(1);
    expect(harness.permissionCounts()).toEqual({ permissionCheckCount: 0, rejectionCount: 1 });

    const wrongCheckpoint = yield* Effect.flip(
      harness.runtime
        .runAction({
          payload: {
            checkpoint: 'requested',
            originalPrincipalId: principal.principalId,
            reason: 'Attempt to misuse recovery authority',
            targetPrincipalId: '00000000-0000-4000-8000-000000000099',
          },
          principal: recoveryPrincipal,
          registration: recordSupportImpersonationAction,
          transport: transport('support-recovery-wrong-checkpoint'),
        })
        .pipe(providePrincipalManagementRepository),
    );
    expect(Predicate.isTagged(wrongCheckpoint, 'ActionTrustedContextValidationError')).toBe(true);

    const wrongAction = yield* Effect.flip(
      harness.runtime.runAction({
        payload: { amount: 1 },
        principal: recoveryPrincipal,
        registration: registration(),
        transport: transport('support-recovery-wrong-action'),
      }),
    );
    expect(Predicate.isTagged(wrongAction, 'ActionTrustedContextValidationError')).toBe(true);
  }),
);

it.effect(
  'fails business Actions closed before invocation, permission, Policy, or handler access',
  Effect.fn(function* testProgram7() {
    yield* forEachSequential(
      (['inactive', 'read_only', 'suspended', 'quarantined', 'deprecated', 'archived', 'missing'] as const).map(
        (state, index) => [index, state] as const,
      ),
      Effect.fn(function* testProgram8([index, state]) {
        let handlerCalls = 0;
        let policyCalls = 0;
        const harness = yield* makeHarness({ moduleState: state });
        const action = defineAction(
          {
            accessDeclaration: fixtureActionAccess('inventory.stock'),
            accessEvidencePolicy: {
              captureMode: 'metadata_only',
              policyKey: 'stock.read.v1',
            },
            actionKey: `inventory.stock.reserve-state-${index}`,
            auditProfile: 'standard',
            domainErrorSchema: Schema.Never,
            domainEvents: {},
            entrypoint: defineTenantModuleEntrypoint({
              access: 'write',
              authorization: {
                kind: 'action_execution',
                provisioning: 'tenant_membership_default',
              },
              entrypointKey: `inventory.stock.reserve-state-${index}`,
              moduleKey: 'inventory.stock',
              role: 'action',
            }),
            idempotency: 'required',
            legalEntityScope: 'optional',
            owningModuleKey: 'inventory.stock',
            payloadSchema: Schema.Void,
            policies: [
              defineGlobalPolicy({
                evaluate: () => Effect.sync(() => (policyCalls += 1)),
                policyKey: `global.unreachable-${index}.v1`,
              }),
            ],
            resultSchema: Schema.Void,
            schemaVersion: '1',
          },
          () =>
            Effect.sync(() => {
              handlerCalls += 1;
            }),
        );
        const failure = yield* Effect.flip(
          harness.runtime.runAction({
            payload: undefined,
            principal,
            registration: action,
            transport: transport(`state-${state}`),
          }),
        );
        expect(Predicate.isTagged(failure, 'ModuleStateDeniedError'), state).toBe(true);

        expect(handlerCalls).toBe(0);
        expect(policyCalls).toBe(0);
        expect(harness.counts()).toEqual({
          createCount: 0,
          lockCount: 0,
          transactionCount: 0,
          transitionCount: 0,
        });
        expect(harness.permissionCounts()).toEqual({
          permissionCheckCount: 0,
          rejectionCount: 0,
        });
        expect(harness.gateCounts()).toEqual({
          handlerResolutionCount: 0,
          moduleStateReadCount: 1,
          moduleStateRecheckCount: 0,
        });
      }),
    );
  }),
);

it.effect(
  'distinguishes unavailable early checks and rolls back a denied locked recheck',
  Effect.fn(function* testProgram9() {
    const action = defineAction(
      {
        accessDeclaration: fixtureActionAccess('inventory.stock'),
        accessEvidencePolicy: {
          captureMode: 'metadata_only',
          policyKey: 'stock.read.v1',
        },
        actionKey: 'inventory.stock.reserve-locked',
        auditProfile: 'standard',
        domainErrorSchema: Schema.Never,
        domainEvents: {},
        entrypoint: defineTenantModuleEntrypoint({
          access: 'write',
          authorization: {
            kind: 'action_execution',
            provisioning: 'tenant_membership_default',
          },
          entrypointKey: 'inventory.stock.reserve-locked',
          moduleKey: 'inventory.stock',
          role: 'action',
        }),
        idempotency: 'required',
        legalEntityScope: 'optional',
        owningModuleKey: 'inventory.stock',
        payloadSchema: Schema.Void,
        policies: [],
        resultSchema: Schema.Void,
        schemaVersion: '1',
      },
      () => Effect.void,
    );

    const unavailable = yield* makeHarness({ moduleState: 'unavailable' });
    const unavailableFailure = yield* Effect.flip(
      unavailable.runtime.runAction({
        payload: undefined,
        principal,
        registration: action,
        transport: transport('state-unavailable'),
      }),
    );
    expect(Predicate.isTagged(unavailableFailure, 'ModuleStateCheckUnavailableError')).toBe(true);

    expect(unavailable.counts().createCount).toBe(0);

    const locked = yield* makeHarness({ lockedModuleState: 'denied' });
    const lockedFailure = yield* Effect.flip(
      locked.runtime.runAction({
        payload: undefined,
        principal,
        registration: action,
        transport: transport('state-locked-denied'),
      }),
    );
    expect(Predicate.isTagged(lockedFailure, 'ModuleStateDeniedError')).toBe(true);

    expect(locked.gateCounts()).toEqual({
      handlerResolutionCount: 0,
      moduleStateReadCount: 1,
      moduleStateRecheckCount: 1,
    });
    expect(locked.counts()).toEqual({
      createCount: 1,
      lockCount: 1,
      transactionCount: 1,
      transitionCount: 0,
    });
  }),
);

it.effect(
  'allows an explicitly authorized Action before Policy evaluation',
  Effect.fn(function* testProgram10() {
    const harness = yield* makeHarness({ permissionDecision: 'allowed' });
    const result = yield* harness.runtime.runAction({
      payload: { amount: 2 },
      principal,
      registration: registration(),
      transport: transport('allowed'),
    });

    expect(result).toEqual({ total: 2 });
    expect(harness.stages.indexOf('permission_checked') < harness.stages.indexOf('policy_boundary')).toBe(true);
    expect(harness.counts().transitionCount).toBe(1);
    expect(harness.counts().transactionCount).toBe(1);
  }),
);

it.effect(
  'requires a declared tenant role independently from the Action executor relation',
  Effect.fn(function* testProgram11() {
    const tenantAuthorizedRegistration = defineAction(
      {
        accessDeclaration: fixtureActionAccess('core.identity'),
        accessEvidencePolicy: {
          captureMode: 'metadata_only',
          policyKey: 'identity.read.v1',
        },
        actionKey: 'core.identity.tenant-authorized',
        auditProfile: 'sensitive',
        domainErrorSchema: Schema.Never,
        domainEvents: {},
        entrypoint: defineSystemModuleEntrypoint({
          access: 'write',
          authorization: {
            kind: 'action_execution',
            provisioning: 'tenant_membership_default',
          },
          entrypointKey: 'core.identity.tenant-authorized',
          moduleKey: 'core.identity',
          role: 'action',
        }),
        idempotency: 'required',
        legalEntityScope: 'optional',
        owningModuleKey: 'core.identity',
        payloadSchema: Schema.Void,
        policies: [],
        resultSchema: Schema.Void,
        schemaVersion: '1',
        tenantPermission: () => 'manage_identity',
      },
      () => Effect.void,
    );

    yield* forEachSequential(
      [
        ['denied', 'ActionPermissionDenied'],
        ['unavailable', 'ActionPermissionCheckError'],
      ] as const,
      Effect.fn(function* testProgram12([decision, expectedTag]) {
        const harness = yield* makeHarness({
          permissionDecision: 'allowed',
          tenantPermissionDecision: decision,
        });
        const failure = yield* Effect.flip(
          harness.runtime.runAction({
            payload: undefined,
            principal,
            registration: tenantAuthorizedRegistration,
            transport: transport(`tenant-${decision}`),
          }),
        );
        expect(Predicate.isTagged(failure, expectedTag)).toBe(true);

        expect(harness.counts().transitionCount).toBe(0);
      }),
    );

    const allowed = yield* makeHarness({
      permissionDecision: 'allowed',
      tenantPermissionDecision: 'allowed',
    });
    yield* allowed.runtime.runAction({
      payload: undefined,
      principal,
      registration: tenantAuthorizedRegistration,
      transport: transport('tenant-allowed'),
    });
    expect(allowed.counts().transitionCount).toBe(1);
  }),
);

it.effect(
  'accepts every Party write authority as an explicit tenant permission',
  Effect.fn(function* testProgram13() {
    const partyPermissions = [
      'manage_party_identity',
      'manage_party_relationships',
      'merge_party_identity',
      'review_party_identity',
    ] as const;
    yield* forEachSequential(
      partyPermissions.map((permission, index) => [index, permission] as const),
      Effect.fn(function* testProgram14([index, permission]) {
        const actionKey = `party.registry.permission-${index}`;
        const action = defineAction(
          {
            accessDeclaration: fixtureActionAccess('party.registry'),
            accessEvidencePolicy: {
              captureMode: 'metadata_only',
              policyKey: 'party.read.v1',
            },
            actionKey,
            auditProfile: 'sensitive',
            domainErrorSchema: Schema.Never,
            domainEvents: {},
            entrypoint: defineTenantModuleEntrypoint({
              access: 'write',
              authorization: {
                kind: 'action_execution',
                provisioning: 'tenant_membership_default',
              },
              entrypointKey: actionKey,
              moduleKey: 'party.registry',
              role: 'action',
            }),
            idempotency: 'required',
            legalEntityScope: 'optional',
            owningModuleKey: 'party.registry',
            payloadSchema: Schema.Void,
            policies: [],
            resultSchema: Schema.Void,
            schemaVersion: '1',
            tenantPermission: () => permission,
          },
          () => Effect.void,
        );
        const harness = yield* makeHarness();
        yield* harness.runtime.runAction({
          payload: undefined,
          principal,
          registration: action,
          transport: transport(permission),
        });
        expect(harness.tenantChecks).toEqual([
          {
            permission,
            principalId: principal.principalId,
            tenantIds: [principal.tenantId],
          },
        ]);
        expect(harness.flushed[0]?.transport).toEqual({
          correlationId: `correlation-${permission}`,
          idempotencyKey: permission,
        });
      }),
    );
  }),
);

it.effect(
  'canonicalizes every resolved tenant permission target for hash and evidence',
  Effect.fn(function* testProgram15() {
    const action = defineAction(
      {
        accessDeclaration: fixtureActionAccess('core.identity'),
        accessEvidencePolicy: {
          captureMode: 'metadata_only',
          policyKey: 'identity.read.v1',
        },
        actionKey: 'core.identity.rotate-managed-key',
        auditProfile: 'sensitive',
        domainErrorSchema: Schema.Never,
        domainEvents: {},
        entrypoint: defineSystemModuleEntrypoint({
          access: 'write',
          authorization: {
            kind: 'action_execution',
            provisioning: 'tenant_membership_default',
          },
          entrypointKey: 'core.identity.rotate-managed-key',
          moduleKey: 'core.identity',
          role: 'action',
        }),
        idempotency: 'required',
        legalEntityScope: 'optional',
        owningModuleKey: 'core.identity',
        payloadSchema: Schema.Void,
        policies: [],
        resultSchema: Schema.Void,
        schemaVersion: '1',
        tenantPermission: () => 'manage_identity',
      },
      () => Effect.void,
    );
    const first = yield* makeHarness();
    const second = yield* makeHarness();
    yield* first.runtime.runAction({
      payload: undefined,
      principal,
      registration: action,
      transport: {
        ...transport('same-idempotency-key'),
        targetModuleKey: 'forged.one',
        targetResourceId: 'forged-one',
        targetResourceType: 'first',
      },
    });
    yield* second.runtime.runAction({
      payload: undefined,
      principal,
      registration: action,
      transport: {
        ...transport('same-idempotency-key'),
        targetModuleKey: 'forged.two',
        targetResourceId: 'forged-two',
        targetResourceType: 'second',
      },
    });

    expect(first.requestHashes).toEqual(second.requestHashes);
    expect(first.flushed[0]?.transport).toEqual({
      correlationId: 'correlation-same-idempotency-key',
      idempotencyKey: 'same-idempotency-key',
    });
    expect(second.flushed[0]?.transport).toEqual(first.flushed[0]?.transport);
  }),
);

it.effect(
  'authorizes Counterparty creation against the trusted Legal Entity before Policy and transaction',
  Effect.fn(function* testProgram16() {
    let handlerCalls = 0;
    let policyCalls = 0;
    const action = defineAction(
      {
        accessDeclaration: fixtureActionAccess('party.registry'),
        accessEvidencePolicy: {
          captureMode: 'metadata_only',
          policyKey: 'counterparty.read.v1',
        },
        actionKey: 'party.registry.create-counterparty',
        auditProfile: 'sensitive',
        domainErrorSchema: Schema.Never,
        domainEvents: {},
        entrypoint: defineTenantModuleEntrypoint({
          access: 'write',
          authorization: {
            kind: 'action_execution',
            provisioning: 'tenant_membership_default',
          },
          entrypointKey: 'party.registry.create-counterparty',
          moduleKey: 'party.registry',
          role: 'action',
        }),
        idempotency: 'required',
        legalEntityPermission: 'manage_counterparty',
        legalEntityScope: 'required',
        owningModuleKey: 'party.registry',
        payloadSchema: Schema.Void,
        policies: [
          defineGlobalPolicy<unknown>({
            evaluate: (input) => {
              policyCalls += 1;
              expect(input.target).toEqual({});
              return Effect.void;
            },
            policyKey: 'party.registry.counterparty-create.v1',
          }),
        ],
        resultSchema: Schema.Void,
        schemaVersion: '1',
      },
      () => {
        handlerCalls += 1;
        return Effect.void;
      },
    );
    const forgedTransport = {
      ...transport('legal-entity-denied'),
      targetModuleKey: 'forged.module',
      targetResourceId: 'forged-legal-entity',
      targetResourceType: 'legal_entity',
    };

    const denied = yield* makeHarness({
      legalEntityPermissionDecision: 'denied',
    });
    const failure = yield* Effect.flip(
      denied.runtime.runAction({
        payload: undefined,
        principal,
        registration: action,
        transport: forgedTransport,
      }),
    );
    expect(Predicate.isTagged(failure, 'ActionPermissionDenied')).toBe(true);

    expect(policyCalls).toBe(0);
    expect(handlerCalls).toBe(0);
    expect(denied.counts().transactionCount).toBe(0);
    expect(denied.legalEntityChecks).toEqual([
      {
        legalEntityIds: [principalLegalEntityId],
        permission: 'manage_counterparty',
        principalId: principal.principalId,
        tenantId: principal.tenantId,
      },
    ]);
    expect(denied.rejections[0]?.transport).toEqual({
      correlationId: 'correlation-legal-entity-denied',
      idempotencyKey: 'legal-entity-denied',
    });
    expect(denied.stages.at(-1)).toBe('permission_checked');

    const unavailable = yield* makeHarness({
      legalEntityPermissionDecision: 'unavailable',
    });
    const unavailableFailure = yield* Effect.flip(
      unavailable.runtime.runAction({
        payload: undefined,
        principal,
        registration: action,
        transport: forgedTransport,
      }),
    );
    expect(Predicate.isTagged(unavailableFailure, 'ActionPermissionCheckError')).toBe(true);

    expect(unavailable.rejections.length).toBe(0);
    expect(unavailable.counts().transactionCount).toBe(0);
    expect(unavailable.stages.includes('permission_checked')).toBe(false);

    const allowed = yield* makeHarness();
    yield* allowed.runtime.runAction({
      payload: undefined,
      principal,
      registration: action,
      transport: {
        ...forgedTransport,
        idempotencyKey: 'legal-entity-allowed',
      },
    });
    expect(policyCalls).toBe(1);
    expect(handlerCalls).toBe(1);
    expect(allowed.flushed[0]?.transport).toEqual({
      correlationId: 'correlation-legal-entity-denied',
      idempotencyKey: 'legal-entity-allowed',
    });
    expect(allowed.stages.indexOf('permission_checked') < allowed.stages.indexOf('policy_boundary')).toBe(true);
  }),
);

it.effect(
  'authorizes the resolved Resource target before Policy, transaction, and handler',
  Effect.fn(function* testProgram17() {
    let handlerCalls = 0;
    let policyCalls = 0;
    const action = defineAction(
      {
        accessDeclaration: fixtureActionAccess('party.registry'),
        accessEvidencePolicy: {
          captureMode: 'metadata_only',
          policyKey: 'counterparty.read.v1',
        },
        actionKey: 'party.registry.end-counterparty-role',
        auditProfile: 'sensitive',
        domainErrorSchema: Schema.Never,
        domainEvents: {},
        entrypoint: defineTenantModuleEntrypoint({
          access: 'write',
          authorization: {
            kind: 'action_execution',
            provisioning: 'tenant_membership_default',
          },
          entrypointKey: 'party.registry.end-counterparty-role',
          moduleKey: 'party.registry',
          role: 'action',
        }),
        idempotency: 'required',
        legalEntityScope: 'required',
        owningModuleKey: 'party.registry',
        payloadSchema: Schema.Struct({ counterpartyId: CounterpartyIdSchema }),
        policies: [
          defineGlobalPolicy<{ readonly counterpartyId: CounterpartyId }>({
            evaluate: (input) => {
              policyCalls += 1;
              expect(input.target).toEqual({
                targetModuleKey: 'party.registry',
                targetResourceId: 'counterparty-1',
                targetResourceType: 'counterparty',
              });
              return Effect.void;
            },
            policyKey: 'party.registry.role-end.v1',
          }),
        ],
        resourcePermission: defineActionResourcePermission<{
          readonly counterpartyId: CounterpartyId;
        }>(({ counterpartyId }, scope) => {
          expect(scope.legalEntityId).toBe(principalLegalEntityId);
          return {
            permission: 'write',
            resource: {
              moduleId: 'party.registry',
              resourceId: counterpartyId,
              resourceType: 'counterparty',
            },
          };
        }),
        resultSchema: Schema.Void,
        schemaVersion: '1',
      },
      () => {
        handlerCalls += 1;
        return Effect.void;
      },
    );

    const denied = yield* makeHarness({ resourcePermissionDecision: 'denied' });
    const failure = yield* Effect.flip(
      denied.runtime.runAction({
        payload: { counterpartyId: 'counterparty-1' },
        principal,
        registration: action,
        transport: {
          ...transport('resource-denied'),
          targetModuleKey: 'forged.module',
          targetResourceId: 'forged-resource',
          targetResourceType: 'forged-type',
        },
      }),
    );

    expect(Predicate.isTagged(failure, 'ActionPermissionDenied')).toBe(true);

    expect(policyCalls).toBe(0);
    expect(handlerCalls).toBe(0);
    expect(denied.counts().transactionCount).toBe(0);
    expect(denied.resourceChecks).toEqual([
      {
        legalEntityId: principalLegalEntityId,
        permission: 'write',
        principalId: principal.principalId,
        resources: [
          {
            moduleId: 'party.registry',
            resourceId: 'counterparty-1',
            resourceType: 'counterparty',
          },
        ],
        tenantId: principal.tenantId,
      },
    ]);
    expect(denied.rejections[0]?.transport).toEqual({
      correlationId: 'correlation-resource-denied',
      idempotencyKey: 'resource-denied',
      targetModuleKey: 'party.registry',
      targetResourceId: 'counterparty-1',
      targetResourceType: 'counterparty',
    });

    const unavailable = yield* makeHarness({
      resourcePermissionDecision: 'unavailable',
    });
    const unavailableFailure = yield* Effect.flip(
      unavailable.runtime.runAction({
        payload: { counterpartyId: 'counterparty-1' },
        principal,
        registration: action,
        transport: transport('resource-unavailable'),
      }),
    );
    expect(Predicate.isTagged(unavailableFailure, 'ActionPermissionCheckError')).toBe(true);

    expect(unavailable.rejections.length).toBe(0);
    expect(unavailable.counts().transactionCount).toBe(0);
  }),
);

it.effect(
  'enforces conjunctive business and Resource permissions before Policy and handler execution',
  Effect.fn(function* testConjunctiveBusinessAndResourcePermissions() {
    const observed: string[] = [];
    let handlerCalls = 0;
    let policyCalls = 0;
    const permission = yield* Schema.decodeEffect(FixturePermissionCodeSchema)(
      'retail.settings.payment_term_preference.manage',
    );
    const action = defineAction(
      {
        accessDeclaration: fixtureActionAccess('commerce.customer-context'),
        accessEvidencePolicy: {
          captureMode: 'metadata_only',
          policyKey: 'retail-profile.write.v1',
        },
        actionKey: 'commerce.customer-context.change-payment-term',
        auditProfile: 'sensitive',
        domainErrorSchema: Schema.Never,
        domainEvents: {},
        entrypoint: defineTenantModuleEntrypoint({
          access: 'write',
          authorization: {
            kind: 'action_execution',
            provisioning: 'tenant_membership_default',
          },
          entrypointKey: 'commerce.customer-context.change-payment-term',
          moduleKey: 'commerce.customer-context',
          role: 'action',
        }),
        idempotency: 'required',
        legalEntityScope: 'required',
        ownerPermissions: historicalActionPermissions<{ readonly profileId: RetailProfileId }>(
          permission,
          ({ profileId }, scope) => ({
            permission,
            target: {
              kind: 'retail_profile',
              legalEntityId: scope.legalEntityId ?? '',
              profileId,
              tenantId: scope.tenantId,
            },
          }),
        ),
        owningModuleKey: 'commerce.customer-context',
        payloadSchema: Schema.Struct({ profileId: RetailProfileIdSchema }),
        policies: [
          defineGlobalPolicy({
            evaluate: () => {
              policyCalls += 1;
              observed.push('policy');
              return Effect.void;
            },
            policyKey: 'global.retail-profile-write.v1',
          }),
        ],
        resourcePermission: defineActionResourcePermission<{
          readonly profileId: RetailProfileId;
        }>(({ profileId }) => ({
          permission: 'write',
          resource: {
            moduleId: 'commerce.customer-context',
            resourceId: profileId,
            resourceType: 'retail-profile',
          },
        })),
        resultSchema: Schema.Void,
        schemaVersion: '1',
      },
      () => {
        observed.push('handler');
        handlerCalls += 1;
        return Effect.void;
      },
    );
    const run = (harness: Effect.Success<ReturnType<typeof makeHarness>>, idempotencyKey: string) =>
      harness.runtime.runAction({
        payload: { profileId: 'profile-1' },
        principal,
        registration: action,
        transport: transport(idempotencyKey),
      });

    const allowed = yield* makeHarness({
      onBusinessPermissionCheck: () => {
        observed.push('business_permission');
      },
      onResourcePermissionCheck: () => {
        observed.push('resource_permission');
      },
    });
    yield* run(allowed, 'conjunctive-allowed');
    expect(observed).toEqual(['resource_permission', 'business_permission', 'policy', 'handler']);
    expect(handlerCalls).toBe(1);
    expect(policyCalls).toBe(1);

    const ownerMissing = yield* makeHarness({
      businessPermissionDecision: 'allowed',
      omitOwnerAuthorizationOverlay: true,
      resourcePermissionDecision: 'allowed',
    });
    const ownerMissingFailure = yield* Effect.flip(run(ownerMissing, 'owner-overlay-missing'));
    expect(Predicate.isTagged(ownerMissingFailure, 'ActionPermissionCheckError')).toBe(true);
    expect(ownerMissing.rejections).toHaveLength(0);
    expect(ownerMissing.counts().transactionCount).toBe(1);
    expect(handlerCalls).toBe(1);

    const resourceDenied = yield* makeHarness({ resourcePermissionDecision: 'denied' });
    const resourceDeniedFailure = yield* Effect.flip(run(resourceDenied, 'resource-denied'));
    expect(Predicate.isTagged(resourceDeniedFailure, 'ActionPermissionDenied')).toBe(true);
    expect(resourceDenied.resourceChecks).toHaveLength(1);
    expect(resourceDenied.businessPermissionChecks).toHaveLength(1);

    const businessDenied = yield* makeHarness({ businessPermissionDecision: 'denied' });
    const businessDeniedFailure = yield* Effect.flip(run(businessDenied, 'business-denied'));
    expect(Predicate.isTagged(businessDeniedFailure, 'ActionPermissionDenied')).toBe(true);
    expect(businessDenied.resourceChecks).toHaveLength(1);
    expect(businessDenied.businessPermissionChecks).toHaveLength(1);

    const resourceUnavailable = yield* makeHarness({ resourcePermissionDecision: 'unavailable' });
    const resourceUnavailableFailure = yield* Effect.flip(run(resourceUnavailable, 'resource-unavailable'));
    expect(Predicate.isTagged(resourceUnavailableFailure, 'ActionPermissionCheckError')).toBe(true);

    const businessUnavailable = yield* makeHarness({ businessPermissionDecision: 'unavailable' });
    const businessUnavailableFailure = yield* Effect.flip(run(businessUnavailable, 'business-unavailable'));
    expect(Predicate.isTagged(businessUnavailableFailure, 'ActionPermissionCheckError')).toBe(true);
    expect(businessUnavailable.resourceChecks).toHaveLength(1);
    expect(businessUnavailable.businessPermissionChecks).toHaveLength(1);

    expect(handlerCalls).toBe(1);
    expect(policyCalls).toBe(2);
  }),
);

it.effect(
  'enforces tenant-only Price Group targets and persists their canonical authorization evidence',
  Effect.fn(function* testPriceGroupBusinessPermission() {
    const permission = yield* Schema.decodeEffect(FixturePermissionCodeSchema)('pricing.price_group.read');
    const PriceGroupIdSchema = Schema.String.pipe(Schema.brand('PriceGroupId'));
    const PricingCatalogIdSchema = Schema.String.pipe(Schema.brand('PricingCatalogId'));
    const TargetTenantIdSchema = Schema.String.pipe(Schema.brand('TargetTenantId'));
    const InputSchema = Schema.Struct({
      priceGroupId: PriceGroupIdSchema,
      pricingCatalogId: PricingCatalogIdSchema,
      targetTenantId: TargetTenantIdSchema,
    });
    let handlerCalls = 0;
    const action = defineAction(
      {
        accessDeclaration: fixtureActionAccess('pricing.price-group-catalog'),
        accessEvidencePolicy: {
          captureMode: 'metadata_only',
          policyKey: 'pricing.price-group.read.v1',
        },
        actionKey: 'pricing.price-group.inspect',
        auditProfile: 'sensitive',
        domainErrorSchema: Schema.Never,
        domainEvents: {},
        entrypoint: defineTenantModuleEntrypoint({
          access: 'write',
          authorization: {
            kind: 'action_execution',
            provisioning: 'tenant_membership_default',
          },
          entrypointKey: 'pricing.price-group.inspect',
          moduleKey: 'pricing.price-group-catalog',
          role: 'action',
        }),
        idempotency: 'required',
        legalEntityScope: 'forbidden',
        ownerPermissions: historicalActionPermissions<typeof InputSchema.Type>(permission, (payload) => ({
          permission,
          target: {
            kind: 'price_group',
            priceGroupId: payload.priceGroupId,
            pricingCatalogId: payload.pricingCatalogId,
            tenantId: payload.targetTenantId,
          },
        })),
        owningModuleKey: 'pricing.price-group-catalog',
        payloadSchema: InputSchema,
        policies: [],
        resultSchema: Schema.Void,
        schemaVersion: '1',
      },
      () => {
        handlerCalls += 1;
        return Effect.void;
      },
    );
    const payload = {
      priceGroupId,
      pricingCatalogId,
      targetTenantId: principal.tenantId,
    };
    const tenantOnlyPrincipal = Struct.omit(principal, ['legalEntityId']);
    const run = (harness: Effect.Success<ReturnType<typeof makeHarness>>, input = payload) =>
      harness.runtime.runAction({
        payload: input,
        principal: tenantOnlyPrincipal,
        registration: action,
        transport: {
          ...transport('pricing-target'),
          targetModuleKey: 'forged.module',
          targetResourceId: 'forged-resource',
          targetResourceType: 'forged-type',
        },
      });

    const first = yield* makeHarness({ businessPermissionDecision: 'allowed' });
    const second = yield* makeHarness({ businessPermissionDecision: 'allowed' });
    yield* run(first);
    yield* run(second);
    expect(first.businessPermissionChecks).toEqual([
      {
        principal: { principalId: principal.principalId, tenantId: principal.tenantId },
        targets: [
          {
            permission,
            target: {
              kind: 'price_group',
              priceGroupId,
              pricingCatalogId,
              tenantId: principal.tenantId,
            },
          },
        ],
      },
    ]);
    expect(first.requestHashes).toEqual(second.requestHashes);
    expect(first.flushed[0]?.transport).toEqual({
      correlationId: 'correlation-pricing-target',
      idempotencyKey: 'pricing-target',
      targetModuleKey: 'pricing.price-group-catalog',
      targetResourceId: `${pricingCatalogId}:${priceGroupId}`,
      targetResourceType: `price_group:${permission}`,
    });

    const wrongPriceGroup = yield* makeHarness({ businessPermissionDecision: 'denied' });
    const denied = yield* Effect.flip(
      run(wrongPriceGroup, {
        ...payload,
        priceGroupId: otherPriceGroupId,
      }),
    );
    expect(Predicate.isTagged(denied, 'ActionPermissionDenied')).toBe(true);

    const crossTenant = yield* makeHarness({ businessPermissionDecision: 'allowed' });
    const crossTenantFailure = yield* Effect.flip(
      run(crossTenant, {
        ...payload,
        targetTenantId: '00000000-0000-4000-8000-000000000099',
      }),
    );
    expect(Predicate.isTagged(crossTenantFailure, 'ActionPermissionCheckError')).toBe(true);
    expect(crossTenant.businessPermissionChecks).toHaveLength(0);

    const unavailable = yield* makeHarness({ businessPermissionDecision: 'unavailable' });
    expect(Predicate.isTagged(yield* Effect.flip(run(unavailable)), 'ActionPermissionCheckError')).toBe(true);
    for (const invalidPayload of [
      { ...payload, priceGroupId: 'DEALER' },
      { ...payload, pricingCatalogId: 'DEALER' },
    ]) {
      const invalidIdentifier = yield* makeHarness({ businessPermissionDecision: 'allowed' });
      expect(
        Predicate.isTagged(yield* Effect.flip(run(invalidIdentifier, invalidPayload)), 'ActionPermissionCheckError'),
      ).toBe(true);
      expect(invalidIdentifier.businessPermissionChecks).toHaveLength(0);
      expect(invalidIdentifier.counts().createCount).toBe(0);
      expect(invalidIdentifier.flushed).toHaveLength(0);
    }
    expect(handlerCalls).toBe(2);
  }),
);

it.effect(
  'enforces exact tenant-qualified Inventory Resource permissions and preserves the durable ResourceRef in evidence',
  Effect.fn(function* testInventoryResourceBusinessPermission() {
    const permission = yield* Schema.decodeEffect(FixturePermissionCodeSchema)('inventory.stock.correct');
    const InventoryResourceIdSchema = Schema.String.check(Schema.isUUID()).pipe(Schema.brand('InventoryResourceId'));
    const TargetTenantIdSchema = Schema.String.check(Schema.isUUID()).pipe(Schema.brand('InventoryTargetTenantId'));
    const InputSchema = Schema.Struct({
      resourceId: InventoryResourceIdSchema,
      targetTenantId: TargetTenantIdSchema,
    });
    let handlerCalls = 0;
    const action = defineAction(
      {
        accessDeclaration: fixtureActionAccess('commerce.inventory'),
        accessEvidencePolicy: {
          captureMode: 'metadata_only',
          policyKey: 'inventory.stock-correction.v1',
        },
        actionKey: 'commerce.inventory.correct-stock-position',
        auditProfile: 'sensitive',
        domainErrorSchema: Schema.Never,
        domainEvents: {},
        entrypoint: defineTenantModuleEntrypoint({
          access: 'write',
          authorization: { kind: 'action_execution', provisioning: 'explicit' },
          entrypointKey: 'commerce.inventory.correct-stock-position',
          moduleKey: 'commerce.inventory',
          role: 'action',
        }),
        idempotency: 'required',
        legalEntityScope: 'optional',
        ownerPermissions: historicalActionPermissions<typeof InputSchema.Type>(permission, (payload) => ({
          permission,
          target: {
            kind: 'inventory_resource',
            resource: {
              moduleId: 'commerce.inventory',
              resourceId: payload.resourceId,
              resourceType: 'commerce.inventory.stock-position',
            },
            tenantId: payload.targetTenantId,
          },
        })),
        owningModuleKey: 'commerce.inventory',
        payloadSchema: InputSchema,
        policies: [],
        resultSchema: Schema.Void,
        schemaVersion: '1',
      },
      () => {
        handlerCalls += 1;
        return Effect.void;
      },
    );
    const resourceId = '70000000-0000-4000-8000-000000000001';
    const payload = { resourceId, targetTenantId: principal.tenantId };
    const run = (harness: Effect.Success<ReturnType<typeof makeHarness>>, input = payload) =>
      harness.runtime.runAction({
        payload: input,
        principal,
        registration: action,
        transport: transport('inventory-resource-target'),
      });

    const allowed = yield* makeHarness({ businessPermissionDecision: 'allowed' });
    yield* run(allowed);
    expect(allowed.businessPermissionChecks).toEqual([
      {
        principal: { principalId: principal.principalId, tenantId: principal.tenantId },
        targets: [
          {
            permission,
            target: {
              kind: 'inventory_resource',
              resource: {
                moduleId: 'commerce.inventory',
                resourceId,
                resourceType: 'commerce.inventory.stock-position',
              },
              tenantId: principal.tenantId,
            },
          },
        ],
      },
    ]);
    expect(allowed.flushed[0]?.transport).toEqual({
      correlationId: 'correlation-inventory-resource-target',
      idempotencyKey: 'inventory-resource-target',
      targetModuleKey: 'commerce.inventory',
      targetResourceId: resourceId,
      targetResourceType: 'commerce.inventory.stock-position',
    });

    const denied = yield* makeHarness({ businessPermissionDecision: 'denied' });
    expect(Predicate.isTagged(yield* Effect.flip(run(denied)), 'ActionPermissionDenied')).toBe(true);

    for (const [invalidPayload, expectedTag] of [
      [{ ...payload, targetTenantId: '00000000-0000-4000-8000-000000000099' }, 'ActionPermissionCheckError'],
      [{ ...payload, resourceId: 'position-by-item-and-location' }, 'ActionPayloadValidationError'],
    ] as const) {
      const invalid = yield* makeHarness({ businessPermissionDecision: 'allowed' });
      expect(Predicate.isTagged(yield* Effect.flip(run(invalid, invalidPayload)), expectedTag)).toBe(true);
      expect(invalid.businessPermissionChecks).toHaveLength(0);
    }
    expect(handlerCalls).toBe(1);
  }),
);

it.effect(
  'enforces TAX management only on the exact trusted Selling Legal Entity and never on another seller',
  Effect.fn(function* testTaxSellingLegalEntityBusinessPermission() {
    const permission = yield* Schema.decodeEffect(FixturePermissionCodeSchema)('tax.rule.manage');
    const SellerIdSchema = Schema.String.pipe(Schema.brand('TaxSellerLegalEntityId'));
    const InputSchema = Schema.Struct({ sellerLegalEntityId: SellerIdSchema });
    let handlerCalls = 0;
    const action = defineAction(
      {
        accessDeclaration: fixtureActionAccess('commerce.tax'),
        accessEvidencePolicy: {
          captureMode: 'metadata_only',
          policyKey: 'commerce.tax.create-tax-rule.access.v1',
        },
        actionKey: 'commerce.tax.create-tax-rule',
        auditProfile: 'sensitive',
        domainErrorSchema: Schema.Never,
        domainEvents: {},
        entrypoint: defineTenantModuleEntrypoint({
          access: 'write',
          authorization: { kind: 'action_execution', provisioning: 'explicit' },
          entrypointKey: 'commerce.tax.create-tax-rule',
          moduleKey: 'commerce.tax',
          role: 'action',
        }),
        idempotency: 'required',
        legalEntityScope: 'required',
        ownerPermissions: historicalActionPermissions<typeof InputSchema.Type>(permission, (payload, scope) => ({
          permission,
          target: {
            kind: 'tax_selling_legal_entity',
            legalEntityId: payload.sellerLegalEntityId,
            tenantId: scope.tenantId,
          },
        })),
        owningModuleKey: 'commerce.tax',
        payloadSchema: InputSchema,
        policies: [],
        resultSchema: Schema.Void,
        schemaVersion: '1',
      },
      () => {
        handlerCalls += 1;
        return Effect.void;
      },
    );
    const payload = { sellerLegalEntityId: principalLegalEntityId };
    const run = (harness: Effect.Success<ReturnType<typeof makeHarness>>, input = payload) =>
      harness.runtime.runAction({
        payload: input,
        principal,
        registration: action,
        transport: transport('tax-seller-target'),
      });

    const allowed = yield* makeHarness({ businessPermissionDecision: 'allowed' });
    yield* run(allowed);
    expect(allowed.businessPermissionChecks).toEqual([
      {
        principal: { principalId: principal.principalId, tenantId: principal.tenantId },
        targets: [
          {
            permission,
            target: {
              kind: 'tax_selling_legal_entity',
              legalEntityId: principalLegalEntityId,
              tenantId: principal.tenantId,
            },
          },
        ],
      },
    ]);
    expect(allowed.flushed[0]?.transport).toEqual({
      correlationId: 'correlation-tax-seller-target',
      idempotencyKey: 'tax-seller-target',
      targetModuleKey: 'commerce.tax',
      targetResourceId: principalLegalEntityId,
      targetResourceType: 'tax_selling_legal_entity:tax.rule.manage',
    });

    const denied = yield* makeHarness({ businessPermissionDecision: 'denied' });
    expect(Predicate.isTagged(yield* Effect.flip(run(denied)), 'ActionPermissionDenied')).toBe(true);

    const otherSeller = yield* makeHarness({ businessPermissionDecision: 'allowed' });
    expect(
      Predicate.isTagged(
        yield* Effect.flip(run(otherSeller, { sellerLegalEntityId: '00000000-0000-4000-8000-000000000099' })),
        'ActionPermissionCheckError',
      ),
    ).toBe(true);
    expect(otherSeller.businessPermissionChecks).toHaveLength(0);
    expect(handlerCalls).toBe(1);
  }),
);

it.effect(
  'rejects a Pricing permission resolved onto a Counterparty target before checks, persistence, or handler code',
  Effect.fn(function* rejectMismatchedBusinessPermissionTarget() {
    const pricingPermission = yield* Schema.decodeEffect(FixturePermissionCodeSchema)('pricing.price_group.read');
    const MismatchedTargetPayloadSchema = Schema.Struct({ counterpartyId: CounterpartyIdSchema });
    let handlerCalls = 0;
    const action = defineAction(
      {
        accessDeclaration: fixtureActionAccess('pricing.price-group-catalog'),
        accessEvidencePolicy: {
          captureMode: 'metadata_only',
          policyKey: 'pricing.price-group.mismatched-target.v1',
        },
        actionKey: 'pricing.price-group.mismatched-target',
        auditProfile: 'sensitive',
        domainErrorSchema: Schema.Never,
        domainEvents: {},
        entrypoint: defineTenantModuleEntrypoint({
          access: 'write',
          authorization: { kind: 'action_execution', provisioning: 'tenant_membership_default' },
          entrypointKey: 'pricing.price-group.mismatched-target',
          moduleKey: 'pricing.price-group-catalog',
          role: 'action',
        }),
        idempotency: 'required',
        legalEntityScope: 'required',
        ownerPermissions: historicalActionPermissions<typeof MismatchedTargetPayloadSchema.Type>(
          pricingPermission,
          (payload) => ({
            permission: pricingPermission,
            target: {
              counterpartyId: payload.counterpartyId,
              kind: 'counterparty',
              legalEntityId: principalLegalEntityId,
              tenantId: principal.tenantId,
            },
          }),
        ),
        owningModuleKey: 'pricing.price-group-catalog',
        payloadSchema: MismatchedTargetPayloadSchema,
        policies: [],
        resultSchema: Schema.Void,
        schemaVersion: '1',
      },
      () => {
        handlerCalls += 1;
        return Effect.void;
      },
    );
    const harness = yield* makeHarness({ businessPermissionDecision: 'allowed' });
    const failure = yield* Effect.flip(
      harness.runtime.runAction({
        payload: { counterpartyId: 'counterparty-one' },
        principal,
        registration: action,
        transport: transport('mismatched-pricing-target'),
      }),
    );

    expect(Predicate.isTagged(failure, 'ActionPermissionCheckError')).toBe(true);
    expect(harness.businessPermissionChecks).toHaveLength(0);
    expect(harness.counts().createCount).toBe(0);
    expect(harness.flushed).toHaveLength(0);
    expect(handlerCalls).toBe(0);
  }),
);

it.effect(
  'accepts Storefront business targets only from exact gateway-verified scope',
  Effect.fn(function* testTrustedStorefrontBusinessPermission() {
    const permission = yield* Schema.decodeEffect(FixturePermissionCodeSchema)('counterparty.purchase.submit');
    const StorefrontIdSchema = Schema.String.pipe(Schema.brand('StorefrontId'));
    let handlerCalls = 0;
    const action = defineAction(
      {
        accessDeclaration: fixtureActionAccess('commerce.customer-context'),
        accessEvidencePolicy: {
          captureMode: 'metadata_only',
          policyKey: 'counterparty-storefront.write.v1',
        },
        actionKey: 'commerce.customer-context.storefront-command',
        auditProfile: 'sensitive',
        domainErrorSchema: Schema.Never,
        domainEvents: {},
        entrypoint: defineTenantModuleEntrypoint({
          access: 'write',
          authorization: {
            kind: 'action_execution',
            provisioning: 'tenant_membership_default',
          },
          entrypointKey: 'commerce.customer-context.storefront-command',
          moduleKey: 'commerce.customer-context',
          role: 'action',
        }),
        idempotency: 'required',
        legalEntityScope: 'required',
        ownerPermissions: historicalActionPermissions<{
          readonly counterpartyId: CounterpartyId;
          readonly storefrontId: string;
        }>(permission, ({ counterpartyId, storefrontId }, scope) => ({
          permission,
          target: {
            counterpartyId,
            kind: 'counterparty_storefront',
            legalEntityId: scope.legalEntityId ?? '',
            storefrontId,
            tenantId: scope.tenantId,
          },
          // Deliberately mirrors untrusted payload to prove Core does not accept self-promotion.
          trustedStorefrontId: storefrontId,
        })),
        owningModuleKey: 'commerce.customer-context',
        payloadSchema: Schema.Struct({
          counterpartyId: CounterpartyIdSchema,
          storefrontId: StorefrontIdSchema,
        }),
        policies: [],
        resultSchema: Schema.Void,
        schemaVersion: '1',
      },
      () => {
        handlerCalls += 1;
        return Effect.void;
      },
    );
    const run = (storefrontPrincipal: typeof principal, storefrontId: string, key: string) =>
      Effect.gen(function* runStorefrontAction() {
        const harness = yield* makeHarness();
        const result = yield* Effect.exit(
          harness.runtime.runAction({
            payload: { counterpartyId: 'counterparty-1', storefrontId },
            principal: storefrontPrincipal,
            registration: action,
            transport: transport(key),
          }),
        );
        return { harness, result };
      });

    const untrusted = yield* run(principal, 'storefront-a', 'storefront-untrusted');
    expect(Exit.isFailure(untrusted.result)).toBe(true);
    expect(untrusted.harness.businessPermissionChecks).toHaveLength(0);

    const trusted = trustVerifiedGatewayPrincipalContext(
      {
        ...principal,
        trustedStorefrontId: 'storefront-a',
      },
      approvedCompositionRevision,
    );
    const mismatch = yield* run(trusted, 'storefront-b', 'storefront-mismatch');
    expect(Exit.isFailure(mismatch.result)).toBe(true);
    expect(mismatch.harness.businessPermissionChecks).toHaveLength(0);

    const allowed = yield* run(trusted, 'storefront-a', 'storefront-allowed');
    expect(Exit.isSuccess(allowed.result)).toBe(true);
    expect(allowed.harness.businessPermissionChecks).toEqual([
      {
        principal: { principalId: principal.principalId, tenantId: principal.tenantId },
        targets: [
          {
            permission,
            target: {
              counterpartyId: 'counterparty-1',
              kind: 'counterparty_storefront',
              legalEntityId: principalLegalEntityId,
              storefrontId: 'storefront-a',
              tenantId: principal.tenantId,
            },
          },
        ],
        trustedStorefrontId: 'storefront-a',
      },
    ]);
    expect(handlerCalls).toBe(1);
  }),
);

it.effect('checks every plural Owner target conjunctively before the handler', () =>
  Effect.gen(function* checksPluralOwnerTargets() {
    let handlerCalls = 0;
    let serviceFactoryCalls = 0;
    const action = defineAction(
      {
        accessDeclaration: fixtureActionAccess('commerce.fixture'),
        accessEvidencePolicy: { captureMode: 'metadata_only', policyKey: 'owner.replace.v1' },
        actionKey: 'commerce.fixture.replace-binding',
        auditProfile: 'standard',
        domainErrorSchema: Schema.Never,
        domainEvents: {},
        entrypoint: defineTenantModuleEntrypoint({
          access: 'write',
          authorization: { kind: 'action_execution', provisioning: 'tenant_membership_default' },
          entrypointKey: 'commerce.fixture.replace-binding',
          moduleKey: 'commerce.fixture',
          role: 'action',
        }),
        idempotency: 'required',
        legalEntityScope: 'required',
        ownerPermissions: defineActionOwnerPermissions(fixtureOwnerContract, () => [
          ownerPermissionTarget(principal, 'existing', {
            definition: fixtureOwnerEndPermission,
            transportObjectId: 'owner-conjunction',
          }),
          ownerPermissionTarget(principal, 'proposed', {
            definition: fixtureOwnerCreatePermission,
            transportObjectId: 'owner-conjunction',
          }),
        ]),
        owningModuleKey: 'commerce.fixture',
        payloadSchema: Schema.Struct({ value: Schema.String }),
        policies: [],
        resultSchema: Schema.Void,
        schemaVersion: '1',
      },
      () => {
        handlerCalls += 1;
        return Effect.void;
      },
      () => {
        serviceFactoryCalls += 1;
        return Effect.succeed({});
      },
    );
    const allowed = yield* makeHarness({
      createRecord: {
        actionInvocationId: 'owner-plural-allowed',
        completedAt: null,
        requestHash: '',
        status: 'received',
      },
    });
    yield* allowed.runtime.runAction({
      payload: { value: 'replace' },
      principal,
      registration: action,
      transport: transport('owner-plural-allowed'),
    });
    expect(allowed.ownerPermissionChecks).toHaveLength(2);
    expect(handlerCalls).toBe(1);
    expect(serviceFactoryCalls).toBe(1);

    const denied = yield* makeHarness({
      createRecord: {
        actionInvocationId: 'owner-plural-denied',
        completedAt: null,
        requestHash: '',
        status: 'received',
      },
      ownerPermissionDecisions: ['allowed', 'denied'],
    });
    const failure = yield* Effect.flip(
      denied.runtime.runAction({
        payload: { value: 'replace' },
        principal,
        registration: action,
        transport: transport('owner-plural-denied'),
      }),
    );
    expect(Predicate.isTagged(failure, 'ActionPermissionDenied')).toBe(true);
    expect(denied.ownerPermissionChecks).toHaveLength(2);
    expect(denied.gateCounts().handlerResolutionCount).toBe(0);
    expect(serviceFactoryCalls).toBe(1);

    const unavailableOptions = { ownerPermissionDecisions: ['allowed', 'unavailable'] } satisfies HarnessOptions;
    const unavailable = yield* makeHarness(unavailableOptions);
    const unavailableFailure = yield* Effect.flip(
      unavailable.runtime.runAction({
        payload: { value: 'replace' },
        principal,
        registration: action,
        transport: transport('owner-plural-unavailable'),
      }),
    );
    expect(Predicate.isTagged(unavailableFailure, 'ActionPermissionCheckError')).toBe(true);
    expect(unavailable.ownerPermissionChecks).toHaveLength(2);
    expect(unavailable.gateCounts().handlerResolutionCount).toBe(0);
    expect(serviceFactoryCalls).toBe(1);
    expect(handlerCalls).toBe(1);
    expect(unavailable.rejections).toHaveLength(0);
    expect(unavailable.invocationState().status).toBe('received');
    unavailableOptions.ownerPermissionDecisions = ['allowed', 'allowed'];
    yield* unavailable.runtime.runAction({
      payload: { value: 'replace' },
      principal,
      registration: action,
      transport: transport('owner-plural-unavailable'),
    });
    expect(unavailable.ownerPermissionChecks).toHaveLength(4);
    expect(handlerCalls).toBe(2);
    expect(serviceFactoryCalls).toBe(2);
  }),
);

it.effect(
  'checks Current grants for each fresh owner invocation and independently preserves executor, module and Resource gates',
  () =>
    Effect.gen(function* rechecksFreshOwnerAuthority() {
      let handlerCalls = 0;
      const action = defineAction(
        {
          accessDeclaration: fixtureActionAccess('commerce.fixture'),
          accessEvidencePolicy: { captureMode: 'metadata_only', policyKey: 'fixture.current.v1' },
          actionKey: 'commerce.fixture.current',
          auditProfile: 'standard',
          domainErrorSchema: Schema.Never,
          domainEvents: {},
          entrypoint: defineTenantModuleEntrypoint({
            access: 'write',
            authorization: { kind: 'action_execution', provisioning: 'tenant_membership_default' },
            entrypointKey: 'commerce.fixture.current',
            moduleKey: 'commerce.fixture',
            role: 'action',
          }),
          idempotency: 'required',
          legalEntityScope: 'required',
          ownerPermissions: defineActionOwnerPermissions(fixtureOwnerContract, (_payload, scope) => [
            ownerPermissionTarget(scope),
          ]),
          owningModuleKey: 'commerce.fixture',
          payloadSchema: Schema.Void,
          policies: [],
          resourcePermission: defineActionResourcePermission(() => ({
            permission: 'write',
            resource: { moduleId: 'commerce.fixture', resourceId: 'existing', resourceType: 'fixture' },
          })),
          resultSchema: Schema.Void,
          schemaVersion: '1',
        },
        () => {
          handlerCalls += 1;
          return Effect.void;
        },
        () => Effect.succeed({}),
      );
      const scenarios = [
        { failure: null, key: 'initial', options: { ownerPermissionDecision: 'allowed' }, principal },
        {
          failure: 'ActionPermissionDenied',
          key: 'revoked',
          options: { ownerPermissionDecision: 'denied' },
          principal,
        },
        {
          failure: 'ActionPermissionDenied',
          key: 'other-principal',
          options: { ownerPermissionDecision: 'denied' },
          principal: { ...principal, principalId: '00000000-0000-4000-8000-000000000099' },
        },
        {
          failure: 'ActionPermissionDenied',
          key: 'other-tenant',
          options: { ownerPermissionDecision: 'denied' },
          principal: { ...principal, tenantId: '00000000-0000-4000-8000-000000000098' },
        },
        {
          failure: 'ActionPermissionDenied',
          key: 'executor-denied',
          options: { ownerPermissionDecision: 'allowed', permissionDecision: 'denied' },
          principal,
        },
        {
          failure: 'ModuleStateDeniedError',
          key: 'module-inactive',
          options: { moduleState: 'inactive', ownerPermissionDecision: 'allowed' },
          principal,
        },
        {
          failure: 'ActionPermissionDenied',
          key: 'resource-denied',
          options: { ownerPermissionDecision: 'allowed', resourcePermissionDecision: 'denied' },
          principal,
        },
      ] as const;
      for (const scenario of scenarios) {
        const harness = yield* makeHarness({
          ...scenario.options,
          createRecord: { actionInvocationId: scenario.key, completedAt: null, requestHash: '', status: 'received' },
        });
        const invocation = harness.runtime.runAction({
          payload: undefined,
          principal: scenario.principal,
          registration: action,
          transport: transport(scenario.key),
        });
        if (scenario.failure === null) {
          yield* invocation;
        } else {
          expect(Predicate.isTagged(yield* Effect.flip(invocation), scenario.failure)).toBe(true);
        }
        expect(handlerCalls).toBe(1);
        if (
          scenario.key === 'initial' ||
          scenario.key === 'revoked' ||
          scenario.key === 'other-principal' ||
          scenario.key === 'other-tenant'
        ) {
          expect(harness.ownerPermissionInputs).toEqual([
            expect.objectContaining({
              principal: { principalId: scenario.principal.principalId, tenantId: scenario.principal.tenantId },
              targets: [
                expect.objectContaining({
                  target: expect.objectContaining({
                    scope: {
                      kind: 'legal_entity',
                      legalEntityId: scenario.principal.legalEntityId,
                      tenantId: scenario.principal.tenantId,
                    },
                  }),
                }),
              ],
            }),
          ]);
        }
      }
    }),
);

it.effect('rejects resolver-selected owner contracts and copied definitions before any permissive Current check', () =>
  Effect.gen(function* rejectsOwnerDefinitionSubstitution() {
    let handlerCalls = 0;
    const foreignContract = Object.freeze({ ...fixtureOwnerContract });
    const copiedDefinition = Object.freeze({ ...fixtureOwnerReadPermission });
    const SubstitutionModeSchema = Schema.Literals(['contract', 'definition']);
    const PayloadSchema = Schema.Struct({ mode: SubstitutionModeSchema });
    const action = defineAction(
      {
        accessDeclaration: fixtureActionAccess('commerce.fixture'),
        accessEvidencePolicy: { captureMode: 'metadata_only', policyKey: 'fixture.bound.v1' },
        actionKey: 'commerce.fixture.bound',
        auditProfile: 'standard',
        domainErrorSchema: Schema.Never,
        domainEvents: {},
        entrypoint: defineTenantModuleEntrypoint({
          access: 'write',
          authorization: { kind: 'action_execution', provisioning: 'tenant_membership_default' },
          entrypointKey: 'commerce.fixture.bound',
          moduleKey: 'commerce.fixture',
          role: 'action',
        }),
        idempotency: 'required',
        legalEntityScope: 'required',
        ownerPermissions: defineActionOwnerPermissions<typeof PayloadSchema.Type>(
          fixtureOwnerContract,
          (payload, scope) => {
            const target = ownerPermissionTarget(scope);
            return [
              Object.freeze(
                payload.mode === 'contract'
                  ? { ...target, contract: foreignContract }
                  : { ...target, definition: copiedDefinition },
              ),
            ];
          },
        ),
        owningModuleKey: 'commerce.fixture',
        payloadSchema: PayloadSchema,
        policies: [],
        resultSchema: Schema.Void,
        schemaVersion: '1',
      },
      () => {
        handlerCalls += 1;
        return Effect.void;
      },
      () => Effect.succeed({}),
    );
    for (const mode of SubstitutionModeSchema.literals) {
      const harness = yield* makeHarness({ ownerPermissionDecision: 'allowed' });
      const failure = yield* Effect.flip(
        harness.runtime.runAction({
          payload: { mode },
          principal,
          registration: action,
          transport: transport(`owner-substitution-${mode}`),
        }),
      );
      expect(Predicate.isTagged(failure, 'ActionPermissionCheckError')).toBe(true);
      expect(harness.ownerPermissionInputs).toHaveLength(0);
      expect(harness.gateCounts().handlerResolutionCount).toBe(0);
      expect(handlerCalls).toBe(0);
    }
  }),
);

it.effect('fails closed for an owner target outside the declared scope kinds', () =>
  Effect.gen(function* rejectsUnknownConfigurationType() {
    let handlerCalls = 0;
    let serviceFactoryCalls = 0;
    const action = defineAction(
      {
        accessDeclaration: fixtureActionAccess('commerce.fixture'),
        accessEvidencePolicy: { captureMode: 'metadata_only', policyKey: 'owner.configuration.v1' },
        actionKey: 'commerce.fixture.configuration-check',
        auditProfile: 'standard',
        domainErrorSchema: Schema.Never,
        domainEvents: {},
        entrypoint: defineTenantModuleEntrypoint({
          access: 'write',
          authorization: { kind: 'action_execution', provisioning: 'tenant_membership_default' },
          entrypointKey: 'commerce.fixture.configuration-check',
          moduleKey: 'commerce.fixture',
          role: 'action',
        }),
        idempotency: 'required',
        legalEntityScope: 'optional',
        ownerPermissions: defineActionOwnerPermissions(fixtureOwnerContract, () => [
          ownerPermissionTarget(principal, 'invalid', { scopeKind: 'unknown_scope' }),
        ]),
        owningModuleKey: 'commerce.fixture',
        payloadSchema: Schema.Void,
        policies: [],
        resultSchema: Schema.Void,
        schemaVersion: '1',
      },
      () => {
        handlerCalls += 1;
        return Effect.void;
      },
      () => {
        serviceFactoryCalls += 1;
        return Effect.succeed({});
      },
    );
    const harness = yield* makeHarness();
    const failure = yield* Effect.flip(
      harness.runtime.runAction({
        payload: undefined,
        principal,
        registration: action,
        transport: transport('owner-unknown-configuration'),
      }),
    );
    expect(Predicate.isTagged(failure, 'ActionPermissionCheckError')).toBe(true);
    expect(harness.ownerPermissionChecks).toHaveLength(0);
    expect(handlerCalls).toBe(0);
    expect(serviceFactoryCalls).toBe(0);
  }),
);

it.effect(
  'persists a definite permission denial before returning it and never evaluates Policies',
  Effect.fn(function* testProgram18() {
    let handlerCount = 0;
    let policyCount = 0;
    let serviceFactoryCount = 0;
    const harness = yield* makeHarness({ permissionDecision: 'denied' });
    const deniedRegistration = defineAction(
      {
        accessDeclaration: fixtureActionAccess('core.shell'),
        accessEvidencePolicy: {
          captureMode: 'metadata_only',
          policyKey: 'counter.read.v1',
        },
        actionKey: 'shell.counter.denied',
        auditProfile: 'sensitive',
        deniedAuditEvidence: {
          resolve: () => ({
            operation: 'grant',
            recipient: '00000000-0000-4000-8000-000000000003',
            requestedScope: { kind: 'counterparty' },
          }),
          schema: Schema.Struct({
            operation: Schema.Literal('grant'),
            recipient: Schema.String,
            requestedScope: Schema.Struct({ kind: Schema.Literal('counterparty') }),
          }),
        },
        domainErrorSchema: Schema.Never,
        domainEvents: {},
        entrypoint: defineSystemModuleEntrypoint({
          access: 'write',
          authorization: {
            kind: 'action_execution',
            provisioning: 'tenant_membership_default',
          },
          entrypointKey: 'shell.counter.denied',
          moduleKey: 'core.shell',
          role: 'action',
        }),
        idempotency: 'required',
        legalEntityScope: 'optional',
        owningModuleKey: 'core.shell',
        payloadSchema: Schema.Void,
        policies: [
          defineGlobalPolicy<unknown>({
            evaluate: () => {
              policyCount += 1;
              return Effect.void;
            },
            policyKey: 'global.unreachable-after-permission-denial.v1',
          }),
        ],
        resultSchema: Schema.Void,
        schemaVersion: '1',
      },
      () => {
        handlerCount += 1;
        return Effect.void;
      },
      () => {
        serviceFactoryCount += 1;
        return Effect.succeed({});
      },
    );

    const failure = yield* Effect.flip(
      harness.runtime.runAction({
        payload: undefined,
        principal,
        registration: deniedRegistration,
        transport: transport('denied'),
      }),
    );

    expect(Predicate.isTagged(failure, 'ActionPermissionDenied')).toBe(true);

    expect(failure.code).toBe('action_permission_denied');
    expect(handlerCount).toBe(0);
    expect(policyCount).toBe(0);
    expect(serviceFactoryCount).toBe(0);
    expect(harness.stages).toEqual([
      'payload_decoded',
      'trusted_context_validated',
      'module_state_gate',
      'invocation_prepared',
      'authentication_boundary',
      'permission_checked',
    ]);
    expect(harness.permissionCounts()).toEqual({
      permissionCheckCount: 1,
      rejectionCount: 1,
    });
    expect(harness.counts()).toEqual({
      createCount: 1,
      lockCount: 0,
      transactionCount: 0,
      transitionCount: 0,
    });
    expect(harness.rejections).toEqual([
      {
        actionInvocationId: 'invocation-1',
        actionKey: 'shell.counter.denied',
        auditProfile: 'sensitive',
        deniedAuditEvidence: {
          operation: 'grant',
          recipient: '00000000-0000-4000-8000-000000000003',
          requestedScope: { kind: 'counterparty' },
        },
        principal,
        transport: transport('denied'),
      },
    ]);
  }),
);

it.effect('a valid owner preflight permit cannot override definitive executor denial', () =>
  Effect.gen(function* executorDenialWithPreflight() {
    const permit = makeActionAuthorizationPreflightPermit({
      actionInvocationId: 'invocation-1',
      actionKey: 'shell.counter.change',
      principalId: principal.principalId,
    });
    const harness = yield* makeHarness({
      authorizationPreflight: { prepare: () => Effect.succeed({ outcome: 'allowed', permit }) },
      permissionDecision: 'denied',
    });
    const failure = yield* Effect.flip(
      harness.runtime.runAction({
        payload: { amount: 1 },
        principal,
        registration: registration(),
        transport: transport('preflight-executor-denied'),
      }),
    );
    expect(Predicate.isTagged(failure, 'ActionPermissionDenied')).toBe(true);
    expect(harness.permissionCounts()).toEqual({ permissionCheckCount: 1, rejectionCount: 1 });
    expect(harness.counts()).toEqual({ createCount: 1, lockCount: 0, transactionCount: 0, transitionCount: 0 });
    expect(harness.gateCounts().handlerResolutionCount).toBe(0);
    expect(harness.flushed).toEqual([]);
    expect(harness.rejections[0]?.actionInvocationId).toBe('invocation-1');
    // Definitive rejection must leave the independent owner permit unconsumed.
    yield* permit.consume;
    const repeated = yield* Effect.flip(
      harness.runtime.runAction({
        payload: { amount: 1 },
        principal,
        registration: registration(),
        transport: transport('preflight-executor-denied'),
      }),
    );
    expect(Predicate.isTagged(repeated, 'ActionPermissionDenied')).toBe(true);
    expect(harness.permissionCounts()).toEqual({ permissionCheckCount: 1, rejectionCount: 1 });
  }),
);

it.effect('requires executor permission and an independent owner preflight on the allowed path', () =>
  Effect.gen(function* allowedExecutorWithPreflight() {
    const permit = makeActionAuthorizationPreflightPermit({
      actionInvocationId: 'invocation-1',
      actionKey: 'shell.counter.change',
      principalId: principal.principalId,
    });
    const harness = yield* makeHarness({
      authorizationPreflight: { prepare: () => Effect.succeed({ outcome: 'allowed', permit }) },
    });
    expect(
      yield* harness.runtime.runAction({
        payload: { amount: 1 },
        principal,
        registration: registration(),
        transport: transport('preflight-executor-allowed'),
      }),
    ).toEqual({ total: 1 });
    expect(harness.flushed).toHaveLength(1);
    expect(harness.permissionCounts()).toEqual({ permissionCheckCount: 1, rejectionCount: 0 });
    expect(Predicate.isTagged(yield* Effect.flip(permit.consume), 'ActionPermissionCheckError')).toBe(true);
  }),
);

it.effect('does not consume an owner permit when executor permission is unavailable', () =>
  Effect.gen(function* unavailableExecutorWithPreflight() {
    const permit = makeActionAuthorizationPreflightPermit({
      actionInvocationId: 'invocation-1',
      actionKey: 'shell.counter.change',
      principalId: principal.principalId,
    });
    const harness = yield* makeHarness({
      authorizationPreflight: { prepare: () => Effect.succeed({ outcome: 'allowed', permit }) },
      permissionFailure: true,
    });
    const failure = yield* Effect.flip(
      harness.runtime.runAction({
        payload: { amount: 1 },
        principal,
        registration: registration(),
        transport: transport('preflight-executor-unavailable'),
      }),
    );
    expect(Predicate.isTagged(failure, 'ActionPermissionCheckError')).toBe(true);
    expect(harness.permissionCounts()).toEqual({ permissionCheckCount: 1, rejectionCount: 0 });
    expect(harness.counts().transitionCount).toBe(0);
    expect(harness.gateCounts().handlerResolutionCount).toBe(0);
    yield* permit.consume;
  }),
);

it.effect('executor allow cannot override owner denial or unavailable owner authority', () =>
  Effect.gen(function* ownerPreflightRemainsIndependent() {
    const decisions: readonly {
      readonly authorizationPreflight: ActionAuthorizationPreflightService;
      readonly expectedTag: 'ActionPermissionDenied' | 'ActionPermissionCheckError';
      readonly rejected: boolean;
    }[] = [
      {
        authorizationPreflight: { prepare: () => Effect.succeed({ outcome: 'denied' }) },
        expectedTag: 'ActionPermissionDenied',
        rejected: true,
      },
      {
        authorizationPreflight: {
          prepare: () =>
            Effect.fail(
              new ActionPermissionCheckError({
                code: 'action_permission_check_failed',
                reason: 'Owner authority unavailable',
              }),
            ),
        },
        expectedTag: 'ActionPermissionCheckError',
        rejected: false,
      },
    ];
    yield* forEachSequential(
      decisions,
      Effect.fn(function* checkOwnerPreflight({ authorizationPreflight, expectedTag, rejected }) {
        const harness = yield* makeHarness({ authorizationPreflight });
        const failure = yield* Effect.flip(
          harness.runtime.runAction({
            payload: { amount: 1 },
            principal,
            registration: registration(),
            transport: transport('preflight-owner-refusal'),
          }),
        );
        expect(Predicate.isTagged(failure, expectedTag)).toBe(true);
        expect(harness.permissionCounts().rejectionCount).toBe(rejected ? 1 : 0);
        expect(harness.invocationState().status).toBe(rejected ? 'rejected' : 'received');
        expect(harness.invocationState().completedAt).toEqual(rejected ? completionTime() : null);
        expect(harness.counts().transitionCount).toBe(0);
        expect(harness.gateCounts().handlerResolutionCount).toBe(0);
        expect(harness.flushed).toEqual([]);
      }),
    );
  }),
);

it.effect('rejects mismatched and already consumed owner permits even when executor allows', () =>
  Effect.gen(function* invalidOwnerPermit() {
    const binding = {
      actionInvocationId: 'invocation-1',
      actionKey: 'shell.counter.change',
      principalId: principal.principalId,
    };
    const consumed = makeActionAuthorizationPreflightPermit(binding);
    yield* consumed.consume;
    const permits = [
      makeActionAuthorizationPreflightPermit({ ...binding, actionInvocationId: 'other-invocation' }),
      makeActionAuthorizationPreflightPermit({ ...binding, actionKey: 'other.action' }),
      makeActionAuthorizationPreflightPermit({ ...binding, principalId: 'other-principal' }),
      consumed,
    ];
    yield* forEachSequential(
      permits,
      Effect.fn(function* checkInvalidPermit(permit) {
        const harness = yield* makeHarness({
          authorizationPreflight: { prepare: () => Effect.succeed({ outcome: 'allowed', permit }) },
        });
        const failure = yield* Effect.flip(
          harness.runtime.runAction({
            payload: { amount: 1 },
            principal,
            registration: registration(),
            transport: transport('preflight-invalid-permit'),
          }),
        );
        expect(Predicate.isTagged(failure, 'ActionPermissionCheckError')).toBe(true);
        expect(harness.counts().transitionCount).toBe(0);
        expect(harness.gateCounts().handlerResolutionCount).toBe(0);
        expect(harness.flushed).toEqual([]);
      }),
    );
  }),
);

it.effect(
  'fails closed before Policy evaluation when permission cannot be determined',
  Effect.fn(function* testProgram19() {
    const harness = yield* makeHarness({ permissionFailure: true });
    const failure = yield* Effect.flip(
      harness.runtime.runAction({
        payload: { amount: 1 },
        principal,
        registration: registration(),
        transport: transport('unavailable'),
      }),
    );

    expect(Predicate.isTagged(failure, 'ActionPermissionCheckError')).toBe(true);

    expect(harness.permissionCounts()).toEqual({
      permissionCheckCount: 1,
      rejectionCount: 0,
    });
    expect(harness.counts()).toEqual({
      createCount: 1,
      lockCount: 0,
      transactionCount: 0,
      transitionCount: 0,
    });
    expect(harness.stages).toEqual([
      'payload_decoded',
      'trusted_context_validated',
      'module_state_gate',
      'invocation_prepared',
      'authentication_boundary',
    ]);
  }),
);

it.effect(
  'does not claim permission denial when terminal evidence persistence rolls back',
  Effect.fn(function* testProgram20() {
    const harness = yield* makeHarness({
      permissionDecision: 'denied',
      rejectionFailure: true,
    });
    const failure = yield* Effect.flip(
      harness.runtime.runAction({
        payload: { amount: 1 },
        principal,
        registration: registration(),
        transport: transport('permission-denial-persistence-failure'),
      }),
    );

    expect(Predicate.isTagged(failure, 'ActionTransactionError')).toBe(true);

    expect(harness.permissionCounts()).toEqual({
      permissionCheckCount: 1,
      rejectionCount: 1,
    });
    expect(harness.counts().transitionCount).toBe(0);
    expect(harness.counts().transactionCount).toBe(0);
  }),
);

it.effect(
  'evaluates Policies in order before running and hands allowed checkpoints to success',
  Effect.fn(function* testProgram21() {
    const observed: string[] = [];
    const globalPolicy = defineGlobalPolicy<{ readonly amount: number }>({
      evaluate: () => {
        observed.push('global');
        return Effect.void;
      },
      policyKey: 'global.tenant-active.v1',
    });
    const modulePolicy = defineMicroverticalPolicy<{ readonly amount: number }, 'inventory.stock'>({
      evaluate: (input) => {
        observed.push(`module:${input.payload.amount}`);
        expect(input.principal.principalId).toBe(principal.principalId);
        expect(input.action.actionKey).toBe('inventory.stock.policy-allowed');
        expect(input.target.targetResourceId).toBe('primary');
        expect('idempotencyKey' in input.transport).toBe(false);
        return Effect.void;
      },
      owningModuleKey: 'inventory.stock',
      policyKey: 'inventory.stock.allowed.v1',
    });
    const action = defineAction(
      {
        accessDeclaration: fixtureActionAccess('inventory.stock'),
        accessEvidencePolicy: {
          captureMode: 'metadata_only',
          policyKey: 'counter.read.v1',
        },
        actionKey: 'inventory.stock.policy-allowed',
        auditProfile: 'standard',
        domainErrorSchema: Schema.Never,
        domainEvents: {},
        entrypoint: defineTenantModuleEntrypoint({
          access: 'write',
          authorization: {
            kind: 'action_execution',
            provisioning: 'tenant_membership_default',
          },
          entrypointKey: 'inventory.stock.policy-allowed',
          moduleKey: 'inventory.stock',
          role: 'action',
        }),
        idempotency: 'required',
        legalEntityScope: 'optional',
        owningModuleKey: 'inventory.stock',
        payloadSchema: Schema.Struct({ amount: Schema.Finite }),
        policies: [globalPolicy, modulePolicy],
        resultSchema: Schema.Finite,
        schemaVersion: '1',
      },
      (payload) => {
        observed.push('handler');
        return Effect.succeed(payload.amount);
      },
    );
    const harness = yield* makeHarness();

    const result = yield* harness.runtime.runAction({
      payload: { amount: 4 },
      principal,
      registration: action,
      transport: { ...transport(), targetModuleKey: 'inventory.stock' },
    });

    expect(result).toBe(4);
    expect(observed).toEqual(['global', 'module:4', 'handler']);
    expect(harness.flushed[0]?.allowedPolicies).toEqual([
      { policyKey: 'global.tenant-active.v1', scope: 'global' },
      {
        owningModuleKey: 'inventory.stock',
        policyKey: 'inventory.stock.allowed.v1',
        scope: 'microvertical',
      },
    ]);
  }),
);

it.effect(
  'short-circuits the first Policy denial, finalizes it, and never starts execution',
  Effect.fn(function* testProgram22() {
    const observed: string[] = [];
    let handlerExecutions = 0;
    const policies = [
      defineGlobalPolicy<{ readonly amount: number }>({
        evaluate: () => {
          observed.push('first');
          return Effect.void;
        },
        policyKey: 'global.first.v1',
      }),
      defineGlobalPolicy<{ readonly amount: number }>({
        evaluate: () => {
          observed.push('denied');
          return Effect.fail(denyPolicy('counter_locked', 'Counter changes are locked — try later'));
        },
        policyKey: 'global.counter-locked.v1',
      }),
      defineGlobalPolicy<{ readonly amount: number }>({
        evaluate: () => {
          observed.push('unreachable');
          return Effect.void;
        },
        policyKey: 'global.unreachable.v1',
      }),
    ] as const;
    const action = defineAction(
      {
        accessDeclaration: fixtureActionAccess('core.shell'),
        accessEvidencePolicy: {
          captureMode: 'metadata_only',
          policyKey: 'counter.read.v1',
        },
        actionKey: 'shell.counter.policy-denied',
        auditProfile: 'sensitive',
        domainErrorSchema: Schema.Never,
        domainEvents: {},
        entrypoint: defineSystemModuleEntrypoint({
          access: 'write',
          authorization: {
            kind: 'action_execution',
            provisioning: 'tenant_membership_default',
          },
          entrypointKey: 'shell.counter.policy-denied',
          moduleKey: 'core.shell',
          role: 'action',
        }),
        idempotency: 'required',
        legalEntityScope: 'optional',
        owningModuleKey: 'core.shell',
        payloadSchema: Schema.Struct({ amount: Schema.Finite }),
        policies,
        resultSchema: Schema.Void,
        schemaVersion: '1',
      },
      () => {
        handlerExecutions += 1;
        return Effect.void;
      },
    );
    const harness = yield* makeHarness();

    const denial = yield* Effect.flip(
      harness.runtime.runAction({
        payload: { amount: 1 },
        principal,
        registration: action,
        transport: transport('policy-denied'),
      }),
    );

    expect(Predicate.isTagged(denial, 'ActionPolicyDenied')).toBe(true);
    if (!Predicate.isTagged(denial, 'ActionPolicyDenied')) {
      throw new Error('Expected typed test outcome');
    }
    expect(denial.policyReasonCode).toBe('counter_locked');
    expect(denial.reason).toBe('Counter changes are locked — try later');
    expect(observed).toEqual(['first', 'denied']);
    expect(handlerExecutions).toBe(0);
    expect(harness.counts()).toEqual({
      createCount: 1,
      lockCount: 0,
      transactionCount: 0,
      transitionCount: 0,
    });
    expect(harness.stages).toEqual([
      'payload_decoded',
      'trusted_context_validated',
      'module_state_gate',
      'invocation_prepared',
      'authentication_boundary',
      'permission_checked',
      'policy_boundary',
    ]);
    expect(harness.finalized[0]).toEqual({
      actionInvocationId: 'invocation-1',
      actionKey: 'shell.counter.policy-denied',
      auditProfile: 'sensitive',
      policy: { policyKey: 'global.counter-locked.v1', scope: 'global' },
      principal,
      reasonCode: 'counter_locked',
      transport: transport('policy-denied'),
    });
    expect(harness.flushed.length).toBe(0);
  }),
);

it.effect(
  'sanitizes Policy defects and interrupts without finalizing',
  Effect.fn(function* testProgram23() {
    const evaluators = [() => Effect.die('secret evaluator defect'), () => Effect.interrupt] as const;

    yield* forEachSequential(
      evaluators.map((evaluate, index) => [index, evaluate] as const),
      Effect.fn(function* testProgram24([index, evaluate]) {
        let handlerExecutions = 0;
        const policy = defineGlobalPolicy<unknown>({
          evaluate,
          policyKey: `global.failure-${index}.v1`,
        });
        const action = defineAction(
          {
            accessDeclaration: fixtureActionAccess('core.shell'),
            accessEvidencePolicy: {
              captureMode: 'metadata_only',
              policyKey: 'counter.read.v1',
            },
            actionKey: `shell.counter.policy-failure-${index}`,
            auditProfile: 'standard',
            domainErrorSchema: Schema.Never,
            domainEvents: {},
            entrypoint: defineSystemModuleEntrypoint({
              access: 'write',
              authorization: {
                kind: 'action_execution',
                provisioning: 'tenant_membership_default',
              },
              entrypointKey: `shell.counter.policy-failure-${index}`,
              moduleKey: 'core.shell',
              role: 'action',
            }),
            idempotency: 'required',
            legalEntityScope: 'optional',
            owningModuleKey: 'core.shell',
            payloadSchema: Schema.Void,
            policies: [policy],
            resultSchema: Schema.Void,
            schemaVersion: '1',
          },
          () => {
            handlerExecutions += 1;
            return Effect.void;
          },
        );
        const harness = yield* makeHarness();
        const error = yield* Effect.flip(
          harness.runtime.runAction({
            payload: undefined,
            principal,
            registration: action,
            transport: transport(`policy-failure-${index}`),
          }),
        );

        expect(Predicate.isTagged(error, 'ActionPolicyEvaluationError')).toBe(true);

        expect(error.reason.includes('secret')).toBe(false);
        expect(handlerExecutions).toBe(0);
        expect(harness.finalized.length).toBe(0);
        expect(harness.counts()).toEqual({
          createCount: 1,
          lockCount: 0,
          transactionCount: 0,
          transitionCount: 0,
        });
      }),
    );
  }),
);

it.effect(
  'returns persistence failure when denial evidence cannot be finalized',
  Effect.fn(function* testProgram25() {
    let handlerExecutions = 0;
    const policy = defineGlobalPolicy<unknown>({
      evaluate: () => Effect.fail(denyPolicy('blocked', 'This action is blocked')),
      policyKey: 'global.blocked.v1',
    });
    const action = defineAction(
      {
        accessDeclaration: fixtureActionAccess('core.shell'),
        accessEvidencePolicy: {
          captureMode: 'metadata_only',
          policyKey: 'counter.read.v1',
        },
        actionKey: 'shell.counter.policy-persistence-failure',
        auditProfile: 'standard',
        domainErrorSchema: Schema.Never,
        domainEvents: {},
        entrypoint: defineSystemModuleEntrypoint({
          access: 'write',
          authorization: {
            kind: 'action_execution',
            provisioning: 'tenant_membership_default',
          },
          entrypointKey: 'shell.counter.policy-persistence-failure',
          moduleKey: 'core.shell',
          role: 'action',
        }),
        idempotency: 'required',
        legalEntityScope: 'optional',
        owningModuleKey: 'core.shell',
        payloadSchema: Schema.Void,
        policies: [policy],
        resultSchema: Schema.Void,
        schemaVersion: '1',
      },
      () => {
        handlerExecutions += 1;
        return Effect.void;
      },
    );
    const harness = yield* makeHarness({ policyFinalizationFailure: true });

    const error = yield* Effect.flip(
      harness.runtime.runAction({
        payload: undefined,
        principal,
        registration: action,
        transport: transport('policy-finalization-failure'),
      }),
    );

    expect(Predicate.isTagged(error, 'ActionInvocationPersistenceError')).toBe(true);

    expect(handlerExecutions).toBe(0);
    expect(harness.finalized.length).toBe(0);
    expect(harness.counts().transactionCount).toBe(0);
  }),
);

it.effect(
  'creates fresh collectors for every execution',
  Effect.fn(function* testProgram26() {
    const harness = yield* makeHarness();
    yield* forEachSequential(
      [
        ['first', 1],
        ['second', 2],
      ] as const,
      Effect.fn(function* testProgram27([key, amount]) {
        yield* harness.runtime.runAction({
          payload: { amount },
          principal,
          registration: registration(),
          transport: transport(key),
        });
      }),
    );

    expect(harness.flushed.length).toBe(2);
    expect(harness.flushed.map((item) => item.evidence.domainEvents.length)).toEqual([1, 1]);
    expect(harness.flushed[0]?.evidence).not.toBe(harness.flushed[1]?.evidence);
  }),
);

it.effect(
  'evaluates Policies afresh for separate invocations',
  Effect.fn(function* testProgram28() {
    let evaluations = 0;
    const policy = defineGlobalPolicy<{ readonly amount: number }>({
      evaluate: () => {
        evaluations += 1;
        return Effect.void;
      },
      policyKey: 'global.fresh-evaluation.v1',
    });
    const action = defineAction(
      {
        accessDeclaration: fixtureActionAccess('core.shell'),
        accessEvidencePolicy: {
          captureMode: 'metadata_only',
          policyKey: 'counter.read.v1',
        },
        actionKey: 'shell.counter.fresh-policy',
        auditProfile: 'standard',
        domainErrorSchema: Schema.Never,
        domainEvents: {},
        entrypoint: defineSystemModuleEntrypoint({
          access: 'write',
          authorization: {
            kind: 'action_execution',
            provisioning: 'tenant_membership_default',
          },
          entrypointKey: 'shell.counter.fresh-policy',
          moduleKey: 'core.shell',
          role: 'action',
        }),
        idempotency: 'required',
        legalEntityScope: 'optional',
        owningModuleKey: 'core.shell',
        payloadSchema: Schema.Struct({ amount: Schema.Finite }),
        policies: [policy],
        resultSchema: Schema.Void,
        schemaVersion: '1',
      },
      () => Effect.void,
    );
    yield* forEachSequential(
      ['fresh-first', 'fresh-second'],
      Effect.fn(function* testProgram29(key) {
        const harness = yield* makeHarness({
          createRecord: {
            actionInvocationId: key,
            completedAt: null,
            requestHash: '',
            status: 'received',
          },
        });
        yield* harness.runtime.runAction({
          payload: { amount: 1 },
          principal,
          registration: action,
          transport: transport(key),
        });
      }),
    );

    expect(evaluations).toBe(2);
  }),
);

it.effect(
  'rejects structural payloads, trusted context, and missing idempotency before invocation',
  Effect.fn(function* testProgram30() {
    const harness = yield* makeHarness();
    const invalidPayload = yield* Effect.flip(
      harness.runtime.runAction({
        payload: { amount: 'not-a-number' },
        principal,
        registration: registration(),
        transport: transport(),
      }),
    );
    const invalidPrincipal = yield* Effect.flip(
      harness.runtime.runAction({
        payload: { amount: 1 },
        principal: { ...principal, principalId: 'not-a-uuid' },
        registration: registration(),
        transport: transport(),
      }),
    );
    const missingKey = yield* Effect.flip(
      harness.runtime.runAction({
        payload: { amount: 1 },
        principal,
        registration: registration(),
        transport: { correlationId: 'correlation-missing-key' },
      }),
    );
    const forgedSystemPrincipal = yield* Effect.flip(
      harness.runtime.runAction({
        payload: { amount: 1 },
        principal: {
          authContextRef: 'job:forged:run:plain-object',
          authMethod: 'system',
          principalId: principal.principalId,
          tenantId: principal.tenantId,
        },
        registration: registration(),
        transport: transport('forged-system'),
      }),
    );

    expect(Predicate.isTagged(invalidPayload, 'ActionPayloadValidationError')).toBe(true);

    expect(Predicate.isTagged(invalidPrincipal, 'ActionTrustedContextValidationError')).toBe(true);
    expect(Predicate.isTagged(missingKey, 'ActionIdempotencyKeyRequired')).toBe(true);

    expect(Predicate.isTagged(forgedSystemPrincipal, 'ActionTrustedContextValidationError')).toBe(true);
    expect(harness.counts().createCount).toBe(0);
  }),
);

it.effect(
  'preserves declared domain rejections and rolls back collected evidence',
  Effect.fn(function* testProgram31() {
    const DomainRejectedContract = Schema.TaggedStruct('DomainRejected', {
      reason: Schema.String,
    });
    type DomainRejectedSelf = typeof DomainRejectedContract.Type;
    const DomainRejected = Schema.TaggedError<DomainRejectedSelf>()('DomainRejected', {
      reason: Schema.String,
    });
    const harness = yield* makeHarness();
    let policyEvaluations = 0;
    const allowedPolicy = defineGlobalPolicy<unknown>({
      evaluate: () => {
        policyEvaluations += 1;
        return Effect.void;
      },
      policyKey: 'global.domain-rejection-allowed.v1',
    });
    const rejected = defineAction(
      {
        accessDeclaration: fixtureActionAccess('core.shell'),
        accessEvidencePolicy: {
          captureMode: 'metadata_only',
          policyKey: 'counter.read.v1',
        },
        actionKey: 'shell.counter.reject',
        auditProfile: 'standard',
        domainErrorSchema: DomainRejected,
        domainEvents: {
          'counter.considered': Schema.Struct({}),
        },
        entrypoint: defineSystemModuleEntrypoint({
          access: 'write',
          authorization: {
            kind: 'action_execution',
            provisioning: 'tenant_membership_default',
          },
          entrypointKey: 'shell.counter.reject',
          moduleKey: 'core.shell',
          role: 'action',
        }),
        idempotency: 'required',
        legalEntityScope: 'optional',
        owningModuleKey: 'core.shell',
        payloadSchema: Schema.Void,
        policies: [allowedPolicy],
        resultSchema: Schema.Void,
        schemaVersion: '1',
      },
      Effect.fn(function* rejectCounter(_payload, context) {
        yield* context.addDomainEvent({
          eventType: 'counter.considered',
          payloadJson: {},
          producerModuleKey: 'core.shell',
          subjectModuleKey: 'core.shell',
          subjectResourceId: 'primary',
          subjectResourceType: 'counter',
        });
        return yield* new DomainRejected({ reason: 'counter_locked' });
      }),
    );

    const error = yield* Effect.flip(
      harness.runtime.runAction({
        payload: undefined,
        principal,
        registration: rejected,
        transport: transport(),
      }),
    );

    expect(Predicate.isTagged(error, 'DomainRejected')).toBe(true);

    expect(error.reason).toBe('counter_locked');
    expect(policyEvaluations).toBe(1);
    expect(harness.flushed.length).toBe(0);
  }),
);

it.effect(
  'commits business work and success evidence before raising a declared domain rejection',
  Effect.fn(function* commitsBusinessWorkAndSuccessEvidenceBeforeRaisingDeclaredRejection() {
    const CommittedDomainRejectedContract = Schema.TaggedStruct('CommittedDomainRejected', {
      reason: Schema.String,
    });
    type CommittedDomainRejectedSelf = typeof CommittedDomainRejectedContract.Type;
    const CommittedDomainRejected = Schema.TaggedError<CommittedDomainRejectedSelf>()('CommittedDomainRejected', {
      reason: Schema.String,
    });
    const businessWrites: number[] = [];
    const harness = yield* makeHarness();
    const action = defineAction(
      {
        accessDeclaration: fixtureActionAccess('core.shell'),
        accessEvidencePolicy: { captureMode: 'metadata_only', policyKey: 'counter.read.v1' },
        actionKey: 'shell.counter.commit-then-reject',
        auditProfile: 'standard',
        domainErrorSchema: CommittedDomainRejected,
        domainEvents: {
          'counter.rejection-recorded': Schema.Struct({ amount: Schema.Finite }),
        },
        entrypoint: defineSystemModuleEntrypoint({
          access: 'write',
          authorization: {
            kind: 'action_execution',
            provisioning: 'tenant_membership_default',
          },
          entrypointKey: 'shell.counter.commit-then-reject',
          moduleKey: 'core.shell',
          role: 'action',
        }),
        idempotency: 'required',
        legalEntityScope: 'optional',
        owningModuleKey: 'core.shell',
        payloadSchema: Schema.Struct({ amount: Schema.Finite }),
        policies: [],
        resultSchema: Schema.Struct({ total: Schema.Finite }),
        schemaVersion: '1',
      },
      Effect.fn(function* commitThenReject(payload, context) {
        yield* context.services.write(payload.amount);
        yield* context.recordDataAccess({
          accessKind: 'read',
          queryHash: 'counter-rejection-check',
          resultCount: 1,
          servingModuleKey: 'core.shell',
        });
        yield* context.addDomainEvent({
          eventType: 'counter.rejection-recorded',
          payloadJson: { amount: payload.amount },
          producerModuleKey: 'core.shell',
          subjectModuleKey: 'core.shell',
          subjectResourceId: 'primary',
          subjectResourceType: 'counter',
        });
        return commitActionThenReject(new CommittedDomainRejected({ reason: 'proof_expired' }));
      }),
      () =>
        Effect.succeed({
          write: (amount: number) =>
            Effect.sync(() => {
              businessWrites.push(amount);
            }),
        }),
    );

    const error = yield* Effect.flip(
      harness.runtime.runAction({
        payload: { amount: 7 },
        principal,
        registration: action,
        transport: transport('commit-then-reject'),
      }),
    );

    expect(Predicate.isTagged(error, 'CommittedDomainRejected')).toBe(true);
    expect(error.reason).toBe('proof_expired');
    expect(businessWrites).toEqual([7]);
    expect(harness.flushed).toHaveLength(1);
    expect(harness.flushed[0]?.actionInvocationId).toBe('invocation-1');
    expect(harness.flushed[0]?.evidence.dataAccessEvents).toHaveLength(1);
    expect(harness.flushed[0]?.evidence.domainEvents).toHaveLength(1);
    expect(harness.flushed[0]?.resultHash).toBe(
      computeCanonicalValueHash({ _tag: 'CommittedDomainRejected', reason: 'proof_expired' }),
    );
    expect(harness.transactionOutcomes()).toEqual({
      committedTransactionCount: 1,
      rolledBackTransactionCount: 0,
    });
  }),
);

it.effect(
  'rolls back malformed and undeclared committed domain rejection sentinels',
  Effect.fn(function* rollsBackMalformedAndUndeclaredCommittedDomainRejectionSentinels() {
    const DeclaredCommittedRejectionContract = Schema.TaggedStruct('DeclaredCommittedRejection', {
      reason: Schema.String,
    });
    type DeclaredCommittedRejectionSelf = typeof DeclaredCommittedRejectionContract.Type;
    const DeclaredCommittedRejection = Schema.TaggedError<DeclaredCommittedRejectionSelf>()(
      'DeclaredCommittedRejection',
      { reason: Schema.String },
    );
    const malformed = new DeclaredCommittedRejection({ reason: 'malformed' });
    Object.defineProperty(malformed, 'reason', { value: 42 });
    const undeclared = new DeclaredCommittedRejection({ reason: 'undeclared' });
    Object.defineProperty(undeclared, '_tag', { value: 'UndeclaredCommittedRejection' });

    for (const [id, rejection] of [
      ['malformed', malformed],
      ['undeclared', undeclared],
    ] as const) {
      const harness = yield* makeHarness();
      const action = defineAction(
        {
          accessDeclaration: fixtureActionAccess('core.shell'),
          accessEvidencePolicy: { captureMode: 'metadata_only', policyKey: 'counter.read.v1' },
          actionKey: `shell.counter.${id}-committed-rejection`,
          auditProfile: 'standard',
          domainErrorSchema: DeclaredCommittedRejection,
          domainEvents: {
            'counter.rejection-considered': Schema.Struct({}),
          },
          entrypoint: defineSystemModuleEntrypoint({
            access: 'write',
            authorization: {
              kind: 'action_execution',
              provisioning: 'tenant_membership_default',
            },
            entrypointKey: `shell.counter.${id}-committed-rejection`,
            moduleKey: 'core.shell',
            role: 'action',
          }),
          idempotency: 'required',
          legalEntityScope: 'optional',
          owningModuleKey: 'core.shell',
          payloadSchema: Schema.Void,
          policies: [],
          resultSchema: Schema.Void,
          schemaVersion: '1',
        },
        Effect.fn(function* invalidCommitThenReject(_payload, context) {
          yield* context.addDomainEvent({
            eventType: 'counter.rejection-considered',
            payloadJson: {},
            producerModuleKey: 'core.shell',
            subjectModuleKey: 'core.shell',
            subjectResourceId: 'primary',
            subjectResourceType: 'counter',
          });
          return commitActionThenReject(rejection);
        }),
      );

      const error = yield* Effect.flip(
        harness.runtime.runAction({
          payload: undefined,
          principal,
          registration: action,
          transport: transport(`${id}-committed-rejection`),
        }),
      );

      expect(Predicate.isTagged(error, 'ActionHandlerExecutionError')).toBe(true);
      expect(harness.flushed).toHaveLength(0);
      expect(harness.transactionOutcomes()).toEqual({
        committedTransactionCount: 0,
        rolledBackTransactionCount: 1,
      });
    }
  }),
);

it.effect(
  'sanitizes unexpected defects and rejects invalid typed results',
  Effect.fn(function* testProgram32() {
    const defectHarness = yield* makeHarness();
    const defective = defineAction(
      {
        accessDeclaration: fixtureActionAccess('core.shell'),
        accessEvidencePolicy: {
          captureMode: 'metadata_only',
          policyKey: 'counter.read.v1',
        },
        actionKey: 'shell.counter.defect',
        auditProfile: 'standard',
        domainErrorSchema: Schema.Never,
        domainEvents: {},
        entrypoint: defineSystemModuleEntrypoint({
          access: 'write',
          authorization: {
            kind: 'action_execution',
            provisioning: 'tenant_membership_default',
          },
          entrypointKey: 'shell.counter.defect',
          moduleKey: 'core.shell',
          role: 'action',
        }),
        idempotency: 'required',
        legalEntityScope: 'optional',
        owningModuleKey: 'core.shell',
        payloadSchema: Schema.Void,
        policies: [],
        resultSchema: Schema.Void,
        schemaVersion: '1',
      },
      () => Effect.die('secret database detail'),
    );
    const defect = yield* Effect.flip(
      defectHarness.runtime.runAction({
        payload: undefined,
        principal,
        registration: defective,
        transport: transport(),
      }),
    );

    const resultHarness = yield* makeHarness();
    const invalidResult = defineAction(
      {
        accessDeclaration: fixtureActionAccess('core.shell'),
        accessEvidencePolicy: {
          captureMode: 'metadata_only',
          policyKey: 'counter.read.v1',
        },
        actionKey: 'shell.counter.invalid-result',
        auditProfile: 'standard',
        domainErrorSchema: Schema.Never,
        domainEvents: {},
        entrypoint: defineSystemModuleEntrypoint({
          access: 'write',
          authorization: {
            kind: 'action_execution',
            provisioning: 'tenant_membership_default',
          },
          entrypointKey: 'shell.counter.invalid-result',
          moduleKey: 'core.shell',
          role: 'action',
        }),
        idempotency: 'required',
        legalEntityScope: 'optional',
        owningModuleKey: 'core.shell',
        payloadSchema: Schema.Void,
        policies: [],
        resultSchema: Schema.Struct({ total: Schema.Finite }),
        schemaVersion: '1',
      },
      () => {
        const result = { total: 0 };
        Object.defineProperty(result, 'total', { value: 'invalid' });
        return Effect.succeed(result);
      },
    );
    const resultError = yield* Effect.flip(
      resultHarness.runtime.runAction({
        payload: undefined,
        principal,
        registration: invalidResult,
        transport: transport(),
      }),
    );

    expect(Predicate.isTagged(defect, 'ActionHandlerExecutionError')).toBe(true);

    expect(defect.reason.includes('secret')).toBe(false);
    expect(Predicate.isTagged(resultError, 'ActionResultValidationError')).toBe(true);

    expect(defectHarness.flushed.length).toBe(0);
    expect(resultHarness.flushed.length).toBe(0);
  }),
);

it.effect(
  'sanitizes undeclared handler failures instead of widening the domain error contract',
  Effect.fn(function* testProgram33() {
    const DeclaredDomainErrorContract = Schema.TaggedStruct('DeclaredDomainError', {
      reason: Schema.String,
    });
    type DeclaredDomainErrorSelf = typeof DeclaredDomainErrorContract.Type;
    const DeclaredDomainError = Schema.TaggedError<DeclaredDomainErrorSelf>()('DeclaredDomainError', {
      reason: Schema.String,
    });
    const undeclaredDomainError = new DeclaredDomainError({
      reason: 'secret undeclared failure',
    });
    Object.defineProperty(undeclaredDomainError, '_tag', {
      value: 'UndeclaredDomainError',
    });
    const harness = yield* makeHarness();
    const action = defineAction(
      {
        accessDeclaration: fixtureActionAccess('core.shell'),
        accessEvidencePolicy: {
          captureMode: 'metadata_only',
          policyKey: 'counter.read.v1',
        },
        actionKey: 'shell.counter.undeclared-error',
        auditProfile: 'standard',
        domainErrorSchema: DeclaredDomainError,
        domainEvents: {},
        entrypoint: defineSystemModuleEntrypoint({
          access: 'write',
          authorization: {
            kind: 'action_execution',
            provisioning: 'tenant_membership_default',
          },
          entrypointKey: 'shell.counter.undeclared-error',
          moduleKey: 'core.shell',
          role: 'action',
        }),
        idempotency: 'required',
        legalEntityScope: 'optional',
        owningModuleKey: 'core.shell',
        payloadSchema: Schema.Void,
        policies: [],
        resultSchema: Schema.Void,
        schemaVersion: '1',
      },
      () => Effect.fail(undeclaredDomainError),
    );
    const error = yield* Effect.flip(
      harness.runtime.runAction({
        payload: undefined,
        principal,
        registration: action,
        transport: transport(),
      }),
    );

    expect(Predicate.isTagged(error, 'ActionHandlerExecutionError')).toBe(true);

    expect(error.reason.includes('secret')).toBe(false);
    expect(harness.flushed.length).toBe(0);
  }),
);

it.effect(
  'handles committed, conflict, definite rollback, and indeterminate commit branches',
  Effect.fn(function* testProgram34() {
    const committed = yield* makeHarness({
      createRecord: {
        actionInvocationId: 'committed',
        completedAt: null,
        requestHash: '',
        status: 'succeeded',
      },
    });
    const committedError = yield* Effect.flip(
      committed.runtime.runAction({
        payload: { amount: 1 },
        principal,
        registration: registration(),
        transport: transport(),
      }),
    );

    const conflict = yield* makeHarness({
      createRecord: {
        actionInvocationId: 'conflict',
        completedAt: null,
        requestHash: 'different-request-hash',
        status: 'running',
      },
    });
    const conflictError = yield* Effect.flip(
      conflict.runtime.runAction({
        payload: { amount: 1 },
        principal,
        registration: registration(),
        transport: transport(),
      }),
    );

    const definite = yield* makeHarness({
      transactionMode: 'definite-failure',
    });
    const definiteError = yield* Effect.flip(
      definite.runtime.runAction({
        payload: { amount: 1 },
        principal,
        registration: registration(),
        transport: transport(),
      }),
    );

    const uncertain = yield* makeHarness({ transactionMode: 'uncertain' });
    const uncertainError = yield* Effect.flip(
      uncertain.runtime.runAction({
        payload: { amount: 1 },
        principal,
        registration: registration(),
        transport: transport(),
      }),
    );

    const definiteCommit = yield* makeHarness({
      transactionMode: 'commit-definite',
    });
    const definiteCommitError = yield* Effect.flip(
      definiteCommit.runtime.runAction({
        payload: { amount: 1 },
        principal,
        registration: registration(),
        transport: transport('definite-commit'),
      }),
    );

    const acknowledgementFailureCodes = ['ETIMEDOUT', 'ECONNABORTED', 'ENETRESET', '08007'];
    const acknowledgementErrors = yield* Effect.forEach(
      acknowledgementFailureCodes,
      Effect.fn(function* testProgram35(code) {
        const harness = yield* makeHarness({ commitFailureCode: code });
        return yield* Effect.flip(
          harness.runtime.runAction({
            payload: { amount: 1 },
            principal,
            registration: registration(),
            transport: transport(`uncertain-${code}`),
          }),
        );
      }),
      { concurrency: 'unbounded' },
    );

    expect(Predicate.isTagged(committedError, 'ActionAlreadyCommitted')).toBe(true);

    expect(committed.counts().transactionCount).toBe(0);
    expect(committed.permissionCounts().permissionCheckCount).toBe(0);
    expect(Predicate.isTagged(conflictError, 'ActionRequestHashConflict')).toBe(true);

    expect(conflict.counts().transactionCount).toBe(0);
    expect(conflict.permissionCounts().permissionCheckCount).toBe(0);
    expect(Predicate.isTagged(definiteError, 'ActionTransactionError')).toBe(true);

    expect(Predicate.isTagged(definiteCommitError, 'ActionTransactionError')).toBe(true);

    expect(Predicate.isTagged(uncertainError, 'ActionCommitIndeterminate')).toBe(true);

    expect(uncertain.flushed.length).toBe(1);
    expect(acknowledgementErrors.length).toBe(acknowledgementFailureCodes.length);
    for (const error of acknowledgementErrors) {
      expect(Predicate.isTagged(error, 'ActionCommitIndeterminate')).toBe(true);
    }
  }),
);

it.effect(
  'interruption during commit waits for native commit settlement',
  Effect.fn(function* testProgram36() {
    const commitStarted = Deferred.makeUnsafe<null>();
    const commitSettlement = Deferred.makeUnsafe<readonly object[]>();
    const harness = yield* makeHarness({
      commit: Deferred.succeed(commitStarted, null).pipe(Effect.andThen(Deferred.await(commitSettlement))),
    });

    const actionFiber = yield* harness.runtime
      .runAction({
        payload: { amount: 1 },
        principal,
        registration: registration(),
        transport: transport('interrupted-commit'),
      })
      .pipe(Effect.forkChild);
    yield* Deferred.await(commitStarted);
    const interruption = yield* Fiber.interrupt(actionFiber).pipe(Effect.forkChild);
    yield* Effect.yieldNow;
    const pending = actionFiber.pollUnsafe() === undefined;
    yield* Deferred.succeed(commitSettlement, []);
    yield* Fiber.join(interruption);

    const exit = yield* Fiber.await(actionFiber);
    const pendingBeforeSettlement = pending;
    expect(pendingBeforeSettlement).toBe(true);
    expect(Exit.isFailure(exit)).toBe(true);
    if (!Exit.isFailure(exit)) {
      throw new Error('Expected typed test outcome');
    }
    expect(Cause.hasInterrupts(exit.cause)).toBe(true);
    expect(harness.flushed.length).toBe(1);
  }),
);

it.effect(
  'resolves commit state explicitly and keeps unavailable outcomes indeterminate',
  Effect.fn(function* testProgram37() {
    const invocationId = '00000000-0000-4000-8000-000000000099';
    const open = yield* makeHarness({
      createRecord: {
        actionInvocationId: invocationId,
        completedAt: null,
        requestHash: 'request',
        status: 'running',
      },
    });
    const openResolution = yield* open.runtime.resolveActionCommit({
      invocationId,
      principal,
    });

    const committed = yield* makeHarness({
      createRecord: {
        actionInvocationId: invocationId,
        completedAt: completionTime(),
        requestHash: 'request',
        status: 'succeeded',
      },
    });
    const committedResolution = yield* Effect.flip(committed.runtime.resolveActionCommit({ invocationId, principal }));

    const unavailable = yield* makeHarness({
      createRecord: {
        actionInvocationId: invocationId,
        completedAt: null,
        requestHash: 'request',
        status: 'indeterminate',
      },
      resolutionUnavailable: true,
    });
    const unavailableResolution = yield* Effect.flip(
      unavailable.runtime.resolveActionCommit({ invocationId, principal }),
    );

    expect(Predicate.isTagged(openResolution, 'ActionCommitOpen')).toBe(true);
    expect(Struct.omit(openResolution, ['_tag'])).toEqual({
      invocationId,
    });
    expect(Predicate.isTagged(committedResolution, 'ActionAlreadyCommitted')).toBe(true);

    expect(Predicate.isTagged(unavailableResolution, 'ActionCommitIndeterminate')).toBe(true);
    if (!Predicate.isTagged(unavailableResolution, 'ActionCommitIndeterminate')) {
      throw new Error('Expected typed test outcome');
    }
    expect(unavailableResolution.invocationId).toBe(invocationId);
  }),
);

it.effect(
  'rejects terminal invocation states before handler execution',
  Effect.fn(function* testProgram38() {
    const terminal = yield* makeHarness({
      createRecord: {
        actionInvocationId: 'terminal',
        completedAt: completionTime(),
        requestHash: '',
        status: 'failed',
      },
    });
    const error = yield* Effect.flip(
      terminal.runtime.runAction({
        payload: { amount: 1 },
        principal,
        registration: registration(),
        transport: transport(),
      }),
    );

    expect(Predicate.isTagged(error, 'ActionInvocationStateError')).toBe(true);

    expect(terminal.counts().transitionCount).toBe(0);
    expect(terminal.counts().transactionCount).toBe(0);
  }),
);

it.effect(
  'returns the recorded permission denial to a same-key retry without re-checking permission',
  Effect.fn(function* testRetryAfterRecordedDenial() {
    const harness = yield* makeHarness({ permissionDecision: 'denied' });
    const input = {
      payload: { amount: 1 },
      principal,
      registration: registration(),
      transport: transport('denied-retry'),
    };
    const first = yield* Effect.flip(harness.runtime.runAction(input));
    const retry = yield* Effect.flip(harness.runtime.runAction(input));

    expect(Schema.is(ActionPermissionDenied)(first)).toBe(true);
    expect(Schema.is(ActionPermissionDenied)(retry)).toBe(true);
    expect(harness.permissionChecks).toHaveLength(1);
    expect(harness.rejections).toHaveLength(1);
    expect(harness.counts().transactionCount).toBe(1);
  }),
);

it.effect(
  'returns the rejection a concurrent request recorded first instead of its own denial',
  Effect.fn(function* testConcurrentRejectionWinner() {
    const harness = yield* makeHarness({
      permissionDecision: 'denied',
      recordedByConcurrentRequest: { policyReasonCode: 'concurrent_policy', stage: 'policy' },
    });
    const error = yield* Effect.flip(
      harness.runtime.runAction({
        payload: { amount: 1 },
        principal,
        registration: registration(),
        transport: transport('concurrent-winner'),
      }),
    );

    expect(Schema.is(ActionPolicyDenied)(error) && error.policyReasonCode).toBe('concurrent_policy');
  }),
);

it.effect(
  'returns a concurrent permission denial instead of its own later Policy denial',
  Effect.fn(function* testConcurrentPermissionWinner() {
    const policy = defineGlobalPolicy<unknown>({
      evaluate: () => Effect.fail(denyPolicy('blocked', 'This action is blocked')),
      policyKey: 'global.blocked.v1',
    });
    const action = defineAction(
      {
        accessDeclaration: fixtureActionAccess('core.shell'),
        accessEvidencePolicy: { captureMode: 'metadata_only', policyKey: 'counter.read.v1' },
        actionKey: 'shell.counter.concurrent-permission-winner',
        auditProfile: 'standard',
        domainErrorSchema: Schema.Never,
        domainEvents: {},
        entrypoint: defineSystemModuleEntrypoint({
          access: 'write',
          authorization: { kind: 'action_execution', provisioning: 'tenant_membership_default' },
          entrypointKey: 'shell.counter.concurrent-permission-winner',
          moduleKey: 'core.shell',
          role: 'action',
        }),
        idempotency: 'required',
        legalEntityScope: 'optional',
        owningModuleKey: 'core.shell',
        payloadSchema: Schema.Void,
        policies: [policy],
        resultSchema: Schema.Void,
        schemaVersion: '1',
      },
      () => Effect.void,
    );
    const harness = yield* makeHarness({ recordedByConcurrentRequest: { stage: 'authz' } });
    const error = yield* Effect.flip(
      harness.runtime.runAction({
        payload: undefined,
        principal,
        registration: action,
        transport: transport('concurrent-permission-winner'),
      }),
    );

    expect(Schema.is(ActionPermissionDenied)(error)).toBe(true);
  }),
);

for (const phase of ['BEGIN', 'COMMIT'] as const) {
  it.effect(`maps ${phase} failure while loading a recorded rejection to invocation persistence unavailability`, () =>
    Effect.gen(function* recordedRejectionSettlementFailure() {
      const harness = yield* makeHarness({
        createRecord: {
          actionInvocationId: 'rejected-settlement-failure',
          completedAt: completionTime(),
          requestHash: '',
          status: 'rejected',
        },
        transactionMode: phase === 'BEGIN' ? 'definite-failure' : 'commit-definite',
      });
      const error = yield* Effect.flip(
        harness.runtime.runAction({
          payload: { amount: 1 },
          principal,
          registration: registration(),
          transport: transport(),
        }),
      );
      expect(Schema.is(ActionInvocationPersistenceError)(error)).toBe(true);
      if (Schema.is(ActionInvocationPersistenceError)(error)) {
        const cause = getActionInvocationPersistenceFailureCause(error);
        expect(cause?.reasons.some((reason) => Cause.isDieReason(reason) && isSqlError(reason.defect))).toBe(true);
      }
    }),
  );
}

it.effect('preserves unrelated defects while loading a recorded rejection', () =>
  Effect.gen(function* recordedRejectionUnexpectedDefect() {
    const defect = new Error('unexpected rejection lookup settlement');
    const harness = yield* makeHarness({
      commit: Effect.die(defect),
      createRecord: {
        actionInvocationId: 'rejected-unexpected-defect',
        completedAt: completionTime(),
        requestHash: '',
        status: 'rejected',
      },
    });
    const exit = yield* Effect.exit(
      harness.runtime.runAction({
        payload: { amount: 1 },
        principal,
        registration: registration(),
        transport: transport(),
      }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(exit.cause.reasons.some((reason) => Cause.isDieReason(reason) && reason.defect === defect)).toBe(true);
    }
  }),
);

it.effect(
  'keeps a rejected invocation without a recorded rejection reason terminal',
  Effect.fn(function* testRejectedWithoutRecordedReason() {
    const harness = yield* makeHarness({
      createRecord: {
        actionInvocationId: 'rejected-without-reason',
        completedAt: completionTime(),
        requestHash: '',
        status: 'rejected',
      },
    });
    const error = yield* Effect.flip(
      harness.runtime.runAction({
        payload: { amount: 1 },
        principal,
        registration: registration(),
        transport: transport(),
      }),
    );

    expect(Schema.is(ActionInvocationStateError)(error)).toBe(true);
  }),
);

it.effect(
  'uses one runtime contract for Shell/Core and MicroVertical-shaped registrations',
  Effect.fn(function* testProgram39() {
    const shell = yield* makeHarness();
    const microvertical = yield* makeHarness();
    const moduleRegistration = defineAction(
      {
        accessDeclaration: fixtureActionAccess('inventory.stock'),
        accessEvidencePolicy: {
          captureMode: 'metadata_only',
          policyKey: 'stock.read.v1',
        },
        actionKey: 'inventory.stock.reserve',
        auditProfile: 'standard',
        domainErrorSchema: Schema.Never,
        domainEvents: {},
        entrypoint: defineTenantModuleEntrypoint({
          access: 'write',
          authorization: {
            kind: 'action_execution',
            provisioning: 'tenant_membership_default',
          },
          entrypointKey: 'inventory.stock.reserve',
          moduleKey: 'inventory.stock',
          role: 'action',
        }),
        idempotency: 'required',
        legalEntityScope: 'optional',
        owningModuleKey: 'inventory.stock',
        payloadSchema: Schema.Struct({ quantity: Schema.Finite }),
        policies: [],
        resultSchema: Schema.Struct({ reserved: Schema.Boolean }),
        schemaVersion: '1',
      },
      () => Effect.succeed({ reserved: true }),
    );

    const shellResult = yield* shell.runtime.runAction({
      payload: { amount: 1 },
      principal,
      registration: registration(),
      transport: transport('shell'),
    });
    const moduleResult = yield* microvertical.runtime.runAction({
      payload: { quantity: 2 },
      principal,
      registration: moduleRegistration,
      transport: {
        ...transport('microvertical'),
        targetModuleKey: 'inventory.stock',
      },
    });

    expect(shellResult).toEqual({ total: 1 });
    expect(moduleResult).toEqual({ reserved: true });
  }),
);

it('the Core database service identity remains server-only', () => {
  expect(Predicate.isFunction(CoreDatabase)).toBe(true);
});

class TestPostAttemptDependency extends Context.Service<
  TestPostAttemptDependency,
  { readonly record: (outcome: string) => void }
>()('@app/core-runtime/tests/unit/action-runtime.test/TestPostAttemptDependency') {}

const checkNestedRuntimeBoundaries = Effect.fn('ActionRuntimeTest.nestedConcurrentBoundaries')(
  function* nestedConcurrentRuntimeBoundaries() {
    const first = yield* Deferred.make<boolean>();
    const second = yield* Deferred.make<boolean>();
    const frameKey = '@app/core-runtime/modules/module-operation-execution/ModuleOperationExecution';
    const decodeFrameStatus = Schema.decodeUnknownEffect(Schema.Option(Schema.Struct({ active: Schema.Boolean })));
    const frameStatus = (context: Context.Context<never>) =>
      decodeFrameStatus(context.mapUnsafe.get(frameKey)).pipe(Effect.orDie);
    const preparePreflight = Effect.fn('ActionRuntimeTest.prepareWithoutAncestor')(function* prepareWithoutAncestor(
      own: Deferred.Deferred<boolean>,
      other: Deferred.Deferred<boolean>,
    ) {
      yield* Deferred.succeed(own, true);
      yield* Deferred.await(other);
      const context = yield* Effect.context();
      expect(Option.isNone(yield* frameStatus(context))).toBe(true);
      return { outcome: 'not_applicable' as const };
    });
    const captured: Context.Context<never>[] = [];
    const run = (own: Deferred.Deferred<boolean>, other: Deferred.Deferred<boolean>, suffix: string) => {
      const parent = registration();
      return withModuleOperationExecution(
        {
          loadCatalog: Effect.fail(
            new ModuleOperationRequirementError({
              code: 'module_operation_requirement_unavailable',
              reason: 'Synthetic parent has no provider catalog',
            }),
          ),
          ownerRegistration: historicalFixtureOwner('core.shell'),
          phase: 'execution',
          registration: parent,
          revision: approvedCompositionRevision,
          scope: principal,
        },
        Effect.gen(function* parentRuntimeScope() {
          const parentContext = yield* Effect.context();
          const parentFrame = parentContext.mapUnsafe.get(frameKey);
          const probeOwnedChild = Effect.gen(function* childFrameProbe() {
            const context = yield* Effect.context();
            const selected = yield* frameStatus(context);
            expect(Option.isSome(selected) && selected.value.active).toBe(true);
            expect(context.mapUnsafe.get(frameKey)).not.toBe(parentFrame);
            captured.push(context);
          });
          const policy = defineGlobalPolicy<{ readonly amount: number }>({
            evaluate: () => probeOwnedChild,
            policyKey: `global.child-frame-${suffix}.v1`,
          });
          const child = defineAction(
            { ...registration().descriptor, policies: [policy] },
            (payload) => probeOwnedChild.pipe(Effect.as({ total: payload.amount })),
            () => Effect.succeed({}),
            undefined,
            () => probeOwnedChild.pipe(Effect.as({ _tag: 'Settled' as const })),
          );
          const harness = yield* makeHarness({
            authorizationPreflight: {
              prepare: () => preparePreflight(own, other),
            },
          });
          expect(
            yield* harness.runtime.runAction({
              payload: { amount: 3 },
              principal,
              registration: child,
              transport: transport(`nested-runtime-${suffix}`),
            }),
          ).toEqual({ total: 3 });
          const restored = yield* Effect.context();
          expect(restored.mapUnsafe.get(frameKey)).toBe(parentFrame);
          const active = yield* frameStatus(restored);
          expect(Option.isSome(active) && active.value.active).toBe(true);
          captured.push(parentContext);
        }),
      );
    };
    yield* Effect.all([run(first, second, 'first'), run(second, first, 'second')], { concurrency: 2 });
    expect(captured).toHaveLength(8);
    yield* Effect.forEach(
      captured,
      (context) =>
        frameStatus(context).pipe(
          Effect.tap((status) => Effect.sync(() => expect(Option.isSome(status) && !status.value.active).toBe(true))),
        ),
      { concurrency: 1, discard: true },
    );
  },
);

it.layer(NodeCrypto.layer)('Action post-attempt runtime', (suite) => {
  suite.effect(
    'runs the genuine post-attempt hook after commit with independent factory and callback dependencies',
    () =>
      Effect.gen(function* distinctPostAttemptRequirements() {
        const harness = yield* makeHarness();
        const seen: string[] = [];
        const base = registration();
        const action = defineAction(
          base.descriptor,
          (payload, context) => Effect.succeed({ total: payload.amount + context.services.offset }),
          () =>
            Effect.gen(function* factoryWithCrypto() {
              yield* Crypto.Crypto;
              return { offset: 1 };
            }),
          undefined,
          Effect.fn(function* privateSettlement(context) {
            const dependency = yield* TestPostAttemptDependency;
            expect(harness.transactionOutcomes().committedTransactionCount).toBe(1);
            expect(harness.flushed).toHaveLength(1);
            expect(Object.isFrozen(context)).toBe(true);
            expect(Object.isFrozen(context.payload)).toBe(true);
            expect('services' in context).toBe(false);
            expect('transaction' in context).toBe(false);
            dependency.record(context.outcome._tag);
            return { _tag: 'Settled' as const };
          }),
        );
        const result = yield* harness.runtime
          .runAction({
            payload: { amount: 3 },
            principal,
            registration: action,
            transport: transport('post-attempt-independent'),
          })
          .pipe(
            Effect.provideService(TestPostAttemptDependency, {
              record: (outcome) => {
                seen.push(outcome);
              },
            }),
          );
        expect(result).toEqual({ total: 4 });
        expect(seen).toEqual(['Committed']);
      }),
  );

  suite.effect('recovers an original AlreadyCommitted invocation without new permission or preflight consume', () =>
    Effect.gen(function* originalCommittedRecovery() {
      const harness = yield* makeHarness({
        createRecord: {
          actionInvocationId: 'invocation-1',
          completedAt: transactionOperationAt,
          requestHash: '',
          status: 'succeeded',
        },
      });
      const seen: string[] = [];
      const action = defineAction(
        registration().descriptor,
        () => Effect.succeed({ total: 1 }),
        () => Effect.succeed({}),
        undefined,
        (context) =>
          Effect.sync(() => {
            seen.push(context.outcome._tag);
            return { _tag: 'Recovered' as const, result: { total: 9 } };
          }),
      );
      const result = yield* harness.runtime.runAction({
        payload: { amount: 3 },
        principal,
        registration: action,
        transport: transport('post-attempt-original'),
      });
      expect(result).toEqual({ total: 9 });
      expect(seen).toEqual(['AlreadyCommitted']);
      expect(harness.permissionCounts().permissionCheckCount).toBe(0);
      expect(harness.counts().transactionCount).toBe(0);
    }),
  );

  suite.effect('accepts commit-loss recovery only when the same original invocation is confirmed succeeded', () =>
    Effect.gen(function* commitLossRecovery() {
      for (const confirmed of [false, true]) {
        const harness = yield* makeHarness({ resolveCommitted: confirmed, transactionMode: 'uncertain' });
        const seen: string[] = [];
        const action = defineAction(
          registration().descriptor,
          () => Effect.succeed({ total: 1 }),
          () => Effect.succeed({}),
          undefined,
          (context) =>
            Effect.sync(() => {
              seen.push(context.outcome._tag);
              return { _tag: 'Recovered' as const, result: { total: 9 } };
            }),
        );
        const exit = yield* Effect.exit(
          harness.runtime.runAction({
            payload: { amount: 3 },
            principal,
            registration: action,
            transport: transport(`post-attempt-loss-${confirmed}`),
          }),
        );
        expect(seen).toEqual(['Indeterminate']);
        expect(Exit.isSuccess(exit)).toBe(confirmed);
        if (Exit.isSuccess(exit)) {
          expect(exit.value).toEqual({ total: 9 });
        } else {
          expect(
            exit.cause.reasons.some(
              (reason) => Cause.isFailReason(reason) && Predicate.isTagged(reason.error, 'ActionCommitIndeterminate'),
            ),
          ).toBe(true);
        }
        expect(harness.permissionCounts().permissionCheckCount).toBe(1);
      }
    }),
  );

  suite.effect('preserves committed storage when a declared post-attempt settlement debt fails the response', () =>
    Effect.gen(function* committedSettlementDebt() {
      const harness = yield* makeHarness();
      const debt = Schema.TaggedStruct('TestSettlementDebt', { reason: Schema.String });
      const action = defineAction(
        { ...registration().descriptor, domainErrorSchema: debt },
        () => Effect.succeed({ total: 1 }),
        () => Effect.succeed({}),
        undefined,
        () => Effect.fail({ _tag: 'TestSettlementDebt' as const, reason: 'receipt confirmation pending' }),
      );
      const failure = yield* Effect.flip(
        harness.runtime.runAction({
          payload: { amount: 3 },
          principal,
          registration: action,
          transport: transport('post-attempt-debt'),
        }),
      );
      expect(Schema.is(debt)(failure)).toBe(true);
      expect(harness.transactionOutcomes()).toEqual({ committedTransactionCount: 1, rolledBackTransactionCount: 0 });
      expect(harness.flushed).toHaveLength(1);
    }),
  );
  suite.effect('round-trips transformed committed and recovered results without changing their domain shape', () =>
    Effect.gen(function* transformedPostAttemptResults() {
      const occurredAt = DateTime.makeUnsafe(Date.parse('2026-10-30T10:00:00.000Z'));
      for (const replay of [false, true]) {
        const harness = yield* makeHarness(
          replay
            ? {
                createRecord: {
                  actionInvocationId: 'invocation-1',
                  completedAt: transactionOperationAt,
                  requestHash: '',
                  status: 'succeeded',
                },
              }
            : {},
        );
        const action = defineAction(
          { ...registration().descriptor, resultSchema: Schema.Struct({ occurredAt: Schema.DateTimeUtcFromString }) },
          () => Effect.succeed({ occurredAt }),
          () => Effect.succeed({}),
          undefined,
          (context) =>
            Effect.succeed(
              Match.value(context.outcome).pipe(
                Match.tag('Committed', ({ result }) => {
                  expect(DateTime.formatIso(result.occurredAt)).toBe('2026-10-30T10:00:00.000Z');
                  expect(Object.isFrozen(result)).toBe(true);
                  return { _tag: 'Settled' as const };
                }),
                Match.orElse(() => ({ _tag: 'Recovered' as const, result: { occurredAt } })),
              ),
            ),
        );
        const result = yield* harness.runtime.runAction({
          payload: { amount: 3 },
          principal,
          registration: action,
          transport: transport(`post-attempt-transformed-${replay}`),
        });
        expect(DateTime.formatIso(result.occurredAt)).toBe('2026-10-30T10:00:00.000Z');
        expect(harness.permissionCounts().permissionCheckCount).toBe(replay ? 0 : 1);
      }
    }),
  );
  suite.effect('fails unknown owner metadata closed before permission or factory work', () =>
    Effect.gen(function* unknownOwnerMetadata() {
      const harness = yield* makeHarness({ omitOwnerRegistration: true });
      const failure = yield* Effect.flip(
        harness.runtime.runAction({
          payload: { amount: 3 },
          principal,
          registration: registration(),
          transport: transport('unknown-owner-metadata'),
        }),
      );
      expect(Schema.is(ActionTransactionError)(failure)).toBe(true);
      expect(harness.permissionCounts().permissionCheckCount).toBe(0);
      expect(harness.counts().transactionCount).toBe(0);
    }),
  );
  suite.effect(
    'shadows ancestor frames through actual nested concurrent admission and restores only live parents',
    checkNestedRuntimeBoundaries,
  );
  suite.effect('distinguishes definite rollback from committed rejection without changing either stored outcome', () =>
    Effect.gen(function* closedRejectionOutcomes() {
      const rejectionSchema = Schema.TaggedStruct('TestPostAttemptRejection', { reason: Schema.String });
      const rejection = { _tag: 'TestPostAttemptRejection' as const, reason: 'known terminal business rule' };
      for (const committed of [false, true]) {
        const harness = yield* makeHarness();
        const outcomes: string[] = [];
        const action = defineAction(
          { ...registration().descriptor, domainErrorSchema: rejectionSchema },
          () => (committed ? Effect.succeed(commitActionThenReject(rejection)) : Effect.fail(rejection)),
          () => Effect.succeed({}),
          undefined,
          (context) =>
            Effect.sync(() => {
              outcomes.push(context.outcome._tag);
              return { _tag: 'Settled' as const };
            }),
        );
        const failure = yield* Effect.flip(
          harness.runtime.runAction({
            payload: { amount: 3 },
            principal,
            registration: action,
            transport: transport(`closed-rejection-${committed}`),
          }),
        );
        expect(Schema.is(rejectionSchema)(failure)).toBe(true);
        expect(outcomes).toEqual([committed ? 'CommittedRejection' : 'DefinitelyUncommitted']);
        expect(harness.transactionOutcomes()).toEqual({
          committedTransactionCount: committed ? 1 : 0,
          rolledBackTransactionCount: committed ? 0 : 1,
        });
        expect(harness.flushed).toHaveLength(committed ? 1 : 0);
      }
    }),
  );
  suite.effect('reports Interrupted after rollback and cannot turn interruption into recovered success', () =>
    Effect.scoped(
      Effect.gen(function* interruptedPostAttempt() {
        const entered = yield* Deferred.make<boolean>();
        const harness = yield* makeHarness();
        const outcomes: string[] = [];
        const action = defineAction(
          registration().descriptor,
          () => Deferred.succeed(entered, true).pipe(Effect.andThen(Effect.never)),
          () => Effect.succeed({}),
          undefined,
          (context) =>
            Effect.sync(() => {
              outcomes.push(context.outcome._tag);
              return { _tag: 'Recovered' as const, result: { total: 99 } };
            }),
        );
        const fiber = yield* Effect.forkChild(
          harness.runtime.runAction({
            payload: { amount: 3 },
            principal,
            registration: action,
            transport: transport('interrupted-post-attempt'),
          }),
        );
        yield* Deferred.await(entered);
        yield* Fiber.interrupt(fiber);
        const exit = yield* Fiber.await(fiber);
        expect(Exit.isFailure(exit)).toBe(true);
        expect(outcomes).toEqual(['Interrupted']);
        expect(harness.flushed).toHaveLength(0);
        expect(harness.transactionOutcomes()).toEqual({ committedTransactionCount: 0, rolledBackTransactionCount: 1 });
      }),
    ),
  );
  suite.effect('does not turn a partial authority plus legacy revision resolver into a requirement lease', () =>
    Effect.gen(function* partialActionAuthorityCannotAttest() {
      let authorityLoads = 0;
      const applicationComposition: ActiveApplicationCompositionServiceContract = {
        load: Effect.suspend(() => {
          authorityLoads += 1;
          return Effect.fail(
            new ActiveApplicationCompositionUnavailableError({
              cause: new Error('Synthetic partial constructor'),
              reason: 'No receiving build was bound',
            }),
          );
        }),
      };
      const harness = yield* makeHarness({ applicationComposition });
      const action = defineAction(
        { ...registration().descriptor, domainErrorSchema: ModuleOperationRequirementError },
        () => requireModuleOperation('core.shell.unqualified-operation').pipe(Effect.as({ total: 1 })),
      );
      const failure = yield* Effect.flip(
        harness.runtime.runAction({
          payload: { amount: 3 },
          principal,
          registration: action,
          transport: transport('partial-action-authority'),
        }),
      );
      expect(Schema.is(ModuleOperationRequirementError)(failure)).toBe(true);
      expect(authorityLoads).toBe(0);
      expect(harness.flushed).toHaveLength(0);
    }),
  );
});

for (const row of remainingPermissionBaselines) {
  it.effect(`freezes corrected ${row.target.kind} Action history and request identity`, () =>
    Effect.gen(function* familyActionBaseline() {
      let handlerCalls = 0;
      const permission = yield* Schema.decodeEffect(FixturePermissionCodeSchema)(row.permission);
      const key = `${row.owner}.baseline.${row.target.kind.replaceAll('_', '-')}`;
      const action = defineAction(
        {
          accessDeclaration: fixtureActionAccess(row.owner),
          accessEvidencePolicy: { captureMode: 'metadata_only', policyKey: `${key}.access.v1` },
          actionKey: key,
          auditProfile: 'sensitive',
          domainErrorSchema: Schema.Never,
          domainEvents: {},
          entrypoint: defineTenantModuleEntrypoint({
            access: 'write',
            authorization: { kind: 'action_execution', provisioning: 'explicit' },
            entrypointKey: key,
            moduleKey: row.owner,
            role: 'action',
          }),
          idempotency: 'required',
          legalEntityScope: row.tenantOnly ? 'forbidden' : 'required',
          ownerPermissions: historicalActionPermissions<typeof Schema.Void.Type>(permission, () =>
            row.target.kind === 'counterparty_storefront'
              ? { permission, target: row.target, trustedStorefrontId: row.target.storefrontId }
              : { permission, target: row.target },
          ),
          owningModuleKey: row.owner,
          payloadSchema: Schema.Void,
          policies: [],
          resultSchema: Schema.Void,
          schemaVersion: '1',
        },
        () => {
          handlerCalls += 1;
          return Effect.void;
        },
      );
      const actor = row.tenantOnly ? Struct.omit(principal, ['legalEntityId']) : principal;
      const admittedActor =
        row.target.kind === 'counterparty_storefront'
          ? trustVerifiedGatewayPrincipalContext(
              { ...actor, trustedStorefrontId: row.target.storefrontId },
              'a'.repeat(64),
            )
          : actor;
      const harness = yield* makeHarness();
      yield* harness.runtime.runAction({
        payload: undefined,
        principal: admittedActor,
        registration: action,
        transport: transport(`baseline-${row.target.kind}`),
      });
      expect(harness.flushed[0]?.transport).toEqual({
        ...row.actionTarget,
        correlationId: `correlation-baseline-${row.target.kind}`,
        idempotencyKey: `baseline-${row.target.kind}`,
      });
      expect(harness.requestHashes).toEqual([row.actionHash]);
      for (const [decision, tag] of [
        ['denied', 'ActionPermissionDenied'],
        ['unavailable', 'ActionPermissionCheckError'],
      ] as const) {
        const checked = yield* makeHarness({ businessPermissionDecision: decision });
        const failure = yield* Effect.flip(
          checked.runtime.runAction({
            payload: undefined,
            principal: admittedActor,
            registration: action,
            transport: transport(`baseline-${row.target.kind}-${decision}`),
          }),
        );
        expect(Predicate.isTagged(failure, tag)).toBe(true);
      }
      expect(handlerCalls).toBe(1);
    }),
  );
}
/** Synthetic registered host; the executed Action remains the exact production Core definition. */
const registeredCoreActionHost = (moduleId: string, mismatchedProjection = false) => {
  const base = makeModuleContractFixture({ appId: 'core-action-host', moduleId }).manifest;
  const manifest = defineOntosModuleManifest({
    ...base,
    publicSurface: { ...base.publicSurface, actions: [], api: {}, components: {} },
    requirements: {
      coreCapabilities: mismatchedProjection ? [{ id: 'test.host.feature', version: '1' }] : [],
      intrinsic: [],
      operations: [],
      schemaVersion: '1',
    },
  });
  return defineVerticalRuntimeRegistration({ actions: [], manifest, outboxWorkers: [] });
};

const hostedCoreActionInput = () => ({
  payload: {
    checkpoint: 'stopped' as const,
    originalPrincipalId: principal.principalId,
    reason: 'Record the genuine Core Action through the registered test host',
    sessionRef: 'better-auth-session:hosted-core-session',
    targetPrincipalId: '00000000-0000-4000-8000-000000000099',
  },
  principal,
  registration: recordSupportImpersonationAction,
  transport: transport('genuine-hosted-core-action'),
});

it.layer(NodeCrypto.layer)('Core Actions hosted by genuine registered modules', (suite) => {
  suite.effect('admits the exact Core Action through a genuine registered host and its pinned projection', () =>
    Effect.gen(function* hostedCoreActionAdmission() {
      const snapshot = yield* freshOutboxWorkerCompositionSnapshot(
        makeOutboxWorkerComposition([
          { appId: 'core-action-host', buildMarker: 'actual-host-build', moduleId: 'test.core-action-host.module' },
        ]),
      );
      const harness = yield* makeHarness({
        applicationComposition: { load: Effect.succeed(snapshot) },
        compositionAuthority: { phase: 'active', revision: snapshot.composition.revision, unexpired: true },
        expectedDeployment: { appId: 'core-action-host', buildMarker: 'actual-host-build' },
        ownerRegistration: registeredCoreActionHost('test.core-action-host.module'),
      });
      const result = yield* harness.runtime
        .runAction(hostedCoreActionInput())
        .pipe(providePrincipalManagementRepository);
      expect(result).toEqual({ checkpoint: 'stopped', recorded: true });
      // Ending an impersonation only takes authority away, so no grant is decided (O35, O71).
      expect(harness.accessQuestions()).toEqual([]);
      expect(harness.permissionCounts().permissionCheckCount).toBe(0);
      expect(harness.gateCounts().handlerResolutionCount).toBe(1);
      expect(harness.flushed).toHaveLength(1);
      expect(harness.compositionAuthority().lockCount).toBe(1);
    }),
  );

  suite.effect('refuses wrong host builds, host projections and recreated Core Action keys', () =>
    Effect.gen(function* hostedCoreActionRemainsExact() {
      const snapshot = yield* freshOutboxWorkerCompositionSnapshot(
        makeOutboxWorkerComposition([
          { appId: 'core-action-host', buildMarker: 'actual-host-build', moduleId: 'test.core-action-host.module' },
        ]),
      );
      let recreatedCalls = 0;
      const recreated = defineAction({ ...recordSupportImpersonationAction.descriptor }, () => {
        recreatedCalls += 1;
        return Effect.succeed({ checkpoint: 'stopped' as const, recorded: true as const });
      });
      for (const control of ['wrong-host', 'wrong-build', 'wrong-projection', 'recreated-key'] as const) {
        const harness = yield* makeHarness({
          applicationComposition: { load: Effect.succeed(snapshot) },
          compositionAuthority: { phase: 'active', revision: snapshot.composition.revision, unexpired: true },
          expectedDeployment: {
            appId: 'core-action-host',
            buildMarker: control === 'wrong-build' ? 'other-build' : 'actual-host-build',
          },
          ownerRegistration: registeredCoreActionHost(
            control === 'wrong-host' ? 'test.other-host.module' : 'test.core-action-host.module',
            control === 'wrong-projection',
          ),
        });
        const input = hostedCoreActionInput();
        const failure =
          control === 'recreated-key'
            ? yield* harness.runtime.runAction({ ...input, registration: recreated }).pipe(Effect.flip)
            : yield* harness.runtime.runAction(input).pipe(Effect.flip);
        expect(Schema.is(ActionTransactionError)(failure)).toBe(true);
        expect(harness.gateCounts().handlerResolutionCount).toBe(0);
        expect(harness.flushed).toHaveLength(0);
      }
      expect(recreatedCalls).toBe(0);
    }),
  );
});
