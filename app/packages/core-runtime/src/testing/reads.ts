import { PgClient } from '@effect/sql-pg';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import { Context, Deferred, Effect, Layer, Schema, Stream } from 'effect';
import { Reactivity } from 'effect/reactivity';
import type { Connection } from 'effect/sql/SqlConnection';
import type { SqlError } from 'effect/sql/SqlError';

import { PARTY_REGISTRY_REQUEST_IDENTITY, SHARED_RUNTIME_IDENTITY } from '../db/database-identity-manifest.ts';
import { coreRelations } from '../db/schema.ts';
import { makeModuleEntrypointGateway } from '../modules/module-entrypoint-gateway.ts';
import { checkModuleEntrypoint, makeModuleStateSnapshot } from '../modules/module-state-gate.ts';
import { makeOperationalScopeResolver } from '../operations/context.ts';
import { makeScriptedBoundAccessGate, makeTestOperationalScopeAccess } from './access-gate.ts';
import type { TestAccessOutcome } from './access-gate.ts';
import type { OperationalScope } from '../operations/context.ts';
import type { VerticalRuntimeRegistration } from '../modules/runtime-registration.ts';
import { ContextAccess } from '../permissions/context-access.ts';
import type { OwnerAuthorizationDecision, OwnerAuthorizationInput } from '../access/enforcement/owner-overlay.ts';
import type {
  OwnerPermissionAccessTarget,
  ContextAccessDecision,
  ContextAccessService,
} from '../permissions/context-access.ts';
import type { CallRoute, CallRouteRequest } from '../execution/contract.ts';
import type { CoreTransaction } from '../db/types.ts';
import type { BoundAccessGate } from '../operations/access-gate.ts';
import { ReadRuntime, makeReadRuntime } from '../reads/runtime.ts';
import type { ReadRuntimeOptions, ReadRuntimeStage } from '../reads/runtime.ts';
import { scriptedPgClientLayer } from './scripted-pg-client.ts';

export interface ReadTestOwnerQuery {
  readonly params: readonly unknown[];
  readonly scope: Readonly<{ legalEntityId: string; tenantId: string }>;
  readonly sql: string;
}

export interface ReadTestHarnessOptions {
  /** The access gate's scripted answer for every protected Read (a v2 carrier decides here). */
  readonly access?: TestAccessOutcome | Readonly<Record<string, TestAccessOutcome>>;
  readonly applicationComposition?: ReadRuntimeOptions['applicationComposition'];
  readonly compositionRevision?: string;
  /** Explicit driver rows for owner SQL; unexpected statements must fail rather than supply empty. */
  readonly executeOwnerQuery: (query: ReadTestOwnerQuery) => Effect.Effect<readonly object[], SqlError>;
  readonly expectedDeployment?: ReadRuntimeOptions['expectedDeployment'];
  /**
   * A stub of the governed HTTP route to verticals (`ModuleCallRoute`) for `{ run }` reads that call
   * another module. The harness records every request it receives in `snapshot().routedCalls`.
   */
  readonly moduleCallRoute?: CallRoute;
  /** Observes the owner overlay input the runtime builds inside the transaction and answers it (O70). */
  readonly onOwnerAuthorization?: (input: OwnerAuthorizationInput) => OwnerAuthorizationDecision;
  readonly operationTime: Date;
  readonly ownerAuthorizationDecision?: ContextAccessDecision;
  readonly ownerPermissionDecision?: (target: OwnerPermissionAccessTarget) => ContextAccessDecision;
  readonly ownerRegistration?: VerticalRuntimeRegistration;
  /**
   * The legacy context-access answer (scope admission and the legacy permission targets). A v2 read
   * decides through `access`, so a harness that scripts a gate answer is admitted into its scope by
   * default; override this only to exercise a refused scope.
   */
  readonly permissionDecision?: ContextAccessDecision;
  readonly scope: OperationalScope;
  /** The scope admission answer on its own, for a test that scripts a gate answer *and* a refused scope. */
  readonly scopeAccess?: ContextAccessDecision;
}

const scopeValuesSchema = Schema.Tuple([Schema.String, Schema.String]);

/**
 * Scripted SQL transport for the real Core Read lifecycle and the registration's original owner
 * factory/handler. No service substitution. Drizzle mapping, scope installation (session settings or a
 * gateway grant registered for `options.scope`), composition
 * admission and evidence writes execute normally; this does not prove native PostgreSQL or RLS.
 * The caller owns its Effect scope. Permissions and owner authorization default to denied.
 */
