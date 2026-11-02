import { randomUUID } from 'node:crypto';
import { loadDatabaseConnectionPair } from '@app/core-runtime';
import { makeIsolatedNativeDatabaseFixture } from '@app/core-runtime/testing/isolated-native-database';
import { NodeChildProcessSpawner, NodeCrypto, NodeServices } from '@effect/platform-node';
import { and, eq, sql } from 'drizzle-orm';
import { Config, Deferred, Effect, Fiber, FileSystem, Layer, Path, Result, Schema, Stream } from 'effect';
import { ChildProcess } from 'effect/process';
import { expect, it } from 'effect-rstest';
import {
  DecidePurchaseApprovalRequestInputSchema,
  PurchasingApprovalRejected,
} from '../../shared/domain/purchasing-approval.ts';
import {
  approvalDecisions,
  approvalRoutes,
  purchaseApprovalRequests,
  purchaseProposalRevisions,
} from '../../src/database/schema.ts';
import { enrollmentApplicationCompositionSnapshot } from '../support/enrollment-application-composition.ts';
import { makePurchasingApprovalNativeFixture } from '../support/purchasing-approval-native.ts';

const services = NodeChildProcessSpawner.layer.pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(NodeCrypto.layer),
);

const journalFingerprint = Effect.fn('ApprovalExpiry.journalFingerprint')(function* journalFingerprint(connection: {
  readonly connectionString: string;
  readonly database: string;
  readonly user: string;
}) {
  const child = yield* ChildProcess.make(
    'docker',
    [
      'exec',
      '-i',
      '-e',
      'PGPASSWORD',
      'ontos-db',
      'psql',
      '--host',
      'localhost',
      '--username',
      connection.user,
      '--dbname',
      connection.database,
      '--tuples-only',
      '--no-align',
      '--quiet',
      '--command',
      "set time zone 'UTC'; select md5(coalesce(jsonb_agg(to_jsonb(journal) order by to_jsonb(journal)::text)::text,'[]')) from drizzle.__drizzle_migrations_commerce_customer_context journal",
    ],
    {
      env: {
        PATH: yield* Config.String('PATH'),
        PGPASSWORD: decodeURIComponent(new URL(connection.connectionString).password),
      },
      stderr: 'pipe',
      stdout: 'pipe',
    },
  );
  const [status, output] = yield* Effect.all(
    [child.exitCode, child.stdout.pipe(Stream.decodeText(), Stream.runCollect), Stream.runDrain(child.stderr)],
    { concurrency: 3 },
  );
  expect(Number(status)).toBe(0);
  return yield* Schema.decodeUnknownEffect(Schema.String.check(Schema.isPattern(/^[a-f0-9]{32}$/u)))(
    output.join('').trim(),
  );
});

// Real source bookkeeping only, matching the schema clone. No fabricated applied rows or business data.
const copyOwnerBookkeeping = Effect.fn('ApprovalExpiry.copyOwnerBookkeeping')(
  function* copyOwnerBookkeeping(connections: {
    readonly admin: { readonly connectionString: string; readonly database: string; readonly user: string };
  }) {
    const source = yield* loadDatabaseConnectionPair({ envPath: '/dev/null' });
    const before = yield* journalFingerprint(source.admin);
    const dump = yield* ChildProcess.make(
      'docker',
      [
        'exec',
        '-i',
        '-e',
        'PGPASSWORD',
        'ontos-db',
        'pg_dump',
        '--host',
        'localhost',
        '--username',
        source.admin.user,
        '--dbname',
        source.admin.database,
        '--data-only',
        '--column-inserts',
        '--table',
        'drizzle.__drizzle_migrations_commerce_customer_context',
      ],
      {
        env: {
          PATH: yield* Config.String('PATH'),
          PGPASSWORD: decodeURIComponent(new URL(source.admin.connectionString).password),
        },
        stderr: 'pipe',
        stdout: 'pipe',
      },
    );
    const restore = yield* ChildProcess.make(
      'docker',
      [
        'exec',
        '-i',
        '-e',
        'PGPASSWORD',
        'ontos-db',
        'psql',
        '--host',
        'localhost',
        '--username',
        connections.admin.user,
        '--dbname',
        connections.admin.database,
        '--set',
        'ON_ERROR_STOP=1',
        '--quiet',
      ],
      {
        env: {
          PATH: yield* Config.String('PATH'),
          PGPASSWORD: decodeURIComponent(new URL(connections.admin.connectionString).password),
        },
        stderr: 'pipe',
        stdin: dump.stdout,
        stdout: 'pipe',
      },
    );
    const [dumpExit, restoreExit] = yield* Effect.all(
      [
        dump.exitCode,
        restore.exitCode,
        Stream.runDrain(dump.stderr),
        Stream.runDrain(restore.stderr),
        Stream.runDrain(restore.stdout),
      ],
      { concurrency: 5 },
    );
    expect(Number(dumpExit)).toBe(0);
    expect(Number(restoreExit)).toBe(0);
    expect(yield* journalFingerprint(connections.admin)).toBe(before);
    expect(yield* journalFingerprint(source.admin)).toBe(before);
  },
);

