import { NodeServices } from '@effect/platform-node';
import {
  ConfigProvider,
  Console,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Logger,
  Match,
  Schema,
  Sink,
  Stream,
} from 'effect';
import { systemError } from 'effect/PlatformError';
import { TestClock } from 'effect/testing';
import { Command } from 'effect/cli';
import { HttpClient } from 'effect/http';
import { ChildProcessSpawner } from 'effect/process';
import type { ChildProcess } from 'effect/process';
import { ConnectionError, SqlError } from 'effect/sql/SqlError';
import { expect, it } from 'effect-rstest';

import { CoreDatabase } from '../../packages/core-runtime/src/db/client.ts';
import type { applicationCompositionAuthority } from '../../packages/core-runtime/src/db/schema.ts';
import { ApplicationCompositionAuthorityError } from '../../packages/core-runtime/src/modules/application-composition-authority.ts';
import {
  migratedRevisionForSchemaRetry,
  readApplicationCompositionReadiness,
  withApplicationCompositionReadinessDeadline,
} from '../application-composition-authority-publication.mts';
import { makeTestDatabase } from '../../packages/core-runtime/tests/support/database.ts';
import {
  migrateStageDemoOwnerSchemas,
  stageDemoMigrationCommand,
  StageDemoMigrationError,
} from '../stage-demo-migrate.mts';
import { ZeropsPublicApiLive } from '../zerops-public-api.mts';
import { StageDeployDiagnosticSchema } from '../stage-deploy-diagnostics.mts';

const REVISION = '1'.repeat(64);
const PUBLICATION_LOCK_QUERY = 'pg_advisory_lock(';
const READINESS = '--readiness';
const CONTINUE_PUBLICATION = '--continue-publication';
const RESUME_MIGRATED = '--resume-migrated-revision';
const runStageDemoMigration = Command.runWith(stageDemoMigrationCommand, { renderErrors: false, version: '1.0.0' });
const DURABLE_DRAINED = 'DURABLE DRAINED';
const CHILD_RELEASED = 'CHILD RELEASED';
const COMMITTED_MIGRATED = 'COMMITTED migrated';
const COMMITTED_SEALED = 'COMMITTED sealed';
const AUTHORITY_CHECK_FAILED = 'authority check failed';
const PENDING_WORK = 'pending-work';
const AuthorityChangeSchema = Schema.Literals(['closed', 'draining', 'sealed', 'migrated']);
type Phase = (typeof applicationCompositionAuthority.$inferSelect)['phase'];
interface FixtureOptions {
  readonly authorityMissing?: boolean;
  readonly childNeverExits?: boolean;
  readonly durableAdmission?: 'open' | 'closed';
  readonly durableBlocks?: readonly boolean[];
  readonly durableRemainsBlocked?: boolean;
  readonly exitCode?: number;
  readonly fresh?: boolean;
  readonly hangQuery?: string;
  readonly initialized?: boolean;
  readonly initialPhase?: Phase;
  readonly leaseRemainingMs?: number;
  readonly lockGrantedWithoutResponse?: boolean;
  readonly outboxBlocks?: readonly boolean[];
  readonly readinessCounts?: { readonly deliveries: number; readonly durable: number; readonly messages: number };
  readonly sealBlocked?: boolean;
  readonly spawnFailure?: ReturnType<typeof systemError>;
  readonly spawnHangs?: boolean;
  readonly sqlFailure?: SqlError;
}

