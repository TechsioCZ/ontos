// @effect-diagnostics strictEffectProvide:off multipleEffectProvide:off -- Test-owned scripted database entrypoint for Action fixtures; Reactivity feeds both the scripted client and the executor. expires: 2026-12-31.
import { NodeCrypto } from '@effect/platform-node';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import { Crypto, DateTime, Deferred, Effect, Layer, Option, Schema } from 'effect';
import { Reactivity } from 'effect/reactivity';
import { ConnectionError, SqlError } from 'effect/sql/SqlError';

import type { ActionRegistration, ActionServiceFactory, AnyActionRegistration } from '../actions/definition.ts';
import { getActionServiceFactory, getActionServicePreflight } from '../actions/definition.ts';
import { originalActionPreparationFactory } from '../actions/preparation-observation.ts';
import {
  ActionInvocationNotFound,
  ActionInvocationPersistenceError,
  ActionPermissionCheckError,
  createActionInvocationPersistenceErrorWithCause,
} from '../actions/errors.ts';
import type { DomainEventContractMap } from '../actions/events.ts';
import type {
  ActionInvocationRecord,
  ActionRecordedRejection,
  ActionRepositoryService,
  FinalizeActionPolicyDenialInput,
  FlushActionSuccessInput,
  PrepareActionInvocationInput,
  RejectPermissionDeniedInput,
} from '../actions/repository.ts';
import type { ActionRuntimeOptions, ActionRuntimeStage } from '../actions/runtime.ts';
import type { ActionMandateDispatch } from '../access/approvals/action-mandate-dispatch.ts';
import { ActionRuntime, makeActionRuntime } from '../actions/runtime.ts';
import { DatabaseCommitAcknowledgementAmbiguous } from '../database/driver-failure.ts';
import {
  defineDatabaseIdentityEnrollment,
  gatewayScopeGrantRoleForAudience,
  SHARED_RUNTIME_IDENTITY,
} from '../db/database-identities.ts';
import type { DatabaseIdentityEnrollment } from '../db/database-identities.ts';
import { coreRelations } from '../db/schema.ts';
import { makeModuleEntrypointGateway } from '../modules/module-entrypoint-gateway.ts';
import type { ModuleStateGateService } from '../modules/module-state-gate.ts';
import { checkModuleEntrypoint, makeModuleStateSnapshot } from '../modules/module-state-gate.ts';
import type { TenantModuleState } from '../modules/tenant-module-state-service.ts';
import type { BoundAccessGate } from '../operations/access-gate.ts';
import { makeOperationalScopeResolver } from '../operations/context.ts';
import { OperationContextUnavailable } from '../operations/errors.ts';
import { ActionAuthorizationPreflight } from '../actions/owner-proof-preflight.ts';
import type {
  ContextAccessDecision,
  ContextAccessService,
  OwnerPermissionAccessTarget,
} from '../permissions/context-access.ts';
import { failClosedOwnerAuthorizationOverlay } from '../access/enforcement/owner-overlay.ts';
import type { OwnerAuthorizationDecision, OwnerAuthorizationInput } from '../access/enforcement/owner-overlay.ts';
import { makeScriptedBoundAccessGate, makeTestOperationalScopeAccess } from './access-gate.ts';
import type { TestAccessOutcome } from './access-gate.ts';
import { scriptedPgClientLayer, testSqlConnection } from './scripted-pg-client.ts';
import { makeOwnerApplicationCompositionFixture } from './module-contract.ts';
import { ActionTestPreparationScope, executeActionTestPreparationRead } from './action-preparation-reads.ts';
import type { ActionTestAccessFences } from './action-access-fences.ts';
import type { ActionTestPreparationRead, ActionTestPreparationReadScript } from './action-preparation-reads.ts';

export type { ActionTestPreparationRead, ActionTestPreparationReadScript } from './action-preparation-reads.ts';
export { makeActionPreparationProbe } from './action-preparation-probe.ts';
export { makeActionTestAccessFences } from './action-access-fences.ts';
export type { ActionTestAccessFenceQuery, ActionTestAccessFenceRow } from './action-access-fences.ts';