// Actual CLI/full immutable journal. Child-only configuration never changes the source database.
const migrateOwner = Effect.fn('ApprovalExpiry.migrateOwner')(function* migrateOwner(
  connections: {
    readonly admin: { readonly connectionString: string };
    readonly runtime: { readonly connectionString: string };
  },
  command: 'migrate' | 'verify' = 'migrate',
  horizon: 'BEFORE_EXPIRY' | 'CURRENT' = 'CURRENT',
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: 'ontos-approval-expiry-' });
  const configuration = path.join(directory, 'drizzle.config.mjs');
  const ownerDirectory = new URL('../../drizzle/', import.meta.url).pathname;
  const migrations = horizon === 'CURRENT' ? ownerDirectory : path.join(directory, 'migrations');
  if (horizon === 'BEFORE_EXPIRY') {
    yield* fs.makeDirectory(migrations);
    for (const folder of yield* fs.readDirectory(ownerDirectory)) {
      // Disposable OLD-behavior cohort retains every unrelated current migration.
      // CURRENT is proved separately on a fresh isolated database with the full owner journal.
      if (folder !== '20261019181146_approval_post_lock_expiry') {
        yield* fs.copy(path.join(ownerDirectory, folder), path.join(migrations, folder));
      }
    }
  }
  yield* fs.writeFileString(
    configuration,
    `export default { dialect:'postgresql', out:process.env.ONTOS_CCC_APPROVAL_MIGRATIONS, schema:process.env.ONTOS_CCC_APPROVAL_SCHEMA, dbCredentials:{url:process.env.DATABASE_ADMIN_URL}, migrations:{schema:'drizzle',table:'__drizzle_migrations_commerce_customer_context'} };`,
  );
  const child = yield* ChildProcess.make(
    'mise',
    [
      'exec',
      '--',
      'pnpm',
      '--filter',
      '@app/commerce-customer-context',
      'exec',
      ...(command === 'migrate'
        ? ['drizzle-kit', 'migrate', '--config', configuration]
        : ['node', 'scripts/verify-db-schema.mts']),
    ],
    {
      cwd: new URL('../../../../', import.meta.url).pathname,
      env: {
        DATABASE_ADMIN_URL: connections.admin.connectionString,
        DATABASE_URL: connections.runtime.connectionString,
        ONTOS_CCC_APPROVAL_MIGRATIONS: migrations,
        ONTOS_CCC_APPROVAL_SCHEMA: new URL('../../src/database/schema.ts', import.meta.url).pathname,
      },
      extendEnv: true,
      stderr: 'pipe',
      stdin: 'ignore',
      stdout: 'pipe',
    },
  );
  const [status, diagnostics] = yield* Effect.all(
    [child.exitCode, child.stderr.pipe(Stream.decodeText(), Stream.runCollect), Stream.runDrain(child.stdout)],
    { concurrency: 3 },
  );
  if (Number(status) !== 0) {
    const text = diagnostics.join('');
    const sqlState = /(?:code|sqlState|sqlstate):\s*['"](?<sqlState>[A-Z0-9]{5})['"]/u.exec(text)?.groups?.sqlState;
    const position = /position:\s*['"]?(?<position>\d+)/u.exec(text)?.groups?.position;
    yield* Effect.logError({
      failureClass: 'MIGRATION_CHILD_FAILURE',
      knownLeasedBoundary: '20261019181146_approval_post_lock_expiry',
      position: position ?? 'UNAVAILABLE',
      sqlState: sqlState ?? 'UNAVAILABLE',
    });
  }
  expect(Number(status)).toBe(0);
});