/** Runs the real native lifecycle over scripted SQL and the native process service, without a database or child. */
const migrationFixture = (options: FixtureOptions = {}) => {
  let phase = options.initialPhase ?? 'active';
  let admission = options.durableAdmission ?? (phase === 'active' ? 'open' : 'closed');
  let pending: typeof AuthorityChangeSchema.Type | null = null;
  let transactionDepth = 0;
  let locked = false;
  let durableRead = 0;
  let outboxRead = 0;
  const events: string[] = [];
  const queries: string[] = [];
  const commands: ChildProcess.Command[] = [];
  const noNetwork = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make(() => Effect.die('Unexpected provider request in stage migration regression')),
  );
  const recordTransaction = (sql: string) => {
    if (sql === 'BEGIN') {
      transactionDepth += 1;
      pending = null;
    } else if (sql === 'COMMIT' || sql === 'ROLLBACK') {
      transactionDepth -= 1;
      if (sql === 'COMMIT' && pending !== null) {
        if (pending === 'closed') {
          admission = pending;
        } else {
          phase = pending;
        }
        events.push(`COMMITTED ${pending}`);
      }
      pending = null;
    }
  };
  const readAuthority = (sql: string) => {
    if (options.authorityMissing === true) {
      return [];
    }
    // The scripted connection maps Object.values to Drizzle's selected column order.
    if (sql.includes('"durable_work_admission"')) {
      return [{ durableWorkAdmission: admission, phase, revision: REVISION }];
    }
    return sql.includes('"valid_until"')
      ? [{ phase, revision: REVISION, validUntil: new Date('2030-01-01') }]
      : [{ phase, revision: REVISION }];
  };
  const readBlockers = (sql: string) => {
    if (sql.includes('application_composition_durable_work') && sql.includes('outbox_messages')) {
      const blocked = options.outboxBlocks?.[outboxRead] ?? false;
      outboxRead += 1;
      events.push(blocked ? 'OUTBOX BLOCKED' : 'OUTBOX DRAINED');
      return [{ blocked }];
    }
    if (sql.includes('application_composition_durable_work')) {
      const blocked = options.durableBlocks?.[durableRead] ?? options.durableRemainsBlocked ?? false;
      durableRead += 1;
      events.push(blocked ? 'DURABLE BLOCKED' : DURABLE_DRAINED);
      return [{ blocked }];
    }
    return [{ blocked: options.sealBlocked ?? false }];
  };
  const database = Layer.effect(
    CoreDatabase,
    makeTestDatabase((sql, params) => {
      if (options.sqlFailure !== undefined && sql.includes('as initialized')) {
        return Effect.fail(options.sqlFailure);
      }
      if (options.hangQuery !== undefined && sql.includes(options.hangQuery)) {
        events.push('QUERY WAIT');
        return Effect.never.pipe(
          Effect.onInterrupt(() =>
            Effect.sync(() => {
              events.push('QUERY RELEASED');
            }),
          ),
        );
      }
      return Effect.sync(() => {
        queries.push(sql);
        recordTransaction(sql);
        if (sql.includes('pg_advisory_unlock(')) {
          const wasLocked = locked;
          locked = false;
          events.push('UNLOCK');
          return [{ unlocked: wasLocked }];
        }
        if (sql.includes(PUBLICATION_LOCK_QUERY)) {
          locked = true;
          events.push('LOCK');
          return [];
        }
        if (sql.includes('as initialized')) {
          return [{ initialized: options.initialized ?? true }];
        }
        if (sql.includes('as isolation')) {
          return [{ isolation: 'read committed' }];
        }
        if (sql.includes('as remaining')) {
          return [{ remaining: options.leaseRemainingMs ?? 1_230_000 }];
        }
        if (
          sql.startsWith('select') &&
          sql.includes('from "core"."application_composition_authority"') &&
          !sql.includes('as fresh')
        ) {
          return readAuthority(sql);
        }
        if (sql.includes('as fresh')) {
          return options.authorityMissing === true
            ? []
            : [
                {
                  admission,
                  fresh: options.fresh ?? true,
                  phase,
                  revision: REVISION,
                  ...(options.readinessCounts ?? { deliveries: 0, durable: 0, messages: 0 }),
                },
              ];
        }
        if (sql.includes('as blocked')) {
          return readBlockers(sql);
        }
        if (sql.startsWith('update "core"."application_composition_authority"')) {
          expect(transactionDepth).toBe(1);
          expect(params[2]).toBe(REVISION);
          if (params[3] === 'migrated' && (phase !== 'migrated' || admission !== 'closed')) {
            return [];
          }
          pending = Schema.decodeUnknownSync(AuthorityChangeSchema)(params[0]);
          return [{ revision: REVISION }];
        }
        return [];
      }).pipe(
        Effect.flatMap((rows) =>
          options.lockGrantedWithoutResponse === true && sql.includes(PUBLICATION_LOCK_QUERY)
            ? Effect.never
            : Effect.succeed(rows),
        ),
      );
    }).pipe(Effect.map((executor) => ({ executor }))),
  );
  const releaseChild = Effect.sync(() => {
    events.push(CHILD_RELEASED);
  });
  const spawner = Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) =>
      Effect.gen(function* spawnScriptedMigration() {
        expect(locked).toBe(true);
        expect(phase).toBe('sealed');
        expect(transactionDepth).toBe(0);
        commands.push(command);
        events.push('SPAWN');
        yield* Effect.addFinalizer(() => releaseChild);
        if (options.spawnFailure !== undefined) {
          return yield* options.spawnFailure;
        }
        if (options.spawnHangs === true) {
          return yield* Effect.never;
        }
        return ChildProcessSpawner.makeHandle({
          all: Stream.empty,
          exitCode:
            options.childNeverExits === true
              ? Effect.never
              : Effect.sync(() => {
                  const code = options.exitCode ?? 0;
                  events.push(`EXIT ${code}`);
                  return ChildProcessSpawner.ExitCode(code);
                }),
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          pid: ChildProcessSpawner.ProcessId(1),
          stderr: Stream.empty,
          stdin: Sink.drain,
          stdout: Stream.empty,
          unref: Effect.succeed(Effect.void),
        });
      }),
    ),
  );
  const layer = Layer.mergeAll(
    database,
    spawner,
    noNetwork,
    ZeropsPublicApiLive.pipe(Layer.provide(noNetwork)),
    ConfigProvider.layer(ConfigProvider.fromUnknown({})),
  );
  return { admission: () => admission, commands, events, layer, phase: () => phase, queries };
};