/** Test-only: bind the existing issuer registrar to an explicitly scoped fixture pool. */
export { makeGatewayScopeGrantRegistrar } from '../auth/gateway-scope-grant.ts';

/** Test-only: owner fixtures bind routines to the package's single scoped-transaction implementation. */
export { installOperationalScope } from '../db/scoped-transaction.ts';

const actionTestServiceBinding: unique symbol = Symbol('test-action-service-binding');
const querySchema = Schema.Union([Schema.String, Schema.Struct({ text: Schema.String })]);
const scopeValuesSchema = Schema.Tuple([Schema.String, Schema.String]);
const gatewayAssertionValuesSchema = Schema.Tuple([Schema.String]);
/** The principal claim Shell registers as the gateway scope grant for an issued assertion. */
const gatewayAssertionClaimsSchema = Schema.Struct({
  aud: Schema.String,
  principal: Schema.Struct({
    legalEntityId: Schema.optional(Schema.String.pipe(Schema.brand('LegalEntityId'))),
    tenantId: Schema.String.pipe(Schema.brand('TenantId')),
  }),
});
const decodeGatewayAssertionClaims = Schema.decodeUnknownEffect(
  Schema.StringFromBase64Url.pipe(Schema.decodeTo(Schema.fromJsonString(gatewayAssertionClaimsSchema))),
);
const ESTABLISH_GATEWAY_SCOPE_SQL =
  "select established_tenant_id::text as tenant_id, coalesce(established_legal_entity_id::text, '') as legal_entity_id from trust.establish_gateway_scope($1)";
const READ_GATEWAY_SCOPE_SQL =
  "select current_user::text as role, coalesce(trust.current_tenant_id()::text, '') as tenant_id, coalesce(trust.current_legal_entity_id()::text, '') as legal_entity_id";
const INSTALL_TEST_SCOPE_SQL =
  "select set_config('ontos.tenant_id', $1, true), set_config('ontos.legal_entity_id', $2, true)";
const READ_TEST_SCOPE_SQL =
  "select current_user::text as role, current_setting('ontos.tenant_id', true) as tenant_id, current_setting('ontos.legal_entity_id', true) as legal_entity_id";
const idempotencyScopeSchema = Schema.Tuple([Schema.String, Schema.String, Schema.String, Schema.String]);
const encodeIdempotencyScope = Schema.encodeEffect(Schema.fromJsonString(idempotencyScopeSchema));
const testCommitAcknowledgementSqlState = ['0', '8007'].join('');
const completionTime = () => DateTime.toDateUtc(DateTime.makeUnsafe(0));

/** Test-only transaction-service substitution; the registered handler and preparation remain unchanged. */
export interface ActionTestServiceBinding {
  readonly [actionTestServiceBinding]: true;
}

interface ActionTestServiceBindingPayload {
  readonly registration: AnyActionRegistration;
  readonly services: unknown;
}

interface ActionTestConnectionScope {
  legalEntityId: string;
  /** The connected role: the shared runtime until a gateway scope is established. */
  role: string;
  tenantId: string;
}

class ActionTestServiceBindingValue implements ActionTestServiceBinding {
  readonly [actionTestServiceBinding] = true;
  readonly #payload: ActionTestServiceBindingPayload;

  constructor(payload: ActionTestServiceBindingPayload) {
    this.#payload = payload;
  }

  resolve(): ActionTestServiceBindingPayload {
    return this.#payload;
  }
}

const isActionTestServiceBindingValue = Schema.is(Schema.instanceOf(ActionTestServiceBindingValue));

export const bindActionTestServices = <
  Payload extends Schema.ConstraintDecoder<unknown>,
  Result extends Schema.ConstraintDecoder<unknown>,
  DomainError extends Schema.ConstraintDecoder<{ readonly _tag: string }>,
  Events extends DomainEventContractMap,
  Owner extends string,
  Services,
  Requirements,
>(
  registration: ActionRegistration<Payload, Result, DomainError, Events, Owner, Services, Requirements>,
  services: NoInfer<Services>,
): ActionTestServiceBinding => Object.freeze(new ActionTestServiceBindingValue({ registration, services }));

