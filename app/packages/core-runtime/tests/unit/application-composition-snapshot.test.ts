import { createHash } from 'node:crypto';

import { Context, DateTime, Effect, Fiber, Layer, Schema } from 'effect';
import { TestClock } from 'effect/testing';
import { expect, it, rstest } from 'effect-rstest';

import { ActiveApplicationCompositionUnavailableError } from '../../src/modules/active-application-composition-errors.ts';
import {
  ActiveApplicationCompositionConfigLive,
  ActiveApplicationCompositionService,
  ActiveApplicationCompositionSnapshotSchema,
  validateActiveApplicationCompositionSnapshot,
} from '../../src/modules/active-application-composition.ts';
import { ActiveApplicationCompositionSource } from '../../src/modules/active-application-composition-source-service.ts';
import { ActiveApplicationCompositionSourceReadError } from '../../src/modules/active-application-composition-source-errors.ts';
import type { ActiveApplicationCompositionSnapshot } from '../../src/modules/active-application-composition.ts';
import {
  ApplicationCompositionSchema,
  canonicalizeApplicationComposition,
  ONTOS_SHELL_CONTRIBUTION_ABI,
} from '../../src/modules/application-composition.ts';

const observedAt = '2026-10-02T12:00:00.000Z';
const validUntil = '2026-10-02T12:00:01.000Z';

const snapshot = (): ActiveApplicationCompositionSnapshot => {
  const composition = Schema.decodeSync(ApplicationCompositionSchema)({
    modules: [],
    revision: '0'.repeat(64),
    schemaVersion: '2',
    shell: {
      contributionAbi: ONTOS_SHELL_CONTRIBUTION_ABI,
      coreCapabilities: [],
      deployment: { appId: 'shell-super-app', buildMarker: 'shell-build-1' },
      federationManifest: {
        sha256: 'a'.repeat(64),
        url: 'https://shell.example/releases/shell-build-1/mf-manifest.json',
      },
      runtimeContract: {
        sha256: 'b'.repeat(64),
        url: 'https://shell.example/releases/shell-build-1/ontos-shell-runtime.json',
      },
      sharedSingletons: [],
    },
  });
  return {
    composition: {
      ...composition,
      revision: createHash('sha256').update(canonicalizeApplicationComposition(composition)).digest('hex'),
    },
    observedAt: Schema.decodeSync(Schema.DateTimeUtcFromString)(observedAt),
    validUntil: Schema.decodeSync(Schema.DateTimeUtcFromString)(validUntil),
  };
};

it.effect('accepts a complete empty installation while its authority is live', () =>
  Effect.gen(function* acceptLiveSnapshot() {
    yield* TestClock.setTime(Date.parse(observedAt));
    const input = snapshot();
    expect(yield* validateActiveApplicationCompositionSnapshot(input)).toEqual(input);
  }),
);

it.effect('returns immutable approved composition without freezing caller-owned input', () =>
  Effect.gen(function* freezeApprovedComposition() {
    yield* TestClock.setTime(Date.parse(observedAt));
    const input = snapshot();
    const output = yield* validateActiveApplicationCompositionSnapshot(input);
    expect(Object.isFrozen(output)).toBe(true);
    expect(Object.isFrozen(output.composition)).toBe(true);
    expect(Object.isFrozen(output.composition.modules)).toBe(true);
    expect(Object.isFrozen(output.composition.shell)).toBe(true);
    expect(Object.isFrozen(output.composition.shell.coreCapabilities)).toBe(true);
    expect(Object.isFrozen(output.composition.shell.sharedSingletons)).toBe(true);
    expect(Object.isFrozen(input)).toBe(false);
    expect(Object.isFrozen(input.composition)).toBe(false);
    expect(Reflect.set(output.composition, 'revision', 'f'.repeat(64))).toBe(false);
    expect(output.composition.revision).toBe(input.composition.revision);
  }),
);

