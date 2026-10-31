import { DateTime, Effect, Option, Schema } from 'effect';
import { TestClock } from 'effect/testing';
import { expect, it, rstest } from 'effect-rstest';

import { ActiveApplicationCompositionUnavailableError } from '../../packages/core-runtime/src/modules/active-application-composition-errors.ts';
import type { ActiveApplicationCompositionSnapshot } from '../../packages/core-runtime/src/modules/active-application-composition.ts';
import {
  ApplicationCompositionSchema,
  ONTOS_SHELL_CONTRIBUTION_ABI,
} from '../../packages/core-runtime/src/modules/application-composition.ts';
import { applicationCompositionRevision } from '../active-application-composition.mts';
import { AppHostError, makeCompositionPointer } from '../zerops/app-host.mts';

const observedAt = 1000;
const validUntil = 100_000;

const snapshot = (buildMarker = 'shell-build'): ActiveApplicationCompositionSnapshot => {
  const composition = Schema.decodeSync(ApplicationCompositionSchema)({
    modules: [],
    revision: '0'.repeat(64),
    schemaVersion: '2',
    shell: {
      contributionAbi: ONTOS_SHELL_CONTRIBUTION_ABI,
      coreCapabilities: [],
      deployment: { appId: 'shell-super-app', buildMarker },
      federationManifest: { sha256: 'a'.repeat(64), url: 'https://shell.example/mf-manifest.json' },
      runtimeContract: { sha256: 'b'.repeat(64), url: 'https://shell.example/ontos-shell-runtime.json' },
      sharedSingletons: [],
    },
  });
  return {
    composition: { ...composition, revision: applicationCompositionRevision(composition) },
    observedAt: DateTime.makeUnsafe(observedAt),
    validUntil: DateTime.makeUnsafe(validUntil),
  };
};

it.effect('validates content once at publication while every concurrent fetch re-reads authority', () =>
  Effect.gen(function* reuseValidatedPublication() {
    yield* TestClock.setTime(observedAt);
    const input = snapshot();
    let reads = 0;
    const pointer = yield* makeCompositionPointer(
      Effect.sync(() => {
        reads += 1;
        return [{ phase: 'active', revision: input.composition.revision, validUntilMillis: validUntil }];
      }),
    );
    const digest = rstest.spyOn(globalThis.crypto.subtle, 'digest');
    yield* Effect.addFinalizer(() => Effect.sync(() => digest.mockRestore()));
    yield* pointer.publish(input);
    expect(digest).toHaveBeenCalledTimes(1);
    const results = yield* Effect.all(
      Array.from({ length: 27 }, () => pointer.load),
      { concurrency: 'unbounded' },
    );
    expect(results.every(Option.isSome)).toBe(true);
    expect(reads).toBe(27);
    expect(digest).toHaveBeenCalledTimes(1);
  }),
);

it.effect('keeps phase, revision, exact lease and expiry checks on every fetch', () =>
  Effect.gen(function* preserveAuthorityChecks() {
    yield* TestClock.setTime(observedAt);
    const input = snapshot();
    let authority = { phase: 'active', revision: input.composition.revision, validUntilMillis: validUntil };
    const pointer = yield* makeCompositionPointer(Effect.sync(() => [authority]));
    yield* pointer.publish(input);
    expect(Option.isSome(yield* pointer.load)).toBe(true);
    authority = { ...authority, phase: 'draining' };
    expect(Option.isSome(yield* pointer.load)).toBe(true);
    authority = { ...authority, phase: 'closed' };
    expect(yield* pointer.load).toEqual(Option.none());
    authority = { ...authority, phase: 'active', revision: 'f'.repeat(64) };
    expect(yield* pointer.load).toEqual(Option.none());
    authority = { ...authority, revision: input.composition.revision, validUntilMillis: validUntil + 1 };
    expect(yield* pointer.load).toEqual(Option.none());
    authority = { ...authority, validUntilMillis: validUntil };
    expect(Reflect.set(input.validUntil, 'epochMilliseconds', validUntil + 60_000)).toBe(true);
    yield* TestClock.setTime(validUntil);
    expect(yield* pointer.load).toEqual(Option.none());
  }),
);

it.effect('retains only the candidate and preceding publication across authority commits', () =>
  Effect.gen(function* boundPublicationJournal() {
    yield* TestClock.setTime(observedAt);
    const first = snapshot('first');
    const second = snapshot('second');
    const third = snapshot('third');
    let { revision } = first.composition;
    const pointer = yield* makeCompositionPointer(
      Effect.sync(() => [{ phase: 'active', revision, validUntilMillis: validUntil }]),
    );
    yield* pointer.publish(first);
    yield* pointer.publish(second);
    expect(Option.isSome(yield* pointer.load)).toBe(true);
    ({ revision } = second.composition);
    expect(Option.isSome(yield* pointer.load)).toBe(true);
    yield* pointer.publish(third);
    ({ revision } = first.composition);
    expect(yield* pointer.load).toEqual(Option.none());
    ({ revision } = third.composition);
    expect(Option.isSome(yield* pointer.load)).toBe(true);
  }),
);

it.effect('rejects changed content and propagates authority-read failures without serving cached bytes', () =>
  Effect.gen(function* failClosed() {
    yield* TestClock.setTime(observedAt);
    const input = snapshot();
    const failure = new AppHostError({ reason: 'authority unavailable' });
    const pointer = yield* makeCompositionPointer(Effect.fail(failure));
    yield* pointer.publish(input);
    expect(yield* Effect.flip(pointer.load)).toBe(failure);
    expect(Reflect.set(input.composition.shell.deployment, 'buildMarker', 'tampered')).toBe(true);
    expect(yield* Effect.flip(pointer.publish(input))).toBeInstanceOf(ActiveApplicationCompositionUnavailableError);
  }),
);
