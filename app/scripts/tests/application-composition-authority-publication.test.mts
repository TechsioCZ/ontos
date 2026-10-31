import { ConfigProvider, Deferred, Effect, Fiber, Layer, Logger, Schema } from 'effect';
import { TestClock } from 'effect/testing';
import { expect, it } from 'effect-rstest';

import { ApplicationCompositionAuthorityError } from '../../packages/core-runtime/src/modules/application-composition-authority.ts';
import {
  ApplicationCompositionAuthorityAdminDatabaseLive,
  withApplicationCompositionPublicationProgress,
  withApplicationCompositionReadinessDeadline,
} from '../application-composition-authority-publication.mts';

const runtimeUrl = 'postgresql://ontos_runtime:runtime-test-secret@127.0.0.1:5432/publication';
const adminUrl = 'postgresql://ontos_admin:admin-test-secret@127.0.0.1:5432/publication';
const DURABLE_DRAIN_PHASE = 'drain durable workflows';
const DRAIN_IDENTIFIERS_MESSAGE = 'drain identifiers';

it.effect('requires explicit distinct valid runtime and admin identities without leaking credentials', () =>
  Effect.gen(function* requiresNativeAdminConfiguration() {
    for (const environment of [
      {},
      { DATABASE_URL: runtimeUrl },
      { DATABASE_ADMIN_URL: adminUrl },
      { DATABASE_ADMIN_URL: runtimeUrl, DATABASE_URL: runtimeUrl },
      { DATABASE_ADMIN_URL: adminUrl, DATABASE_URL: adminUrl },
      {
        DATABASE_ADMIN_URL: adminUrl,
        DATABASE_URL: 'https://ontos_runtime:runtime-test-secret@example.test/publication',
      },
      { DATABASE_ADMIN_URL: 'not-a-url-admin-test-secret', DATABASE_URL: runtimeUrl },
    ]) {
      const failure = yield* Layer.build(ApplicationCompositionAuthorityAdminDatabaseLive).pipe(
        Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(environment))),
        Effect.scoped,
        Effect.flip,
      );
      expect(Schema.is(ApplicationCompositionAuthorityError)(failure)).toBe(true);
      expect(failure.reason).toMatch(/database (?:configuration|identities)/u);
      expect(failure.reason).not.toContain('admin-test-secret');
      expect(failure.reason).not.toContain('runtime-test-secret');
      expect(failure.cause).toBeUndefined();
    }
  }),
);

it.effect('reports the exact waiting phase and blockers every 30 seconds, then stops after success', () =>
  Effect.gen(function* publicationHeartbeatLifecycle() {
    const messages: unknown[] = [];
    const logger = Logger.layer([Logger.make(({ message }) => messages.push(message))]);
    const finished = yield* Deferred.make<string>();
    const fiber = yield* withApplicationCompositionPublicationProgress(
      DURABLE_DRAIN_PHASE,
      Deferred.await(finished),
      Effect.logInfo(DRAIN_IDENTIFIERS_MESSAGE, { workId: 'test-work-id' }),
    ).pipe(Effect.provide(logger), Effect.forkChild);
    yield* TestClock.adjust('29 seconds');
    expect(messages).toEqual([['Application Composition publication started', { phase: DURABLE_DRAIN_PHASE }]]);
    yield* TestClock.adjust('1 second');
    expect(messages).toContainEqual(['Application Composition publication waiting', { phase: DURABLE_DRAIN_PHASE }]);
    expect(messages).toContainEqual([DRAIN_IDENTIFIERS_MESSAGE, { workId: 'test-work-id' }]);
    yield* TestClock.adjust('30 seconds');
    expect(
      messages.filter((message) => Array.isArray(message) && message[0] === DRAIN_IDENTIFIERS_MESSAGE),
    ).toHaveLength(2);
    yield* Deferred.succeed(finished, 'published');
    expect(yield* Fiber.join(fiber)).toBe('published');
    expect(messages.at(-1)).toEqual(['Application Composition publication completed', { phase: DURABLE_DRAIN_PHASE }]);
    const count = messages.length;
    yield* TestClock.adjust('60 seconds');
    expect(messages).toHaveLength(count);
  }),
);

it.effect('preserves publication failures and cancels heartbeats without claiming completion', () =>
  Effect.gen(function* failedPublicationHeartbeat() {
    const messages: unknown[] = [];
    const logger = Logger.layer([Logger.make(({ message }) => messages.push(message))]);
    const failure = new ApplicationCompositionAuthorityError({
      code: 'application_composition_authority_unavailable',
      reason: 'publication failed',
    });
    const result = yield* withApplicationCompositionPublicationProgress('provider write', Effect.fail(failure)).pipe(
      Effect.provide(logger),
      Effect.flip,
    );
    expect(result).toBe(failure);
    const fiber = yield* withApplicationCompositionPublicationProgress('publication lock', Effect.never).pipe(
      Effect.provide(logger),
      Effect.forkChild,
    );
    yield* TestClock.adjust('30 seconds');
    expect(messages).toContainEqual(['Application Composition publication waiting', { phase: 'publication lock' }]);
    yield* Fiber.interrupt(fiber);
    const count = messages.length;
    yield* TestClock.adjust('60 seconds');
    expect(messages).toHaveLength(count);
    expect(
      messages.some(
        (message) => Array.isArray(message) && message[0] === 'Application Composition publication completed',
      ),
    ).toBe(false);
  }),
);

it.effect('returns only sanitized unknown evidence when a readiness dependency fails', () =>
  Effect.gen(function* unavailableReadinessDoesNotLeak() {
    const failure = new ApplicationCompositionAuthorityError({
      code: 'application_composition_authority_unavailable',
      reason: 'synthetic credential-like diagnostic that must not escape',
    });
    const result = yield* withApplicationCompositionReadinessDeadline(Effect.fail(failure));
    expect(result).toEqual({ advisoryOnly: true, reason: 'diagnostic-unavailable', status: 'unknown' });
  }),
);
