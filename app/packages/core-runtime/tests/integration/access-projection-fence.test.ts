import { NodeServices } from '@effect/platform-node';
import type { PgClient } from '@effect/sql-pg';
import { Clock, Deferred, Effect, Fiber, Layer, Option, Ref, Schema } from 'effect';
import { TestClock } from 'effect/testing';
import { expect, it } from 'effect-rstest';

import { TenantAccessBootstrap } from '../../src/access/bootstrap/index.ts';
import { AccessProjectionError } from '../../src/access/compiler/projection-error.ts';
import type { AccessProjectionCompiler as AccessProjectionCompilerEngine } from '../../src/access/compiler/spice-db-compiler.ts';
import type { TenantId } from '../../src/access/ids.ts';
import { AccessProjectionWriter } from '../../src/access/intent/projection-writer.ts';
import type { TenantIntentLoaderService } from '../../src/access/intent/tenant-intent-loader.ts';
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

const journalPhases = (admin: PgClient.PgClient, tenantId: TenantId) =>
  journals(admin, tenantId).pipe(Effect.map((rows) => rows.map((journal) => journal.phase)));

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

/** The dead holder's journal last moved `age` ago. */
const idleJournal = (admin: PgClient.PgClient, age: string) =>
  admin
    .unsafe(
      `update core.access_operation_journals set updated_at = now() - interval '${age}' where operation_id = '${DEAD_HOLDER}'`,
    )
    .pipe(Effect.orDie);

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

/** The armed write, taken so it runs once; nothing when none is armed. */
const runArmed = (afterRead: Ref.Ref<Option.Option<Effect.Effect<void>>>) =>
  Ref.getAndSet(afterRead, Option.none()).pipe(Effect.flatMap(Option.getOrElse(() => Effect.void)));

/** A loader that runs the armed write once, right after the writer's next read of the tenant's intent. */
const interleavedLoader =
  (afterRead: Ref.Ref<Option.Option<Effect.Effect<void>>>) =>
  (loader: TenantIntentLoaderService): TenantIntentLoaderService => ({
    ...loader,
    loadProjection: (scope) => loader.loadProjection(scope).pipe(Effect.tap(runArmed(afterRead))),
  });

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

/** The connection lost in the middle of an engine write. */
const midWriteLoss = [new AccessProjectionError({ code: 'access_projection_unavailable', reason: 'connection lost' })];

/**
 * An engine whose next `failures` reconciles send their first relationship write (the compiler's `beforeWrite` runs)
 * and then lose the connection: from then on the graph may be half-written.
 */
const failingMidWrite =
  (failures: Ref.Ref<number>) =>
  (engine: AccessProjectionCompilerEngine): AccessProjectionCompilerEngine => ({
    ...engine,
    reconcile: (intent, options) =>
      Ref.modify(failures, (left) => [left, Math.max(0, left - 1)] as const).pipe(
        Effect.flatMap((left) =>
          left > 0
            ? (options.beforeWrite ?? Effect.void).pipe(Effect.andThen(Effect.fail(midWriteLoss)))
            : engine.reconcile(intent, options),
        ),
      ),
  });

const lastJournal = (admin: PgClient.PgClient, tenantId: TenantId) =>
  journals(admin, tenantId).pipe(Effect.map((rows) => rows.at(-1)));

/**
 * An engine that, once armed, sends its first relationship write and waits inside it until the suite lets it go, then
 * sends the next one: `wroteAfterLoss` records a write that went out after the hold was lost.
 */
