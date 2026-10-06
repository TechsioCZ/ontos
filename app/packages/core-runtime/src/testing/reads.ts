import { PgClient } from '@effect/sql-pg';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import { Context, Deferred, Effect, Layer, Schema, Stream } from 'effect';
import { Reactivity } from 'effect/unstable/reactivity';
import type { Connection } from 'effect/unstable/sql/SqlConnection';
import type { SqlError } from 'effect/unstable/sql/SqlError';

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
import { ReadRuntime, makeReadRuntime } from '../reads/runtime.ts';
import type { ReadRuntimeStage } from '../reads/runtime.ts';
import { scriptedPgClientLayer } from './scripted-pg-client.ts';

export interface ReadTestOwnerQuery {
  readonly params: readonly unknown[];
  readonly scope: Readonly<{ legalEntityId: string; tenantId: string }>;
  readonly sql: string;
}

export interface ReadTestHarnessOptions {
  readonly businessPermissionDecision?: (target: BusinessPermissionAccessTarget) => ContextAccessDecision;
  readonly compositionRevision?: string;
  /** Explicit driver rows for owner SQL; unexpected statements must fail rather than supply empty. */
  readonly executeOwnerQuery: (query: ReadTestOwnerQuery) => Effect.Effect<readonly object[], SqlError>;
  readonly operationTime: Date;
  readonly ownerAuthorizationDecision?: ContextAccessDecision;
  readonly permissionDecision?: ContextAccessDecision;
  readonly scope: OperationalScope;
}

const scopeValuesSchema = Schema.Tuple([Schema.String, Schema.String]);

/**
 * Scripted SQL transport for the real Core Read lifecycle and the registration's original owner
 * factory/handler. No service substitution. Drizzle mapping, scope installation, composition
 * admission and evidence writes execute normally; this does not prove native PostgreSQL or RLS.
 * The caller owns its Effect scope. Permissions and owner authorization default to denied.
 */
export const makeReadTestHarness = Effect.fn('ReadTestHarness.make')(function* makeReadTestHarness(
  options: ReadTestHarnessOptions,
) {
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
    const execute = Effect.fn('ReadTestHarness.executeQuery')(function* executeReadTestQuery(
      sql: string,
      params: readonly unknown[],
    ): Effect.fn.Return<readonly object[], SqlError> {
      statements.push(sql);
      const text = sql.toLowerCase();
      if (/^(?:begin|commit|rollback|savepoint|release savepoint)(?:\s|$)/u.test(text)) {
        return [];
      }
      if (text.includes("current_setting('transaction_isolation')")) {
        return [{ isolation: 'read committed' }];
      }
      if (text.includes('pg_advisory_xact_lock_shared')) {
        return [];
      }
      if (text.includes('"core"."application_composition_authority"')) {
        return [{ phase: 'active', revision: options.compositionRevision, subscriptionsJson: [], unexpired: true }];
      }
      if (text.includes("set_config('ontos.tenant_id'")) {
        [scope.tenantId, scope.legalEntityId] = yield* Schema.decodeUnknownEffect(scopeValuesSchema)(params).pipe(
          Effect.orDie,
        );
        return [];
      }
      if (text.includes("current_setting('ontos.tenant_id'")) {
        return [{ legal_entity_id: scope.legalEntityId, tenant_id: scope.tenantId }];
      }
      if (text.includes('transaction_timestamp()')) {
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
  const scopeResolver = makeOperationalScopeResolver(
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
    onStage: (stage) => {
      stages.push(stage);
    },
    ownerAuthorizationOverlay: { authorize: () => Effect.succeed(options.ownerAuthorizationDecision ?? 'denied') },
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
