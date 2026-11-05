// @effect-diagnostics strictEffectProvide:off -- Test-owned entry point: it provides the store and its one-request port to `runAccessWrite` itself; expires: 2026-12-31.
import { NodeCrypto } from '@effect/platform-node';
import { sql } from 'drizzle-orm';
import { Crypto, DateTime, Deferred, Effect, Match, Option, Ref, Result, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { TrustedPrincipalContextSchema } from '../../src/actions/principal-context.ts';
import {
  AccessOperationIdSchema,
  AccessScopeIdSchema,
  CommandDigestSchema,
  LegalEntityIdSchema,
  TenantIdSchema,
} from '../../src/access/ids.ts';
import type { AccessOperationId, AccessScopeId, CommandDigest, TenantId } from '../../src/access/ids.ts';
import { OperationJournalSchema } from '../../src/access/model.ts';
import type { OperationJournal } from '../../src/access/model.ts';
import {
  advanceOperationJournal,
  openOperationJournal,
  recoverAccessWrite,
  runAccessWrite,
  validateAccessChange,
} from '../../src/access/lifecycle/fence.ts';
import type { AccessChangeReceipt, AccessWriteJournalPort } from '../../src/access/lifecycle/fence.ts';
import {
  AccessWriteJournalStore,
  accessWriteJournalPortLayer,
  makeAccessWriteJournalStore,
} from '../../src/access/lifecycle/persistence/journal-store.ts';
import type {
  AccessJournalStoreDatabase,
  AccessWriteJournalStoreService,
} from '../../src/access/lifecycle/persistence/journal-store.ts';
import { findPostgresFailure } from '../../src/database/postgres-failure.ts';
import { accessScopeFences, accessScopes, coreRelations, legalEntities, tenants } from '../../src/db/schema.ts';
import type { OperationalScope } from '../../src/operations/context.ts';
import { makeTestDatabaseFromClient, testDatabaseClients } from '../support/database.ts';
import type { TestDatabaseFromClient } from '../support/database.ts';

/*
 * The scope fence and the operation journal are the only lock every access writer shares (D15, D24),
 * so their persistence is proved against a real PostgreSQL: the migration's forward-only trigger, the
 * tenant row-level security of both tables, and the compare-and-set that lets exactly one of two
 * racing writers project.
 *
 * The store is built once and every call carries the caller's `OperationalScope`, which it installs
 * with Core's `installOperationalScope` (O66). The suite runs it as `ontos_runtime` (the role the
 * policies name) and seeds fixtures as the administrative login.
 */
type CoreTestDatabase = TestDatabaseFromClient<typeof coreRelations>;

const nextUuid = Crypto.Crypto.use((crypto) => crypto.randomUUIDv4());
const digestOf = (seed: string) => CommandDigestSchema.make(seed.repeat(64));

const databaseFixture = Effect.gen(function* accessJournalDatabases() {
  const { admin, runtime } = yield* testDatabaseClients;
  return {
    adminDatabase: yield* makeTestDatabaseFromClient(admin, coreRelations),
    runtimeDatabase: yield* makeTestDatabaseFromClient(runtime, coreRelations),
  };
});

/** One store for the whole process: it binds no tenant, so every call names its own scope. */
const storeOf = (runtimeDatabase: CoreTestDatabase) =>
  makeAccessWriteJournalStore({ executor: runtimeDatabase } satisfies AccessJournalStoreDatabase);

/** The caller's operational scope: the verified session principal acting in one context. */
const operationalScope = (context: {
  readonly legalEntityId?: string;
  readonly tenantId: TenantId;
}): OperationalScope => {
  const principalContext = Schema.decodeSync(TrustedPrincipalContextSchema)({
    authBindingId: '00000000-0000-4000-8000-00000000b00b',
    authContextRef: `access-journal-test:${context.tenantId}`,
    authMethod: 'session',
    principalId: '00000000-0000-4000-8000-00000000a11a',
    tenantId: context.tenantId,
  });
  const scoped =
    context.legalEntityId === undefined
      ? principalContext
      : { ...principalContext, legalEntityId: context.legalEntityId };
  return Object.freeze({ ...scoped, correlationId: `access-journal-${context.tenantId}` });
};

/**
 * A fresh tenant per run. The access intent is append-only by migration (a scope, a fence and a
 * journal are never removed), so a fixture cannot be cleaned up afterwards: the suite seeds
 * identifiers nothing else uses and runs against a disposable database.
 */
const seedTenant = (adminDatabase: CoreTestDatabase, label: string) =>
  Effect.gen(function* seedAccessJournalTenant() {
    const tenantId = TenantIdSchema.make(yield* nextUuid);
    yield* adminDatabase.insert(tenants).values({
      defaultLocale: 'en',
      name: `Access journal ${label}`,
      slug: `access-journal-${label}-${tenantId}`,
      status: 'active',
      tenantId,
    });
    return tenantId;
  });

/** The tenant-context scope of a tenant, with the fence every writer of that scope takes. */
const seedTenantScope = (adminDatabase: CoreTestDatabase, tenantId: TenantId) =>
  Effect.gen(function* seedAccessJournalTenantScope() {
    const scopeId = AccessScopeIdSchema.make(yield* nextUuid);
    yield* adminDatabase.insert(accessScopes).values({ scopeId, tenantContextId: tenantId, tenantId });
    yield* adminDatabase.insert(accessScopeFences).values({ revision: 1, scopeId, state: 'Ready', tenantId });
    return { scope: operationalScope({ tenantId }), scopeId };
  });

/** One legal entity of a tenant: a second scope beside the tenant context, with its own fence. */
const seedLegalEntityScope = (adminDatabase: CoreTestDatabase, tenantId: TenantId) =>
  Effect.gen(function* seedAccessJournalLegalEntityScope() {
    const legalEntityId = LegalEntityIdSchema.make(yield* nextUuid);
    const scopeId = AccessScopeIdSchema.make(yield* nextUuid);
    yield* adminDatabase.insert(legalEntities).values({
      legalEntityId,
      legalName: `Access journal entity ${legalEntityId}`,
      registrationCountry: 'CZ',
      registrationNumber: `CZ${legalEntityId}`,
      status: 'active',
      tenantId,
    });
    yield* adminDatabase.insert(accessScopes).values({ legalEntityId, scopeId, tenantId });
    yield* adminDatabase.insert(accessScopeFences).values({ revision: 1, scopeId, state: 'Ready', tenantId });
    return { scope: operationalScope({ legalEntityId, tenantId }), scopeId };
  });

const receiptOf = () => validateAccessChange([{ check: 'access-journal-fixture', run: Effect.void }]);

interface WriteFixture {
  readonly commandDigest?: CommandDigest;
  readonly operationId: AccessOperationId;
  readonly project: () => Effect.Effect<string>;
  readonly scopeId: AccessScopeId;
  readonly tenantId: TenantId;
}

const writeRequest = (fixture: { readonly receipt: AccessChangeReceipt; readonly write: WriteFixture }) => ({
  change: fixture.receipt,
  commandDigest: fixture.write.commandDigest ?? digestOf('a'),
  operationId: fixture.write.operationId,
  project: fixture.write.project,
  scopeId: fixture.write.scopeId,
  tenantId: fixture.write.tenantId,
});

/** The write path of the caller's scope, over the process store. */
const withPort = <Value, Failure>(
  store: AccessWriteJournalStoreService,
  scope: OperationalScope,
  effect: Effect.Effect<Value, Failure, AccessWriteJournalPort>,
): Effect.Effect<Value, Failure> =>
  effect.pipe(
    Effect.provide(accessWriteJournalPortLayer(scope)),
    Effect.provideService(AccessWriteJournalStore, store),
  );

/** The store the writer sees, counting every projection so a resumed or refused write cannot hide one. */
const projectCounter = Effect.gen(function* projectionCounter() {
  const projections = yield* Ref.make<readonly string[]>([]);
  return {
    project: (token: string) => () => Ref.update(projections, (tokens) => [...tokens, token]).pipe(Effect.as(token)),
    projected: projections,
  };
});

/** Asserts one writer of the journal race read no journal for the operation id it is opening. */
const observeNoJournal = (found: Option.Option<OperationJournal>) =>
  Effect.sync(() => {
    expect(Option.isNone(found)).toBe(true);
  });

interface ReadGate {
  readonly bothRead: Deferred.Deferred<null>;
  readonly reads: Ref.Ref<number>;
}

/** Releases the gate once both writers hold the revision they read. */
const countFenceRead = (gate: ReadGate) =>
  Ref.updateAndGet(gate.reads, (seen) => seen + 1).pipe(
    Effect.flatMap((seen) => (seen >= 2 ? Deferred.succeed(gate.bothRead, null) : Effect.succeed(false))),
  );

/**
 * Both writers read the fence before either one compares and sets it: the lost-update window a
 * sequential pair never enters. Only the store's compare-and-set can close it.
 */
const gateFenceReads = (store: AccessWriteJournalStoreService, gate: ReadGate): AccessWriteJournalStoreService => ({
  ...store,
  readFence: (scope, command) =>
    store.readFence(scope, command).pipe(
      Effect.tap(() => countFenceRead(gate)),
      Effect.tap(() => Deferred.await(gate.bothRead)),
    ),
});

it.layer(NodeCrypto.layer, { excludeTestServices: true })('access lifecycle journal', (suite) => {
  suite.effect('lets exactly one of two writers that read the same fence revision take the scope', () =>
    Effect.gen(function* racingWritersTakeOneFence() {
      const { adminDatabase, runtimeDatabase } = yield* databaseFixture;
      const tenantId = yield* seedTenant(adminDatabase, 'race');
      const { scope, scopeId } = yield* seedTenantScope(adminDatabase, tenantId);
      const store = storeOf(runtimeDatabase);
      const receipt = yield* receiptOf();
      const counter = yield* projectCounter;
      const gate: ReadGate = { bothRead: yield* Deferred.make<null>(), reads: yield* Ref.make(0) };
      const gatedStore = gateFenceReads(store, gate);
      const race = (operationId: AccessOperationId, token: string) =>
        withPort(
          gatedStore,
          scope,
          runAccessWrite(
            writeRequest({ receipt, write: { operationId, project: counter.project(token), scopeId, tenantId } }),
          ),
        ).pipe(Effect.result);

      const firstOperation = AccessOperationIdSchema.make(yield* nextUuid);
      const secondOperation = AccessOperationIdSchema.make(yield* nextUuid);
      const results = yield* Effect.all([race(firstOperation, 'token-1'), race(secondOperation, 'token-2')], {
        concurrency: 2,
      });

      expect(results.filter(Result.isSuccess)).toHaveLength(1);
      const refused = results.flatMap((result) => (Result.isFailure(result) ? [result.failure] : []));
      expect(refused).toHaveLength(1);
      // Whichever writer took the fence first wins the compare-and-set; the other one stops on it.
      expect(['fence_held_by_other_operation', 'fence_revision_conflict']).toContain(refused[0]?.code);
      // Exactly one operation projected, and only the winner's journal reached committed.
      expect(yield* Ref.get(counter.projected)).toHaveLength(1);
      const committed = yield* Effect.all(
        [
          store.readJournal(scope, { operationId: firstOperation, tenantId }),
          store.readJournal(scope, { operationId: secondOperation, tenantId }),
        ],
        { concurrency: 1 },
      );
      const journals = committed.flatMap((journal) => (Option.isSome(journal) ? [journal.value] : []));
      expect(journals.filter((journal) => journal.phase === 'committed')).toHaveLength(1);
      // A writer leaves the scope exactly as it found it: taken once, given back once.
      const fence = yield* store.readFence(scope, { scopeId, tenantId });
      expect(Option.getOrThrow(fence)).toEqual({ revision: 3, scopeId, state: 'Ready', tenantId });
    }),
  );

  suite.effect('resumes the operation it already committed and refuses another command or scope', () =>
    Effect.gen(function* resumesTheSameCommand() {
      const { adminDatabase, runtimeDatabase } = yield* databaseFixture;
      const tenantId = yield* seedTenant(adminDatabase, 'resume');
      const { scope, scopeId } = yield* seedTenantScope(adminDatabase, tenantId);
      const entityScope = yield* seedLegalEntityScope(adminDatabase, tenantId);
      const store = storeOf(runtimeDatabase);
      const receipt = yield* receiptOf();
      const counter = yield* projectCounter;
      const operationId = AccessOperationIdSchema.make(yield* nextUuid);
      const write = (overrides: Partial<WriteFixture>) =>
        withPort(
          store,
          scope,
          runAccessWrite(
            writeRequest({
              receipt,
              write: { operationId, project: counter.project('token-1'), scopeId, tenantId, ...overrides },
            }),
          ),
        );

      const committed = yield* write({});
      expect(committed.phase).toBe('committed');
      expect(committed.resumed).toBe(false);
      expect(committed.projectionToken).toBe('token-1');

      // The same operation of the same command in the same scope is resumed, not projected twice.
      const resumed = yield* write({});
      expect(resumed.resumed).toBe(true);
      expect(resumed.projectionToken).toBe('token-1');
      expect(yield* Ref.get(counter.projected)).toHaveLength(1);

      // A journal belongs to one command: another digest is somebody else's work under this id.
      const otherCommand = yield* Effect.flip(write({ commandDigest: digestOf('b') }));
      expect(otherCommand.code).toBe('operation_command_mismatch');
      // The same command in another scope of the tenant is a different operation, whatever the id says.
      const otherScope = yield* Effect.flip(
        withPort(
          store,
          entityScope.scope,
          runAccessWrite(
            writeRequest({
              receipt,
              write: {
                operationId,
                project: counter.project('token-2'),
                scopeId: entityScope.scopeId,
                tenantId,
              },
            }),
          ),
        ),
      );
      expect(otherScope.code).toBe('operation_command_mismatch');
      // Recovery resumes an existing operation and never invents one.
      const unknown = yield* Effect.flip(
        withPort(
          store,
          scope,
          recoverAccessWrite(
            writeRequest({
              receipt,
              write: {
                operationId: AccessOperationIdSchema.make(yield* nextUuid),
                project: counter.project('token-9'),
                scopeId,
                tenantId,
              },
            }),
          ),
        ),
      );
      expect(unknown.code).toBe('operation_unknown');
      // Nothing above projected, took or moved a fence: the committed write is the only change.
      expect(yield* Ref.get(counter.projected)).toHaveLength(1);
      expect(Option.getOrThrow(yield* store.readFence(scope, { scopeId, tenantId })).revision).toBe(3);
      expect(
        Option.getOrThrow(yield* store.readFence(entityScope.scope, { scopeId: entityScope.scopeId, tenantId }))
          .revision,
      ).toBe(1);
    }),
  );

  suite.effect('makes the journal forward-only in PostgreSQL and hands the scope to the next writer', () =>
    Effect.gen(function* journalOnlyAdvances() {
      const { adminDatabase, runtimeDatabase } = yield* databaseFixture;
      const tenantId = yield* seedTenant(adminDatabase, 'forward-only');
      const { scope, scopeId } = yield* seedTenantScope(adminDatabase, tenantId);
      const store = storeOf(runtimeDatabase);
      const receipt = yield* receiptOf();
      const counter = yield* projectCounter;
      const operationId = AccessOperationIdSchema.make(yield* nextUuid);
      yield* withPort(
        store,
        scope,
        runAccessWrite(
          writeRequest({ receipt, write: { operationId, project: counter.project('token-1'), scopeId, tenantId } }),
        ),
      );
      const committed = Option.getOrThrow(yield* store.readJournal(scope, { operationId, tenantId }));
      expect(committed.phase).toBe('committed');
      const now = DateTime.toDateUtc(yield* DateTime.now);

      // The store refuses first so the writer gets the model's reason, not a raw database error. A
      // committed operation is terminal: it does not reopen at all.
      const backwards = yield* Effect.flip(
        store.writeJournal(scope, { ...committed, phase: 'projected', updatedAt: now }),
      );
      expect(backwards.code).toBe('operation_terminal');
      const reopened = yield* Effect.flip(
        store.writeJournal(scope, { ...committed, phase: 'validated', updatedAt: now }),
      );
      expect(reopened.code).toBe('operation_terminal');
      // NEGATIVE CONTROL for R4-L3: even a write of the same phase is refused, because a terminal
      // journal's projection token and failure code are part of the record it committed.
      const rewrittenJournal = yield* Schema.decodeUnknownEffect(OperationJournalSchema)({
        ...committed,
        projectionToken: 'token-rewritten',
        updatedAt: now,
      });
      const rewritten = yield* Effect.flip(store.writeJournal(scope, rewrittenJournal));
      expect(rewritten.code).toBe('operation_terminal');
      expect(Option.getOrThrow(yield* store.readJournal(scope, { operationId, tenantId }))).toEqual(committed);

      // An unfinished journal advances forward only: a projected operation never returns to validated.
      const partialId = AccessOperationIdSchema.make(yield* nextUuid);
      const opened = yield* openOperationJournal({
        commandDigest: digestOf('c'),
        operationId: partialId,
        scopeId,
        startedAt: now,
        tenantId,
      });
      const projected = yield* advanceOperationJournal({
        current: opened,
        operationId: partialId,
        phase: 'projected',
        projectionToken: 'token-partial',
        updatedAt: now,
      });
      yield* store.writeJournal(scope, projected);
      const regression = yield* Effect.flip(
        store.writeJournal(scope, { ...projected, phase: 'validated', updatedAt: now }),
      );
      expect(regression.code).toBe('operation_phase_regression');
      expect(Option.getOrThrow(yield* store.readJournal(scope, { operationId: partialId, tenantId })).phase).toBe(
        'projected',
      );

      // PostgreSQL itself refuses the same write, whatever the store does: the trigger is the half of
      // D24 that no TypeScript can guarantee.
      const triggerRefusal = yield* Effect.match(
        adminDatabase.execute(
          sql`update core.access_operation_journals set phase = 'projected' where operation_id = ${operationId}`,
          'objects',
        ),
        {
          onFailure: (failure) =>
            Option.match(findPostgresFailure(failure), { onNone: () => 'unknown', onSome: ({ code }) => code }),
          onSuccess: () => 'accepted',
        },
      );
      expect(triggerRefusal).toBe('55000');

      const stored = Option.getOrThrow(yield* store.readJournal(scope, { operationId, tenantId }));
      expect(stored.phase).toBe('committed');
      expect(stored.projectionToken).toBe('token-1');
      // The refused writes never released or re-took the fence: it stayed Ready for the next writer.
      expect(Option.getOrThrow(yield* store.readFence(scope, { scopeId, tenantId }))).toEqual({
        revision: 3,
        scopeId,
        state: 'Ready',
        tenantId,
      });

      const nextOperation = AccessOperationIdSchema.make(yield* nextUuid);
      const next = yield* withPort(
        store,
        scope,
        runAccessWrite(
          writeRequest({
            receipt,
            write: { operationId: nextOperation, project: counter.project('token-2'), scopeId, tenantId },
          }),
        ),
      );
      expect(next.resumed).toBe(false);
      expect(next.projectionToken).toBe('token-2');
      expect(Option.getOrThrow(yield* store.readFence(scope, { scopeId, tenantId })).revision).toBe(5);
    }),
  );

  suite.effect('refuses a command of another tenant and reaches nothing of it under RLS', () =>
    Effect.gen(function* anotherTenantIsOutOfScope() {
      const { adminDatabase, runtimeDatabase } = yield* databaseFixture;
      const tenantId = yield* seedTenant(adminDatabase, 'owner');
      const otherTenantId = yield* seedTenant(adminDatabase, 'intruder');
      const { scope, scopeId } = yield* seedTenantScope(adminDatabase, tenantId);
      const other = yield* seedTenantScope(adminDatabase, otherTenantId);
      // One store serves both tenants; the scope of each call is the caller's, never the store's.
      const store = storeOf(runtimeDatabase);
      const receipt = yield* receiptOf();
      const counter = yield* projectCounter;
      const operationId = AccessOperationIdSchema.make(yield* nextUuid);
      yield* withPort(
        store,
        scope,
        runAccessWrite(
          writeRequest({ receipt, write: { operationId, project: counter.project('token-1'), scopeId, tenantId } }),
        ),
      );

      // NEGATIVE CONTROL 1: a command for another tenant under this scope is refused before it reaches
      // a row, whether it reads, takes, releases or writes.
      const foreignRead = yield* Effect.flip(store.readFence(scope, { scopeId, tenantId: otherTenantId }));
      expect(foreignRead.code).toBe('fence_unavailable');
      const foreignJournal = yield* Effect.flip(store.readJournal(scope, { operationId, tenantId: otherTenantId }));
      expect(foreignJournal.code).toBe('operation_not_owned');
      const foreignAcquire = yield* Effect.flip(
        store.acquireFence(scope, {
          expectedRevision: 1,
          operationId: AccessOperationIdSchema.make(yield* nextUuid),
          scopeId,
          tenantId: otherTenantId,
        }),
      );
      expect(foreignAcquire.code).toBe('fence_unavailable');
      const foreignRelease = yield* Effect.flip(
        store.releaseFence(scope, { expectedRevision: 3, operationId, scopeId, tenantId: otherTenantId }),
      );
      expect(foreignRelease.code).toBe('fence_unavailable');
      const journal = Option.getOrThrow(yield* store.readJournal(scope, { operationId, tenantId }));
      const foreignWrite = yield* Effect.flip(store.writeJournal(scope, { ...journal, tenantId: otherTenantId }));
      expect(foreignWrite.code).toBe('operation_not_owned');

      // NEGATIVE CONTROL 2: even a command that names its own tenant consistently reaches nothing of
      // the other tenant, because the installed scope's row-level security answers for it.
      expect(Option.isNone(yield* store.readFence(other.scope, { scopeId, tenantId: otherTenantId }))).toBe(true);
      expect(Option.isNone(yield* store.readJournal(other.scope, { operationId, tenantId: otherTenantId }))).toBe(true);
      const hiddenAcquire = yield* Effect.flip(
        store.acquireFence(other.scope, {
          expectedRevision: 1,
          operationId: AccessOperationIdSchema.make(yield* nextUuid),
          scopeId,
          tenantId: otherTenantId,
        }),
      );
      expect(hiddenAcquire.code).toBe('fence_unavailable');

      // The owning scope still reaches both rows, and its own release finds the fence already Ready.
      expect(Option.isSome(yield* store.readFence(scope, { scopeId, tenantId }))).toBe(true);
      expect(Option.isSome(yield* store.readJournal(scope, { operationId, tenantId }))).toBe(true);
      const ownRelease = yield* store.releaseFence(scope, { expectedRevision: 3, operationId, scopeId, tenantId });
      const ownReleaseOutcome = Match.value(ownRelease).pipe(
        Match.tag('Conflict', () => 'conflict' as const),
        Match.tag('Released', () => 'released' as const),
        Match.exhaustive,
      );
      expect(ownReleaseOutcome).toBe('conflict');

      // An operation id is never reused across tenants, even though the other tenant cannot see the
      // journal that already holds it.
      const reused = yield* Effect.flip(
        withPort(
          store,
          other.scope,
          runAccessWrite(
            writeRequest({
              receipt,
              write: {
                operationId,
                project: counter.project('token-intruder'),
                scopeId: other.scopeId,
                tenantId: otherTenantId,
              },
            }),
          ),
        ),
      );
      expect(reused.code).toBe('operation_not_owned');

      // The owner's write is untouched and nothing of the other tenant was ever projected.
      expect(Option.getOrThrow(yield* store.readJournal(scope, { operationId, tenantId })).phase).toBe('committed');
      expect(yield* Ref.get(counter.projected)).toEqual(['token-1']);
      expect(
        Option.getOrThrow(yield* store.readFence(other.scope, { scopeId: other.scopeId, tenantId: otherTenantId })),
      ).toEqual({
        revision: 1,
        scopeId: other.scopeId,
        state: 'Ready',
        tenantId: otherTenantId,
      });
    }),
  );

  suite.effect('lets exactly one of two writers that opened the same operation id with different commands win', () =>
    Effect.gen(function* racingJournalDigests() {
      const { adminDatabase, runtimeDatabase } = yield* databaseFixture;
      const tenantId = yield* seedTenant(adminDatabase, 'journal-digest-race');
      const { scope, scopeId } = yield* seedTenantScope(adminDatabase, tenantId);
      const store = storeOf(runtimeDatabase);
      const operationId = AccessOperationIdSchema.make(yield* nextUuid);
      const startedAt = DateTime.toDateUtc(yield* DateTime.now);
      /** One writer's journal for this operation id: its own command digest and its own projection. */
      const journalOf = (seed: string, projectionToken: string) =>
        openOperationJournal({
          commandDigest: digestOf(seed),
          operationId,
          scopeId,
          startedAt,
          tenantId,
        }).pipe(
          Effect.flatMap((opened) =>
            advanceOperationJournal({
              current: opened,
              operationId,
              phase: 'projected',
              projectionToken,
              updatedAt: startedAt,
            }),
          ),
        );
      const first = yield* journalOf('a', 'token-a');
      const second = yield* journalOf('b', 'token-b');

      // Both writers observe that this operation id has no journal before either of them opens one.
      // That is the lost-update window in which an unguarded upsert let the loser advance the winner's
      // journal into its own phase and projection token (R4-M2); the barrier makes both enter it.
      const bothSawNoJournal = yield* Deferred.make<null>();
      const observed = yield* Ref.make(0);
      const joinBarrier = Ref.updateAndGet(observed, (count) => count + 1).pipe(
        Effect.flatMap((count) => (count >= 2 ? Deferred.succeed(bothSawNoJournal, null) : Effect.succeed(false))),
        Effect.asVoid,
        Effect.andThen(Deferred.await(bothSawNoJournal)),
      );
      const gated: AccessWriteJournalStoreService = {
        ...store,
        writeJournal: (callScope, journal) =>
          store.readJournal(callScope, { operationId, tenantId }).pipe(
            Effect.tap(observeNoJournal),
            Effect.tap(() => joinBarrier),
            Effect.andThen(store.writeJournal(callScope, journal)),
          ),
      };

      const results = yield* Effect.all(
        [gated.writeJournal(scope, first).pipe(Effect.result), gated.writeJournal(scope, second).pipe(Effect.result)],
        { concurrency: 2 },
      );
      expect(results.filter(Result.isSuccess)).toHaveLength(1);
      const refused = results.flatMap((result) => (Result.isFailure(result) ? [result.failure] : []));
      expect(refused).toHaveLength(1);
      expect(refused[0]?.code).toBe('operation_command_mismatch');

      // Exactly one journal is stored, and the loser rewrote neither its command nor its projection.
      const stored = Option.getOrThrow(yield* store.readJournal(scope, { operationId, tenantId }));
      const winner = stored.commandDigest === first.commandDigest ? first : second;
      expect([first.commandDigest, second.commandDigest]).toContain(stored.commandDigest);
      expect(stored.phase).toBe('projected');
      expect(stored.projectionToken).toBe(winner.projectionToken);
    }),
  );

  suite.effect('reports a journal PostgreSQL refuses for good as a lifecycle refusal, never as unavailability', () =>
    Effect.gen(function* permanentJournalRefusal() {
      const { adminDatabase, runtimeDatabase } = yield* databaseFixture;
      const tenantId = yield* seedTenant(adminDatabase, 'journal-refusal');
      const { scope, scopeId } = yield* seedTenantScope(adminDatabase, tenantId);
      const store = storeOf(runtimeDatabase);
      const operationId = AccessOperationIdSchema.make(yield* nextUuid);
      const startedAt = DateTime.toDateUtc(yield* DateTime.now);
      const opened = yield* openOperationJournal({
        commandDigest: digestOf('d'),
        operationId,
        scopeId,
        startedAt,
        tenantId,
      });
      const projected = yield* advanceOperationJournal({
        current: opened,
        operationId,
        phase: 'projected',
        projectionToken: 'token-projected',
        updatedAt: startedAt,
      });
      yield* store.writeJournal(scope, projected);

      // A committed journal must carry the projection token it committed, and the table says so in
      // SQL. The store does not trust the record it is handed, so PostgreSQL's refusal of it is the
      // answer — and a refusal that no retry can satisfy is never reported as unavailability (R4-M1).
      const withoutToken: OperationJournal = {
        commandDigest: projected.commandDigest,
        operationId: projected.operationId,
        phase: 'committed',
        scopeId: projected.scopeId,
        startedAt: projected.startedAt,
        tenantId: projected.tenantId,
        updatedAt: startedAt,
      };
      const refused = yield* Effect.flip(store.writeJournal(scope, withoutToken));
      expect(refused.code).toBe('operation_journal_invalid');
      // Nothing of the refused write survived: the journal is still the projection it stored.
      expect(Option.getOrThrow(yield* store.readJournal(scope, { operationId, tenantId }))).toEqual(projected);
    }),
  );
});