it.effect('freezes descendants even when an injected composition is already shallow frozen', () =>
  Effect.gen(function* freezeShallowFrozenComposition() {
    yield* TestClock.setTime(Date.parse(observedAt));
    const input = snapshot();
    Object.freeze(input.composition);
    expect(Object.isFrozen(input.composition.shell)).toBe(false);
    const output = yield* validateActiveApplicationCompositionSnapshot(input);
    expect(Object.isFrozen(output.composition)).toBe(true);
    expect(Object.isFrozen(output.composition.modules)).toBe(true);
    expect(Object.isFrozen(output.composition.shell)).toBe(true);
    expect(Object.isFrozen(output.composition.shell.coreCapabilities)).toBe(true);
    expect(Object.isFrozen(output.composition.shell.sharedSingletons)).toBe(true);
    expect(Reflect.set(output.composition.shell, 'contributionAbi', { id: 'invalid', version: '0' })).toBe(false);
    expect(output.composition.shell.contributionAbi).toEqual(ONTOS_SHELL_CONTRIBUTION_ABI);
  }),
);

it.effect('owns immutable lease dates while preserving native DateTime operations', () =>
  Effect.gen(function* preserveImmutableLeaseDates() {
    yield* TestClock.setTime(Date.parse(observedAt));
    const input = snapshot();
    const output = yield* validateActiveApplicationCompositionSnapshot(input);
    expect(output.observedAt).not.toBe(input.observedAt);
    expect(output.validUntil).not.toBe(input.validUntil);
    expect(Object.isFrozen(output.observedAt)).toBe(true);
    expect(Object.isFrozen(output.validUntil)).toBe(true);
    expect(Reflect.set(input.observedAt, 'epochMilliseconds', Date.parse(observedAt) - 60_000)).toBe(true);
    expect(Reflect.set(input.validUntil, 'epochMilliseconds', Date.parse(validUntil) + 60_000)).toBe(true);
    expect(Reflect.set(output.observedAt, 'epochMilliseconds', Date.parse(observedAt) - 60_000)).toBe(false);
    expect(Reflect.set(output.validUntil, 'epochMilliseconds', Date.parse(validUntil) + 60_000)).toBe(false);
    expect(DateTime.formatIso(output.observedAt)).toBe(observedAt);
    expect(DateTime.formatIso(output.validUntil)).toBe(validUntil);
    const observedParts = DateTime.toPartsUtc(output.observedAt);
    const expiresParts = DateTime.toPartsUtc(output.validUntil);
    expect(observedParts).toMatchObject({ day: 2, hour: 12, month: 10, second: 0, year: 2026 });
    expect(expiresParts).toMatchObject({ day: 2, hour: 12, month: 10, second: 1, year: 2026 });
    expect(Object.isFrozen(observedParts)).toBe(true);
    expect(Object.isFrozen(expiresParts)).toBe(true);
    expect(Reflect.set(expiresParts, 'second', 59)).toBe(false);
    expect(DateTime.toEpochMillis(output.observedAt)).toBe(Date.parse(observedAt));
    expect(DateTime.toEpochMillis(output.validUntil)).toBe(Date.parse(validUntil));
  }),
);

it.effect('reuses only validator-owned snapshots and checks the lease again without hashing', () =>
  Effect.gen(function* reuseValidatedSnapshot() {
    yield* TestClock.setTime(Date.parse(observedAt));
    const digest = rstest.spyOn(globalThis.crypto.subtle, 'digest');
    yield* Effect.addFinalizer(() => Effect.sync(() => digest.mockRestore()));
    const input = snapshot();
    const approved = yield* validateActiveApplicationCompositionSnapshot(input);
    const digestCalls = digest.mock.calls.length;
    expect(yield* validateActiveApplicationCompositionSnapshot(approved)).toBe(approved);
    expect(digest).toHaveBeenCalledTimes(digestCalls);
    // An injected object with the same revision is not trusted by identity.
    expect(Reflect.set(input.composition.shell.deployment, 'buildMarker', 'changed-build')).toBe(true);
    expect(yield* Effect.flip(validateActiveApplicationCompositionSnapshot(input))).toBeInstanceOf(
      ActiveApplicationCompositionUnavailableError,
    );
    yield* TestClock.setTime(Date.parse(validUntil));
    expect(yield* Effect.flip(validateActiveApplicationCompositionSnapshot(approved))).toBeInstanceOf(
      ActiveApplicationCompositionUnavailableError,
    );
  }),
);