const scenario = Effect.fn('ApprovalExpiry.nativeScenario')(function* nativeScenario({
  ttlMilliseconds = 5000,
  twoLevels = false,
  wrongApprover = false,
}: {
  readonly ttlMilliseconds?: number;
  readonly twoLevels?: boolean;
  readonly wrongApprover?: boolean;
} = {}) {
  const snapshot = yield* enrollmentApplicationCompositionSnapshot;
  const isolated = yield* makeIsolatedNativeDatabaseFixture({
    compositionSnapshot: snapshot,
    mode: 'schema-only',
    purpose: 'stabilization-1246-approval-post-lock-expiry',
  });
  yield* isolated.assertClonedSchema();
  const source = yield* loadDatabaseConnectionPair({ envPath: '/dev/null' });
  const sourceJournal = yield* journalFingerprint(source.admin);
  const oldSql = yield* Config.Boolean('ONTOS_APPROVAL_EXPIRY_PRE_MIGRATION').pipe(Config.withDefault(false));
  const horizon = oldSql ? 'BEFORE_EXPIRY' : 'CURRENT';
  yield* copyOwnerBookkeeping(isolated.connections);
  yield* migrateOwner(isolated.connections, 'migrate', horizon);
  yield* migrateOwner(isolated.connections, 'verify', horizon);
  const migratedJournal = yield* journalFingerprint(isolated.connections.admin);
  yield* migrateOwner(isolated.connections, 'migrate', horizon);
  expect(yield* journalFingerprint(isolated.connections.admin)).toBe(migratedJournal);
  yield* Effect.addFinalizer(() =>
    Effect.scoped(
      journalFingerprint(source.admin).pipe(
        Effect.tap((fingerprint) => Effect.sync(() => expect(fingerprint).toBe(sourceJournal))),
        Effect.orDie,
      ),
    ),
  );
  const native = yield* makePurchasingApprovalNativeFixture({ connections: isolated.connections, snapshot });
  const produced = yield* native.createRequest({ ttlMilliseconds, twoLevels, wrongApprover });
  const { admin, fixture, legalEntityId, principal, runtimeContext, tenantId } = native;
  const { command, decide, expiresAtText, request } = produced;
  const readState = () =>
    Effect.all(
      {
        decisions: admin.select().from(approvalDecisions).where(eq(approvalDecisions.tenantId, tenantId)),
        proposals: admin
          .select()
          .from(purchaseProposalRevisions)
          .where(eq(purchaseProposalRevisions.tenantId, tenantId)),
        requests: admin.select().from(purchaseApprovalRequests).where(eq(purchaseApprovalRequests.tenantId, tenantId)),
        routes: admin.select().from(approvalRoutes).where(eq(approvalRoutes.tenantId, tenantId)),
      },
      { concurrency: 1 },
    );
  const waitUntilExpired = () =>
    Effect.gen(function* awaitServerExpiry() {
      for (let attempt = 0; attempt < 1000; attempt += 1) {
        const [row] = yield* admin.execute<{ expired: boolean }>(
          sql`select clock_timestamp() >= ${expiresAtText}::timestamptz as expired, pg_sleep(0.01)`,
          'objects',
        );
        if (row?.expired) {
          return;
        }
        yield* Effect.yieldNow;
      }
      yield* Effect.die('The server clock did not reach the request expiry deadline');
    });
  const waitForBlock = (blocker: number, tenantLock = false) =>
    Effect.gen(function* awaitNativeLock() {
      for (let attempt = 0; attempt < 1000; attempt += 1) {
        const [row] = yield* admin.execute<{ pid: number; startedBeforeExpiry: boolean; tenantLock: boolean }>(
          sql`select pid, xact_start < ${expiresAtText}::timestamptz as "startedBeforeExpiry",
          position('"core"."tenants"' in query) > 0 as "tenantLock"
          from pg_stat_activity where datname = current_database() and ${blocker}::integer = any(pg_blocking_pids(pid))`,
          'objects',
        );
        if (row !== undefined) {
          expect(row.startedBeforeExpiry).toBe(true);
          if (tenantLock) {
            expect(row.tenantLock).toBe(true);
          }
          return row.pid;
        }
        yield* Effect.yieldNow;
      }
      return yield* Effect.die('The deciding transaction did not wait on the expected native lock');
    });
  const installedPredicate = () =>
    admin.execute<{ inclusive: boolean; operationClockPreserved: boolean; postLockSample: boolean }>(
      sql`select
    position('v_eligibility_at := clock_timestamp();' in pg_get_functiondef('commerce_customer_context.decide_purchase_approval_request(uuid,uuid,jsonb)'::regprocedure)) > position('FOR UPDATE;' in pg_get_functiondef('commerce_customer_context.decide_purchase_approval_request(uuid,uuid,jsonb)'::regprocedure)) as "postLockSample",
    position('v_eligibility_at >= v_request_row.expires_at' in pg_get_functiondef('commerce_customer_context.decide_purchase_approval_request(uuid,uuid,jsonb)'::regprocedure)) > 0 as inclusive,
    position('v_operation_at timestamptz := now();' in pg_get_functiondef('commerce_customer_context.decide_purchase_approval_request(uuid,uuid,jsonb)'::regprocedure)) > 0 as "operationClockPreserved"`,
      'objects',
    );
  return {
    admin,
    assertSourceJournalUnchanged: () =>
      Effect.scoped(journalFingerprint(source.admin)).pipe(
        Effect.tap((fingerprint) => Effect.sync(() => expect(fingerprint).toBe(sourceJournal))),
      ),
    command,
    decide,
    expiresAtText,
    fixture,
    installedPredicate,
    legalEntityId,
    native,
    principal,
    readState,
    request,
    runtimeContext,
    tenantId,
    waitForBlock,
    waitUntilExpired,
  };
});