const writingAcrossLoss =
  (gate: {
    readonly armed: Ref.Ref<boolean>;
    readonly entered: Deferred.Deferred<boolean>;
    readonly letGo: Deferred.Deferred<boolean>;
    readonly wroteAfterLoss: Ref.Ref<boolean>;
  }) =>
  (engine: AccessProjectionCompilerEngine): AccessProjectionCompilerEngine => ({
    ...engine,
    reconcile: (intent, options) =>
      Effect.gen(function* writeAcrossLoss() {
        if (yield* Ref.get(gate.armed)) {
          const beforeWrite = options.beforeWrite ?? Effect.void;
          yield* beforeWrite;
          yield* Deferred.succeed(gate.entered, true);
          yield* Deferred.await(gate.letGo);
          yield* beforeWrite;
          yield* Ref.set(gate.wroteAfterLoss, true);
        }
        return yield* engine.reconcile(intent, options);
      }),
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

  suite.effect(
    'a hold taken before leases existed is recovered after 30 idle minutes and a skew margin, not before',
    () =>
      withProjectionTenant({ activeModules: [MODULE] }, (tenantId, admin) =>
        Effect.gen(function* legacyHold() {
          const scope = yield* bootstrapTenant(tenantId);
          yield* plantDeadHolder(admin, tenantId, { journalAge: '10 seconds', lease: null });
          const writer = yield* AccessProjectionWriter;
          expect(yield* refusalOf(writer.reconcileTenant({ scope }))).toContain('whose hold has not lapsed');
          // A writer of the previous release moves its journal only between phases: ten quiet minutes inside one long
          // engine write is no lapse.
          yield* idleJournal(admin, '10 minutes');
          expect(yield* refusalOf(writer.reconcileTenant({ scope }))).toContain('whose hold has not lapsed');
          // Thirty minutes plus the five-minute margin for the writer's clock against the database's is.
          yield* idleJournal(admin, '34 minutes');
          expect(yield* refusalOf(writer.reconcileTenant({ scope }))).toContain('whose hold has not lapsed');
          yield* idleJournal(admin, '36 minutes');
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

  suite.effect('an intent that moved between the read and the fence is read again, never projected stale', () =>
    Effect.gen(function* movedIntent() {
      const afterRead = yield* Ref.make(Option.none<Effect.Effect<void>>());
      yield* withProjectionTenant(
        { activeModules: [MODULE], wrapIntentLoader: interleavedLoader(afterRead) },
        (tenantId, admin) =>
          Effect.gen(function* revocationInTheGap() {
            const scope = yield* bootstrapTenant(tenantId);
            // Right after the writer read the tenant, an intent write suspends the module. Like an Action, it commits
            // while the fence is Ready and moves no revision, so the fence's compare-and-set cannot see it.
            yield* Ref.set(
              afterRead,
              Option.some(
                admin
                  .unsafe(
                    `update core.tenant_module_states set state = 'suspended'
                      where tenant_id = '${tenantId}' and module_key = '${MODULE}'`,
                  )
                  .pipe(Effect.orDie, Effect.asVoid),
              ),
            );
            const writer = yield* AccessProjectionWriter;
            const written = yield* writer.reconcileTenant({ scope }).pipe(Effect.orDie);
            // The suspension was projected, not the plan read before it.
            expect(written.deletions).toBeGreaterThan(0);
            const again = yield* writer.reconcileTenant({ scope }).pipe(Effect.orDie);
            expect({ deletions: again.deletions, touches: again.touches }).toEqual({ deletions: 0, touches: 0 });
            expect((yield* journalPhases(admin, tenantId)).slice(-3)).toEqual(['failed', 'committed', 'committed']);
            expect(yield* tenantFence(admin, tenantId)).toEqual([{ owning_operation_id: null, state: 'Ready' }]);
          }),
      );
    }),
  );

  suite.effect('a projection that failed after it wrote to the engine keeps the tenant closed for the next taker', () =>
    Effect.gen(function* failedAfterEngineWrite() {
      const failures = yield* Ref.make(0);
      yield* withProjectionTenant(
        { activeModules: [MODULE], wrapCompiler: failingMidWrite(failures) },
        (tenantId, admin) =>
          Effect.gen(function* keptClosed() {
            const scope = yield* bootstrapTenant(tenantId);
            yield* Ref.set(failures, 99);
            const writer = yield* AccessProjectionWriter;
            yield* refusalOf(writer.reconcileTenant({ scope }));
            // Tried once and twice more under the same fence, then given up without opening the tenant.
            expect(yield* Ref.get(failures)).toBe(96);
            const [held] = yield* tenantFence(admin, tenantId);
            const failed = yield* lastJournal(admin, tenantId);
            expect(held).toEqual({ owning_operation_id: failed?.operation_id, state: 'Changing' });
            expect(yield* journalOf(admin, failed?.operation_id ?? '')).toEqual([
              { failure_code: 'projection_failed', phase: 'failed' },
            ]);
            // Once the lease lapsed the next reconcile takes the fence over and opens it on a full projection.
            yield* Ref.set(failures, 0);
            yield* lapseLease(admin, tenantId);
            yield* writer.reconcileTenant({ scope }).pipe(Effect.orDie);
            expect(yield* tenantFence(admin, tenantId)).toEqual([{ owning_operation_id: null, state: 'Ready' }]);
          }),
      );
    }),
  );

  suite.effect('a projection that failed before any engine write gives the fence back', () =>
    Effect.gen(function* failedBeforeEngineWrite() {
      const failing = yield* Ref.make(false);
      yield* withProjectionTenant(
        { activeModules: [MODULE], wrapCompiler: failingEngine(failing) },
        (tenantId, admin) =>
          Effect.gen(function* releasedUntouched() {
            const scope = yield* bootstrapTenant(tenantId);
            yield* Ref.set(failing, true);
            const writer = yield* AccessProjectionWriter;
            yield* refusalOf(writer.reconcileTenant({ scope }));
            expect(yield* tenantFence(admin, tenantId)).toEqual([{ owning_operation_id: null, state: 'Ready' }]);
            expect((yield* lastJournal(admin, tenantId))?.phase).toBe('failed');
          }),
      );
    }),
  );

  suite.effect('a projection that lost the engine mid-write is tried again under the same fence and opens it', () =>
    Effect.gen(function* retriedUnderFence() {
      const failures = yield* Ref.make(0);
      yield* withProjectionTenant(
        { activeModules: [MODULE], wrapCompiler: failingMidWrite(failures) },
        (tenantId, admin) =>
          Effect.gen(function* recoveredInProcess() {
            const scope = yield* bootstrapTenant(tenantId);
            yield* Ref.set(failures, 1);
            const writer = yield* AccessProjectionWriter;
            const written = yield* writer.reconcileTenant({ scope }).pipe(Effect.orDie);
            expect(written.verified).toBe(true);
            expect(yield* journalOf(admin, written.operationId)).toEqual([{ failure_code: null, phase: 'committed' }]);
            expect(yield* tenantFence(admin, tenantId)).toEqual([{ owning_operation_id: null, state: 'Ready' }]);
          }),
      );
    }),
  );

  suite.effect('a holder whose hold was lost stops before its next engine write and leaves the fence alone', () =>
    Effect.gen(function* lostHold() {
      const gate = {
        armed: yield* Ref.make(false),
        entered: yield* Deferred.make<boolean>(),
        letGo: yield* Deferred.make<boolean>(),
        wroteAfterLoss: yield* Ref.make(false),
      };
      yield* withProjectionTenant(
        { activeModules: [MODULE], wrapCompiler: writingAcrossLoss(gate) },
        (tenantId, admin) =>
          Effect.gen(function* holdTakenMidWrite() {
            const scope = yield* bootstrapTenant(tenantId);
            yield* Ref.set(gate.armed, true);
            yield* Effect.addFinalizer(letGoOf(gate.letGo));
            // The holder runs on a test clock, so its renewals and its own sense of time move only when told.
            const clock = yield* Layer.build(TestClock.layer());
            yield* TestClock.setTime(yield* Clock.currentTimeMillis).pipe(Effect.provide(clock));
            const writer = yield* AccessProjectionWriter;
            const holder = yield* writer.reconcileTenant({ scope }).pipe(Effect.provide(clock), Effect.forkChild);
            yield* Deferred.await(gate.entered);
            // Another operation now holds the fence (a taker that judged this hold lapsed), and the holder's renewals
            // fail to prove its hold for longer than it may go unproved.
            yield* plantDeadHolder(admin, tenantId, { journalAge: '1 second', lease: '5 minutes' });
            yield* TestClock.adjust('95 seconds').pipe(Effect.provide(clock));
            yield* Deferred.succeed(gate.letGo, true);
            expect(yield* refusalOf(Fiber.join(holder))).toContain('no longer holds');
            expect(yield* Ref.get(gate.wroteAfterLoss)).toBe(false);
            expect(yield* tenantFence(admin, tenantId)).toEqual([
              { owning_operation_id: DEAD_HOLDER, state: 'Changing' },
            ]);
          }),
      );
    }),
  );
});
