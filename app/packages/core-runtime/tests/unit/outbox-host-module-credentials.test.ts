import { Config, ConfigProvider, Effect, Fiber, Layer, Option, Record, Ref } from 'effect';
import { expect, it } from 'effect-rstest';
import { TestClock } from 'effect/testing';

import { defineOutboxWorkerEntry, hostedOutboxWorkerEntry, runOutboxWorkerHost } from '../../src/outbox/process.ts';
import { OutboxRuntime } from '../../src/outbox/runtime.ts';
import type { OutboxCycleResult } from '../../src/outbox/runtime.ts';
import { outboxWorkerCompositionLayer } from '../support/outbox-worker-composition.ts';

const expectedDeployment = { appId: 'worker-fixture', buildMarker: 'worker-fixture-build' };
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
  claimOwnerPrefix: string,
  credential: Ref.Ref<string | null>,
  failure: Ref.Ref<Config.ConfigError | null>,
) =>
  defineOutboxWorkerEntry({
    claimOwnerPrefix,
    expectedDeployment,
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

it.effect('gives each hosted owner its own module credential, and a dedicated owner the plain one', () =>
  Effect.gen(function* hostedOwnersReadTheirOwnCredential() {
    const partyRegistry = yield* Ref.make<string | null>(null);
    const partyRegistryFailure = yield* Ref.make<Config.ConfigError | null>(null);
    const commerceOrder = yield* Ref.make<string | null>(null);
    const commerceOrderFailure = yield* Ref.make<Config.ConfigError | null>(null);
    const dedicated = yield* Ref.make<string | null>(null);
    const dedicatedFailure = yield* Ref.make<Config.ConfigError | null>(null);
    const host = yield* runOutboxWorkerHost({
      entries: [
        hostedOutboxWorkerEntry(
          reportingOwner('party-registry-outbox-worker', partyRegistry, partyRegistryFailure),
          'ONTOS_GATEWAY_MODULE_API_KEY_PARTY_REGISTRY',
        ),
        hostedOutboxWorkerEntry(
          reportingOwner('commerce-order-outbox-worker', commerceOrder, commerceOrderFailure),
          'ONTOS_GATEWAY_MODULE_API_KEY_COMMERCE_ORDER',
        ),
        reportingOwner('dedicated-outbox-worker', dedicated, dedicatedFailure),
      ],
    }).pipe(
      Effect.provideService(
        ConfigProvider.ConfigProvider,
        ConfigProvider.fromUnknown({
          ONTOS_GATEWAY_MODULE_API_KEY: 'plain-key-of-the-dedicated-worker',
          ONTOS_GATEWAY_MODULE_API_KEY_COMMERCE_ORDER: 'commerce-order-key',
          ONTOS_GATEWAY_MODULE_API_KEY_PARTY_REGISTRY: 'party-registry-key',
          OUTBOX_WORKER_POLL_INTERVAL_MS: '10',
        }),
      ),
      Effect.forkChild,
    );

    expect(yield* readCredential(partyRegistry)).toBe('party-registry-key');
    expect(yield* readCredential(commerceOrder)).toBe('commerce-order-key');
    expect(yield* readCredential(dedicated)).toBe('plain-key-of-the-dedicated-worker');
    yield* Fiber.interrupt(host);
  }),
);

it.effect('fails a hosted owner closed when its per-unit credential is absent, without reading the plain key', () =>
  Effect.gen(function* hostedOwnerFailsClosedWithoutUnitCredential() {
    const credential = yield* Ref.make<string | null>(null);
    const failure = yield* Ref.make<Config.ConfigError | null>(null);
    const reads: string[] = [];
    const host = yield* runOutboxWorkerHost({
      entries: [
        hostedOutboxWorkerEntry(
          reportingOwner('party-registry-outbox-worker', credential, failure),
          'ONTOS_GATEWAY_MODULE_API_KEY_PARTY_REGISTRY',
        ),
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

    expect(yield* readCredential(failure)).toBeInstanceOf(Config.ConfigError);
    expect(reads).toContain('ONTOS_GATEWAY_MODULE_API_KEY_PARTY_REGISTRY');
    expect(reads).not.toContain(MODULE_CREDENTIAL);
    expect(yield* Ref.get(credential)).toBeNull();
    yield* Fiber.interrupt(host);
  }),
);
