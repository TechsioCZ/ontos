import { NodeServices } from '@effect/platform-node';
import {
  ConfigProvider,
  Context,
  DateTime,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Ref,
  Schema,
  Stream,
} from 'effect';
import { TestClock } from 'effect/testing';
import { ChildProcess } from 'effect/process';
import { expect, it } from 'effect-rstest';

import { CommerceEnrollmentContinuation } from '../../src/enrollment/continuation/enrollment-continuation.ts';
import type { CommerceEnrollmentContinuationService } from '../../src/enrollment/continuation/enrollment-continuation.ts';
import { attemptUnavailable } from '../../src/enrollment/attempts/errors.ts';
import { EnrollmentAttemptIdSchema, EnrollmentTenantIdSchema } from '../../shared/enrollment-contracts.ts';
import { commerceEnrollmentContinuationSweeperFor } from '../../src/workers/enrollment-continuation-sweeper.ts';
import {
  makeCommerceEnrollmentRecoveryHealth,
  runCommerceEnrollmentRecovery,
  validateCommerceEnrollmentRecoveryConfiguration,
  withCommerceEnrollmentRecovery,
} from '../../src/worker-host/recovery.ts';

const config = { claimOwner: 'commerce-recovery-proof', maxDeliveries: 1, pollIntervalMs: 1000 };
const emptyContinuation: CommerceEnrollmentContinuationService = {
  advance: () => Effect.succeed({ outcome: 'COMPLETE' }),
  openSweepPass: Effect.succeed({
    advance: () => Effect.succeed({ outcome: 'COMPLETE' }),
    claimSweep: () => Effect.succeed(Option.some(1)),
    compositionRevision: `sha256:${'a'.repeat(64)}`,
    listDue: () => Effect.succeed([]),
  }),
};

const observedHealth = Effect.gen(function* observedHealthEffect() {
  const ready = yield* Ref.make(false);
  return {
    health: { cycleFailed: Ref.set(ready, false), cycleSucceeded: Ref.set(ready, true) },
    ready: Ref.get(ready),
  };
});

for (const [index, environment] of [
  {},
  { ONTOS_SHELL_GATEWAY_BASE_URL: 'https://shell.invalid' },
  {
    ONTOS_COMMERCE_CUSTOMER_CONTEXT_GATEWAY_API_KEY: '',
    ONTOS_SHELL_GATEWAY_BASE_URL: 'https://shell.invalid',
  },
  {
    ONTOS_COMMERCE_CUSTOMER_CONTEXT_GATEWAY_API_KEY: 'synthetic-test-credential',
    ONTOS_SHELL_GATEWAY_BASE_URL: 'https://shell.invalid?untrusted=true',
  },
].entries()) {
  it.effect(`fails recovery preflight for incomplete or invalid gateway configuration ${index}`, () =>
    Effect.gen(function* missingGatewayConfiguration() {
      const exit = yield* Effect.exit(
        validateCommerceEnrollmentRecoveryConfiguration.pipe(
          Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(environment)),
        ),
      );
      expect(Exit.isFailure(exit)).toBe(true);
    }),
  );
}

it.effect('accepts explicit owner gateway configuration without resolving ambient environment values', () =>
  validateCommerceEnrollmentRecoveryConfiguration.pipe(
    Effect.provideService(
      ConfigProvider.ConfigProvider,
      ConfigProvider.fromUnknown({
        ONTOS_COMMERCE_CUSTOMER_CONTEXT_GATEWAY_API_KEY: 'synthetic-test-credential',
        ONTOS_SHELL_GATEWAY_BASE_URL: 'https://shell.invalid',
      }),
    ),
  ),
);