export interface ActionTestHarnessOptions extends Pick<
  ActionRuntimeOptions,
  'applicationComposition' | 'expectedDeployment' | 'ownerRegistration'
> {
  /** The access gate's scripted answer for every protected Action (a v2 carrier decides here). */
  readonly access?: TestAccessOutcome | Readonly<Record<string, TestAccessOutcome>>;
  /** A fully bound gate (the real seam with faked ports) instead of a scripted answer. */
  readonly accessDecision?: BoundAccessGate;
  /** Exact Core fence SQL only, over the same explicit rows as the fixture's canonical gate. */
  readonly accessFences?: ActionTestAccessFences;
  readonly actionPermission?: ContextAccessDecision;
  /** Persist the first commit, then simulate a database connection losing its acknowledgement. */
  readonly commitAcknowledgement?: 'indeterminate-once';
  readonly compositionRevision?: string;
  readonly databaseIdentities?: DatabaseIdentityEnrollment;
  readonly legalEntityAccess?: ContextAccessDecision;
  readonly legalEntityPermission?: ContextAccessDecision;
  /** Test-only fence lock; defaults to an in-memory no-op because this database has no fence SQL. */
  readonly lockAccessExecutionFence?: NonNullable<ActionRuntimeOptions['lockAccessExecutionFence']>;
  readonly mandateDispatch?: ActionMandateDispatch;
  readonly moduleState?: TenantModuleState;
  /**
   * Observes the owner overlay input the runner builds inside the transaction and answers it (O70).
   * Omitting it keeps the fail-closed owner-neutral overlay.
   */
  readonly onOwnerAuthorization?: (input: OwnerAuthorizationInput) => OwnerAuthorizationDecision;
  /** Scripted Current decisions in exact target order; omitted positions remain unavailable. */
  readonly ownerPermissionDecisions?: readonly ContextAccessDecision[];
  /** Exact read-only driver answers for the original registered preparation snapshot only. */
  readonly preparationReads?: readonly ActionTestPreparationReadScript[];
  readonly resourcePermission?: ContextAccessDecision;
  readonly scope?: 'active' | 'denied' | 'unavailable';
  readonly services?: readonly ActionTestServiceBinding[];
  readonly tenantPermission?: ContextAccessDecision;
}

export interface ActionTestInvocation extends ActionInvocationRecord {
  readonly actionKey: string;
  readonly idempotencyKey: string | undefined;
  readonly legalEntityId: string | undefined;
  readonly principalId: string;
  readonly tenantId: string;
}

export interface ActionTestSnapshot {
  readonly committed: readonly FlushActionSuccessInput[];
  readonly invocations: readonly ActionTestInvocation[];
  readonly ownerPermissionTargets: readonly OwnerPermissionAccessTarget[];
  readonly permissionDenials: readonly RejectPermissionDeniedInput[];
  readonly policyDenials: readonly FinalizeActionPolicyDenialInput[];
  readonly preparationQueries: readonly ActionTestPreparationRead[];
  readonly stages: readonly ActionRuntimeStage[];
  readonly transactionCount: number;
}

const persistenceFailure = () =>
  new ActionInvocationPersistenceError({
    code: 'action_invocation_persistence_failed',
    reason: 'The test invocation does not exist',
  });

/**
 * Runs the real Action runtime against in-memory boundary fakes. It deliberately rejects owner
 * SQL: bind typed owner services explicitly. This proves lifecycle behavior, not database/RLS.
 * Authorization defaults to denied; only the test scope's ordinary LE access defaults allowed.
 */
const queryRows = (result: { readonly rows: readonly object[] }) => result.rows;
const sqlFailure = (cause: unknown) => new SqlError({ reason: new ConnectionError({ cause }) });

const actionTestComposition = Effect.fn('ActionTestHarness.composition')(function* actionTestComposition(
  options: Pick<ActionTestHarnessOptions, 'applicationComposition' | 'expectedDeployment' | 'ownerRegistration'>,
) {
  if (
    options.ownerRegistration !== undefined &&
    options.applicationComposition === undefined &&
    options.expectedDeployment === undefined
  ) {
    return yield* makeOwnerApplicationCompositionFixture({ ownerRegistration: options.ownerRegistration });
  }
  return {
    applicationComposition: options.applicationComposition,
    expectedDeployment: options.expectedDeployment,
  };
});

