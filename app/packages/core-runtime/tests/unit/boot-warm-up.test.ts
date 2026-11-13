import { v1 } from '@authzed/authzed-node';
import { Clock, Deferred, Duration, Effect, Logger, Option, Ref } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  BOOT_WARM_UP_COMPLETED,
  BOOT_WARM_UP_INCOMPLETE,
  asBootWarmUpStep,
  compositionWarmUp,
  databasePoolWarmUp,
  importsWarmUp,
  runBootWarmUp,
  spiceDbWarmUp,
} from '../../src/runtime/boot-warm-up.ts';
import type { BootWarmUpBudget, BootWarmUpStep } from '../../src/runtime/boot-warm-up.ts';
import type { SpiceDbRpc } from '../../src/permissions/spicedb-rpc.ts';

const budget: BootWarmUpBudget = {
  servingRetry: Duration.millis(5),
  servingTimeout: Duration.millis(200),
  stepTimeout: Duration.millis(60),
  totalTimeout: Duration.millis(100),
};

interface LogLine {
  readonly annotationKeys: readonly string[];
  readonly level: string;
  readonly message: string;
  readonly steps: string;
}

const captured = (lines: LogLine[]) =>
  Logger.layer([
    Logger.make((options) => {
      const structured = Logger.formatStructured.log(options);
      lines.push({
        annotationKeys: Object.keys(structured.annotations),
        level: structured.level,
        message: String(structured.message),
        steps: String(structured.annotations['steps']),
      });
    }),
  ]);

/** Runs the warm-up with a logger that keeps every line it writes. */
const runLogged = (effect: Effect.Effect<void>) =>
  Effect.gen(function* runWithCapturedLogs() {
    const lines: LogLine[] = [];
    // @effect-diagnostics-next-line strictEffectProvide:off -- Test-owned diagnostic logger capture.
    yield* effect.pipe(Effect.provide(captured(lines)));
    return lines;
  });

const warmUp = <Failure>(steps: readonly BootWarmUpStep[], serving: Effect.Effect<void, Failure> = Effect.void) =>
  runBootWarmUp({ serving: asBootWarmUpStep('serving')(serving), steps }, budget);

const step = <Value, Failure>(name: BootWarmUpStep['name'], run: Effect.Effect<Value, Failure>): BootWarmUpStep => ({
  name,
  run: asBootWarmUpStep(name)(run),
});

const forbidden = (rpc: string) => () => Effect.die(`the warm-up must not call ${rpc}`);

/** A SpiceDB client whose only answering RPC is the schema read; any permission check or write is a defect. */
const schemaOnlySpiceDb = (calls: string[]): SpiceDbRpc => ({
  checkBulkPermissions: forbidden('CheckBulkPermissions'),
  checkPermission: forbidden('CheckPermission'),
  close: () => {
    calls.push('close');
  },
  diffSchema: forbidden('DiffSchema'),
  readRelationships: forbidden('ReadRelationships'),
  readSchema: (request) =>
    Effect.sync(() => {
      calls.push(v1.ReadSchemaRequest.equals(request, v1.ReadSchemaRequest.create({})) ? 'readSchema' : 'other');
      return v1.ReadSchemaResponse.create({ schemaText: 'definition user {}' });
    }),
  writeRelationships: forbidden('WriteRelationships'),
  writeSchema: forbidden('WriteSchema'),
});

it.live('runs every step concurrently once the process serves, and logs one completion line', () =>
  Effect.gen(function* concurrentSteps() {
    const started = yield* Ref.make(0);
    const allStarted = yield* Deferred.make<boolean>();
    // Each step finishes only after all three started: run one after another, they would all time out.
    const rendezvous = Ref.updateAndGet(started, (count) => count + 1).pipe(
      Effect.flatMap((count) => (count === 3 ? Deferred.succeed(allStarted, true) : Effect.void)),
      Effect.andThen(Deferred.await(allStarted)),
    );
    const lines = yield* runLogged(
      warmUp([step('database-pool', rendezvous), step('spicedb', rendezvous), step('composition', rendezvous)]),
    );
    expect(yield* Ref.get(started)).toBe(3);
    expect(lines.map(({ level, message, steps }) => [level, message, steps])).toEqual([
      ['INFO', BOOT_WARM_UP_COMPLETED, 'database-pool spicedb composition'],
    ]);
  }),
);