const expectConflict = (result: Result.Result<unknown, unknown>) => {
  expect(Result.isFailure(result)).toBe(true);
  if (Result.isFailure(result)) {
    expect(Schema.is(PurchasingApprovalRejected)(result.failure)).toBe(true);
    if (Schema.is(PurchasingApprovalRejected)(result.failure)) {
      expect(result.failure.code).toBe('COMMIT_CONFLICT');
    }
  }
};

it.live('rejects a new Decision after a real unchanged request-row lock waits across expiry', () =>
  Effect.scoped(
    Effect.gen(function* postLockExpiry() {
      const current = yield* scenario();
      const before = yield* current.readState();
      const held = yield* Deferred.make<number>();
      const release = yield* Deferred.make<boolean>();
      const holder = yield* current.admin
        .transaction((transaction) =>
          Effect.gen(function* holdRequestRow() {
            const [connection] = yield* transaction.execute<{ pid: number }>(
              sql`select pg_backend_pid() as pid`,
              'objects',
            );
            yield* transaction
              .select()
              .from(purchaseApprovalRequests)
              .where(
                and(
                  eq(purchaseApprovalRequests.tenantId, current.tenantId),
                  eq(purchaseApprovalRequests.requestResourceId, current.request.request.requestRef.resourceId),
                ),
              )
              .for('update');
            if (connection === undefined) {
              return yield* Effect.die('Holder native connection unavailable');
            }
            yield* Deferred.succeed(held, connection.pid);
            return yield* Deferred.await(release);
          }),
        )
        .pipe(Effect.forkScoped);
      const blocker = yield* Deferred.await(held);
      const decision = yield* current.decide().pipe(Effect.result, Effect.forkScoped);
      const waiter = yield* current.waitForBlock(blocker);
      yield* current.waitUntilExpired();
      expect(yield* current.waitForBlock(blocker)).toBe(waiter);
      yield* Deferred.succeed(release, true);
      yield* Fiber.join(holder);
      expectConflict(yield* Fiber.join(decision));
      for (const decisionKind of ['RETURN', 'REJECT'] as const) {
        expectConflict(
          yield* Effect.result(
            current.decide({ decision: decisionKind, reason: 'A new late decision must remain unavailable' }),
          ),
        );
      }
      expect(yield* current.readState()).toEqual(before);
      expect(yield* current.installedPredicate()).toEqual([
        { inclusive: true, operationClockPreserved: true, postLockSample: true },
      ]);
      yield* current.assertSourceJournalUnchanged();
    }),
  ).pipe(Effect.provide(services)),
);

