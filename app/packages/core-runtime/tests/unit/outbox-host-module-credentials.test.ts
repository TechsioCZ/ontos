import { Config, ConfigProvider, Effect, Fiber, Layer, Option, Record, Redacted, Ref } from 'effect';
import { expect, it } from 'effect-rstest';
import { TestClock } from 'effect/testing';

import { sealHostedModuleCredentials } from '../../src/auth/hosted-module-credentials.ts';
import { defineOutboxWorkerEntry, runOutboxWorkerHost } from '../../src/outbox/process.ts';
import { OutboxRuntime } from '../../src/outbox/runtime.ts';
import type { OutboxCycleResult } from '../../src/outbox/runtime.ts';
import { outboxWorkerCompositionLayer } from '../support/outbox-worker-composition.ts';

const MODULE_CREDENTIAL = 'ONTOS_GATEWAY_MODULE_API_KEY';

const emptyResult: OutboxCycleResult = {
  claimed: 0,
  dead: 0,
  deliveriesCreated: 0,
  failed: 0,
  messagesMatched: 0,
  retried: 0,
  succeeded: 0,
};

/**
 * An owner whose delegated calls read the module credential per cycle, as the delegated gateway client does. Each read
 * records the value it resolved, or the Config failure it met.
 */
const reportingOwner = (
  appId: string,
  credential: Ref.Ref<string | null>,
  failure: Ref.Ref<Config.ConfigError | null>,
) =>
  defineOutboxWorkerEntry({
    claimOwnerPrefix: `${appId}-outbox-worker`,
    expectedDeployment: { appId, buildMarker: `${appId}-build` },
    layer: Layer.succeed(OutboxRuntime, {
      matchMessages: () => Effect.succeed({ deliveriesCreated: 0, messagesMatched: 0 }),
      runCycle: () =>
        Config.String(MODULE_CREDENTIAL).pipe(
          Effect.matchEffect({
            onFailure: (missing) => Ref.set(failure, missing),
            onSuccess: (value) => Ref.set(credential, value),
          }),
          Effect.as(emptyResult),
        ),
    }).pipe(Layer.merge(outboxWorkerCompositionLayer())),
    registrations: [],
    subscriptions: [],
  });

/**
 * A provider whose store records every key it is asked for, after the owner's key mapping, so a read of the plain
 * credential variable is visible as such.
 */
const recordingStore = (env: Readonly<Record<string, string>>, reads: string[]) =>
  ConfigProvider.make((path) => {
    const key = path.join('.');
    reads.push(key);
    return Effect.succeed(Record.get(key)(env).pipe(Option.map(ConfigProvider.makeValue), Option.getOrUndefined));
  });

/** Drives the host's polling clock until the owner has recorded a read, and returns what it recorded. */
const readCredential = <A>(recorded: Ref.Ref<A | null>): Effect.Effect<A> =>
  Ref.get(recorded).pipe(
    Effect.flatMap((value) =>
      value === null
        ? TestClock.adjust('10 millis').pipe(
            Effect.andThen(Effect.yieldNow),
            Effect.andThen(Effect.suspend(() => readCredential(recorded))),
          )
        : Effect.succeed(value),
    ),
  );

// Declared first: this file's process is not sealed until the next test seals it.
it.effect('lets the owner of a dedicated, unsealed worker process read the plain module credential', () =>
  Effect.gen(function* dedicatedOwnerReadsItsEnvironment() {
    const dedicated = yield* Ref.make<string | null>(null);
    const dedicatedFailure = yield* Ref.make<Config.ConfigError | null>(null);
    const host = yield* runOutboxWorkerHost({
      entries: [reportingOwner('commerce-order', dedicated, dedicatedFailure)],
    }).pipe(
      Effect.provideService(
        ConfigProvider.ConfigProvider,
        ConfigProvider.fromUnknown({
          ONTOS_GATEWAY_MODULE_API_KEY: 'plain-key-of-the-dedicated-worker',
          OUTBOX_WORKER_POLL_INTERVAL_MS: '10',
        }),
      ),
      Effect.forkChild,
    );
    expect(yield* readCredential(dedicated)).toBe('plain-key-of-the-dedicated-worker');
    yield* Fiber.interrupt(host);
  }),
);

it.effect('gives each owner of a sealed host only its own key and fails an owner without one closed', () =>
  Effect.gen(function* hostedOwnersReadTheirOwnCredential() {
    yield* sealHostedModuleCredentials({
      credentials: {
        'commerce-order': Redacted.make('commerce-order-module-key'),
        'party-registry': Redacted.make('party-registry-module-key'),
      },
      schemaVersion: 1,
    });
    const partyRegistry = yield* Ref.make<string | null>(null);
    const partyRegistryFailure = yield* Ref.make<Config.ConfigError | null>(null);
    const commerceOrder = yield* Ref.make<string | null>(null);
    const commerceOrderFailure = yield* Ref.make<Config.ConfigError | null>(null);
    const pricing = yield* Ref.make<string | null>(null);
    const pricingFailure = yield* Ref.make<Config.ConfigError | null>(null);
    const reads: string[] = [];
    const host = yield* runOutboxWorkerHost({
      entries: [
        reportingOwner('party-registry', partyRegistry, partyRegistryFailure),
        reportingOwner('commerce-order', commerceOrder, commerceOrderFailure),
        reportingOwner('pricing', pricing, pricingFailure),
      ],
    }).pipe(
      Effect.provideService(
        ConfigProvider.ConfigProvider,
        recordingStore(
          {
            ONTOS_GATEWAY_MODULE_API_KEY: 'plain-key-that-must-not-be-read',
            OUTBOX_WORKER_POLL_INTERVAL_MS: '10',
          },
          reads,
        ),
      ),
      Effect.forkChild,
    );

    expect(yield* readCredential(partyRegistry)).toBe('party-registry-module-key');
    expect(yield* readCredential(commerceOrder)).toBe('commerce-order-module-key');
    expect(yield* readCredential(pricingFailure)).toBeInstanceOf(Config.ConfigError);
    expect(yield* Ref.get(pricing)).toBeNull();
    // No hosted owner ever reads the shared environment's module credential.
    expect(reads).not.toContain(MODULE_CREDENTIAL);
    yield* Fiber.interrupt(host);
  }),
);