it.effect('reuses exact configured bytes across request Layers but never skips the source or its lease', () =>
  Effect.gen(function* reuseConfiguredSnapshot() {
    yield* TestClock.setTime(Date.parse(observedAt));
    const input = snapshot();
    const encode = Schema.encodeEffect(Schema.fromJsonString(ActiveApplicationCompositionSnapshotSchema));
    const encoded = yield* encode(input);
    let current = encoded;
    let available = true;
    let reads = 0;
    const layer = ActiveApplicationCompositionConfigLive.pipe(
      Layer.provide(
        Layer.succeed(ActiveApplicationCompositionSource, {
          load: Effect.suspend(() => {
            reads += 1;
            return available
              ? Effect.succeed(current)
              : Effect.fail(
                  new ActiveApplicationCompositionSourceReadError({
                    reason: 'source unavailable',
                  }),
                );
          }),
        }),
      ),
    );
    const load = Effect.scoped(
      Layer.build(layer).pipe(
        Effect.flatMap((context) => Context.get(context, ActiveApplicationCompositionService).load),
      ),
    );
    const first = yield* load;
    expect(yield* load).toBe(first);
    expect(reads).toBe(2);
    current = yield* encode({
      ...input,
      composition: {
        ...input.composition,
        shell: {
          ...input.composition.shell,
          deployment: { ...input.composition.shell.deployment, buildMarker: 'tampered' },
        },
      },
    });
    expect(yield* Effect.flip(load)).toBeInstanceOf(ActiveApplicationCompositionUnavailableError);
    current = encoded;
    available = false;
    expect(yield* Effect.flip(load)).toBeInstanceOf(ActiveApplicationCompositionUnavailableError);
    available = true;
    yield* TestClock.setTime(Date.parse(validUntil));
    expect(yield* Effect.flip(load)).toBeInstanceOf(ActiveApplicationCompositionUnavailableError);
    current = yield* encode({ ...input, validUntil: DateTime.makeUnsafe(Date.parse(validUntil) + 1000) });
    const renewed = yield* load;
    expect(renewed).not.toBe(first);
    expect(renewed.composition.revision).toBe(first.composition.revision);
    expect(yield* load).toBe(renewed);
    expect(reads).toBe(7);
  }),
);

it.effect('rejects non-finite injected authority dates as typed unavailability', () =>
  Effect.gen(function* rejectInvalidLeaseDate() {
    yield* TestClock.setTime(Date.parse(observedAt));
    const input = snapshot();
    expect(Reflect.set(input.validUntil, 'epochMilliseconds', Infinity)).toBe(true);
    const error = yield* Effect.flip(validateActiveApplicationCompositionSnapshot(input));
    expect(error).toBeInstanceOf(ActiveApplicationCompositionUnavailableError);
    expect(error.cause).toBe('Application Composition authority dates are invalid');
  }),
);

it.effect('rejects observations from the future', () =>
  Effect.gen(function* rejectFutureObservation() {
    yield* TestClock.setTime(Date.parse(observedAt) - 1);
    const error = yield* Effect.flip(validateActiveApplicationCompositionSnapshot(snapshot()));
    expect(error).toBeInstanceOf(ActiveApplicationCompositionUnavailableError);
    expect(error.cause).toBe('Application Composition authority is expired or not yet valid');
  }),
);

it.effect('expires authority exactly at validUntil without selecting an older revision', () =>
  Effect.gen(function* rejectExpiredSnapshot() {
    const input = snapshot();
    yield* TestClock.setTime(Date.parse(validUntil) - 1);
    expect(yield* validateActiveApplicationCompositionSnapshot(input)).toEqual(input);
    yield* TestClock.adjust('1 millis');
    const error = yield* Effect.flip(validateActiveApplicationCompositionSnapshot(input));
    expect(error).toBeInstanceOf(ActiveApplicationCompositionUnavailableError);
    expect(error.cause).toBe('Application Composition authority is expired or not yet valid');
  }),
);

