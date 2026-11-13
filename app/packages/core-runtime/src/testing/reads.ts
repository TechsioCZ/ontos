import { AccessDecisionGate } from '../access/enforcement/contract.ts';
import { PgClient } from '@effect/sql-pg';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import { Context, Deferred, Effect, Layer, Option, Schema, Stream } from 'effect';
import { Reactivity } from 'effect/reactivity';
import type { Connection } from 'effect/sql/SqlConnection';
import type { SqlError } from 'effect/sql/SqlError';

import { readVerifiedGatewayScopeAssertion } from '../auth/system-principal-context-provenance.ts';
import {
  DatabaseIdentityEnrollmentContext,
  defineDatabaseIdentityEnrollment,
  gatewayScopeGrantRoleForAudience,
  SHARED_RUNTIME_IDENTITY,
} from '../db/database-identities.ts';
import { CoreDatabase } from '../db/client.ts';
import type { DatabaseIdentityEnrollment } from '../db/database-identities.ts';
import { coreRelations } from '../db/schema.ts';
import { makeModuleEntrypointGateway } from '../modules/module-entrypoint-gateway.ts';
import { checkModuleEntrypoint, makeModuleStateSnapshot } from '../modules/module-state-gate.ts';
import { makeOperationalScopeResolver, OperationalScopeResolver } from '../operations/context.ts';
import { makeScriptedBoundAccessGate, makeTestOperationalScopeAccess } from './access-gate.ts';
import type { TestAccessOutcome } from './access-gate.ts';
import type { OperationalScope } from '../operations/context.ts';
import { ContextAccess } from '../permissions/context-access.ts';
import type { TenantPermissionKey, LegalEntityPermissionKey } from '../permissions/context-permissions.ts';
import type { VerticalRuntimeRegistration } from '../modules/runtime-registration.ts';
import type { OwnerAuthorizationDecision, OwnerAuthorizationInput } from '../access/enforcement/owner-overlay.ts';
import type {
  OwnerPermissionAccessTarget,
  ContextAccessDecision,
  ContextAccessService,
} from '../permissions/context-access.ts';
import { ReadRuntime, makeReadRuntime } from '../reads/runtime.ts';
import type { ReadRuntimeOptions, ReadRuntimeStage } from '../reads/runtime.ts';
import { scriptedPgClientLayer } from './scripted-pg-client.ts';
import { guardPoolAcquisition } from '../db/transaction-io-guard.ts';

export interface ReadTestOwnerQuery {
  readonly params: readonly unknown[];
  readonly scope: Readonly<{ legalEntityId: string; tenantId: string }>;
  readonly sql: string;
}

export interface ReadTestHarnessOptions extends Pick<
  ReadRuntimeOptions,
  'accessDecision' | 'applicationComposition' | 'expectedDeployment' | 'shellSystemReads'
> {
  /** The access gate's scripted answer for every protected Read (a v2 carrier decides here). */
  readonly access?: TestAccessOutcome | Readonly<Record<string, TestAccessOutcome>>;
  readonly compositionRevision?: string;
  readonly databaseIdentities?: DatabaseIdentityEnrollment;
  /** Explicit driver rows for owner SQL; unexpected statements must fail rather than supply empty. */
  readonly executeOwnerQuery: (query: ReadTestOwnerQuery) => Effect.Effect<readonly object[], SqlError>;
  readonly legalEntityPermissionDecisions?: Readonly<Partial<Record<LegalEntityPermissionKey, ContextAccessDecision>>>;
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
  readonly tenantPermissionDecisions?: Readonly<Partial<Record<TenantPermissionKey, ContextAccessDecision>>>;
}

const scopeValuesSchema = Schema.Tuple([Schema.String, Schema.String]);

const SESSION_INSTALL_AND_READ_SCOPE_SQL =
  "select current_user::text as role, set_config('ontos.tenant_id', $1, true) as tenant_id, set_config('ontos.legal_entity_id', $2, true) as legal_entity_id";
const SESSION_INSTALL_SCOPE_SQL =
  "select set_config('ontos.tenant_id', $1, true), set_config('ontos.legal_entity_id', $2, true)";
const SESSION_READ_SCOPE_SQL =
  "select current_user::text as role, current_setting('ontos.tenant_id', true) as tenant_id, current_setting('ontos.legal_entity_id', true) as legal_entity_id";