it.effect('missing owner gateway configuration cannot pass readiness through an empty journal', () =>
  Effect.gen(function* missingGatewayNeverSweeps() {
    const listed = yield* Ref.make(false);
    const ready = yield* Ref.make(false);
    const service: CommerceEnrollmentContinuationService = {
      ...emptyContinuation,
      openSweepPass: emptyContinuation.openSweepPass.pipe(
        Effect.map((pass) => ({
          ...pass,
          listDue: () => Ref.set(listed, true).pipe(Effect.as([])),
        })),
      ),
    };
    const entry = withCommerceEnrollmentRecovery(
      {
        claimOwnerPrefix: 'commerce-recovery-config-proof',
        registrations: 1,
        runLoop: ({ health }) => (health?.cycleSucceeded ?? Effect.void).pipe(Effect.andThen(Effect.never)),
      },
      (health) =>
        validateCommerceEnrollmentRecoveryConfiguration.pipe(
          Effect.andThen(
            runCommerceEnrollmentRecovery(health).pipe(Effect.provideService(CommerceEnrollmentContinuation, service)),
          ),
        ),
    );
    const exit = yield* Effect.exit(
      entry
        .runLoop({
          config,
          health: { cycleFailed: Ref.set(ready, false), cycleSucceeded: Ref.set(ready, true) },
        })
        .pipe(Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown({}))),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(yield* Ref.get(listed)).toBe(false);
    expect(yield* Ref.get(ready)).toBe(false);
  }),
);

it.effect('requires both cycles and neither success clears the other cycle failure', () =>
  Effect.gen(function* independentReadiness() {
    const observed = yield* observedHealth;
    const checks = yield* makeCommerceEnrollmentRecoveryHealth(5000, observed.health);
    yield* checks.outbox.cycleSucceeded;
    expect(yield* observed.ready).toBe(false);
    yield* checks.recovery.cycleSucceeded;
    expect(yield* observed.ready).toBe(true);

    yield* checks.recovery.cycleFailed;
    yield* checks.outbox.cycleSucceeded;
    expect(yield* observed.ready).toBe(false);
    yield* checks.recovery.cycleSucceeded;
    expect(yield* observed.ready).toBe(true);

    yield* checks.outbox.cycleFailed;
    yield* checks.recovery.cycleSucceeded;
    expect(yield* observed.ready).toBe(false);
  }),
);

it.effect('healthy outbox polling cannot refresh a stale recovery cycle', () =>
  Effect.gen(function* staleRecovery() {
    const observed = yield* observedHealth;
    const checks = yield* makeCommerceEnrollmentRecoveryHealth(5000, observed.health);
    yield* checks.recovery.cycleSucceeded;
    yield* checks.outbox.cycleSucceeded;
    expect(yield* observed.ready).toBe(true);

    yield* TestClock.adjust(90_001);
    yield* checks.outbox.cycleSucceeded;
    expect(yield* observed.ready).toBe(false);
  }),
);

it.effect('successful recovery cannot refresh a stale outbox cycle', () =>
  Effect.gen(function* staleOutbox() {
    const observed = yield* observedHealth;
    const checks = yield* makeCommerceEnrollmentRecoveryHealth(5000, observed.health);
    yield* checks.outbox.cycleSucceeded;
    yield* checks.recovery.cycleSucceeded;
    yield* TestClock.adjust(5001);
    yield* checks.recovery.cycleSucceeded;
    expect(yield* observed.ready).toBe(false);
  }),
);

it.effect('an unavailable admission pass reports failure instead of a successful empty sweep', () =>
  Effect.gen(function* unavailableAdmission() {
    const reported = yield* Deferred.make<boolean>();
    const service: CommerceEnrollmentContinuationService = {
      ...emptyContinuation,
      openSweepPass: Effect.fail(attemptUnavailable('The active build is not approved')),
    };
    const loop = runCommerceEnrollmentRecovery({
      cycleFailed: Deferred.succeed(reported, false).pipe(Effect.asVoid),
      cycleSucceeded: Deferred.succeed(reported, true).pipe(Effect.asVoid),
    }).pipe(Effect.provideService(CommerceEnrollmentContinuation, service));
    const fiber = yield* Effect.forkScoped(loop);
    expect(yield* Deferred.await(reported)).toBe(false);
    yield* Fiber.interrupt(fiber);
  }),
);

