import { PgClient } from '@effect/sql-pg';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import { DateTime, Deferred, Effect, Layer, Schema, Stream } from 'effect';
import { Reactivity } from 'effect/unstable/reactivity';
import type { Connection } from 'effect/unstable/sql/SqlConnection';
import { ConnectionError, SqlError } from 'effect/unstable/sql/SqlError';
import { randomUUID } from 'node:crypto';
import type {
  ActionRegistration,
  ActionServiceFactory,
  AnyActionRegistration,
} from '../actions/definition.ts';
import { getActionServiceFactory } from '../actions/definition.ts';
import {
  ActionInvocationNotFound,
  ActionInvocationPersistenceError,
  ActionPermissionCheckError,
} from '../actions/errors.ts';
import type { DomainEventContractMap } from '../actions/events.ts';
import type {
  ActionInvocationRecord,
  ActionRepositoryService,
  FinalizeActionPolicyDenialInput,
  FlushActionSuccessInput,
  PrepareActionInvocationInput,
  RejectPermissionDeniedInput,
} from '../actions/repository.ts';
import type { ActionRuntimeStage } from '../actions/runtime.ts';
import { ActionRuntime, makeActionRuntime } from '../actions/runtime.ts';
import { DatabaseCommitAcknowledgementAmbiguous } from '../database/driver-failure.ts';
import { coreRelations } from '../db/schema.ts';
import { makeModuleEntrypointGateway } from '../modules/module-entrypoint-gateway.ts';
import type { ModuleStateGateService } from '../modules/module-state-gate.ts';
import { checkModuleEntrypoint, makeModuleStateSnapshot } from '../modules/module-state-gate.ts';
import type { TenantModuleState } from '../modules/tenant-module-state-service.ts';
import { makeOperationalScopeResolver } from '../operations/context.ts';
import { OperationContextUnavailable } from '../operations/errors.ts';
import type { ContextAccessDecision, ContextAccessService } from '../permissions/context-access.ts';

const actionTestServiceBinding: unique symbol = Symbol('test-action-service-binding');
const querySchema = Schema.Union([Schema.String, Schema.Struct({ text: Schema.String })]);
const scopeValuesSchema = Schema.Tuple([Schema.String, Schema.String]);
const idempotencyScopeSchema = Schema.Tuple([
  Schema.String,
  Schema.String,
  Schema.String,
  Schema.String,
]);
const encodeIdempotencyScope = Schema.encodeEffect(Schema.fromJsonString(idempotencyScopeSchema));
const testCommitAcknowledgementSqlState = ['0', '8007'].join('');
const completionTime = () => DateTime.toDateUtc(DateTime.makeUnsafe(0));

/** Test-only service substitution; the registration's real private handler remains unchanged. */
export interface ActionTestServiceBinding {
  readonly [actionTestServiceBinding]: true;
}

interface ActionTestServiceBindingPayload {
  readonly registration: AnyActionRegistration;
  readonly services: unknown;
}

interface ActionTestConnectionScope {
  legalEntityId: string;
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
  registration: ActionRegistration<
    Payload,
    Result,
    DomainError,
    Events,
    Owner,
    Services,
    Requirements
  >,
  services: NoInfer<Services>,
): ActionTestServiceBinding =>
  Object.freeze(new ActionTestServiceBindingValue({ registration, services }));

export interface ActionTestHarnessOptions {
  readonly actionPermission?: ContextAccessDecision;
  /** Persist the first commit, then simulate a database connection losing its acknowledgement. */
  readonly commitAcknowledgement?: 'indeterminate-once';
  readonly legalEntityAccess?: ContextAccessDecision;
  readonly legalEntityPermission?: ContextAccessDecision;
  readonly moduleState?: TenantModuleState;
  readonly resourcePermission?: ContextAccessDecision;
  readonly scope?: 'active' | 'denied' | 'unavailable';
  readonly services?: readonly ActionTestServiceBinding[];
  readonly tenantPermission?: ContextAccessDecision;
}