/**
 * A session-setting role's scope statements, each matched by its exact text: installing records the scope from its
 * parameters, and the one-statement install and the read-back answer the connected role with it. None for any other
 * statement.
 */
const sessionScopeRows = Effect.fn('ReadTestHarness.sessionScopeRows')(function* sessionScopeRows(
  text: string,
  params: readonly unknown[],
  scope: { legalEntityId: string; tenantId: string },
  role: string,
) {
  if (text === SESSION_INSTALL_AND_READ_SCOPE_SQL || text === SESSION_INSTALL_SCOPE_SQL) {
    [scope.tenantId, scope.legalEntityId] = yield* Schema.decodeUnknownEffect(scopeValuesSchema)(params).pipe(
      Effect.orDie,
    );
  }
  if (text === SESSION_INSTALL_SCOPE_SQL) {
    return Option.some<readonly object[]>([]);
  }
  return text === SESSION_INSTALL_AND_READ_SCOPE_SQL || text === SESSION_READ_SCOPE_SQL
    ? Option.some<readonly object[]>([{ legal_entity_id: scope.legalEntityId, role, tenant_id: scope.tenantId }])
    : Option.none<readonly object[]>();
});
const readCommittedIsolation = 'read committed';
const fencedScopeValuesSchema = Schema.Tuple([Schema.String, Schema.String, Schema.Literal(readCommittedIsolation)]);
const installReadScopeSql =
  "select current_user::text as role, set_config('ontos.tenant_id', $1, true) as tenant_id, set_config('ontos.legal_entity_id', $2, true) as legal_entity_id, transaction_timestamp() as operation_at";
const installFencedReadScopeSql = `${installReadScopeSql}, current_setting('transaction_isolation') as isolation, case when current_setting('transaction_isolation') = $3 then pg_advisory_xact_lock_shared(hashtextextended('ontos.application-composition-authority', 0)) end as publication_lock`;
const readFenceValuesSchema = Schema.Tuple([Schema.Literal(readCommittedIsolation)]);

const guardedPublicationLockSql =
  "select current_setting('transaction_isolation') as isolation, case when current_setting('transaction_isolation') = $1 then pg_advisory_xact_lock_shared(hashtextextended('ontos.application-composition-authority', 0)) end as publication_lock";