it.effect('due discovery starts immediately without an HTTP request', () =>
  Effect.gen(function* immediateSweep() {
    const discovered = yield* Deferred.make<null>();
    const service: CommerceEnrollmentContinuationService = {
      ...emptyContinuation,
      openSweepPass: emptyContinuation.openSweepPass.pipe(
        Effect.map((pass) => ({
          ...pass,
          listDue: () => Deferred.succeed(discovered, null).pipe(Effect.as([])),
        })),
      ),
    };
    const fiber = yield* Effect.forkScoped(
      runCommerceEnrollmentRecovery({ cycleFailed: Effect.void, cycleSucceeded: Effect.void }).pipe(
        Effect.provideService(CommerceEnrollmentContinuation, service),
      ),
    );
    yield* Deferred.await(discovered);
    yield* Fiber.interrupt(fiber);
  }),
);

it.effect('an unreadable durable journal cannot become a successful recovery cycle', () =>
  Effect.gen(function* unavailableJournal() {
    const reported = yield* Deferred.make<boolean>();
    const service: CommerceEnrollmentContinuationService = {
      ...emptyContinuation,
      openSweepPass: emptyContinuation.openSweepPass.pipe(
        Effect.map((pass) => ({
          ...pass,
          listDue: () => Effect.fail(attemptUnavailable('The journal is unavailable')),
        })),
      ),
    };
    const fiber = yield* Effect.forkScoped(
      runCommerceEnrollmentRecovery({
        cycleFailed: Deferred.succeed(reported, false).pipe(Effect.asVoid),
        cycleSucceeded: Deferred.succeed(reported, true).pipe(Effect.asVoid),
      }).pipe(Effect.provideService(CommerceEnrollmentContinuation, service)),
    );
    expect(yield* Deferred.await(reported)).toBe(false);
    yield* Fiber.interrupt(fiber);
  }),
);

it.effect('a RUNNING owner receipt remains tracked and unresolved after a healthy sweep', () =>
  Effect.gen(function* runningReceiptIsNotRecovery() {
    const attempt = {
      portalEnrollmentAttemptId: Schema.decodeSync(EnrollmentAttemptIdSchema)('20000000-0000-4000-8000-000000000011'),
      tenantId: Schema.decodeSync(EnrollmentTenantIdSchema)('10000000-0000-4000-8000-000000000011'),
    };
    const inspected = yield* Ref.make(0);
    // The parent proves the native received-receipt mapping separately. At the runtime boundary,
    // RUNNING is still an unresolved owner outcome, not NOT_STARTED and not a committed profile.
    const service: CommerceEnrollmentContinuationService = {
      ...emptyContinuation,
      openSweepPass: emptyContinuation.openSweepPass.pipe(
        Effect.map((pass) => ({
          ...pass,
          advance: () =>
            Ref.update(inspected, (count) => count + 1).pipe(
              Effect.as({
                halt: { reason: 'RECONCILIATION_REQUIRED' as const, transition: Option.none() },
                outcome: 'HALTED' as const,
              }),
            ),
          listDue: () =>
            Effect.succeed([
              {
                ...attempt,
                compositionRevision: `sha256:${'a'.repeat(64)}`,
                revision: 9,
                state: 'IN_PROGRESS' as const,
                updatedAt: DateTime.makeUnsafe(new Date(0)),
              },
            ]),
        })),
      ),
    };
    const sweeper = yield* commerceEnrollmentContinuationSweeperFor({
      continuation: service,
      staleAfterMillis: 0,
    });
    for (let tick = 0; tick < 2; tick += 1) {
      const result = yield* sweeper.sweep;
      expect(result).toStrictEqual({ released: 0, swept: 1, tracked: 1 });
      const observation = yield* sweeper.observation;
      expect(observation.unresolved).toBe(1);
      // This means the admitted journal was reachable, not that the owner effect completed.
      expect(observation.available).toBe(true);
      expect(Option.isSome(observation.lastSuccessfulSweepAt)).toBe(true);
    }
    expect(yield* Ref.get(inspected)).toBe(2);
  }),
);

