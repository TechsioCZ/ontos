import { PgClient } from '@effect/sql-pg';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import { Context, Deferred, Effect, Layer, Option, Schema, Stream } from 'effect';
import { Reactivity } from 'effect/reactivity';
import type { Connection } from 'effect/sql/SqlConnection';
import type { SqlError } from 'effect/sql/SqlError';

import { readVerifiedGatewayScopeAssertion } from '../auth/system-principal-context-provenance.ts';
import {
  defineDatabaseIdentityEnrollment,
  gatewayScopeGrantRoleForAudience,
  SHARED_RUNTIME_IDENTITY,
} from '../db/database-identities.ts';
import type { DatabaseIdentityEnrollment } from '../db/database-identities.ts';
import { coreRelations } from '../db/schema.ts';
import { makeModuleEntrypointGateway } from '../modules/module-entrypoint-gateway.ts';
import { checkModuleEntrypoint, makeModuleStateSnapshot } from '../modules/module-state-gate.ts';
import { makeOperationalScopeResolver } from '../operations/context.ts';
import type { OperationalScope } from '../operations/context.ts';
import { ContextAccess, toBusinessPermissionAccessKey } from '../permissions/context-access.ts';
import type {
  BusinessPermissionAccessTarget,
  ContextAccessDecision,
  ContextAccessService,
} from '../permissions/context-access.ts';
import { transactionalOwnerAuthorization } from '../permissions/owner-authorization-overlay.ts';
import { ReadRuntime, makeReadRuntime } from '../reads/runtime.ts';
import type { ReadRuntimeStage } from '../reads/runtime.ts';
import { scriptedPgClientLayer } from './scripted-pg-client.ts';
import { guardPoolAcquisition } from '../db/transaction-io-guard.ts';

export interface ReadTestOwnerQuery {
  readonly params: readonly unknown[];
  readonly scope: Readonly<{ legalEntityId: string; tenantId: string }>;
  readonly sql: string;
}

export interface ReadTestHarnessOptions {
  readonly businessPermissionDecision?: (target: BusinessPermissionAccessTarget) => ContextAccessDecision;
  readonly compositionRevision?: string;
  readonly databaseIdentities?: DatabaseIdentityEnrollment;
  /** Explicit driver rows for owner SQL; unexpected statements must fail rather than supply empty. */
  readonly executeOwnerQuery: (query: ReadTestOwnerQuery) => Effect.Effect<readonly object[], SqlError>;
  readonly operationTime: Date;
  readonly ownerAuthorizationDecision?: ContextAccessDecision;
  readonly permissionDecision?: ContextAccessDecision;
  readonly scope: OperationalScope;
}

const scopeValuesSchema = Schema.Tuple([Schema.String, Schema.String]);
const readCommittedIsolation = 'read committed';
const fencedScopeValuesSchema = Schema.Tuple([Schema.String, Schema.String, Schema.Literal(readCommittedIsolation)]);
const installReadScopeSql =
  "select current_user::text as role, set_config('ontos.tenant_id', $1, true) as tenant_id, set_config('ontos.legal_entity_id', $2, true) as legal_entity_id, transaction_timestamp() as operation_at";
const installFencedReadScopeSql = `${installReadScopeSql}, current_setting('transaction_isolation') as isolation, case when current_setting('transaction_isolation') = $3 then pg_advisory_xact_lock_shared(hashtextextended('ontos.application-composition-authority', 0)) end as publication_lock`;
const readFenceValuesSchema = Schema.Tuple([Schema.Literal(readCommittedIsolation)]);

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
      if (text === "select current_setting('transaction_isolation') as isolation") {
        return [{ isolation: readCommittedIsolation }];
      }
      if (
        text === "select pg_advisory_xact_lock_shared(hashtextextended('ontos.application-composition-authority', 0))"
      ) {
        return [];
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
  const decision = options.permissionDecision ?? 'denied';
  const contextAccess: ContextAccessService = {
    businessPermissions: ({ targets }) =>
      Effect.succeed(
        targets.map((target) => ({
          decision: options.businessPermissionDecision?.(target) ?? decision,
          key: toBusinessPermissionAccessKey(target),
        })),
      ),
    legalEntities: ({ legalEntityIds }) => Effect.succeed(legalEntityIds.map((key) => ({ decision, key }))),
    modules: ({ moduleIds }) => Effect.succeed(moduleIds.map((key) => ({ decision, key }))),
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
    contextAccess,
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
  const runtime = makeReadRuntime({ executor }, gateway, scopeResolver, contextAccess, {
    databaseIdentities,
    onStage: (stage) => {
      stages.push(stage);
    },
    ownerAuthorizationOverlay: transactionalOwnerAuthorization(() =>
      Effect.succeed(options.ownerAuthorizationDecision ?? 'denied'),
    ),
  });
  return {
    layer: Layer.mergeAll(Layer.succeed(ReadRuntime, runtime), Layer.succeed(ContextAccess, contextAccess)),
    runtime,
    snapshot: () => ({
      evidenceWrites,
      ownerQueries: [...ownerQueries],
      stages: [...stages],
      statements: [...statements],
    }),
  };
});