export const makeReadTestHarness = Effect.fn('ReadTestHarness.make')(function* makeReadTestHarness(
  options: ReadTestHarnessOptions,
) {
  const stages: ReadRuntimeStage[] = [];
  const statements: string[] = [];
  const ownerQueries: ReadTestOwnerQuery[] = [];
  const routedCalls: CallRouteRequest[] = [];
  /** Whether each access gate question was asked inside a transaction the runtime already held. */
  const gateTransactions: ('none' | 'owned')[] = [];
  let evidenceWrites = 0;
  let connectionsOpened = 0;
  let openConnections = 0;
  let connectionQueue = Effect.void;
  const acquireConnection = Effect.gen(function* acquireReadTestConnection() {
    const previous = connectionQueue;
    const released = Deferred.makeUnsafe<null>();
    connectionQueue = Deferred.await(released).pipe(Effect.asVoid);
    yield* previous;
    connectionsOpened += 1;
    openConnections += 1;
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        openConnections -= 1;
      }).pipe(Effect.andThen(Deferred.succeed(released, null))),
    );
    const scope = { legalEntityId: '', tenantId: '' };
    // The connected role: the shared runtime until a gateway scope is established.
    const connection = { role: SHARED_RUNTIME_IDENTITY.role };
    const execute = Effect.fn('ReadTestHarness.executeQuery')(function* executeReadTestQuery(
      sql: string,
      params: readonly unknown[],
    ): Effect.fn.Return<readonly object[], SqlError> {
      statements.push(sql);
      const text = sql.trim().replaceAll(/\s+/gu, ' ').toLowerCase();
      if (
        /^(?:begin|commit|rollback|savepoint|release savepoint|start transaction|set transaction)(?:\s|$)/u.test(text)
      ) {
        return [];
      }
      if (text === 'select current_user::text as role') {
        return [{ role: connection.role }];
      }
      if (text === "select current_setting('transaction_isolation') as isolation") {
        return [{ isolation: 'read committed' }];
      }
      if (
        text === "select pg_advisory_xact_lock_shared(hashtextextended('ontos.application-composition-authority', 0))"
      ) {
        return [];
      }
      if (
        text ===
        'select "phase", "revision", "subscriptions_json", "valid_until" > clock_timestamp() from "core"."application_composition_authority" where "core"."application_composition_authority"."authority_key" = $1'
      ) {
        return [{ phase: 'active', revision: options.compositionRevision, subscriptionsJson: [], unexpired: true }];
      }
      if (text === "select set_config('ontos.tenant_id', $1, true), set_config('ontos.legal_entity_id', $2, true)") {
        [scope.tenantId, scope.legalEntityId] = yield* Schema.decodeUnknownEffect(scopeValuesSchema)(params).pipe(
          Effect.orDie,
        );
        return [];
      }
      if (
        text ===
        "select current_user::text as role, current_setting('ontos.tenant_id', true) as tenant_id, current_setting('ontos.legal_entity_id', true) as legal_entity_id"
      ) {
        return [{ legal_entity_id: scope.legalEntityId, role: connection.role, tenant_id: scope.tenantId }];
      }
      if (
        text ===
        "select established_tenant_id::text as tenant_id, coalesce(established_legal_entity_id::text, '') as legal_entity_id from trust.establish_gateway_scope($1)"
      ) {
        // Models a gateway grant that Shell registered for the harness scope.
        scope.tenantId = options.scope.tenantId;
        scope.legalEntityId = options.scope.legalEntityId ?? '';
        connection.role = PARTY_REGISTRY_REQUEST_IDENTITY.role;
        return [{ legal_entity_id: scope.legalEntityId, tenant_id: scope.tenantId }];
      }
      if (
        text ===
        "select current_user::text as role, coalesce(trust.current_tenant_id()::text, '') as tenant_id, coalesce(trust.current_legal_entity_id()::text, '') as legal_entity_id"
      ) {
        return [{ legal_entity_id: scope.legalEntityId, role: connection.role, tenant_id: scope.tenantId }];
      }
      if (
        text === 'select transaction_timestamp() as operation_at' ||
        text === 'select statement_timestamp() as operation_at'
      ) {
        return [{ operation_at: options.operationTime }];
      }
      if (text.startsWith('insert into "core"."data_access_events"')) {
        evidenceWrites += 1;
        return [];
      }
      const query = Object.freeze({ params: [...params], scope: Object.freeze({ ...scope }), sql });
      ownerQueries.push(query);
      return yield* options.executeOwnerQuery(query);
    });
    const values = (sql: string, params: readonly unknown[]) =>
      execute(sql, params).pipe(Effect.map((rows) => rows.map(Object.values)));
    return {
      execute,
      executeRaw: execute,
      executeStream: (sql, params) => Stream.fromIterableEffect(execute(sql, params)),
      executeUnprepared: execute,
      executeValues: values,
      executeValuesUnprepared: values,
    } satisfies Connection;
  });
  const clientContext = yield* Layer.build(
    scriptedPgClientLayer(acquireConnection).pipe(Layer.provide(Reactivity.layer)),
  );
  const executor = yield* makeWithDefaults({ relations: coreRelations }).pipe(
    Effect.provideService(PgClient.PgClient, Context.get(clientContext, PgClient.PgClient)),
  );
  /**
   * The scope admission answer (O28). It is the harness's own question, answered by the V2 SCRIPT, never
   * by the legacy context-access answer: a bag that scripts the gate through `access` is admitted into
   * its scope, and `scopeAccess` is the explicit override for a test that is about a refused scope. The
   * legacy `permissionDecision` is consulted only for a bag that has not migrated yet (no `access`), so
   * the codemod's removal of that key can never turn a scope red; it disappears entirely in C03b step 3.
   */
  const decision: ContextAccessDecision =
    options.scopeAccess ?? (options.access === undefined ? (options.permissionDecision ?? 'denied') : 'allowed');
  const contextAccess: ContextAccessService = {
    legalEntities: ({ legalEntityIds }) => Effect.succeed(legalEntityIds.map((key) => ({ decision, key }))),
    modules: ({ moduleIds }) => Effect.succeed(moduleIds.map((key) => ({ decision, key }))),
    ownerPermissions: ({ targets }) =>
      Effect.succeed(
        targets.map(({ target }) => ({
          decision: options.ownerPermissionDecision?.(target) ?? decision,
          key: target.key,
        })),
      ),
    resources: ({ resources }) =>
      Effect.succeed(
        resources.map((resource) => ({
          decision,
          key: `${resource.moduleId}:${resource.resourceType}:${resource.resourceId}`,
        })),
      ),
    tenants: ({ tenantIds }) => Effect.succeed(tenantIds.map((key) => ({ decision, key }))),
  };
  const scopeResolver = yield* makeOperationalScopeResolver(
    {
      load: () =>
        Effect.succeed({
          bindingAuthenticationNamespaceId: options.scope.authenticationNamespaceId ?? null,
          bindingPrincipalId: options.scope.principalId,
          bindingRevokedAt: null,
          bindingStatus: 'active',
          bindingTenantId: options.scope.tenantId,
          legalEntityStatus: 'active',
          legalEntityTenantId: options.scope.tenantId,
          principalStatus: 'active',
          principalTenantId: options.scope.tenantId,
          tenantStatus: 'active',
        }),
    },
    makeTestOperationalScopeAccess({ decision }),
  );
  const gateway = makeModuleEntrypointGateway({
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
          ].map((moduleKey) => ({ moduleKey, state: 'active' })),
        ),
      ),
    recheckWrite: () => Effect.void,
  });
  const scriptedGate = makeScriptedBoundAccessGate(options.access ?? options.permissionDecision ?? 'denied').bound;
  const observe = (transaction: CoreTransaction | undefined) => {
    gateTransactions.push(transaction === undefined ? 'none' : 'owned');
  };
  const observedGate: BoundAccessGate = {
    ...scriptedGate,
    decide: (input, transaction) =>
      Effect.sync(() => observe(transaction)).pipe(Effect.andThen(scriptedGate.decide(input, transaction))),
    list: (input, transaction) =>
      Effect.sync(() => observe(transaction)).pipe(Effect.andThen(scriptedGate.list(input, transaction))),
  };
  const { decideMany } = scriptedGate;
  const accessDecision: BoundAccessGate =
    decideMany === undefined
      ? observedGate
      : {
          ...observedGate,
          decideMany: (inputs, transaction) =>
            Effect.sync(() => observe(transaction)).pipe(Effect.andThen(decideMany(inputs, transaction))),
        };
  let runtimeOptions: ReadRuntimeOptions = {
    accessDecision,
    onStage: (stage) => {
      stages.push(stage);
    },
    ownerAuthorizationOverlay: {
      authorize: (_transaction, input) =>
        Effect.succeed(options.onOwnerAuthorization?.(input) ?? options.ownerAuthorizationDecision ?? 'denied'),
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
  const stubRoute = options.moduleCallRoute;
  if (stubRoute !== undefined) {
    runtimeOptions = {
      ...runtimeOptions,
      moduleCallRoute: {
        send: (request) =>
          Effect.sync(() => {
            routedCalls.push(request);
          }).pipe(Effect.andThen(stubRoute.send(request))),
      },
    };
  }
  const runtime = makeReadRuntime({ executor }, gateway, scopeResolver, contextAccess, runtimeOptions);
  return {
    layer: Layer.mergeAll(Layer.succeed(ReadRuntime, runtime), Layer.succeed(ContextAccess, contextAccess)),
    /** Scripted database connections open right now: zero while no transaction is held. */
    openConnections: () => openConnections,
    runtime,
    snapshot: () => ({
      connectionsOpened,
      evidenceWrites,
      gateTransactions: [...gateTransactions],
      ownerQueries: [...ownerQueries],
      routedCalls: [...routedCalls],
      stages: [...stages],
      statements: [...statements],
    }),
  };
});

/** Test-owned access to the original registration factory. */
export { getReadServiceFactory } from '../reads/definition.ts';

export {
  getReadPermissionTargetResolver,
  getReadResourcePermissionTargetResolver,
  getReadResultPermissionTargetResolver,
  getReadConditionalPermissionPlan,
  getReadHandler,
} from '../reads/definition.ts';