it.effect('a stuck cycle times out unready and retries without an unbounded busy loop', () =>
  Effect.gen(function* boundedCycle() {
    const started = yield* Deferred.make<null>();
    const failures = yield* Ref.make(0);
    const service: CommerceEnrollmentContinuationService = {
      ...emptyContinuation,
      openSweepPass: Deferred.succeed(started, null).pipe(Effect.andThen(Effect.never)),
    };
    const fiber = yield* Effect.forkScoped(
      runCommerceEnrollmentRecovery({
        cycleFailed: Ref.update(failures, (count) => count + 1),
        cycleSucceeded: Effect.die('A timed-out cycle cannot report success'),
      }).pipe(Effect.provideService(CommerceEnrollmentContinuation, service)),
    );
    yield* Deferred.await(started);
    yield* TestClock.adjust(60_000);
    expect(yield* Ref.get(failures)).toBe(1);
    yield* TestClock.adjust(999);
    expect(yield* Ref.get(failures)).toBe(1);
    yield* TestClock.adjust(60_001);
    expect(yield* Ref.get(failures)).toBe(2);
    yield* Fiber.interrupt(fiber);
  }),
);

it.effect('entry interruption waits for recovery and outbox disposal', () =>
  Effect.gen(function* interruptionDisposesBoth() {
    const outboxStarted = yield* Deferred.make<null>();
    const recoveryStarted = yield* Deferred.make<null>();
    const outboxDisposed = yield* Ref.make(false);
    const recoveryDisposed = yield* Ref.make(false);
    const service: CommerceEnrollmentContinuationService = {
      ...emptyContinuation,
      openSweepPass: Deferred.succeed(recoveryStarted, null).pipe(Effect.andThen(emptyContinuation.openSweepPass)),
    };
    const layer = Layer.effect(
      CommerceEnrollmentContinuation,
      Effect.acquireRelease(Effect.succeed(service), () => Ref.set(recoveryDisposed, true)),
    );
    const entry = withCommerceEnrollmentRecovery(
      {
        claimOwnerPrefix: 'commerce-recovery-proof',
        registrations: 1,
        runLoop: () =>
          Effect.acquireUseRelease(
            Deferred.succeed(outboxStarted, null),
            () => Effect.never,
            () => Ref.set(outboxDisposed, true),
          ),
      },
      (health) => runCommerceEnrollmentRecovery(health).pipe(Effect.provide(layer)),
    );
    const fiber = yield* Effect.forkScoped(entry.runLoop({ config }));
    yield* Deferred.await(outboxStarted);
    yield* Deferred.await(recoveryStarted);
    yield* Fiber.interrupt(fiber);
    expect(yield* Ref.get(outboxDisposed)).toBe(true);
    expect(yield* Ref.get(recoveryDisposed)).toBe(true);
  }),
);

it.effect('recovery defects fail the owner entry and dispose its outbox loop', () =>
  Effect.gen(function* recoveryDefectPropagates() {
    const started = yield* Deferred.make<null>();
    const disposed = yield* Ref.make(false);
    const service: CommerceEnrollmentContinuationService = {
      ...emptyContinuation,
      openSweepPass: Deferred.await(started).pipe(Effect.andThen(Effect.die('recovery-proof-defect'))),
    };
    const entry = withCommerceEnrollmentRecovery(
      {
        claimOwnerPrefix: 'commerce-recovery-proof',
        registrations: 1,
        runLoop: () =>
          Effect.acquireUseRelease(
            Deferred.succeed(started, null),
            () => Effect.never,
            () => Ref.set(disposed, true),
          ),
      },
      (health) =>
        runCommerceEnrollmentRecovery(health).pipe(Effect.provideService(CommerceEnrollmentContinuation, service)),
    );
    const exit = yield* Effect.exit(entry.runLoop({ config }));
    expect(Exit.isFailure(exit)).toBe(true);
    expect(yield* Ref.get(disposed)).toBe(true);
  }),
);

