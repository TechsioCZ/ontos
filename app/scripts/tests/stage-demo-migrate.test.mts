import { NodeServices } from '@effect/platform-node';
import { ConfigProvider, Effect, Fiber, Layer, Match, Schema, Sink, Stream } from 'effect';
import { TestClock } from 'effect/testing';
import { HttpClient } from 'effect/unstable/http';
import { ChildProcessSpawner } from 'effect/unstable/process';
import type { ChildProcess } from 'effect/unstable/process';
import { expect, it } from 'effect-rstest';

import { CoreDatabase } from '../../packages/core-runtime/src/db/client.ts';
import type { applicationCompositionAuthority } from '../../packages/core-runtime/src/db/schema.ts';
import { ApplicationCompositionAuthorityError } from '../../packages/core-runtime/src/modules/application-composition-authority.ts';
import { makeTestDatabase } from '../../packages/core-runtime/tests/support/database.ts';
import { migrateStageDemoOwnerSchemas, StageDemoMigrationError } from '../stage-demo-migrate.mts';
import { ZeropsPublicApiLive } from '../zerops-public-api.mts';

const REVISION = `sha256:${'1'.repeat(64)}`;
const DURABLE_DRAINED = 'DURABLE DRAINED';
const CHILD_RELEASED = 'CHILD RELEASED';
const COMMITTED_MIGRATED = 'COMMITTED migrated';
const AuthorityChangeSchema = Schema.Literals(['closed', 'draining', 'sealed', 'migrated']);
type Phase = (typeof applicationCompositionAuthority.$inferSelect)['phase'];
interface FixtureOptions {
  readonly durableBlocks?: readonly boolean[];
  readonly exitCode?: number;
  readonly initialPhase?: Phase;
  readonly outboxBlocks?: readonly boolean[];
  readonly sealBlocked?: boolean;
}

/** Runs the real native lifecycle over scripted SQL and the native process service, without a database or child. */
const migrationFixture = (options: FixtureOptions = {}) => {
  let phase = options.initialPhase ?? 'active';
  let admission = phase === 'active' ? 'open' : 'closed';
  let pending: typeof AuthorityChangeSchema.Type | null = null;
  let transactionDepth = 0;
  let locked = false;
  let durableRead = 0;
  let outboxRead = 0;
  const events: string[] = [];
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
      const blocked = options.durableBlocks?.[durableRead] ?? false;
      durableRead += 1;
      events.push(blocked ? 'DURABLE BLOCKED' : DURABLE_DRAINED);
      return [{ blocked }];
    }
    return [{ blocked: options.sealBlocked ?? false }];
  };
  const database = Layer.effect(
    CoreDatabase,
    makeTestDatabase((sql, params) =>
      Effect.sync(() => {
        recordTransaction(sql);
        if (sql.includes('pg_advisory_unlock(')) {
          locked = false;
          events.push('UNLOCK');
          return [{ unlocked: true }];
        }
        if (sql.includes('pg_advisory_lock(')) {
          locked = true;
          events.push('LOCK');
          return [];
        }
        if (sql.includes('as initialized')) {
          return [{ initialized: true }];
        }
        if (sql.includes('as isolation')) {
          return [{ isolation: 'read committed' }];
        }
        if (sql.includes('as remaining')) {
          return [{ remaining: 1_230_000 }];
        }
        if (sql.startsWith('select') && sql.includes('from "core"."application_composition_authority"')) {
          return readAuthority(sql);
        }
        if (sql.includes('as blocked')) {
          return readBlockers(sql);
        }
        if (sql.startsWith('update "core"."application_composition_authority"')) {
          expect(transactionDepth).toBe(1);
          expect(params[2]).toBe(REVISION);
          pending = Schema.decodeUnknownSync(AuthorityChangeSchema)(params[0]);
          return [{ revision: REVISION }];
        }
        return [];
      }),
    ).pipe(Effect.map((executor) => ({ executor }))),
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
        return ChildProcessSpawner.makeHandle({
          all: Stream.empty,
          exitCode: Effect.sync(() => {
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
  return { commands, events, layer, phase: () => phase };
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
        'COMMITTED sealed',
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
        expect(standard.args).toEqual(['db:migrate']);
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
      new StageDemoMigrationError({ exitCode: 7, message: 'The stage owner migration chain failed' }),
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
      expect(Schema.is(ApplicationCompositionAuthorityError)(failure)).toBe(true);
      expect(migrated.phase()).toBe('migrated');
      expect(migrated.commands).toEqual([]);
      expect(migrated.events).toEqual(['LOCK', 'UNLOCK']);
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect('never starts the runner migration when the native final seal discovers unfinished outbox work', () =>
  Effect.gen(function* rejectsStageMigrationBeforeSeal() {
    const fixture = migrationFixture({ sealBlocked: true });
    const failure = yield* migrateStageDemoOwnerSchemas().pipe(Effect.provide(fixture.layer), Effect.flip);
    expect(Schema.is(ApplicationCompositionAuthorityError)(failure)).toBe(true);
    expect(fixture.phase()).toBe('draining');
    expect(fixture.commands).toEqual([]);
    expect(fixture.events).not.toContain('COMMITTED sealed');
    expect(fixture.events.at(-1)).toBe('UNLOCK');
  }).pipe(Effect.provide(NodeServices.layer)),
);