it.live('commits a pre-expiry Decision and recovers its exact immutable result after expiry', () =>
  Effect.scoped(
    Effect.gen(function* recoverCommittedDecision() {
      const current = yield* scenario();
      const first = yield* current.decide();
      expect(first.outcome).toBe('DECISION_RECORDED');
      expect(first.request.status).toBe('APPROVED');
      const committed = yield* current.readState();
      expect(committed.decisions).toHaveLength(1);
      yield* current.waitUntilExpired();
      const replayed = yield* current.decide();
      expect(replayed.outcome).toBe('ALREADY_RECORDED');
      expect(replayed.decision).toEqual(first.decision);
      expect(yield* current.readState()).toEqual(committed);
      const conflict = yield* Effect.result(current.decide({ reason: 'Changed historical intent' }));
      expect(Result.isFailure(conflict)).toBe(true);
      expect(yield* current.readState()).toEqual(committed);
      expectConflict(yield* Effect.result(current.decide({ idempotencyKey: randomUUID() })));
      expect(yield* current.readState()).toEqual(committed);
      yield* current.assertSourceJournalUnchanged();
    }),
  ).pipe(Effect.provide(services)),
);

it.live('retains serialized CAS, exact proposal/scope guards and atomic owner rollback', () =>
  Effect.scoped(
    Effect.gen(function* guardedDecision() {
      const current = yield* scenario({ ttlMilliseconds: 30_000 });
      const before = yield* current.readState();
      const invalidInputs = [
        { ...current.command, expectedRequestRevision: 2 },
        {
          ...current.command,
          proposalRevisionRef: { ...current.command.proposalRevisionRef, resourceId: randomUUID() },
        },
        { ...current.command, counterpartyRef: { ...current.command.counterpartyRef, tenantId: randomUUID() } },
        { ...current.command, storefrontId: 'foreign-storefront' },
      ].map((input) => Schema.decodeUnknownSync(Schema.toType(DecidePurchaseApprovalRequestInputSchema))(input));
      for (const patch of invalidInputs) {
        expect(Result.isFailure(yield* Effect.result(current.decide(patch)))).toBe(true);
        expect(yield* current.readState()).toEqual(before);
      }
      current.fixture.faultNextTransaction('rollback');
      const rolledBack = yield* Effect.result(current.decide());
      expect(Result.isFailure(rolledBack)).toBe(true);
      expect(yield* current.readState()).toEqual(before);
      const contenders = yield* Effect.all(
        [Effect.result(current.decide()), Effect.result(current.decide({ idempotencyKey: randomUUID() }))],
        { concurrency: 2 },
      );
      expect(contenders.filter(Result.isSuccess)).toHaveLength(1);
      expect(contenders.filter(Result.isFailure)).toHaveLength(1);
      const committed = yield* current.readState();
      expect(committed.decisions).toHaveLength(1);
      expect(committed.requests[0]?.requestRevision).toBe(2);
      expect(committed.requests[0]?.status).toBe('APPROVED');
      yield* current.assertSourceJournalUnchanged();
    }),
  ).pipe(Effect.provide(services)),
);

it.live('preserves successive levels and derives the actor from the trusted owner scope', () =>
  Effect.scoped(
    Effect.gen(function* multipleLevels() {
      const current = yield* scenario({ ttlMilliseconds: 30_000, twoLevels: true });
      const first = yield* current.decide({ actor: { principalId: randomUUID(), tenantId: randomUUID() } });
      expect(first.decision.actor).toEqual(current.principal);
      expect(first.request.status).toBe('PENDING');
      expect(first.request.route.currentLevelOrder).toBe(2);
      expectConflict(yield* Effect.result(current.decide({ idempotencyKey: randomUUID() })));
      const second = yield* current.decide({
        expectedRequestRevision: first.request.requestRevision,
        idempotencyKey: randomUUID(),
      });
      expect(second.request.status).toBe('APPROVED');
      expect(second.decision.levelOrder).toBe(2);
      expect((yield* current.readState()).decisions).toHaveLength(2);
      yield* current.assertSourceJournalUnchanged();
    }),
  ).pipe(Effect.provide(services)),
);

it.live('keeps a wrong Current route approver denied without writing a Decision', () =>
  Effect.scoped(
    Effect.gen(function* wrongRouteApprover() {
      const current = yield* scenario({ ttlMilliseconds: 30_000, wrongApprover: true });
      const before = yield* current.readState();
      const rejected = yield* Schema.decodeUnknownEffect(PurchasingApprovalRejected)(
        yield* Effect.flip(current.decide()),
      );
      expect(rejected.code).toBe('NOT_ROUTE_ELIGIBLE');
      expect(yield* current.readState()).toEqual(before);
      yield* current.assertSourceJournalUnchanged();
    }),
  ).pipe(Effect.provide(services)),
);