it.live('serves anyway when a step fails, hangs or ignores interruption, with exactly one WARN line', () =>
  Effect.gen(function* failingSteps() {
    const release = yield* Deferred.make<boolean>();
    const startedAt = yield* Clock.currentTimeMillis;
    const lines = yield* runLogged(
      warmUp([
        databasePoolWarmUp(Effect.fail({ reason: 'connect ECONNREFUSED postgresql://secret@db18' })),
        step('spicedb', Effect.never),
        step('composition', Effect.uninterruptible(Deferred.await(release))),
        step('imports', Effect.die('boom')),
      ]),
    );
    expect((yield* Clock.currentTimeMillis) - startedAt).toBeLessThan(1000);
    // Fixed text and step names only: no cause, URL, credential or identity reaches the line.
    expect(lines).toEqual([
      {
        annotationKeys: ['steps'],
        level: 'WARN',
        message: BOOT_WARM_UP_INCOMPLETE,
        steps: 'database-pool=failed spicedb=timed-out composition=timed-out imports=failed',
      },
    ]);
    yield* Deferred.succeed(release, true);
  }),
);

it.live('waits for the process to serve, and runs no step when it never does', () =>
  Effect.gen(function* servingWait() {
    const ran = yield* Ref.make(0);
    const attempts = yield* Ref.make(0);
    const servesOnThirdAttempt = Ref.updateAndGet(attempts, (count) => count + 1).pipe(
      Effect.flatMap((count) => (count < 3 ? Effect.fail('not published yet') : Effect.void)),
    );
    const counted = step(
      'composition',
      Ref.update(ran, (count) => count + 1),
    );
    const served = yield* runLogged(warmUp([counted], servesOnThirdAttempt));
    expect(yield* Ref.get(attempts)).toBe(3);
    expect(yield* Ref.get(ran)).toBe(1);
    expect(served.map(({ message }) => message)).toEqual([BOOT_WARM_UP_COMPLETED]);

    const neverServes = yield* runLogged(warmUp([counted], Effect.fail('not published yet')));
    expect(yield* Ref.get(ran)).toBe(1);
    expect(neverServes.map(({ level, message, steps }) => [level, message, steps])).toEqual([
      ['WARN', BOOT_WARM_UP_INCOMPLETE, 'serving=timed-out'],
    ]);
  }),
);

it.live('uses only select 1, a SpiceDB schema read, the composition load and catalog build, and imports', () =>
  Effect.gen(function* readOnlySteps() {
    const statements = yield* Ref.make<readonly string[]>([]);
    const composition = yield* Ref.make<readonly string[]>([]);
    const imports = yield* Ref.make<readonly string[]>([]);
    const spiceDb: string[] = [];
    const pool = (maxConnections: number) =>
      Effect.succeed(
        Option.some({
          maxConnections,
          run: (statement: string) => Ref.update(statements, (recorded) => [...recorded, statement]),
        }),
      );
    const lines = yield* runLogged(
      warmUp([
        databasePoolWarmUp(pool(6)),
        spiceDbWarmUp(
          Effect.acquireRelease(
            Effect.sync(() => schemaOnlySpiceDb(spiceDb)),
            (rpc) => Effect.sync(() => rpc.close()),
          ),
        ),
        compositionWarmUp(
          Ref.update(composition, (recorded) => [...recorded, 'load']).pipe(Effect.as({ composition: 'revision-1' })),
          (revision) => Ref.update(composition, (recorded) => [...recorded, `catalog:${revision}`]),
        ),
        importsWarmUp(Effect.succeed([Ref.update(imports, (recorded) => [...recorded, 'module'])])),
      ]),
    );
    expect(lines.map(({ message }) => message)).toEqual([BOOT_WARM_UP_COMPLETED]);
    expect(yield* Ref.get(statements)).toEqual(['select 1', 'select 1']);
    expect(spiceDb).toEqual(['readSchema', 'close']);
    expect(yield* Ref.get(composition)).toEqual(['load', 'catalog:revision-1']);
    expect(yield* Ref.get(imports)).toEqual(['module']);

    // Never more sessions than the pool allows, and none when the process does not share its pools.
    yield* Ref.set(statements, []);
    yield* runLogged(warmUp([databasePoolWarmUp(pool(1))]));
    expect(yield* Ref.get(statements)).toEqual(['select 1']);
    yield* Ref.set(statements, []);
    yield* runLogged(warmUp([databasePoolWarmUp(Effect.succeed(Option.none()))]));
    expect(yield* Ref.get(statements)).toEqual([]);
  }),
);