export interface ActionTestInvocation extends ActionInvocationRecord {
  readonly actionKey: string;
  readonly idempotencyKey: string | undefined;
  readonly principalId: string;
  readonly tenantId: string;
}

export interface ActionTestSnapshot {
  readonly committed: readonly FlushActionSuccessInput[];
  readonly invocations: readonly ActionTestInvocation[];
  readonly permissionDenials: readonly RejectPermissionDeniedInput[];
  readonly policyDenials: readonly FinalizeActionPolicyDenialInput[];
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

const actionTestHarness = Effect.fn('ActionTestHarness.make')(function* actionTestHarness(
  options: ActionTestHarnessOptions = {},
) {
  const invocations = new Map<string, ActionTestInvocation>();
  const idempotency = new Map<string, string>();
  const committed: FlushActionSuccessInput[] = [];
  const permissionDenials: RejectPermissionDeniedInput[] = [];
  const policyDenials: FinalizeActionPolicyDenialInput[] = [];
  const stages: ActionRuntimeStage[] = [];
  let transactionCount = 0;
  let loseCommitAcknowledgement = options.commitAcknowledgement === 'indeterminate-once';
  let pendingCommit: Effect.Effect<void, ActionInvocationPersistenceError>[] = [];
  let connectionQueue = Effect.void;

  const find = (
    id: string,
  ): Effect.Effect<ActionTestInvocation, ActionInvocationPersistenceError> => {
    const invocation = invocations.get(id);
    return invocation === undefined
      ? Effect.fail(persistenceFailure())
      : Effect.succeed(invocation);
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
    const invocation: ActionTestInvocation = {
      actionInvocationId: randomUUID(),
      actionKey: input.actionKey,
      completedAt: null,
      idempotencyKey: input.idempotencyKey,
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
  const repository: ActionRepositoryService = {
    createOrResolveInvocation: (_executor, input) => Effect.suspend(() => prepare(input)),
    finalizePolicyDenial: (_executor, input) =>
      find(input.actionInvocationId).pipe(
        Effect.flatMap((invocation) =>
          Effect.sync(() => {
            policyDenials.push(input);
            invocations.set(input.actionInvocationId, {
              ...invocation,
              completedAt: completionTime(),
              status: 'rejected',
            });
          }),
        ),
      ),
    flushSuccess: (_transaction, input) =>
      Effect.sync(() => {
        pendingCommit.push(commitSuccess(input));
      }),
    lockInvocation: (_transaction, id) => Effect.suspend(() => find(id)),
    rejectPermissionDenied: (_executor, input) =>
      find(input.actionInvocationId).pipe(
        Effect.flatMap((invocation) =>
          Effect.sync(() => {
            permissionDenials.push(input);
            invocations.set(input.actionInvocationId, {
              ...invocation,
              completedAt: completionTime(),
              status: 'rejected',
            });
          }),
        ),
      ),
    resolveInvocation: (_executor, input) =>
      Effect.suspend(() => {
        const invocation = invocations.get(input.invocationId);
        return invocation?.tenantId === input.principal.tenantId &&
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

  const executeTestQuery = Effect.fn('ActionTestHarness.executeQuery')(
    function* executeTestQueryEffect<Query, Values>(
      scope: ActionTestConnectionScope,
      query: Query,
      values?: Values,
    ) {
      const decoded = yield* Schema.decodeUnknownEffect(querySchema)(query);
      const sql = Schema.is(Schema.String)(decoded) ? decoded : decoded.text;
      if (sql === 'begin') {
        transactionCount += 1;
      } else if (sql === 'commit') {
        yield* Effect.all(pendingCommit, { concurrency: 1, discard: true });
        pendingCommit = [];
        if (loseCommitAcknowledgement) {
          loseCommitAcknowledgement = false;
          return yield* new DatabaseCommitAcknowledgementAmbiguous({
            code: testCommitAcknowledgementSqlState,
            kind: 'sqlstate',
          });
        }
      } else if (sql === 'rollback') {
        pendingCommit = [];
      } else if (sql.includes('set_config')) {
        [scope.tenantId, scope.legalEntityId] =
          yield* Schema.decodeUnknownEffect(scopeValuesSchema)(values);
      } else if (sql.includes('current_setting')) {
        return {
          rows: [{ legal_entity_id: scope.legalEntityId, tenant_id: scope.tenantId }],
        };
      } else {
        return yield* Effect.die(
          'Owner SQL is unavailable in the Action test harness; bind typed services',
        );
      }
      return { rows: [] };
    },
  );

  const acquireConnection = Effect.suspend(() => {
    const previous = connectionQueue;
    const released = Deferred.makeUnsafe<null>();
    connectionQueue = Deferred.await(released).pipe(Effect.asVoid);
    return Effect.gen(function* acquireTestConnection() {
      yield* previous;
      yield* Effect.addFinalizer(() => Deferred.succeed(released, null));
      const scope: ActionTestConnectionScope = { legalEntityId: '', tenantId: '' };
      pendingCommit = [];
      const execute = (query: string, values: readonly unknown[]) =>
        executeTestQuery(scope, query.toLowerCase(), values).pipe(
          Effect.map(queryRows),
          Effect.mapError(sqlFailure),
        );
      const unsupported = Effect.die('Owner SQL is unavailable in the Action test harness');
      return {
        execute,
        executeRaw: execute,
        executeStream: () => Stream.fromEffect(unsupported),
        executeUnprepared: execute,
        executeValues: () => unsupported,
        executeValuesUnprepared: () => unsupported,
      } satisfies Connection;
    });
  });
  const database = yield* Effect.scoped(
    Effect.gen(function* makeTestDatabase() {
      const reactivity = yield* Reactivity.make;
      const client = yield* PgClient.makeWith({
        acquirer: acquireConnection,
        config: {},
        listenAcquirer: Effect.die('Notifications are unavailable in the Action test harness'),
        transactionAcquirer: acquireConnection,
      }).pipe(Effect.provideService(Reactivity.Reactivity, reactivity), Effect.orDie);
      return {
        executor: yield* makeWithDefaults({ relations: coreRelations }).pipe(
          Effect.provideService(PgClient.PgClient, client),
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
    modules: ({ moduleIds }) =>
      Effect.succeed(moduleIds.map((key) => ({ decision: 'allowed' as const, key }))),
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
  const scopeResolver = makeOperationalScopeResolver(
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
    contextAccess,
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
          ].map((moduleKey) => ({ moduleKey, state: options.moduleState ?? 'active' })),
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
    DomainErrorSchema extends Schema.ConstraintDecoder<{ readonly _tag: string }>,
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
    return () =>
      Schema.decodeUnknownEffect(Schema.Any)(bindings.get(registration)).pipe(Effect.orDie);
  };
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
    {
      contextAccess,
      moduleEntrypointGateway: makeModuleEntrypointGateway(moduleStateGate),
      moduleStateGate,
      onStage: (stage) => {
        stages.push(stage);
      },
      resolveServiceFactory,
    },
  );
  return Object.freeze({
    layer: Layer.succeed(ActionRuntime, runtime),
    runtime,
    snapshot: (): ActionTestSnapshot =>
      Object.freeze({
        committed: Object.freeze([...committed]),
        invocations: Object.freeze(
          [...invocations.values()].map((value) => Object.freeze({ ...value })),
        ),
        permissionDenials: Object.freeze([...permissionDenials]),
        policyDenials: Object.freeze([...policyDenials]),
        stages: Object.freeze([...stages]),
        transactionCount,
      }),
  });
});

export const makeActionTestHarness: typeof actionTestHarness = actionTestHarness;

export { makeLiveOperationFixture } from './live-operations.ts';