it.live(
  'refuses a different authorized Decision after an unrelated Action holds the actual Core tenant lock across expiry',
  () =>
    Effect.scoped(
      Effect.gen(function* tenantSerializationExpiry() {
        const current = yield* scenario();
        const other = yield* current.native.createRequest();
        const before = yield* current.readState();
        const held = yield* Deferred.make<number>();
        const release = yield* Deferred.make<boolean>();
        // A is a request-row orchestrator. B and C are genuine, independently authorized registered Actions.
        // Three native transactions share one owned database; B never targets C's request or route.
        const orchestrator = yield* current.admin
          .transaction((transaction) =>
            Effect.gen(function* holdUnrelatedRequest() {
              const [row] = yield* transaction.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`, 'objects');
              yield* transaction
                .select()
                .from(purchaseApprovalRequests)
                .where(
                  and(
                    eq(purchaseApprovalRequests.tenantId, current.tenantId),
                    eq(purchaseApprovalRequests.requestResourceId, current.request.request.requestRef.resourceId),
                  ),
                )
                .for('update');
              if (row === undefined) {
                return yield* Effect.die('Native orchestrator connection unavailable');
              }
              yield* Deferred.succeed(held, row.pid);
              return yield* Deferred.await(release);
            }),
          )
          .pipe(Effect.forkScoped);
        const pidA = yield* Deferred.await(held);
        const actionB = yield* current.decide().pipe(Effect.result, Effect.forkScoped);
        const pidB = yield* current.waitForBlock(pidA);
        const actionC = yield* other.decide().pipe(Effect.result, Effect.forkScoped);
        const pidC = yield* current.waitForBlock(pidB, true);
        expect(pidC).not.toBe(pidB);
        expect(yield* current.readState()).toEqual(before);
        // Server clock, not a frozen Effect time or a sleep-only guess, determines release.
        yield* current.waitUntilExpired();
        for (let attempt = 0; attempt < 1000; attempt += 1) {
          const [clock] = yield* current.admin.execute<{ expired: boolean }>(
            sql`select clock_timestamp() >= ${other.expiresAtText}::timestamptz as expired, pg_sleep(0.01)`,
            'objects',
          );
          if (clock?.expired) {
            break;
          }
          if (attempt === 999) {
            yield* Effect.die('The unrelated request did not reach server expiry');
          }
        }
        expect(yield* current.waitForBlock(pidA)).toBe(pidB);
        expect(yield* current.waitForBlock(pidB, true)).toBe(pidC);
        yield* Deferred.succeed(release, true);
        yield* Fiber.join(orchestrator);
        expectConflict(yield* Fiber.join(actionB));
        expectConflict(yield* Fiber.join(actionC));
        expect(yield* current.readState()).toEqual(before);
        yield* current.assertSourceJournalUnchanged();
      }),
    ).pipe(Effect.provide(services)),
);

it.live('retains pre-expiry return and reject transitions on their exact immutable proposal lineages', () =>
  Effect.scoped(
    Effect.gen(function* terminalDecisionControls() {
      const current = yield* scenario({ ttlMilliseconds: 30_000 });
      const returned = yield* current.decide({ decision: 'RETURN', reason: 'Native pre-expiry return control' });
      expect(returned.request.status).toBe('RETURNED');
      expect(returned.request.proposal.state).toBe('SUPERSEDED');
      const other = yield* current.native.createRequest({ ttlMilliseconds: 30_000 });
      const rejected = yield* other.decide({ decision: 'REJECT', reason: 'Native pre-expiry reject control' });
      expect(rejected.request.status).toBe('REJECTED');
      expect(rejected.request.proposal.state).toBe('SUPERSEDED');
      const committed = yield* current.readState();
      expect(committed.decisions).toHaveLength(2);
      expect(committed.requests).toHaveLength(2);
      expect(committed.requests.map(({ status }) => status)).toEqual(expect.arrayContaining(['REJECTED', 'RETURNED']));
      yield* current.assertSourceJournalUnchanged();
    }),
  ).pipe(Effect.provide(services)),
);