/** Composition-authority isolation and shared publication lock statements, including the guarded combined form. */
const compositionPublicationLockRows = (
  text: string,
  params: readonly unknown[],
): Option.Option<Effect.Effect<readonly object[]>> => {
  if (text === "select current_setting('transaction_isolation') as isolation") {
    return Option.some(Effect.succeed([{ isolation: readCommittedIsolation }]));
  }
  if (text === "select pg_advisory_xact_lock_shared(hashtextextended('ontos.application-composition-authority', 0))") {
    return Option.some(Effect.succeed([]));
  }
  // The guarded shared publication lock taken before a Read's admitted evidence write (for example, a denial).
  return text === guardedPublicationLockSql
    ? Option.some(
        Schema.decodeUnknownEffect(readFenceValuesSchema)(params).pipe(
          Effect.orDie,
          Effect.as([{ isolation: readCommittedIsolation, publication_lock: null }]),
        ),
      )
    : Option.none();
};

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
  const databaseIdentities = options.databaseIdentities ?? defineDatabaseIdentityEnrollment([]);
  const stages: ReadRuntimeStage[] = [];
  const statements: string[] = [];
  const ownerQueries: ReadTestOwnerQuery[] = [];
  let evidenceWrites = 0;
  let connectionQueue = Effect.void;
  const acquireConnection = Effect.gen(function* acquireReadTestConnection() {
    const previous = connectionQueue;
    const released = Deferred.makeUnsafe<null>();
    connectionQueue = Deferred.await(released).pipe(Effect.asVoid);
    yield* previous;
    yield* Effect.addFinalizer(() => Deferred.succeed(released, null));
    const scope = { legalEntityId: '', tenantId: '' };
    // The connected role: the shared runtime until a gateway scope is established.
    const connection = { role: SHARED_RUNTIME_IDENTITY.role };
    const installedReadScopeRows = (fencedScope: boolean) => {
      const installed = {
        legal_entity_id: scope.legalEntityId,
        operation_at: options.operationTime,
        role: connection.role,
        tenant_id: scope.tenantId,
      };
      return [fencedScope ? { ...installed, isolation: readCommittedIsolation } : installed];
    };
    const execute = Effect.fn('ReadTestHarness.executeQuery')(function* executeReadTestQuery(
      sql: string,
      params: readonly unknown[],
    ): Effect.fn.Return<readonly object[], SqlError> {
      statements.push(sql);
      const text = sql.trim().replaceAll(/\s+/gu, ' ').toLowerCase();
      if (/^(?:begin|commit|rollback|savepoint|release savepoint)(?:\s|$)/u.test(text)) {
        return [];
      }
      const publicationLock = compositionPublicationLockRows(text, params);
      if (Option.isSome(publicationLock)) {
        return yield* publicationLock.value;
      }
      // Read and write admissions (the unlocked precheck and the locked fence) select only the fence columns;
      // matching also reads the approved subscriptions.
      if (
        text ===
        'select "phase", "revision", null, "valid_until" > clock_timestamp() from "core"."application_composition_authority" where "core"."application_composition_authority"."authority_key" = $1'
      ) {
        return [{ phase: 'active', revision: options.compositionRevision, subscriptionsJson: null, unexpired: true }];
      }
      if (
        text ===
        'select "phase", "revision", "subscriptions_json", "valid_until" > clock_timestamp() from "core"."application_composition_authority" where "core"."application_composition_authority"."authority_key" = $1'
      ) {
        return [{ phase: 'active', revision: options.compositionRevision, subscriptionsJson: [], unexpired: true }];
      }
      const sessionScope = yield* sessionScopeRows(text, params, scope, connection.role);
      if (Option.isSome(sessionScope)) {
        return sessionScope.value;
      }
      if (
        text ===
        "select established_tenant_id::text as tenant_id, coalesce(established_legal_entity_id::text, '') as legal_entity_id from trust.establish_gateway_scope($1)"
      ) {
        // Models a gateway grant that Shell registered for the harness scope.
        const assertion = readVerifiedGatewayScopeAssertion(options.scope);
        const role =
          assertion === undefined
            ? Option.none<string>()
            : gatewayScopeGrantRoleForAudience(databaseIdentities, assertion.audience);
        if (Option.isNone(role)) {
          return yield* Effect.die('The Read test gateway audience has no enrolled database identity');
        }
        scope.tenantId = options.scope.tenantId;
        scope.legalEntityId = options.scope.legalEntityId ?? '';
        connection.role = role.value;
        return [{ legal_entity_id: scope.legalEntityId, tenant_id: scope.tenantId }];
      }
      if (
        text ===
        "select current_user::text as role, coalesce(trust.current_tenant_id()::text, '') as tenant_id, coalesce(trust.current_legal_entity_id()::text, '') as legal_entity_id"
      ) {
        return [{ legal_entity_id: scope.legalEntityId, role: connection.role, tenant_id: scope.tenantId }];
      }
      // A gateway grant verified in the same statement as its transaction time (installOperationalScopeAt).
      if (
        text ===
        "select current_user::text as role, coalesce(trust.current_tenant_id()::text, '') as tenant_id, coalesce(trust.current_legal_entity_id()::text, '') as legal_entity_id, transaction_timestamp() as operation_at"
      ) {
        return installedReadScopeRows(false);
      }
      if (
        text ===
        "select set_config('ontos.tenant_id', $1, true) as tenant_id, set_config('ontos.legal_entity_id', $2, true) as legal_entity_id, transaction_timestamp() as operation_at"
      ) {
        [scope.tenantId, scope.legalEntityId] = yield* Schema.decodeUnknownEffect(scopeValuesSchema)(params).pipe(
          Effect.orDie,
        );
        return [
          { legal_entity_id: scope.legalEntityId, operation_at: options.operationTime, tenant_id: scope.tenantId },
        ];
      }
      // Owner factories return the connected role with the installed session so the runtime can
      // distinguish the dedicated owner login from the legacy shared runtime.
      // Match the complete infrastructure statement, never owner SQL that merely uses transaction time.
      const fencedScope = text === installFencedReadScopeSql;
      if (text === installReadScopeSql || fencedScope) {
        [scope.tenantId, scope.legalEntityId] = yield* fencedScope
          ? Schema.decodeUnknownEffect(fencedScopeValuesSchema)(params).pipe(Effect.orDie)
          : Schema.decodeUnknownEffect(scopeValuesSchema)(params).pipe(Effect.orDie);
        return installedReadScopeRows(fencedScope);
      }
      // The lock statement installs/verifies scope but cannot serve the authority read: admission
      // must use a separate post-lock snapshot. Match both exact native scope-authority protocols.
      if (
        text ===
        "select current_user::text as role, coalesce(trust.current_tenant_id()::text, '') as tenant_id, coalesce(trust.current_legal_entity_id()::text, '') as legal_entity_id, transaction_timestamp() as operation_at, current_setting('transaction_isolation') as isolation, case when current_setting('transaction_isolation') = $1 then pg_advisory_xact_lock_shared(hashtextextended('ontos.application-composition-authority', 0)) end as publication_lock"
      ) {
        yield* Schema.decodeUnknownEffect(readFenceValuesSchema)(params).pipe(Effect.orDie);
        return installedReadScopeRows(true);
      }
      if (text === 'select transaction_timestamp() as operation_at') {
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
    Effect.provideService(PgClient.PgClient, guardPoolAcquisition(Context.get(clientContext, PgClient.PgClient))),
  );
  /**
   * The scope admission answer (O28). It is the harness's own question, answered by the V2 SCRIPT, never
   * by the legacy context-access answer: a bag that scripts the gate through `access` is admitted into
   * its scope, and `scopeAccess` is the explicit override for a test that is about a refused scope. The
   * legacy `permissionDecision` is consulted only for a bag that has not migrated yet (no `access`), so
   * the codemod's removal of that key can never turn a scope red; it disappears entirely in C03b step 3.
   */
  const decision: ContextAccessDecision =
    options.scopeAccess ??
    (options.access === undefined && options.accessDecision === undefined
      ? (options.permissionDecision ?? 'denied')
      : 'allowed');
  const contextAccess: ContextAccessService = {
    legalEntities: ({ legalEntityIds, permission = 'access' }) =>
      Effect.succeed(
        legalEntityIds.map((key) => ({
          decision: options.legalEntityPermissionDecisions?.[permission] ?? decision,
          key,
        })),
      ),
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
    tenants: ({ permission, tenantIds }) =>
      Effect.succeed(
        tenantIds.map((key) => ({
          decision: options.tenantPermissionDecisions?.[permission] ?? decision,
          key,
        })),
      ),
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
  // The same scripted gate answers the runtime and any owner code that asks the gate itself (O62).
  const scriptedGate = makeScriptedBoundAccessGate(options.access ?? options.permissionDecision ?? 'denied');
  let runtimeOptions: ReadRuntimeOptions = {
    accessDecision: options.accessDecision ?? scriptedGate.bound,
    databaseIdentities,
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
  if (options.shellSystemReads !== undefined) {
    runtimeOptions = { ...runtimeOptions, shellSystemReads: options.shellSystemReads };
  }
  const database = { executor };
  const runtime = makeReadRuntime(
    database,
    gateway,
    scopeResolver,
    contextAccess,
    options.ownerRegistration === undefined
      ? runtimeOptions
      : { ...runtimeOptions, ownerRegistration: options.ownerRegistration },
  );
  return {
    layer: Layer.mergeAll(
      Layer.succeed(ReadRuntime, runtime),
      Layer.succeed(ContextAccess, contextAccess),
      // A default only: a gate the test supplies around this layer wins, so a test's own gate is never shadowed.
      Layer.effect(
        AccessDecisionGate,
        Effect.serviceOption(AccessDecisionGate).pipe(Effect.map(Option.getOrElse(() => scriptedGate.accessDecision))),
      ),
    ),
    ownerServices: Layer.mergeAll(
      Layer.succeed(CoreDatabase, database),
      Layer.succeed(DatabaseIdentityEnrollmentContext, databaseIdentities),
      Layer.succeed(OperationalScopeResolver, scopeResolver),
      Layer.succeed(ContextAccess, contextAccess),
    ),
    runtime,
    snapshot: () => ({
      evidenceWrites,
      ownerQueries: [...ownerQueries],
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