it.effect('a recovery layer configuration failure fails the owner entry', () =>
  Effect.gen(function* missingConfigurationFailsStartup() {
    // A typed layer startup failure must remain a failure, never select an empty continuation.
    const entry = withCommerceEnrollmentRecovery(
      { claimOwnerPrefix: 'commerce-recovery-proof', registrations: 1, runLoop: () => Effect.never },
      (health) =>
        runCommerceEnrollmentRecovery(health).pipe(
          Effect.provide(
            Layer.effect(
              CommerceEnrollmentContinuation,
              Effect.fail(attemptUnavailable('Recovery configuration is missing')),
            ),
          ),
        ),
    );
    expect(Exit.isFailure(yield* Effect.exit(entry.runLoop({ config })))).toBe(true);
  }),
);

const signalHostSetupTimeoutMs = 10_000;
const signalHostShutdownTimeoutMs = 3000;

const makeRecoverySignalHost = Effect.gen(function* makeRecoverySignalHost() {
  const nodeServices = yield* Layer.build(NodeServices.layer);
  return yield* Effect.gen(function* readySignalHost() {
    const child = yield* ChildProcess.make(
      process.execPath,
      ['--experimental-strip-types', 'tests/support/enrollment-recovery-host.fixture.ts'],
      {
        cwd: new URL('../..', import.meta.url).pathname,
        env: { OUTBOX_WORKER_POLL_INTERVAL_MS: '10' },
        extendEnv: false,
        forceKillAfter: '1 second',
        stderr: 'pipe',
        stdin: 'ignore',
        stdout: 'pipe',
      },
    );
    const outboxStarted = yield* Deferred.make<null>();
    const discovered = yield* Deferred.make<null>();
    const output = yield* child.stdout.pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.tap((line) => {
        if (line === 'outbox-started') {
          return Deferred.succeed(outboxStarted, null).pipe(Effect.asVoid);
        }
        return line === 'recovery-discovered' ? Deferred.succeed(discovered, null).pipe(Effect.asVoid) : Effect.void;
      }),
      Stream.runCollect,
      Effect.forkScoped,
    );
    const errors = yield* child.stderr.pipe(Stream.decodeText(), Stream.mkString, Effect.forkScoped);
    yield* Effect.all([Deferred.await(outboxStarted), Deferred.await(discovered)], {
      concurrency: 2,
      discard: true,
    }).pipe(
      Effect.raceFirst(
        child.exitCode.pipe(Effect.andThen(Effect.die('Host exited before outbox and recovery readiness'))),
      ),
    );
    return {
      shutdown: child.kill({ killSignal: 'SIGTERM' }).pipe(
        Effect.andThen(
          Effect.all([child.exitCode, Fiber.join(output), Fiber.join(errors)], {
            concurrency: 3,
          }),
        ),
        Effect.timeout(signalHostShutdownTimeoutMs),
      ),
    };
  }).pipe(Effect.provideContext(nodeServices));
}).pipe(Effect.timeout(signalHostSetupTimeoutMs));

class RecoverySignalHost extends Context.Service<RecoverySignalHost, Effect.Success<typeof makeRecoverySignalHost>>()(
  '@app/commerce-customer-context/tests/unit/enrollment-recovery-runtime.test/RecoverySignalHost',
) {}

it.layer(Layer.effect(RecoverySignalHost, makeRecoverySignalHost), {
  excludeTestServices: true,
  // Only fixture hooks get the existing 10-second setup plus a 3-second cleanup envelope.
  timeout: signalHostSetupTimeoutMs + signalHostShutdownTimeoutMs,
})((suite) => {
  suite.effect(
    'the real host SIGTERM boundary waits for outbox and recovery disposal',
    () =>
      Effect.gen(function* realSignalDisposesBothLoops() {
        const host = yield* RecoverySignalHost;
        const [code, lines, stderr] = yield* host.shutdown;
        expect(Number(code), stderr).toBe(0);
        expect(lines.join('\n')).toContain('outbox-disposed');
        expect(lines.join('\n')).toContain('recovery-disposed');
        expect(lines.join('\n')).toContain('Outbox Worker host received SIGTERM; shutting down');
      }),
    5000,
  );
});