it.effect('rejects authority that expires while its complete bundle is being verified', () =>
  Effect.gen(function* rejectExpiryDuringVerification() {
    yield* TestClock.setTime(Date.parse(observedAt));
    const input = snapshot();
    const digestBytes = Uint8Array.from(Buffer.from(input.composition.revision, 'hex')).buffer;
    const digestCompletion = Promise.withResolvers<ArrayBuffer>();
    const digest = rstest.spyOn(globalThis.crypto.subtle, 'digest').mockImplementation(() => digestCompletion.promise);
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        digestCompletion.resolve(digestBytes);
        digest.mockRestore();
      }),
    );
    const validation = yield* validateActiveApplicationCompositionSnapshot(input).pipe(Effect.flip, Effect.forkChild);
    yield* Effect.yieldNow;
    expect(digest).toHaveBeenCalledTimes(1);
    expect(Reflect.set(input.validUntil, 'epochMilliseconds', Date.parse(validUntil) + 60_000)).toBe(true);
    yield* TestClock.adjust('1 second');
    digestCompletion.resolve(digestBytes);
    const error = yield* Fiber.join(validation);
    expect(error).toBeInstanceOf(ActiveApplicationCompositionUnavailableError);
    expect(error.cause).toBe('Application Composition authority expired during validation');
  }),
);

it.effect('fails closed when immutable bundle verification exceeds its time budget', () =>
  Effect.gen(function* boundStalledDigestVerification() {
    yield* TestClock.setTime(Date.parse(observedAt));
    const futureExpiry = yield* Schema.decodeEffect(Schema.DateTimeUtcFromString)('2026-10-02T13:00:00.000Z');
    const input = {
      ...snapshot(),
      validUntil: futureExpiry,
    };
    const digestBytes = Uint8Array.from(Buffer.from(input.composition.revision, 'hex')).buffer;
    const digestCompletion = Promise.withResolvers<ArrayBuffer>();
    const digest = rstest.spyOn(globalThis.crypto.subtle, 'digest').mockImplementation(() => digestCompletion.promise);
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        digestCompletion.resolve(digestBytes);
        digest.mockRestore();
      }),
    );
    const validation = yield* validateActiveApplicationCompositionSnapshot(input).pipe(Effect.flip, Effect.forkChild);
    yield* Effect.yieldNow;
    expect(digest).toHaveBeenCalledTimes(1);
    yield* TestClock.adjust('5 seconds');
    const error = yield* Fiber.join(validation);
    expect(error).toBeInstanceOf(ActiveApplicationCompositionUnavailableError);
    expect(error.cause).toMatchObject({ reason: 'Application Composition validation exceeded its time budget' });
  }),
);

it.effect('rejects a well-shaped revision that does not identify the complete bundle', () =>
  Effect.gen(function* rejectIncorrectRevision() {
    yield* TestClock.setTime(Date.parse(observedAt));
    const input = snapshot();
    const error = yield* Effect.flip(
      validateActiveApplicationCompositionSnapshot({
        ...input,
        composition: { ...input.composition, revision: 'f'.repeat(64) },
      }),
    );
    expect(error).toBeInstanceOf(ActiveApplicationCompositionUnavailableError);
    expect(error.cause).toMatchObject({
      reason: 'Application Composition revision does not match its immutable content',
    });
  }),
);

it.effect('rejects excess snapshot properties instead of silently discarding them', () =>
  Effect.gen(function* rejectExcessSnapshotProperty() {
    yield* TestClock.setTime(Date.parse(observedAt));
    const input = { ...snapshot(), lastKnownGood: true };
    const error = yield* Effect.flip(validateActiveApplicationCompositionSnapshot(input));
    expect(error).toBeInstanceOf(ActiveApplicationCompositionUnavailableError);
  }),
);

it.effect('rejects excess composition properties from an injected source', () =>
  Effect.gen(function* rejectExcessCompositionProperty() {
    yield* TestClock.setTime(Date.parse(observedAt));
    const input = snapshot();
    const excessPropertySnapshot = {
      ...input,
      composition: { ...input.composition, excludedApplications: [] },
    };
    const error = yield* Effect.flip(validateActiveApplicationCompositionSnapshot(excessPropertySnapshot));
    expect(error).toBeInstanceOf(ActiveApplicationCompositionUnavailableError);
  }),
);

it.effect('rejects a legacy schema even when an injected source bypasses its declared type', () =>
  Effect.gen(function* rejectLegacyCompositionSchema() {
    yield* TestClock.setTime(Date.parse(observedAt));
    const input = snapshot();
    expect(Reflect.set(input.composition, 'schemaVersion', '1')).toBe(true);
    const error = yield* Effect.flip(validateActiveApplicationCompositionSnapshot(input));
    expect(error).toBeInstanceOf(ActiveApplicationCompositionUnavailableError);
  }),
);