const actionTestHarness = Effect.fn('ActionTestHarness.make')(
  function* actionTestHarness(options: ActionTestHarnessOptions = {}) {
    const crypto = yield* Crypto.Crypto;
    const { applicationComposition, expectedDeployment } = yield* actionTestComposition(options);
    const databaseIdentities = options.databaseIdentities ?? defineDatabaseIdentityEnrollment([]);
    const invocations = new Map<string, ActionTestInvocation>();
    const idempotency = new Map<string, string>();
    const committed: FlushActionSuccessInput[] = [];
    const permissionDenials: RejectPermissionDeniedInput[] = [];
    const ownerPermissionTargets: OwnerPermissionAccessTarget[] = [];
    const policyDenials: FinalizeActionPolicyDenialInput[] = [];
    const stages: ActionRuntimeStage[] = [];
    const preparationQueries: ActionTestPreparationRead[] = [];
    let transactionCount = 0;
    let loseCommitAcknowledgement = options.commitAcknowledgement === 'indeterminate-once';
    let pendingCommit: Effect.Effect<void, ActionInvocationPersistenceError>[] = [];
    let connectionQueue = Effect.void;

    const find = (id: string): Effect.Effect<ActionTestInvocation, ActionInvocationPersistenceError> => {
      const invocation = invocations.get(id);
      return invocation === undefined ? Effect.fail(persistenceFailure()) : Effect.succeed(invocation);
    };
    const prepare = Effect.fn('ActionTestHarness.prepare')(function* prepareTestInvocation(
      input: PrepareActionInvocationInput,
    ) {
      const key =
        input.idempotencyKey === undefined
          ? undefined
          : yield* encodeIdempotencyScope([
              input.principal.tenantId,
              input.principal.principalId,
              input.actionKey,
              input.idempotencyKey,
            ]).pipe(Effect.orDie);
      const existing = key === undefined ? undefined : idempotency.get(key);
      if (existing !== undefined) {
        return yield* find(existing);
      }
      const actionInvocationId = yield* crypto.randomUUIDv4().pipe(
        Effect.mapError((cause) =>
          createActionInvocationPersistenceErrorWithCause(
            {
              code: 'action_invocation_persistence_failed',
              reason: 'The test invocation identifier could not be generated',
            },
            cause,
          ),
        ),
      );
      const invocation: ActionTestInvocation = {
        actionInvocationId,
        actionKey: input.actionKey,
        completedAt: null,
        idempotencyKey: input.idempotencyKey,
        legalEntityId: input.principal.legalEntityId,
        principalId: input.principal.principalId,
        requestHash: input.requestHash,
        status: 'received',
        tenantId: input.principal.tenantId,
      };
      invocations.set(invocation.actionInvocationId, invocation);
      if (key !== undefined) {
        idempotency.set(key, invocation.actionInvocationId);
      }
      return invocation;
    });
    const commitSuccess = Effect.fn('ActionTestHarness.commitSuccess')(function* commitTestSuccess(
      input: FlushActionSuccessInput,
    ) {
      const invocation = yield* find(input.actionInvocationId);
      committed.push(input);
      invocations.set(input.actionInvocationId, {
        ...invocation,
        completedAt: completionTime(),
        status: 'succeeded',
      });
    });
    const recordRejection = <Input extends { readonly actionInvocationId: string }>(input: Input, denials: Input[]) =>
      find(input.actionInvocationId).pipe(
        Effect.flatMap((invocation) =>
          Effect.sync(() => {
            denials.push(input);
            invocations.set(input.actionInvocationId, {
              ...invocation,
              completedAt: completionTime(),
              status: 'rejected',
            });
            return Option.none<ActionRecordedRejection>();
          }),
        ),
      );
    const repository: ActionRepositoryService = {
      createOrResolveInvocation: (_executor, input) => Effect.suspend(() => prepare(input)),
      finalizePolicyDenial: (_executor, input) => recordRejection(input, policyDenials),
      flushSuccess: (_transaction, input) =>
        Effect.sync(() => {
          pendingCommit.push(commitSuccess(input));
        }),
      loadRecordedRejection: (_executor, id) =>
        Effect.sync(() => {
          const policyDenial = policyDenials.find((denial) => denial.actionInvocationId === id);
          if (policyDenial !== undefined) {
            return Option.some({ policyReasonCode: policyDenial.reasonCode, stage: 'policy' as const });
          }
          return permissionDenials.some((denial) => denial.actionInvocationId === id)
            ? Option.some({ stage: 'authz' as const })
            : Option.none();
        }),
      lockInvocation: (_transaction, id) => Effect.suspend(() => find(id)),
      rejectPermissionDenied: (_executor, input) => recordRejection(input, permissionDenials),
      resolveInvocation: (_executor, input) =>
        Effect.suspend(() => {
          const hasInvocationId = input.invocationId !== undefined;
          const invocation = hasInvocationId
            ? invocations.get(input.invocationId)
            : [...invocations.values()].find(
                (candidate) =>
                  candidate.actionKey === input.actionKey &&
                  candidate.idempotencyKey === input.idempotencyKey &&
                  candidate.legalEntityId === input.principal.legalEntityId &&
                  candidate.tenantId === input.principal.tenantId &&
                  candidate.principalId === input.principal.principalId,
              );
          return invocation?.tenantId === input.principal.tenantId &&
            invocation.legalEntityId === input.principal.legalEntityId &&
            invocation.principalId === input.principal.principalId
            ? Effect.succeed(invocation)
            : Effect.fail(
                new ActionInvocationNotFound({
                  code: 'action_invocation_not_found',
                  reason: 'The test invocation is outside this scope',
                }),
              );
        }),
      transitionInvocationToRunning: (_executor, id) =>
        find(id).pipe(
          Effect.map((invocation) => {
            if (invocation.completedAt !== null) {
              return invocation;
            }
            const running = { ...invocation, status: 'running' as const };
            invocations.set(id, running);
            return running;
          }),
        ),
    };

    const executeTestQuery = Effect.fn('ActionTestHarness.executeQuery')(function* executeTestQueryEffect<
      Query,
      Values,
    >(scope: ActionTestConnectionScope, query: Query, values?: Values) {
      const decoded = yield* Schema.decodeUnknownEffect(querySchema)(query);
      const sql = Schema.is(Schema.String)(decoded) ? decoded : decoded.text;
      // Normalize only for complete known infrastructure statements. Owner scripts still match
      // their exact original driver SQL below; this never admits a broader SELECT.
      const statement = sql.trim().replaceAll(/\s+/gu, ' ').toLowerCase();
      if (statement === 'begin') {
        transactionCount += 1;
      } else if (statement === 'commit') {
        const ownerCommit = pendingCommit.length > 0;
        yield* Effect.all(pendingCommit, { concurrency: 1, discard: true });
        pendingCommit = [];
        if (loseCommitAcknowledgement && ownerCommit) {
          loseCommitAcknowledgement = false;
          return yield* new DatabaseCommitAcknowledgementAmbiguous({
            code: testCommitAcknowledgementSqlState,
            kind: 'sqlstate',
          });
        }
      } else if (statement === 'rollback') {
        pendingCommit = [];
      } else if (statement === ESTABLISH_GATEWAY_SCOPE_SQL) {
        // Models the grant Shell registered for this assertion: the database derives the scope
        // from the redeemed assertion's principal claim, never from the request.
        const [assertion] = yield* Schema.decodeUnknownEffect(gatewayAssertionValuesSchema)(values);
        const { aud, principal } = yield* decodeGatewayAssertionClaims(assertion.split('.')[1] ?? '');
        const role = gatewayScopeGrantRoleForAudience(databaseIdentities, aud);
        if (Option.isNone(role)) {
          return yield* Effect.die('The Action test gateway audience has no enrolled database identity');
        }
        scope.tenantId = principal.tenantId;
        scope.legalEntityId = principal.legalEntityId ?? '';
        scope.role = role.value;
        return {
          rows: [{ legal_entity_id: scope.legalEntityId, tenant_id: scope.tenantId }],
        };
      } else if (statement === INSTALL_TEST_SCOPE_SQL) {
        [scope.tenantId, scope.legalEntityId] = yield* Schema.decodeUnknownEffect(scopeValuesSchema)(values);
      } else if (statement === READ_TEST_SCOPE_SQL || statement === READ_GATEWAY_SCOPE_SQL) {
        return {
          rows: [
            {
              legal_entity_id: scope.legalEntityId,
              role: scope.role,
              tenant_id: scope.tenantId,
            },
          ],
        };
      } else if (statement === 'select transaction_timestamp() as operation_at') {
        return {
          rows: [{ operation_at: completionTime() }],
        };
      } else {
        const params = yield* Schema.decodeUnknownEffect(Schema.Array(Schema.Unknown))(values ?? []);
        const fence = options.accessFences?.read({
          params,
          scope: { legalEntityId: scope.legalEntityId, tenantId: scope.tenantId },
          sql,
        });
        if (fence !== undefined && Option.isSome(fence)) {
          return { rows: yield* fence.value };
        }
        const rows = yield* executeActionTestPreparationRead({
          query: { params, scope: { legalEntityId: scope.legalEntityId, tenantId: scope.tenantId }, sql },
          scripts: options.preparationReads ?? [],
          trace: preparationQueries,
        });
        return { rows };
      }
      return { rows: [] };
    });

    const acquireConnection = Effect.suspend(() => {
      const previous = connectionQueue;
      const released = Deferred.makeUnsafe<null>();
      connectionQueue = Deferred.await(released).pipe(Effect.asVoid);
      return Effect.gen(function* acquireTestConnection() {
        yield* previous;
        yield* Effect.addFinalizer(() => Deferred.succeed(released, null));
        const scope: ActionTestConnectionScope = {
          legalEntityId: '',
          role: SHARED_RUNTIME_IDENTITY.role,
          tenantId: '',
        };
        pendingCommit = [];
        const execute = (query: string, values: readonly unknown[]) =>
          executeTestQuery(scope, query, values).pipe(Effect.map(queryRows), Effect.mapError(sqlFailure));
        return testSqlConnection(execute);
      });
    });
    const database = yield* Effect.scoped(
      Effect.gen(function* makeTestDatabase() {
        return {
          executor: yield* makeWithDefaults({ relations: coreRelations }).pipe(
            Effect.provide(scriptedPgClientLayer(acquireConnection)),
            Effect.provide(Reactivity.layer),
          ),
        };
      }),
    );
    const contextAccess: ContextAccessService = {
      legalEntities: ({ legalEntityIds, permission }) =>
        Effect.succeed(
          legalEntityIds.map((key) => ({
            decision:
              permission === undefined || permission === 'access'
                ? (options.legalEntityAccess ?? 'allowed')
                : (options.legalEntityPermission ?? 'denied'),
            key,
          })),
        ),
      modules: ({ moduleIds }) => Effect.succeed(moduleIds.map((key) => ({ decision: 'allowed' as const, key }))),
      ownerPermissions: ({ targets }) => {
        ownerPermissionTargets.push(...targets.map(({ target }) => target));
        return Effect.succeed(
          targets.map(({ target }, index) => ({
            decision: options.ownerPermissionDecisions?.[index] ?? 'unavailable',
            key: target.key,
          })),
        );
      },
      resources: ({ resources }) =>
        Effect.succeed(
          resources.map((resource) => ({
            decision: options.resourcePermission ?? 'denied',
            key: `${resource.moduleId}:${resource.resourceType}:${resource.resourceId}`,
          })),
        ),
      tenants: ({ tenantIds }) =>
        Effect.succeed(
          tenantIds.map((key) => ({
            decision: options.tenantPermission ?? 'denied',
            key,
          })),
        ),
    };
    const scopeAccess = makeTestOperationalScopeAccess({ decision: options.legalEntityAccess ?? 'allowed' });
    // Transitional: a suite that still states the legacy executor decision describes the same
    // authority a v2 carrier asks for, until the codemod renames the option to `access` (C05).
    const boundAccess = makeScriptedBoundAccessGate(options.access ?? options.actionPermission ?? 'denied');
    const scopeResolver = yield* makeOperationalScopeResolver(
      {
        load: (principal) =>
          options.scope === 'unavailable'
            ? Effect.fail(
                new OperationContextUnavailable({
                  code: 'operation_context_unavailable',
                  reason: 'Test scope unavailable',
                }),
              )
            : Effect.succeed({
                // Fixture principals carry no authenticationNamespaceId, so the persisted
                // binding must claim none either, matching how the live repository always
                // reports the column explicitly instead of leaving it unset.
                bindingAuthenticationNamespaceId: principal.authenticationNamespaceId ?? null,
                bindingPrincipalId: principal.principalId,
                bindingRevokedAt: null,
                bindingStatus: 'active',
                bindingTenantId: principal.tenantId,
                legalEntityStatus: 'active',
                legalEntityTenantId: principal.tenantId,
                principalStatus: options.scope === 'denied' ? 'inactive' : 'active',
                principalTenantId: principal.tenantId,
                tenantStatus: 'active',
              }),
      },
      scopeAccess,
    );
    const moduleStateGate: ModuleStateGateService = {
      check: checkModuleEntrypoint,
      prepareSnapshot: (tenantId, entrypoints) =>
        Effect.succeed(
          makeModuleStateSnapshot(
            tenantId,
            entrypoints,
            [
              ...new Set(
                entrypoints
                  .filter((entrypoint) => entrypoint.scope === 'tenant')
                  .map((entrypoint) => entrypoint.moduleKey),
              ),
            ].map((moduleKey) => ({
              moduleKey,
              state: options.moduleState ?? 'active',
            })),
          ),
        ),
      recheckWrite: () => Effect.void,
    };
    const bindings = new Map<object, unknown>();
    for (const binding of options.services ?? []) {
      if (isActionTestServiceBindingValue(binding)) {
        const stored = binding.resolve();
        bindings.set(stored.registration, stored.services);
      }
    }
    const resolveServiceFactory: typeof getActionServiceFactory = <
      PayloadSchema extends Schema.ConstraintDecoder<unknown>,
      ResultSchema extends Schema.ConstraintDecoder<unknown>,
      DomainErrorSchema extends Schema.ConstraintDecoder<{
        readonly _tag: string;
      }>,
      DomainEvents extends DomainEventContractMap,
      Owner extends string,
      Services,
      HandlerRequirements,
    >(
      registration: ActionRegistration<
        PayloadSchema,
        ResultSchema,
        DomainErrorSchema,
        DomainEvents,
        Owner,
        Services,
        HandlerRequirements
      >,
    ): ActionServiceFactory<Services, HandlerRequirements> => {
      if (!bindings.has(registration)) {
        return getActionServiceFactory(registration);
      }
      return () => Schema.decodeUnknownEffect(Schema.Any)(bindings.get(registration)).pipe(Effect.orDie);
    };
    const authorizationPreflight = yield* Effect.serviceOption(ActionAuthorizationPreflight);
    const mandateOptions: Pick<ActionRuntimeOptions, 'mandateDispatch'> =
      options.mandateDispatch === undefined ? {} : { mandateDispatch: options.mandateDispatch };
    let runtimeOptions: ActionRuntimeOptions = {
      accessDecision: options.accessDecision ?? boundAccess.bound,
      contextAccess,
      databaseIdentities,
      // This scripted harness rejects owner SQL and tests the Action lifecycle only.
      lockAccessExecutionFence: options.lockAccessExecutionFence ?? (() => Effect.void),
      lockCompositionAuthority: () => Effect.succeed([]),
      ...mandateOptions,
      moduleEntrypointGateway: makeModuleEntrypointGateway(moduleStateGate),
      moduleStateGate,
      onStage: (stage) => {
        stages.push(stage);
      },
      ownerAuthorizationOverlay:
        options.onOwnerAuthorization === undefined
          ? failClosedOwnerAuthorizationOverlay
          : {
              authorize: (_transaction, input) => Effect.succeed(options.onOwnerAuthorization?.(input) ?? 'denied'),
            },
      resolveServiceFactory,
      // A service fixture replaces only transaction-scoped acquisition. The original preparation
      // must first complete using the real Core context and the test's declared service requirements,
      // including once-only Policy evaluation and its ordinary denial/evidence lifecycle.
      resolveServicePreflight: (registration) => {
        const preparation = getActionServicePreflight(registration);
        if (preparation === undefined) {
          return preparation;
        }
        return (payload, context) =>
          preparation(payload, context).pipe(
            Effect.updateService(ActionTestPreparationScope, () => Option.some(context.scope)),
            Effect.map((prepared) =>
              bindings.has(registration)
                ? Object.assign(resolveServiceFactory(registration), { [originalActionPreparationFactory]: prepared })
                : prepared,
            ),
          );
      },
    };
    if (Option.isSome(authorizationPreflight)) {
      runtimeOptions = { ...runtimeOptions, authorizationPreflight: authorizationPreflight.value };
    }
    if (applicationComposition !== undefined) {
      runtimeOptions = { ...runtimeOptions, applicationComposition };
    }
    if (expectedDeployment !== undefined) {
      runtimeOptions = { ...runtimeOptions, expectedDeployment };
    }
    if (options.ownerRegistration !== undefined) {
      runtimeOptions = { ...runtimeOptions, ownerRegistration: options.ownerRegistration };
    }
    // Bound owners use the genuine runtime resolver; retain the historical synthetic R only when unbound.
    if (applicationComposition === undefined && expectedDeployment === undefined) {
      runtimeOptions = {
        ...runtimeOptions,
        resolveCompositionRevision: () => Effect.succeed(options.compositionRevision ?? 'a'.repeat(64)),
      };
    }
    const runtime = makeActionRuntime(
      database,
      repository,
      {
        checkActionPermission: () =>
          options.actionPermission === 'unavailable'
            ? Effect.fail(
                new ActionPermissionCheckError({
                  code: 'action_permission_check_failed',
                  reason: 'Test authorization unavailable',
                }),
              )
            : Effect.succeed(options.actionPermission ?? 'denied'),
      },
      scopeResolver,
      runtimeOptions,
    );
    return Object.freeze({
      layer: Layer.succeed(ActionRuntime, runtime),
      runtime,
      snapshot: (): ActionTestSnapshot =>
        Object.freeze({
          committed: Object.freeze([...committed]),
          invocations: Object.freeze([...invocations.values()].map((value) => Object.freeze({ ...value }))),
          ownerPermissionTargets: Object.freeze([...ownerPermissionTargets]),
          permissionDenials: Object.freeze([...permissionDenials]),
          policyDenials: Object.freeze([...policyDenials]),
          preparationQueries: Object.freeze([...preparationQueries]),
          stages: Object.freeze([...stages]),
          transactionCount,
        }),
    });
  },
  (harness, _options?: ActionTestHarnessOptions) => Effect.provide(harness, NodeCrypto.layer),
);

export const makeActionTestHarness: typeof actionTestHarness = actionTestHarness;

export {
  makeLiveOperationFixture,
  makeLiveOperationFixtureRuntime,
  makeLiveOperationFixtureBootstrap,
  LiveOperationFixtureRuntimeHandoffSchema,
  LiveOperationFixtureBootstrapRequestSchema,
  LiveOperationFixtureBootstrapResponseSchema,
} from './live-operations.ts';
export type { LiveOperationFixtureRuntimeHandoff, LiveOperationFixtureBootstrapRequest } from './live-operations.ts';

/** Test-owned access to the original registration, without publishing private storage in production. */
export { createActionCollector } from '../actions/collector.ts';
export { getActionHandler, getActionServiceFactory } from '../actions/definition.ts';

export {
  getActionOwnerPermissionTargetResolver,
  getActionResourcePermissionTargetResolver,
} from '../actions/definition.ts';
