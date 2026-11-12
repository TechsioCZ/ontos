import { NodeServices } from '@effect/platform-node';
import type { PgClient } from '@effect/sql-pg';
import { Deferred, Effect, Fiber, Ref, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { TenantAccessBootstrap } from '../../src/access/bootstrap/index.ts';
import type { AccessProjectionCompiler as AccessProjectionCompilerEngine } from '../../src/access/compiler/spice-db-compiler.ts';
import type { TenantId } from '../../src/access/ids.ts';
import { AccessProjectionWriter } from '../../src/access/intent/projection-writer.ts';
import type { AccessCatalogModule } from '../../src/authorization/access-declaration.ts';
import { defineTenantModuleEntrypoint } from '../../src/modules/module-entrypoint.ts';
import { ownerScope, SCENARIO_COMPANY, withProjectionTenant } from '../support/projection-tenant-scenario.ts';

/*
 * The tenant scope fence under the real writer, journal store, PostgreSQL and SpiceDB: what happens to the fence when
 * the process that holds it is interrupted or dies in the middle of the engine write.
 */
const MODULE = 'billing.invoices';
const deployment: readonly AccessCatalogModule[] = [
  {
    descriptors: [
      {
        accessDeclaration: {
          key: `${MODULE}.invoice.read`,
          kind: 'read',
          modes: ['run'],
          placement: { group: 'invoices', level: 'basic' },
          risk: 'routine',
          selectors: [],
        },
        entrypoint: defineTenantModuleEntrypoint({
          access: 'read',
          authorization: { kind: 'protected' },
          entrypointKey: `${MODULE}.api.list`,
          moduleKey: MODULE,
          role: 'api',
        }),
      },
    ],
    moduleId: MODULE,
  },
];

const FenceRowSchema = Schema.Struct({ owning_operation_id: Schema.NullOr(Schema.String), state: Schema.String });
const JournalRowSchema = Schema.Struct({ operation_id: Schema.String, phase: Schema.String });

export const tenantFence = (admin: PgClient.PgClient, tenantId: TenantId) =>
  admin
    .unsafe(
      `select f.state, f.owning_operation_id from core.access_scope_fences f
         join core.access_scopes s on s.scope_id = f.scope_id
        where f.tenant_id = '${tenantId}' and s.legal_entity_id is null`,
    )
    .pipe(Effect.orDie, Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(FenceRowSchema))), Effect.orDie);

export const journals = (admin: PgClient.PgClient, tenantId: TenantId) =>
  admin
    .unsafe(
      `select operation_id, phase from core.access_operation_journals where tenant_id = '${tenantId}' order by started_at`,
    )
    .pipe(Effect.orDie, Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(JournalRowSchema))), Effect.orDie);

export const bootstrapTenant = (tenantId: TenantId) =>
  Effect.gen(function* bootstrapScenarioTenant() {
    const scope = yield* ownerScope(tenantId);
    const bootstrap = yield* TenantAccessBootstrap;
    yield* bootstrap
      .bootstrapTenantAccess({ legalEntityIds: [SCENARIO_COMPANY], modules: deployment, scope })
      .pipe(Effect.orDie);
    const writer = yield* AccessProjectionWriter;
    yield* writer.reconcileTenant({ scope }).pipe(Effect.orDie);
    return scope;
  });

/** An engine whose write waits, once armed, until the suite lets it go: the holder is inside its engine write. */
const holdingEngine =
  (gate: {
    readonly armed: Ref.Ref<boolean>;
    readonly entered: Deferred.Deferred<boolean>;
    readonly finished: Ref.Ref<boolean>;
    readonly letGo: Deferred.Deferred<boolean>;
  }) =>
  (engine: AccessProjectionCompilerEngine): AccessProjectionCompilerEngine => ({
    ...engine,
    reconcile: (intent, options) =>
      Effect.gen(function* heldEngineWrite() {
        if (yield* Ref.get(gate.armed)) {
          yield* Deferred.succeed(gate.entered, true);
          yield* Deferred.await(gate.letGo);
        }
        const report = yield* engine.reconcile(intent, options);
        yield* Ref.set(gate.finished, true);
        return report;
      }),
  });

it.layer(NodeServices.layer, { excludeTestServices: true })('the tenant scope fence', (suite) => {
  suite.effect('a reconcile interrupted inside its engine write still finishes, commits and releases the fence', () =>
    Effect.gen(function* interruptedReconcile() {
      const gate = {
        armed: yield* Ref.make(false),
        entered: yield* Deferred.make<boolean>(),
        finished: yield* Ref.make(false),
        letGo: yield* Deferred.make<boolean>(),
      };
      yield* withProjectionTenant({ activeModules: [MODULE], wrapCompiler: holdingEngine(gate) }, (tenantId, admin) =>
        Effect.gen(function* interruptMidWrite() {
          const scope = yield* bootstrapTenant(tenantId);
          yield* Ref.set(gate.armed, true);
          const writer = yield* AccessProjectionWriter;
          const fiber = yield* writer.reconcileTenant({ scope }).pipe(Effect.forkChild);
          yield* Deferred.await(gate.entered);
          // The holder is stopped (a SIGTERM to its process, a caller's budget) while its engine write is open.
          const stopping = yield* Fiber.interrupt(fiber).pipe(Effect.forkChild);
          yield* Deferred.succeed(gate.letGo, true);
          yield* Fiber.join(stopping);
          expect(yield* Ref.get(gate.finished)).toBe(true);
          expect(yield* tenantFence(admin, tenantId)).toEqual([{ owning_operation_id: null, state: 'Ready' }]);
          expect((yield* journals(admin, tenantId)).at(-1)?.phase).toBe('committed');
        }),
      );
    }),
  );
});
