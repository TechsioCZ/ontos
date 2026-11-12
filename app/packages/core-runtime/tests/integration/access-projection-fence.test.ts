import { NodeServices } from '@effect/platform-node';
import type { PgClient } from '@effect/sql-pg';
import { Deferred, Effect, Fiber, Ref, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { TenantAccessBootstrap } from '../../src/access/bootstrap/index.ts';
import { AccessProjectionError } from '../../src/access/compiler/projection-error.ts';
import type { AccessProjectionCompiler as AccessProjectionCompilerEngine } from '../../src/access/compiler/spice-db-compiler.ts';
import type { TenantId } from '../../src/access/ids.ts';
import { AccessProjectionWriter } from '../../src/access/intent/projection-writer.ts';
import type { AccessCatalogModule } from '../../src/authorization/access-declaration.ts';
import { defineTenantModuleEntrypoint } from '../../src/modules/module-entrypoint.ts';
import {
  ownerScope,
  SCENARIO_COMPANY,
  scenarioUid,
  withProjectionTenant,
} from '../support/projection-tenant-scenario.ts';

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

const DEAD_HOLDER = scenarioUid(900);
const LeaseRowSchema = Schema.Struct({ lease_live: Schema.NullOr(Schema.Boolean) });

/**
 * What a holder that died in the middle of its engine write leaves behind (OOM kill, SIGKILL, host loss): its
 * journal at `fenced` and the tenant fence `Changing` in its name, with the given lease (`null` = taken before leases
 * existed) and a journal last touched `journalAge` ago. No finalizer ever ran.
 */
const plantDeadHolder = (
  admin: PgClient.PgClient,
  tenantId: TenantId,
  hold: { readonly journalAge: string; readonly lease: string | null },
) =>
  Effect.gen(function* plantDeadHolderEffect() {
    const scopes = yield* admin
      .unsafe(
        `select s.scope_id from core.access_scopes s where s.tenant_id = '${tenantId}' and s.legal_entity_id is null`,
      )
      .pipe(
        Effect.orDie,
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ scope_id: Schema.String })))),
        Effect.orDie,
      );
    const [scope] = scopes;
    if (scope === undefined) {
      return yield* Effect.die('the tenant has no tenant-context scope');
    }
    yield* admin
      .unsafe(
        `insert into core.access_operation_journals
           (operation_id, tenant_id, scope_id, command_digest, phase, started_at, updated_at) values
           ('${DEAD_HOLDER}', '${tenantId}', '${scope.scope_id}', '${'d'.repeat(64)}', 'fenced',
            now() - interval '1 hour', now() - interval '${hold.journalAge}')`,
      )
      .pipe(Effect.orDie);
    yield* admin
      .unsafe(
        `update core.access_scope_fences
            set state = 'Changing', owning_operation_id = '${DEAD_HOLDER}', revision = revision + 1,
                lease_expires_at = ${hold.lease === null ? 'null' : `now() + interval '${hold.lease}'`}
          where tenant_id = '${tenantId}' and scope_id = '${scope.scope_id}'`,
      )
      .pipe(Effect.orDie);
    return yield* Effect.void;
  });

/** The lapse of the hold, as time passing would bring it. */
const lapseLease = (admin: PgClient.PgClient, tenantId: TenantId) =>
  admin
    .unsafe(
      `update core.access_scope_fences set lease_expires_at = now() - interval '1 second'
        where tenant_id = '${tenantId}' and state = 'Changing'`,
    )
    .pipe(Effect.orDie);

const journalOf = (admin: PgClient.PgClient, operationId: string) =>
  admin
    .unsafe(`select phase, failure_code from core.access_operation_journals where operation_id = '${operationId}'`)
    .pipe(Effect.orDie);

const leaseLive = (admin: PgClient.PgClient, tenantId: TenantId) =>
  admin
    .unsafe(
      `select f.lease_expires_at > now() as lease_live from core.access_scope_fences f
         join core.access_scopes s on s.scope_id = f.scope_id
        where f.tenant_id = '${tenantId}' and s.legal_entity_id is null`,
    )
    .pipe(Effect.orDie, Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(LeaseRowSchema))), Effect.orDie);

const refusalOf = <A, E extends { readonly reason?: string }, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.flip,
    Effect.map((failure) => failure.reason ?? ''),
  );

/** The finalizer that lets a held engine write go. */
const letGoOf = (letGo: Deferred.Deferred<boolean>) => () => Deferred.succeed(letGo, true);