it.effect(
  'waits for native durable and outbox drain, commits sealing, then scopes the exact workspace chain under the lock',
  () =>
    Effect.gen(function* runsStageMigrationAfterDrain() {
      const fixture = migrationFixture({ durableBlocks: [true, false], outboxBlocks: [true, false] });
      const fiber = yield* migrateStageDemoOwnerSchemas().pipe(Effect.provide(fixture.layer), Effect.forkChild);
      yield* TestClock.adjust('0 seconds');
      expect(fixture.events).toContain('COMMITTED closed');
      expect(fixture.events).toContain('DURABLE BLOCKED');
      expect(fixture.phase()).toBe('active');
      expect(fixture.commands).toEqual([]);
      yield* TestClock.adjust('3 seconds');
      expect(fixture.events).toContain('COMMITTED draining');
      expect(fixture.events).toContain('OUTBOX BLOCKED');
      expect(fixture.commands).toEqual([]);
      yield* TestClock.adjust('3 seconds');
      yield* Fiber.join(fiber);
      expect(fixture.events.slice(-8)).toEqual([
        DURABLE_DRAINED,
        COMMITTED_SEALED,
        'SPAWN',
        'EXIT 0',
        CHILD_RELEASED,
        DURABLE_DRAINED,
        COMMITTED_MIGRATED,
        'UNLOCK',
      ]);
      expect(fixture.phase()).toBe('migrated');
      expect(fixture.commands).toHaveLength(1);
      for (const command of fixture.commands) {
        const standard = Match.value(command).pipe(
          Match.tag('StandardCommand', (value) => ({
            args: value.args,
            command: value.command,
            options: value.options,
          })),
          Match.tag('PipedCommand', () => expect.unreachable('The workspace migration must be one native command')),
          Match.exhaustive,
        );
        expect(standard.command).toBe('pnpm');
        expect(standard.args).toEqual(['db:migrate:prepared:internal']);
        expect(standard.options).toEqual({
          cwd: new URL('../..', import.meta.url).pathname.replace(/\/$/u, ''),
          extendEnv: true,
          stderr: 'inherit',
          stdin: 'ignore',
          stdout: 'inherit',
        });
      }
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect('propagates a nonzero owner migration exit without marking completion or reopening the fence', () =>
  Effect.gen(function* preservesStageMigrationFailure() {
    const fixture = migrationFixture({ exitCode: 7 });
    const failure = yield* migrateStageDemoOwnerSchemas().pipe(Effect.provide(fixture.layer), Effect.flip);
    expect(failure).toEqual(
      new StageDemoMigrationError({
        childStarted: true,
        exitCode: 7,
        message: 'The stage owner migration chain failed',
      }),
    );
    expect(fixture.phase()).toBe('sealed');
    expect(fixture.commands).toHaveLength(1);
    expect(fixture.events).not.toContain(COMMITTED_MIGRATED);
    expect(fixture.events.slice(-3)).toEqual(['EXIT 7', CHILD_RELEASED, 'UNLOCK']);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  'retries an existing sealed authority but refuses an already migrated authority until native publication',
  () =>
    Effect.gen(function* honorsNativeMigrationRecovery() {
      const sealed = migrationFixture({ initialPhase: 'sealed' });
      yield* migrateStageDemoOwnerSchemas().pipe(Effect.provide(sealed.layer));
      expect(sealed.events).toEqual([
        'LOCK',
        'SPAWN',
        'EXIT 0',
        CHILD_RELEASED,
        DURABLE_DRAINED,
        COMMITTED_MIGRATED,
        'UNLOCK',
      ]);
      const migrated = migrationFixture({ initialPhase: 'migrated' });
      const failure = yield* migrateStageDemoOwnerSchemas().pipe(Effect.provide(migrated.layer), Effect.flip);
      expect(Schema.is(StageDemoMigrationError)(failure)).toBe(true);
      expect(failure.message).toContain(AUTHORITY_CHECK_FAILED);
      expect(migrated.phase()).toBe('migrated');
      expect(migrated.commands).toEqual([]);
      expect(migrated.events).toEqual(['LOCK', 'UNLOCK']);
    }).pipe(Effect.provide(NodeServices.layer)),
);

const continuationConfiguration = (revision: string) =>
  ConfigProvider.layer(ConfigProvider.fromUnknown({ ONTOS_RETIRED_COMPOSITION_REVISION: revision }));

it.effect('explicitly reseals the exact closed migrated revision before the verified migration child starts', () =>
  Effect.gen(function* resumesClosedMigratedAuthority() {
    const fixture = migrationFixture({ initialPhase: 'migrated' });
    yield* runStageDemoMigration([RESUME_MIGRATED, REVISION]).pipe(Effect.provide(fixture.layer));
    expect(fixture.events.indexOf(COMMITTED_SEALED)).toBeLessThan(fixture.events.indexOf('SPAWN'));
    expect(fixture.events.indexOf(CHILD_RELEASED)).toBeLessThan(fixture.events.indexOf(COMMITTED_MIGRATED));
    expect(fixture.events.filter((event) => event === 'LOCK')).toHaveLength(1);
    expect(fixture.events.at(-1)).toBe('UNLOCK');
    expect(fixture.commands).toHaveLength(1);
    expect(fixture.phase()).toBe('migrated');
    expect(fixture.admission()).toBe('closed');
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect('never falls back to initial or ordinary migration when an explicit retry target no longer matches', () =>
  Effect.gen(function* refusesStaleSchemaRetries() {
    const cases: readonly { readonly options: FixtureOptions; readonly revision: string }[] = [
      { options: { initialized: false, initialPhase: 'migrated' }, revision: REVISION },
      { options: { authorityMissing: true, initialPhase: 'migrated' }, revision: REVISION },
      { options: { durableAdmission: 'open', initialPhase: 'migrated' }, revision: REVISION },
      { options: { initialPhase: 'active' }, revision: REVISION },
      { options: { initialPhase: 'sealed' }, revision: REVISION },
      { options: { initialPhase: 'migrated' }, revision: '2'.repeat(64) },
      { options: { initialPhase: 'migrated' }, revision: 'not-a-revision' },
      { options: { durableRemainsBlocked: true, initialPhase: 'migrated' }, revision: REVISION },
      { options: { initialPhase: 'migrated', sealBlocked: true }, revision: REVISION },
    ];
    for (const { options, revision } of cases) {
      const fixture = migrationFixture(options);
      const failure = yield* runStageDemoMigration([RESUME_MIGRATED, revision]).pipe(
        Effect.provide(fixture.layer),
        Effect.flip,
      );
      expect(Schema.is(StageDemoMigrationError)(failure)).toBe(true);
      expect(fixture.commands).toEqual([]);
      expect(fixture.events).not.toContain(COMMITTED_SEALED);
      expect(fixture.phase()).toBe(options.initialPhase);
    }
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect('keeps the retry sealed and closed when its migration or verification chain fails', () =>
  Effect.gen(function* retainsFailedRetryFence() {
    const fixture = migrationFixture({ exitCode: 7, initialPhase: 'migrated' });
    yield* runStageDemoMigration([RESUME_MIGRATED, REVISION]).pipe(Effect.provide(fixture.layer), Effect.flip);
    expect(fixture.phase()).toBe('sealed');
    expect(fixture.admission()).toBe('closed');
    expect(fixture.events).not.toContain(COMMITTED_MIGRATED);
    expect(fixture.events.at(-1)).toBe('UNLOCK');
  }).pipe(Effect.provide(NodeServices.layer)),
);

it('selects a schema retry only from a complete exact closed and empty native readiness observation', () => {
  const observed = {
    advisoryOnly: true as const,
    authority: { durableWorkAdmission: 'closed' as const, phase: 'migrated' as const, revision: REVISION },
    blockers: { deliveries: 0, durable: 0, messages: 0 },
    reason: 'replacement-publication-required' as const,
    status: 'blocked' as const,
  };
  expect(migratedRevisionForSchemaRetry(observed, 1)).toBe(REVISION);
  for (const exitCode of [0, 130, 137]) {
    expect(migratedRevisionForSchemaRetry(observed, exitCode)).toBeUndefined();
  }
  const base = { advisoryOnly: observed.advisoryOnly, reason: observed.reason, status: observed.status };
  expect(migratedRevisionForSchemaRetry({ ...base, blockers: observed.blockers }, 1)).toBeUndefined();
  expect(migratedRevisionForSchemaRetry({ ...base, authority: observed.authority }, 1)).toBeUndefined();
  expect(
    migratedRevisionForSchemaRetry(
      { ...observed, authority: { ...observed.authority, durableWorkAdmission: 'open' } },
      1,
    ),
  ).toBeUndefined();
  for (const kind of ['deliveries', 'durable', 'messages'] as const) {
    expect(
      migratedRevisionForSchemaRetry({ ...observed, blockers: { ...observed.blockers, [kind]: 1 } }, 1),
    ).toBeUndefined();
  }
});

it.effect('continues only the exact migrated and closed authority without SQL writes or a migration child', () =>
  Effect.gen(function* continuesCompletedMigration() {
    const fixture = migrationFixture({ initialPhase: 'migrated' });
    yield* runStageDemoMigration([CONTINUE_PUBLICATION]).pipe(
      Effect.provide(continuationConfiguration(REVISION)),
      Effect.provide(fixture.layer),
    );
    expect(fixture.phase()).toBe('migrated');
    expect(fixture.commands).toEqual([]);
    expect(fixture.events).toEqual(['LOCK', 'UNLOCK']);
    expect(fixture.queries.every((query) => query.startsWith('select'))).toBe(true);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect('refuses missing, incomplete, open, wrong-revision and malformed continuation targets', () =>
  Effect.gen(function* rejectsUnprovenContinuation() {
    const cases: readonly { readonly options: FixtureOptions; readonly revision: string }[] = [
      { options: { initialPhase: 'active' }, revision: REVISION },
      { options: { initialPhase: 'draining' }, revision: REVISION },
      { options: { initialPhase: 'sealed' }, revision: REVISION },
      { options: { initialized: false, initialPhase: 'migrated' }, revision: REVISION },
      { options: { authorityMissing: true, initialPhase: 'migrated' }, revision: REVISION },
      { options: { durableAdmission: 'open', initialPhase: 'migrated' }, revision: REVISION },
      { options: { initialPhase: 'migrated' }, revision: '2'.repeat(64) },
      { options: { initialPhase: 'migrated' }, revision: 'not-a-composition-revision' },
    ];
    for (const { options, revision } of cases) {
      const fixture = migrationFixture(options);
      const failure = yield* runStageDemoMigration([CONTINUE_PUBLICATION]).pipe(
        Effect.provide(continuationConfiguration(revision)),
        Effect.provide(fixture.layer),
        Effect.flip,
      );
      expect(Schema.is(ApplicationCompositionAuthorityError)(failure)).toBe(true);
      expect(fixture.commands).toEqual([]);
      expect(fixture.queries.every((query) => query.startsWith('select'))).toBe(true);
    }
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect('rejects unsupported arguments and a missing continuation revision before touching authority', () =>
  Effect.gen(function* rejectsInvalidContinuationInvocation() {
    yield* Effect.forEach([['--skip-migrations'], [CONTINUE_PUBLICATION, 'extra'], [CONTINUE_PUBLICATION]], (args) =>
      Effect.gen(function* rejectsArguments() {
        const fixture = migrationFixture({ initialPhase: 'migrated' });
        const failure = yield* runStageDemoMigration(args).pipe(Effect.provide(fixture.layer), Effect.flip);
        expect(Schema.is(StageDemoMigrationError)(failure)).toBe(args.length === 1 && args[0] === CONTINUE_PUBLICATION);
        expect(fixture.queries).toEqual([]);
        expect(fixture.commands).toEqual([]);
      }),
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect('never starts the runner migration when the native final seal discovers unfinished outbox work', () =>
  Effect.gen(function* rejectsStageMigrationBeforeSeal() {
    const fixture = migrationFixture({ sealBlocked: true });
    const failure = yield* migrateStageDemoOwnerSchemas().pipe(Effect.provide(fixture.layer), Effect.flip);
    expect(Schema.is(StageDemoMigrationError)(failure)).toBe(true);
    expect(failure.message.length).toBeGreaterThan(0);
    expect(fixture.phase()).toBe('draining');
    expect(fixture.commands).toEqual([]);
    expect(fixture.events).not.toContain(COMMITTED_SEALED);
    expect(fixture.events.at(-1)).toBe('UNLOCK');
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect('readiness observes counts and authority using only SELECTs without settlement or child execution', () =>
  Effect.gen(function* readOnlyReadiness() {
    for (const testCase of [
      { options: {}, reason: 'drained', status: 'ready' },
      {
        options: { readinessCounts: { deliveries: 0, durable: 1, messages: 0 } },
        reason: PENDING_WORK,
        status: 'blocked',
      },
      { options: { fresh: false }, reason: 'authority-expired', status: 'blocked' },
      { options: { initialPhase: 'sealed' }, reason: 'authority-sealed', status: 'blocked' },
      { options: { initialPhase: 'migrated' }, reason: 'replacement-publication-required', status: 'blocked' },
      { options: { authorityMissing: true }, reason: 'authority-missing', status: 'unknown' },
      { options: { initialized: false }, reason: 'authority-missing', status: 'unknown' },
    ] satisfies readonly { options: FixtureOptions; reason: string; status: string }[]) {
      const fixture = migrationFixture(testCase.options);
      const result = yield* withApplicationCompositionReadinessDeadline(
        readApplicationCompositionReadiness.pipe(Effect.provide(fixture.layer)),
      );
      expect(result).toMatchObject({ reason: testCase.reason, status: testCase.status });
      expect(fixture.queries.every((query) => query.startsWith('select'))).toBe(true);
      expect(fixture.events).toEqual([]);
      expect(fixture.commands).toEqual([]);
    }
  }),
);

it.effect('counts database provisioning and query waits in the fifty-second diagnostic deadline', () =>
  Effect.gen(function* boundedReadinessFromInvocation() {
    const fixture = migrationFixture({ hangQuery: 'as fresh' });
    const query = yield* withApplicationCompositionReadinessDeadline(
      readApplicationCompositionReadiness.pipe(Effect.provide(fixture.layer)),
    ).pipe(Effect.forkChild);
    yield* TestClock.adjust('49 seconds');
    expect(fixture.events).toEqual(['QUERY WAIT']);
    yield* TestClock.adjust('1 second');
    expect(yield* Fiber.join(query)).toEqual({ advisoryOnly: true, reason: 'diagnostic-timeout', status: 'unknown' });
    const provisioning = Layer.effect(CoreDatabase, Effect.never);
    const acquire = yield* withApplicationCompositionReadinessDeadline(
      readApplicationCompositionReadiness.pipe(Effect.provide(provisioning)),
    ).pipe(Effect.forkChild);
    yield* TestClock.adjust('50 seconds');
    expect(yield* Fiber.join(acquire)).toEqual({ advisoryOnly: true, reason: 'diagnostic-timeout', status: 'unknown' });
    expect(fixture.commands).toEqual([]);
  }),
);

it.effect('a read-only preflight cannot authorize the later seal when native work changes', () =>
  Effect.gen(function* stalePreflightDoesNotAdmitMigration() {
    const fixture = migrationFixture({ sealBlocked: true });
    expect((yield* readApplicationCompositionReadiness.pipe(Effect.provide(fixture.layer))).status).toBe('ready');
    const failure = yield* migrateStageDemoOwnerSchemas().pipe(Effect.provide(fixture.layer), Effect.flip);
    expect(failure.message).toContain(AUTHORITY_CHECK_FAILED);
    expect(fixture.commands).toEqual([]);
    expect(fixture.phase()).toBe('draining');
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  'bounds unchanged live durable work by its explicit budget without declaring it dead or reopening admission',
  () =>
    Effect.gen(function* boundedDurableDrain() {
      const fixture = migrationFixture({ durableRemainsBlocked: true });
      const fiber = yield* migrateStageDemoOwnerSchemas({ drainMs: 60_000 }).pipe(
        Effect.provide(fixture.layer),
        Effect.flip,
        Effect.forkChild,
      );
      yield* TestClock.adjust('59 seconds');
      expect(fixture.commands).toEqual([]);
      expect(fixture.phase()).toBe('active');
      yield* TestClock.adjust('1 second');
      const failure = yield* Fiber.join(fiber);
      expect(failure).toMatchObject({
        authorityPhase: 'active',
        childStarted: false,
        migrationsCompleted: false,
        phase: 'durable-drain',
      });
      expect(failure.message).toContain('not proof of a dead owner');
      expect(fixture.events).toContain('COMMITTED closed');
      expect(fixture.events.at(-1)).toBe('UNLOCK');
      expect(fixture.phase()).toBe('active');
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect('lets long-running work complete after repeated unchanged polls within the explicit drain budget', () =>
  Effect.gen(function* legitimateLiveWorkCanFinish() {
    const fixture = migrationFixture({ durableBlocks: [...Array.from({ length: 25 }, () => true), false] });
    const fiber = yield* migrateStageDemoOwnerSchemas({ drainMs: 90_000 }).pipe(
      Effect.provide(fixture.layer),
      Effect.forkChild,
    );
    yield* TestClock.adjust('60 seconds');
    expect(fixture.commands).toEqual([]);
    yield* TestClock.adjust('15 seconds');
    yield* Fiber.join(fiber);
    expect(fixture.phase()).toBe('migrated');
    expect(fixture.commands).toHaveLength(1);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  'gives the child its own budget and releases it under the lock without marking migration complete on timeout',
  () =>
    Effect.gen(function* boundedChildAfterDrain() {
      const fixture = migrationFixture({ childNeverExits: true, durableBlocks: [true, false] });
      const fiber = yield* migrateStageDemoOwnerSchemas({ drainMs: 5000, migrationMs: 10_000, totalMs: 20_000 }).pipe(
        Effect.provide(fixture.layer),
        Effect.flip,
        Effect.forkChild,
      );
      yield* TestClock.adjust('3 seconds');
      expect(fixture.commands).toHaveLength(1);
      yield* TestClock.adjust('9 seconds');
      expect(fixture.events).not.toContain(CHILD_RELEASED);
      yield* TestClock.adjust('1 second');
      expect(yield* Fiber.join(fiber)).toMatchObject({
        authorityPhase: 'sealed',
        childStarted: true,
        migrationsCompleted: false,
        phase: 'migration',
      });
      expect(fixture.phase()).toBe('sealed');
      expect(fixture.events.slice(-2)).toEqual([CHILD_RELEASED, 'UNLOCK']);
      expect(fixture.events).not.toContain(COMMITTED_MIGRATED);
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect('includes lock/query waits in the overall ceiling and never starts a child when they exhaust it', () =>
  Effect.gen(function* boundedPublicationQueries() {
    for (const hangQuery of [PUBLICATION_LOCK_QUERY, 'as remaining']) {
      const fixture = migrationFixture({ hangQuery });
      const fiber = yield* migrateStageDemoOwnerSchemas({ drainMs: 5000, totalMs: 10_000 }).pipe(
        Effect.provide(fixture.layer),
        Effect.flip,
        Effect.forkChild,
      );
      yield* TestClock.adjust('10 seconds');
      const failure = yield* Fiber.join(fiber);
      expect(Schema.is(StageDemoMigrationError)(failure)).toBe(true);
      if (Schema.is(StageDemoMigrationError)(failure)) {
        expect(failure.childStarted).toBe(false);
      }
      expect(fixture.commands).toEqual([]);
      expect(fixture.phase()).toBe('active');
    }
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  'interruption before and after sealing keeps the committed fence and releases only the owned child and lock',
  () =>
    Effect.gen(function* interruptionKeepsNativeLifecycle() {
      for (const options of [{ durableRemainsBlocked: true }, { childNeverExits: true }]) {
        const fixture = migrationFixture(options);
        const fiber = yield* migrateStageDemoOwnerSchemas().pipe(Effect.provide(fixture.layer), Effect.forkChild);
        yield* TestClock.adjust('0 seconds');
        yield* Fiber.interrupt(fiber);
        expect(fixture.phase()).toBe(options.childNeverExits === true ? 'sealed' : 'active');
        expect(fixture.events).not.toContain(COMMITTED_MIGRATED);
        expect(fixture.events.at(-1)).toBe('UNLOCK');
        expect(fixture.events.includes(CHILD_RELEASED)).toBe(options.childNeverExits === true);
      }
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect('rejects conflicting readiness/continuation and invalid phase budgets without querying authority', () =>
  Effect.gen(function* rejectsUnsafeFlags() {
    for (const args of [
      [READINESS, CONTINUE_PUBLICATION],
      [READINESS, RESUME_MIGRATED, REVISION],
      [CONTINUE_PUBLICATION, RESUME_MIGRATED, REVISION],
      ['--drain-budget-ms', '0'],
      ['--migration-budget-ms', '1200001'],
      ['--total-budget-ms', 'NaN'],
    ]) {
      const fixture = migrationFixture();
      const failure = yield* runStageDemoMigration(args).pipe(Effect.provide(fixture.layer), Effect.flip);
      expect(Schema.is(StageDemoMigrationError)(failure)).toBe(true);
      expect(failure.message.length).toBeGreaterThan(0);
      expect(fixture.queries).toEqual([]);
      expect(fixture.commands).toEqual([]);
    }
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  'the readiness CLI reports pending work without running settlement, acquiring the lock or spawning a child',
  () =>
    Effect.gen(function* readinessCliDoesNotMutate() {
      const clear = migrationFixture();
      yield* runStageDemoMigration([READINESS]).pipe(Effect.provide(clear.layer));
      expect(clear.events).toEqual([]);
      expect(clear.commands).toEqual([]);
      const blocked = migrationFixture({ readinessCounts: { deliveries: 0, durable: 1, messages: 0 } });
      const failure = yield* runStageDemoMigration([READINESS]).pipe(Effect.provide(blocked.layer), Effect.flip);
      expect(Schema.is(StageDemoMigrationError)(failure)).toBe(true);
      if (Schema.is(StageDemoMigrationError)(failure)) {
        expect(failure.childStarted).toBe(false);
        expect(failure.message).toContain(PENDING_WORK);
      }
      expect(blocked.events).toEqual([]);
      expect(blocked.commands).toEqual([]);
      expect(blocked.queries.every((query) => query.startsWith('select'))).toBe(true);
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  'clamps the migration child to the remaining total deadline instead of resetting the publication budget',
  () =>
    Effect.gen(function* remainingDeadlineBoundsChild() {
      const fixture = migrationFixture({ childNeverExits: true, durableBlocks: [true, false] });
      const fiber = yield* migrateStageDemoOwnerSchemas({ drainMs: 5000, migrationMs: 10_000, totalMs: 8000 }).pipe(
        Effect.provide(fixture.layer),
        Effect.flip,
        Effect.forkChild,
      );
      yield* TestClock.adjust('3 seconds');
      expect(fixture.commands).toHaveLength(1);
      yield* TestClock.adjust('5 seconds');
      const failure = yield* Fiber.join(fiber);
      expect(failure).toMatchObject({
        authorityPhase: 'sealed',
        childStarted: true,
        migrationsCompleted: false,
        phase: 'migration',
      });
      expect(fixture.events.slice(-2)).toEqual([CHILD_RELEASED, 'UNLOCK']);
      expect(fixture.phase()).toBe('sealed');
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect('retains successful child completion when the native migrated commit cannot finish before the deadline', () =>
  Effect.gen(function* successfulChildIsNotAnAuthorityCommit() {
    // Use an already sealed release so the blocked query belongs only to markMigrated's recheck.
    const sealed = migrationFixture({ hangQuery: 'as blocked', initialPhase: 'sealed' });
    const fiber = yield* migrateStageDemoOwnerSchemas({ totalMs: 5000 }).pipe(
      Effect.provide(sealed.layer),
      Effect.flip,
      Effect.forkChild,
    );
    yield* TestClock.adjust('5 seconds');
    const failure = yield* Fiber.join(fiber);
    expect(failure).toMatchObject({
      authorityPhase: 'sealed',
      childStarted: true,
      migrationsCompleted: true,
      phase: 'migration-complete',
    });
    expect(sealed.phase()).toBe('sealed');
    expect(sealed.events).not.toContain(COMMITTED_MIGRATED);
    expect(sealed.events.at(-1)).toBe('UNLOCK');
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect('fails closed before closing admission if the authoritative lease has too little freshness left', () =>
  Effect.gen(function* staleLeaseCannotStartDrain() {
    const fixture = migrationFixture({ leaseRemainingMs: 30_000 });
    const failure = yield* migrateStageDemoOwnerSchemas().pipe(Effect.provide(fixture.layer), Effect.flip);
    expect(Schema.is(StageDemoMigrationError)(failure)).toBe(true);
    expect(failure.message).toContain(AUTHORITY_CHECK_FAILED);
    expect(fixture.events).toEqual(['LOCK', 'UNLOCK']);
    expect(fixture.commands).toEqual([]);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  'unlocks the same reserved session when cancellation races with a granted but unacknowledged publication lock',
  () =>
    Effect.gen(function* lockGrantCancellationDoesNotLeak() {
      const fixture = migrationFixture({ lockGrantedWithoutResponse: true });
      const fiber = yield* migrateStageDemoOwnerSchemas({ totalMs: 5000 }).pipe(
        Effect.provide(fixture.layer),
        Effect.flip,
        Effect.forkChild,
      );
      yield* TestClock.adjust('5 seconds');
      const failure = yield* Fiber.join(fiber);
      expect(failure).toMatchObject({ childStarted: false, phase: 'publication-lock' });
      expect(fixture.events).toEqual(['LOCK', 'UNLOCK']);
      expect(fixture.commands).toEqual([]);
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  'does not claim the child never started when process acquisition times out before its handle is confirmed',
  () =>
    Effect.gen(function* spawnOutcomeStaysUnknown() {
      const fixture = migrationFixture({ spawnHangs: true });
      const fiber = yield* migrateStageDemoOwnerSchemas({ migrationMs: 1000 }).pipe(
        Effect.provide(fixture.layer),
        Effect.flip,
        Effect.forkChild,
      );
      yield* TestClock.adjust('1 second');
      const failure = yield* Fiber.join(fiber);
      expect(failure).toMatchObject({
        authorityPhase: 'sealed',
        childStarted: 'unknown',
        migrationsCompleted: false,
        phase: 'migration',
      });
      expect(fixture.phase()).toBe('sealed');
      expect(fixture.events.slice(-2)).toEqual([CHILD_RELEASED, 'UNLOCK']);
    }).pipe(Effect.provide(NodeServices.layer)),
);

const SUMMARY_FILE = '/runner/stage-summary';
const diagnosticCapture = (failWrites = false) => {
  const stderr: unknown[] = [];
  const stdout: unknown[] = [];
  const writes: { readonly body: string; readonly flag: string | undefined; readonly path: string }[] = [];
  const output: Console.Console = {
    ...console,
    error: (...values: readonly unknown[]) => {
      stderr.push(...values);
    },
    log: (...values: readonly unknown[]) => {
      stdout.push(...values);
    },
  };
  const unsupportedFileSystem = FileSystem.makeNoop({});
  const fileSystem = FileSystem.layerNoop({
    writeFileString: (path, body, options) => {
      if (failWrites) {
        return unsupportedFileSystem.writeFileString(path, body, options);
      }
      return Effect.sync(() => {
        writes.push({ body, flag: options?.flag, path });
      });
    },
  });
  return {
    layer: Layer.mergeAll(fileSystem, Layer.succeed(Console.Console, output), Logger.layer([])),
    stderr,
    stdout,
    writes,
  };
};
type DiagnosticCapture = ReturnType<typeof diagnosticCapture>;
const capturedDiagnostic = (output: DiagnosticCapture) => {
  const stderr = Schema.decodeUnknownSync(Schema.String)(output.stderr[0]);
  const json = stderr.split('\n').at(-1) ?? '';
  const diagnostic = Schema.decodeUnknownSync(Schema.fromJsonString(StageDeployDiagnosticSchema))(json);
  expect(output.writes).toHaveLength(1);
  expect(output.writes[0]?.body).toContain(`\`\`\`json\n${json}\n\`\`\``);
  expect(output.writes[0]?.flag).toBe('a');
  expect(output.writes[0]?.path).toBe(SUMMARY_FILE);
  const annotation = Schema.decodeUnknownSync(Schema.String)(output.stdout[0]);
  expect(annotation).toContain(diagnostic.message);
  expect(annotation).toContain(`migrationStarted ${diagnostic.migrationStarted}`);
  expect(annotation).not.toMatch(/[\r\n]/u);
  expect(output.stdout).toHaveLength(1);
  expect(output.stderr).toHaveLength(1);
  return diagnostic;
};

it.effect('writes exactly one matching timeout record to stderr, annotation and the trusted summary', () =>
  Effect.gen(function* timeoutDiagnosticSinks() {
    for (const spawnHangs of [false, true]) {
      const fixture = migrationFixture({ childNeverExits: true, spawnHangs });
      const output = diagnosticCapture();
      const fiber = yield* migrateStageDemoOwnerSchemas({ migrationMs: 1000 }, { summaryFile: SUMMARY_FILE }).pipe(
        Effect.provide(fixture.layer),
        Effect.provide(output.layer),
        Effect.flip,
        Effect.forkChild,
      );
      yield* TestClock.adjust('1 second');
      const failure = yield* Fiber.join(fiber);
      expect(failure).toMatchObject({ childStarted: spawnHangs ? 'unknown' : true });
      expect(capturedDiagnostic(output)).toMatchObject({
        authorityPhase: 'sealed',
        budgetMs: 1000,
        classification: 'unknown',
        elapsedMs: 1000,
        migrationsCompleted: false,
        migrationStarted: spawnHangs ? 'unknown' : true,
        phase: 'migration',
        reason: 'phase-timeout',
        status: 'failed',
      });
      expect(fixture.phase()).toBe('sealed');
      expect(fixture.events).not.toContain(COMMITTED_MIGRATED);
    }
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect('reports child failure and normal completion without inventing an authority observation', () =>
  Effect.gen(function* childOutcomesUseOneRecord() {
    for (const exitCode of [7, 0]) {
      const fixture = migrationFixture({ exitCode });
      const output = diagnosticCapture();
      const exit = yield* migrateStageDemoOwnerSchemas({}, { summaryFile: SUMMARY_FILE }).pipe(
        Effect.provide(fixture.layer),
        Effect.provide(output.layer),
        Effect.exit,
      );
      expect(Exit.isSuccess(exit)).toBe(exitCode === 0);
      const diagnostic = capturedDiagnostic(output);
      expect(diagnostic).toMatchObject({
        authorityPhase: 'unknown',
        migrationsCompleted: exitCode === 0,
        migrationStarted: true,
        phase: exitCode === 0 ? 'migration-complete' : 'migration',
        status: exitCode === 0 ? 'completed' : 'failed',
      });
      expect(fixture.phase()).toBe(exitCode === 0 ? 'migrated' : 'sealed');
    }
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  'reports interruption once while preserving unknown process acquisition and the original interrupted exit',
  () =>
    Effect.gen(function* interruptedAcquisitionDiagnostic() {
      const fixture = migrationFixture({ spawnHangs: true });
      const output = diagnosticCapture();
      const fiber = yield* migrateStageDemoOwnerSchemas({}, { summaryFile: SUMMARY_FILE }).pipe(
        Effect.provide(fixture.layer),
        Effect.provide(output.layer),
        Effect.forkChild,
      );
      yield* TestClock.adjust('0 seconds');
      yield* Fiber.interrupt(fiber);
      const exit = yield* Fiber.await(fiber);
      expect(Exit.hasInterrupts(exit)).toBe(true);
      expect(capturedDiagnostic(output)).toMatchObject({
        authorityPhase: 'unknown',
        classification: 'unknown',
        migrationsCompleted: false,
        migrationStarted: 'unknown',
        phase: 'migration',
        reason: 'interrupted',
        status: 'aborted',
      });
      expect(fixture.phase()).toBe('sealed');
      expect(fixture.events.slice(-2)).toEqual([CHILD_RELEASED, 'UNLOCK']);
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect('secondary summary failure cannot mask the child exit, successful migration or interruption', () =>
  Effect.gen(function* summaryFailureDoesNotReplaceOutcome() {
    for (const exitCode of [9, 0]) {
      const fixture = migrationFixture({ exitCode });
      const output = diagnosticCapture(true);
      const exit = yield* migrateStageDemoOwnerSchemas({}, { summaryFile: '/runner/private-summary-secret' }).pipe(
        Effect.provide(fixture.layer),
        Effect.provide(output.layer),
        Effect.exit,
      );
      expect(Exit.isSuccess(exit)).toBe(exitCode === 0);
      if (Exit.isFailure(exit)) {
        expect(yield* Effect.failCause(exit.cause).pipe(Effect.flip)).toEqual(
          new StageDemoMigrationError({
            childStarted: true,
            exitCode,
            message: 'The stage owner migration chain failed',
          }),
        );
      }
      expect(output.stderr).toHaveLength(2);
      expect(output.stderr[1]).toBe('Stage deployment summary unavailable; the migration outcome is unchanged.');
      expect(output.stdout).toHaveLength(1);
      expect(output.stderr.join('\n')).not.toContain('private-summary-secret');
      expect(fixture.phase()).toBe(exitCode === 0 ? 'migrated' : 'sealed');
    }
    const fixture = migrationFixture({ childNeverExits: true });
    const output = diagnosticCapture(true);
    const fiber = yield* migrateStageDemoOwnerSchemas({}, { summaryFile: SUMMARY_FILE }).pipe(
      Effect.provide(fixture.layer),
      Effect.provide(output.layer),
      Effect.forkChild,
    );
    yield* TestClock.adjust('0 seconds');
    yield* Fiber.interrupt(fiber);
    expect(Exit.hasInterrupts(yield* Fiber.await(fiber))).toBe(true);
    expect(output.stdout).toHaveLength(1);
    expect(output.stderr).toHaveLength(2);
    expect(fixture.events.slice(-2)).toEqual([CHILD_RELEASED, 'UNLOCK']);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect('drops secret-bearing native SQL and spawn errors from every diagnostic channel and returned CLI error', () =>
  Effect.gen(function* sanitizedNativeFailures() {
    const secret = 'postgresql://admin:credential-secret@host/db\nperson@example.test\n::error::injected';
    const sqlFailure = new SqlError({ reason: new ConnectionError({ cause: secret, message: secret }) });
    const spawnFailure = systemError({
      _tag: 'PermissionDenied',
      cause: secret,
      description: secret,
      method: 'spawn',
      module: 'ChildProcessSpawner',
      pathOrDescriptor: secret,
    });
    for (const options of [{ sqlFailure }, { spawnFailure }]) {
      const fixture = migrationFixture(options);
      const output = diagnosticCapture();
      const failure = yield* migrateStageDemoOwnerSchemas({}, { summaryFile: SUMMARY_FILE }).pipe(
        Effect.provide(fixture.layer),
        Effect.provide(output.layer),
        Effect.flip,
      );
      expect(Schema.is(StageDemoMigrationError)(failure)).toBe(true);
      const diagnostic = capturedDiagnostic(output);
      expect(diagnostic.status).toBe('failed');
      expect(diagnostic.migrationStarted).toBe('spawnFailure' in options ? 'unknown' : false);
      const text = [
        ...output.stderr,
        ...output.stdout,
        ...output.writes.map((write) => write.body),
        failure.message,
      ].join('\n');
      for (const forbidden of ['credential-secret', 'person@', 'injected', 'postgresql://']) {
        expect(text).not.toContain(forbidden);
      }
      expect(fixture.events).not.toContain(COMMITTED_MIGRATED);
    }
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  'reads the trusted summary path through CLI Config and leaves readiness stdout as one advisory JSON document',
  () =>
    Effect.gen(function* configuredCliSummaryPath() {
      const fixture = migrationFixture({ readinessCounts: { deliveries: 0, durable: 1, messages: 0 } });
      const output = diagnosticCapture();
      const failure = yield* runStageDemoMigration([READINESS]).pipe(
        Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ GITHUB_STEP_SUMMARY: SUMMARY_FILE }))),
        Effect.provide(fixture.layer),
        Effect.provide(output.layer),
        Effect.flip,
      );
      expect(Schema.is(StageDemoMigrationError)(failure)).toBe(true);
      expect(output.stdout).toHaveLength(1);
      const result = Schema.decodeUnknownSync(
        Schema.fromJsonString(
          Schema.Struct({
            advisoryOnly: Schema.Literal(true),
            reason: Schema.Literal(PENDING_WORK),
            status: Schema.Literal('blocked'),
          }),
        ),
      )(output.stdout[0]);
      expect(result.advisoryOnly).toBe(true);
      expect(output.stderr).toHaveLength(2);
      expect(output.stderr[1]).toEqual(expect.stringMatching(/^::warning title=Stage deployment::/u));
      expect(output.writes).toHaveLength(1);
      expect(output.writes[0]?.path).toBe(SUMMARY_FILE);
      expect(output.writes[0]?.body).toContain('"migrationStarted":false');
      expect(fixture.commands).toEqual([]);
      expect(fixture.events).toEqual([]);

      const migration = migrationFixture();
      const completed = diagnosticCapture();
      yield* runStageDemoMigration([]).pipe(
        Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ GITHUB_STEP_SUMMARY: SUMMARY_FILE }))),
        Effect.provide(migration.layer),
        Effect.provide(completed.layer),
      );
      expect(capturedDiagnostic(completed).status).toBe('completed');
      expect(migration.commands).toHaveLength(1);
    }).pipe(Effect.provide(NodeServices.layer)),
);