/** An engine that fails its write while `failing` is set, as an unreachable SpiceDB would. */
const failingEngine =
  (failing: Ref.Ref<boolean>) =>
  (engine: AccessProjectionCompilerEngine): AccessProjectionCompilerEngine => ({
    ...engine,
    reconcile: (intent, options) =>
      Ref.get(failing).pipe(
        Effect.flatMap((fail) =>
          fail
            ? Effect.fail([new AccessProjectionError({ code: 'access_projection_unavailable', reason: 'engine down' })])
            : engine.reconcile(intent, options),
        ),
      ),
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
          // A failed expectation must never leave the held write waiting: it is uninterruptible by design.
          yield* Effect.addFinalizer(letGoOf(gate.letGo));
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

  suite.effect(
    'a dead holder keeps the tenant closed while its lease is live; once it lapsed a reconcile takes over',
    () =>
      withProjectionTenant({ activeModules: [MODULE] }, (tenantId, admin) =>
        Effect.gen(function* deadHolderRecovered() {
          const scope = yield* bootstrapTenant(tenantId);
          yield* plantDeadHolder(admin, tenantId, { journalAge: '1 second', lease: '5 minutes' });
          const writer = yield* AccessProjectionWriter;
          // A live lease is never preempted: the reconcile is refused and the tenant stays closed to every Action
          // (`lockActionAccessFence` admits only a Ready fence).
          expect(yield* refusalOf(writer.reconcileTenant({ scope }))).toContain('whose hold has not lapsed');
          expect(yield* tenantFence(admin, tenantId)).toEqual([
            { owning_operation_id: DEAD_HOLDER, state: 'Changing' },
          ]);

          yield* lapseLease(admin, tenantId);
          const recovered = yield* writer.reconcileTenant({ scope }).pipe(Effect.orDie);
          expect(recovered.verified).toBe(true);
          // The fence opens only after the taker's whole reconcile committed, and the dead holder can never resume.
          expect(yield* tenantFence(admin, tenantId)).toEqual([{ owning_operation_id: null, state: 'Ready' }]);
          expect(yield* journalOf(admin, DEAD_HOLDER)).toEqual([{ failure_code: 'lease_expired', phase: 'failed' }]);
          expect(yield* journalOf(admin, recovered.operationId)).toEqual([{ failure_code: null, phase: 'committed' }]);
          // And the next reconcile is an ordinary one.
          yield* writer.reconcileTenant({ scope }).pipe(Effect.orDie);
          expect(yield* tenantFence(admin, tenantId)).toEqual([{ owning_operation_id: null, state: 'Ready' }]);
        }),
      ),
  );

  suite.effect('a hold taken before leases existed is recovered once its journal stopped moving, not before', () =>
    withProjectionTenant({ activeModules: [MODULE] }, (tenantId, admin) =>
      Effect.gen(function* legacyHold() {
        const scope = yield* bootstrapTenant(tenantId);
        yield* plantDeadHolder(admin, tenantId, { journalAge: '10 seconds', lease: null });
        const writer = yield* AccessProjectionWriter;
        expect(yield* refusalOf(writer.reconcileTenant({ scope }))).toContain('whose hold has not lapsed');
        yield* admin
          .unsafe(
            `update core.access_operation_journals set updated_at = now() - interval '10 minutes' where operation_id = '${DEAD_HOLDER}'`,
          )
          .pipe(Effect.orDie);
        yield* writer.reconcileTenant({ scope }).pipe(Effect.orDie);
        expect(yield* tenantFence(admin, tenantId)).toEqual([{ owning_operation_id: null, state: 'Ready' }]);
      }),
    ),
  );

  suite.effect('a live holder in the middle of its write is never preempted, and holds a lease while it works', () =>
    Effect.gen(function* liveHolder() {
      const gate = {
        armed: yield* Ref.make(false),
        entered: yield* Deferred.make<boolean>(),
        finished: yield* Ref.make(false),
        letGo: yield* Deferred.make<boolean>(),
      };
      yield* withProjectionTenant({ activeModules: [MODULE], wrapCompiler: holdingEngine(gate) }, (tenantId, admin) =>
        Effect.gen(function* concurrentReconciles() {
          const scope = yield* bootstrapTenant(tenantId);
          yield* Ref.set(gate.armed, true);
          // A failed expectation must never leave the held write waiting: it is uninterruptible by design.
          yield* Effect.addFinalizer(letGoOf(gate.letGo));
          const writer = yield* AccessProjectionWriter;
          const holder = yield* writer.reconcileTenant({ scope }).pipe(Effect.forkChild);
          yield* Deferred.await(gate.entered);
          expect(yield* leaseLive(admin, tenantId)).toEqual([{ lease_live: true }]);
          const [held] = yield* tenantFence(admin, tenantId);
          yield* Ref.set(gate.armed, false);
          expect(yield* refusalOf(writer.reconcileTenant({ scope }))).toContain('whose hold has not lapsed');
          expect(yield* tenantFence(admin, tenantId)).toEqual([held]);
          yield* Deferred.succeed(gate.letGo, true);
          yield* Fiber.join(holder).pipe(Effect.orDie);
          expect(yield* tenantFence(admin, tenantId)).toEqual([{ owning_operation_id: null, state: 'Ready' }]);
          expect(yield* leaseLive(admin, tenantId)).toEqual([{ lease_live: null }]);
        }),
      );
    }),
  );

  suite.effect('a take-over whose reconcile fails keeps the tenant closed for the next taker', () =>
    Effect.gen(function* failedTakeOver() {
      const failing = yield* Ref.make(false);
      yield* withProjectionTenant(
        {
          activeModules: [MODULE],
          wrapCompiler: failingEngine(failing),
        },
        (tenantId, admin) =>
          Effect.gen(function* takeOverThatFails() {
            const scope = yield* bootstrapTenant(tenantId);
            yield* plantDeadHolder(admin, tenantId, { journalAge: '1 second', lease: '5 minutes' });
            yield* lapseLease(admin, tenantId);
            yield* Ref.set(failing, true);
            const writer = yield* AccessProjectionWriter;
            yield* refusalOf(writer.reconcileTenant({ scope }));
            const [held] = yield* tenantFence(admin, tenantId);
            // The graph may be half-written by the dead holder: the fence does not open on a failed reconcile.
            expect(held?.state).toBe('Changing');
            expect(held?.owning_operation_id).not.toBe(DEAD_HOLDER);
            yield* Ref.set(failing, false);
            yield* lapseLease(admin, tenantId);
            yield* writer.reconcileTenant({ scope }).pipe(Effect.orDie);
            expect(yield* tenantFence(admin, tenantId)).toEqual([{ owning_operation_id: null, state: 'Ready' }]);
          }),
      );
    }),
  );
});
