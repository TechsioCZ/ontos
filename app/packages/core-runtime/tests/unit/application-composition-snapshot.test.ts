import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { Cause, Clock, Context, DateTime, Effect, Exit, Fiber, Layer, Schema } from 'effect';
import { Hex } from 'effect/encoding';
import { TestClock } from 'effect/testing';
import { expect, it, rstest } from 'effect-rstest';

import { ActionTransactionError } from '../../src/actions/errors.ts';
import { TrustedPrincipalContextSchema } from '../../src/actions/principal-context.ts';
import { makeActionCompositionRevisionResolver } from '../../src/actions/runtime.ts';
import { getActionTransactionErrorCause } from '../../src/actions/transaction-error.ts';
import { ActiveApplicationCompositionUnavailableError } from '../../src/modules/active-application-composition-errors.ts';
import {
  ActiveApplicationCompositionConfigLive,
  ActiveApplicationCompositionService,
  ActiveApplicationCompositionServiceContract,
  ActiveApplicationCompositionSnapshotSchema,
  checkActiveApplicationCompositionSnapshot,
  InstalledModuleCatalogServiceLive,
  loadActiveApplicationComposition,
  loadCheckedActiveApplicationComposition,
  narrowActiveApplicationComposition,
  makeActiveApplicationCompositionLayer,
  ProcessCompositionValidationLive,
  makeActiveApplicationCompositionService,
  validateActiveApplicationCompositionSnapshot,
} from '../../src/modules/active-application-composition.ts';
import { ActiveApplicationCompositionSource } from '../../src/modules/active-application-composition-source-service.ts';
import { ProcessCompositionValidation } from '../../src/modules/process-composition-validation.ts';
import { ActiveApplicationCompositionSourceReadError } from '../../src/modules/active-application-composition-source-errors.ts';
import { TenantModuleStateValidationUnavailableError } from '../../src/modules/tenant-module-state-errors.ts';
import { InstalledModuleCatalogService } from '../../src/modules/catalog.ts';
import type {
  ActiveApplicationCompositionSnapshot,
  CheckedActiveApplicationComposition,
} from '../../src/modules/active-application-composition.ts';
import {
  ApplicationCompositionSchema,
  canonicalizeApplicationComposition,
  ONTOS_SHELL_CONTRIBUTION_ABI,
} from '../../src/modules/application-composition.ts';

const observedAt = '2026-10-02T12:00:00.000Z';
const validUntil = '2026-10-02T12:00:01.000Z';

const snapshot = (shellBuildMarker = 'shell-build-1'): ActiveApplicationCompositionSnapshot => {
  const composition = Schema.decodeSync(ApplicationCompositionSchema)({
    modules: [],
    revision: '0'.repeat(64),
    schemaVersion: '2',
    shell: {
      contributionAbi: ONTOS_SHELL_CONTRIBUTION_ABI,
      coreCapabilities: [],
      deployment: { appId: 'shell-super-app', buildMarker: shellBuildMarker },
      federationManifest: {
        sha256: 'a'.repeat(64),
        url: `https://shell.example/releases/${shellBuildMarker}/mf-manifest.json`,
      },
      runtimeContract: {
        sha256: 'b'.repeat(64),
        url: `https://shell.example/releases/${shellBuildMarker}/ontos-shell-runtime.json`,
      },
      sharedSingletons: [],
    },
  });
  return {
    composition: {
      ...composition,
      revision: Hex.encode(sha256(utf8ToBytes(canonicalizeApplicationComposition(composition)))),
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

it.effect('rejects authority whose observation is in the future once its bundle is verified', () =>
  Effect.gen(function* rejectClockBeforeObservationAfterVerification() {
    yield* TestClock.setTime(Date.parse(observedAt) + 500);
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
    const validation = yield* checkActiveApplicationCompositionSnapshot(input).pipe(Effect.flip, Effect.forkChild);
    yield* Effect.yieldNow;
    expect(digest).toHaveBeenCalledTimes(1);
    yield* TestClock.setTime(Date.parse(observedAt) - 1);
    digestCompletion.resolve(digestBytes);
    const error = yield* Fiber.join(validation);
    expect(error).toBeInstanceOf(ActiveApplicationCompositionUnavailableError);
    expect(error.cause).toBe('Application Composition authority is not yet valid after validation');
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

it.effect('loads installed contracts only for the exact trusted live composition revision', () =>
  Effect.scoped(
    Effect.gen(function* revisionPinnedCatalog() {
      yield* TestClock.setTime(Date.parse(observedAt));
      const source = snapshot();
      const loader = InstalledModuleCatalogServiceLive.pipe(
        Layer.provide(makeActiveApplicationCompositionLayer(Effect.succeed(source))),
      );
      const context = yield* Layer.build(loader);
      yield* Effect.gen(function* verifyCatalogRevision() {
        const installed = yield* InstalledModuleCatalogService;
        expect((yield* installed.loadForRevision(source.composition.revision)).moduleIds).toEqual([]);
        const mismatch = yield* Effect.flip(installed.loadForRevision('f'.repeat(64)));
        expect(Schema.is(TenantModuleStateValidationUnavailableError)(mismatch)).toBe(true);
        yield* TestClock.setTime(Date.parse(validUntil));
        const expired = yield* Effect.flip(installed.loadForRevision(source.composition.revision));
        expect(Schema.is(TenantModuleStateValidationUnavailableError)(expired)).toBe(true);
      }).pipe(Effect.provide(context));
    }),
  ),
);

it.effect('constructs the Core runtime catalog service without reading an unavailable source', () =>
  Effect.scoped(
    Effect.gen(function* lazyCoreCatalogAssembly() {
      let reads = 0;
      const unavailable = Effect.suspend(() => {
        reads += 1;
        return Effect.fail(new ActiveApplicationCompositionUnavailableError({ reason: 'Unavailable source fixture' }));
      });
      const loader = InstalledModuleCatalogServiceLive.pipe(
        Layer.provide(makeActiveApplicationCompositionLayer(unavailable)),
      );
      const context = yield* Layer.build(loader);
      yield* Effect.gen(function* unrelatedCoreAdministration() {
        const installed = yield* InstalledModuleCatalogService;
        expect(reads).toBe(0);
        const rejected = yield* Effect.flip(installed.loadForRevision('a'.repeat(64)));
        expect(Schema.is(TenantModuleStateValidationUnavailableError)(rejected)).toBe(true);
        expect(reads).toBe(1);
        expect(
          yield* Schema.encodeEffect(Schema.fromJsonString(TenantModuleStateValidationUnavailableError))(rejected),
        ).not.toContain('Unavailable source fixture');
      }).pipe(Effect.provide(context));
    }),
  ),
);

const encodeSnapshot = Schema.encodeEffect(Schema.fromJsonString(ActiveApplicationCompositionSnapshotSchema));

/** Counts complete checks: each one digests the revision of this empty composition exactly once. */
const countChecks = Effect.fn('test.countChecks')(function* countChecks() {
  const digest = rstest.spyOn(globalThis.crypto.subtle, 'digest');
  yield* Effect.addFinalizer(() => Effect.sync(() => digest.mockRestore()));
  return { checks: () => digest.mock.calls.length, digest };
});

/** The configured service over a source whose text, or read failure, the test replaces. */
const configuredSource = Effect.fn('test.configuredSource')(function* configuredSource(initial: string) {
  let presented: Effect.Effect<string, ActiveApplicationCompositionSourceReadError> = Effect.succeed(initial);
  let reads = 0;
  const layer = ActiveApplicationCompositionConfigLive.pipe(
    Layer.provide(
      Layer.succeed(ActiveApplicationCompositionSource, {
        load: Effect.suspend(() => {
          reads += 1;
          return presented;
        }),
      }),
    ),
  );
  const context = yield* Layer.build(Layer.merge(layer, InstalledModuleCatalogServiceLive.pipe(Layer.provide(layer))));
  const readsReached = (count: number): Effect.Effect<void> =>
    Effect.suspend(() => (reads < count ? Effect.yieldNow.pipe(Effect.andThen(readsReached(count))) : Effect.yieldNow));
  return {
    authority: Context.get(context, ActiveApplicationCompositionService),
    catalogs: Context.get(context, InstalledModuleCatalogService),
    failReads: (error: ActiveApplicationCompositionSourceReadError) => {
      presented = Effect.fail(error);
    },
    present: (next: string) => {
      presented = Effect.succeed(next);
    },
    /** Resumes once the source has been read `count` times and those loads have run on to their next wait. */
    readsReached,
  };
});

const countedConfiguredSource = Effect.fn('test.countedConfiguredSource')(function* countedSource(initial: string) {
  const { checks } = yield* countChecks();
  return { ...(yield* configuredSource(initial)), checks };
});

it.effect('checks the same snapshot text once across every load and catalog read of it', () =>
  Effect.scoped(
    Effect.gen(function* sameTextCheckedOnce() {
      yield* TestClock.setTime(Date.parse(observedAt));
      const source = yield* countedConfiguredSource(yield* encodeSnapshot(snapshot()));
      const first = yield* loadCheckedActiveApplicationComposition(source.authority);
      for (let load = 0; load < 20; load += 1) {
        expect(yield* loadCheckedActiveApplicationComposition(source.authority)).toBe(first);
        expect((yield* loadActiveApplicationComposition(source.authority)).composition).toBe(
          first.snapshot.composition,
        );
        expect(yield* source.catalogs.loadForRevision(first.snapshot.composition.revision)).toBe(first.catalog);
      }
      expect(source.checks()).toBe(1);
    }),
  ),
);

it.effect('checks a snapshot text that differs in any character in full again', () =>
  Effect.scoped(
    Effect.gen(function* changedTextCheckedAgain() {
      yield* TestClock.setTime(Date.parse(observedAt));
      const encoded = yield* encodeSnapshot(snapshot());
      const source = yield* countedConfiguredSource(encoded);
      const first = yield* loadCheckedActiveApplicationComposition(source.authority);
      expect(source.checks()).toBe(1);
      source.present(`${encoded} `);
      const second = yield* loadCheckedActiveApplicationComposition(source.authority);
      expect(source.checks()).toBe(2);
      expect(second).not.toBe(first);
      expect(second.snapshot).toEqual(first.snapshot);
    }),
  ),
);

/** The native host's process registry, installed for one test and removed when it ends. */
const withHostRegistry = Effect.fn('test.withHostRegistry')(function* withHostRegistry() {
  const registry = Context.get(yield* Layer.build(ProcessCompositionValidationLive), ProcessCompositionValidation);
  globalThis.ontosProcessCompositionValidation = registry;
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      Reflect.deleteProperty(globalThis, 'ontosProcessCompositionValidation');
    }),
  );
});

it.effect('checks a text with appended JSON whitespace in full again through the host registry', () =>
  Effect.scoped(
    Effect.gen(function* registryWhitespaceCheckedAgain() {
      yield* TestClock.setTime(Date.parse(observedAt));
      yield* withHostRegistry();
      const encoded = yield* encodeSnapshot(snapshot());
      const source = yield* countedConfiguredSource(encoded);
      yield* loadCheckedActiveApplicationComposition(source.authority);
      expect(source.checks()).toBe(1);
      source.present(`${encoded}\n `);
      yield* loadCheckedActiveApplicationComposition(source.authority);
      expect(source.checks()).toBe(2);
    }),
  ),
);

it.effect('checks a renewed lease around an unchanged composition in full again through the host registry', () =>
  Effect.scoped(
    Effect.gen(function* registryRenewalCheckedAgain() {
      yield* TestClock.setTime(Date.parse(observedAt));
      yield* withHostRegistry();
      const original = snapshot();
      const source = yield* countedConfiguredSource(yield* encodeSnapshot(original));
      yield* loadCheckedActiveApplicationComposition(source.authority);
      expect(source.checks()).toBe(1);
      source.present(
        yield* encodeSnapshot({
          ...original,
          validUntil: yield* Schema.decodeEffect(Schema.DateTimeUtcFromString)('2026-10-02T12:00:02.000Z'),
        }),
      );
      const renewed = yield* loadCheckedActiveApplicationComposition(source.authority);
      expect(source.checks()).toBe(2);
      expect(renewed.snapshot.composition.revision).toBe(original.composition.revision);
    }),
  ),
);

it.effect('refuses a composition that differs in one byte through the host registry', () =>
  Effect.scoped(
    Effect.gen(function* registryChangedByteRefused() {
      yield* TestClock.setTime(Date.parse(observedAt));
      yield* withHostRegistry();
      const valid = snapshot();
      const encoded = yield* encodeSnapshot(valid);
      const source = yield* countedConfiguredSource(encoded);
      yield* loadCheckedActiveApplicationComposition(source.authority);
      const changed = encoded.replace('shell-build-1/mf-manifest.json', 'shell-build-2/mf-manifest.json');
      expect(changed).not.toBe(encoded);
      source.present(changed);
      const error = yield* Effect.flip(loadCheckedActiveApplicationComposition(source.authority));
      expect(error.cause).toMatchObject({
        reason: 'Application Composition revision does not match its immutable content',
      });
      expect(source.checks()).toBe(2);
    }),
  ),
);

it.effect('rejects an expired snapshot on a load that reuses its checked text', () =>
  Effect.scoped(
    Effect.gen(function* expiredKeptEntryRejected() {
      yield* TestClock.setTime(Date.parse(observedAt));
      const source = yield* countedConfiguredSource(yield* encodeSnapshot(snapshot()));
      yield* loadCheckedActiveApplicationComposition(source.authority);
      yield* TestClock.setTime(Date.parse(validUntil));
      for (const error of [
        yield* Effect.flip(loadActiveApplicationComposition(source.authority)),
        yield* Effect.flip(loadCheckedActiveApplicationComposition(source.authority)),
      ]) {
        expect(error).toBeInstanceOf(ActiveApplicationCompositionUnavailableError);
        expect(error.cause).toBe('Application Composition authority is expired or not yet valid');
      }
      expect(source.checks()).toBe(1);
    }),
  ),
);

it.effect('rejects an invalid snapshot text in full on every load and keeps no earlier text', () =>
  Effect.scoped(
    Effect.gen(function* invalidTextAlwaysRejected() {
      yield* TestClock.setTime(Date.parse(observedAt));
      const valid = snapshot();
      const encoded = yield* encodeSnapshot(valid);
      const source = yield* countedConfiguredSource(encoded);
      yield* loadCheckedActiveApplicationComposition(source.authority);
      source.present(
        yield* encodeSnapshot({ ...valid, composition: { ...valid.composition, revision: 'f'.repeat(64) } }),
      );
      for (let load = 1; load <= 3; load += 1) {
        const error = yield* Effect.flip(loadCheckedActiveApplicationComposition(source.authority));
        expect(error.cause).toMatchObject({
          reason: 'Application Composition revision does not match its immutable content',
        });
        expect(source.checks()).toBe(1 + load);
      }
      source.present(encoded);
      yield* loadCheckedActiveApplicationComposition(source.authority);
      expect(source.checks()).toBe(5);
    }),
  ),
);

it.effect('checks an injected load in full on every read', () =>
  Effect.scoped(
    Effect.gen(function* injectedLoadAlwaysChecked() {
      yield* TestClock.setTime(Date.parse(observedAt));
      const input = snapshot();
      const digest = rstest.spyOn(globalThis.crypto.subtle, 'digest');
      yield* Effect.addFinalizer(() => Effect.sync(() => digest.mockRestore()));
      const authority = makeActiveApplicationCompositionService(Effect.succeed(input));
      yield* loadActiveApplicationComposition(authority);
      yield* loadCheckedActiveApplicationComposition(authority);
      expect(digest).toHaveBeenCalledTimes(2);
      const invalid = makeActiveApplicationCompositionService(
        Effect.succeed({ ...input, composition: { ...input.composition, revision: 'f'.repeat(64) } }),
      );
      expect(yield* Effect.flip(loadActiveApplicationComposition(invalid))).toBeInstanceOf(
        ActiveApplicationCompositionUnavailableError,
      );
    }),
  ),
);

/** Holds every complete check at its digest until released, so loads can overlap one check in flight. */
const pauseChecks = Effect.fn('test.pauseChecks')(function* pauseChecks() {
  const original = globalThis.crypto.subtle.digest.bind(globalThis.crypto.subtle);
  const { checks, digest } = yield* countChecks();
  const released = Promise.withResolvers<true>();
  const started = Promise.withResolvers<true>();
  digest.mockImplementation((algorithm, data) => {
    started.resolve(true);
    return released.promise.then(() => original(algorithm, data));
  });
  return {
    checks,
    release: Effect.sync(() => released.resolve(true)),
    started: Effect.promise(() => started.promise),
  };
});

it.effect('checks a new text once when simultaneous loads miss together', () =>
  Effect.scoped(
    Effect.gen(function* simultaneousMissesCheckedOnce() {
      yield* TestClock.setTime(Date.parse(observedAt));
      const paused = yield* pauseChecks();
      const source = yield* configuredSource(yield* encodeSnapshot(snapshot()));
      const loads = yield* Effect.all(
        Array.from({ length: 8 }, () => loadCheckedActiveApplicationComposition(source.authority)),
        { concurrency: 'unbounded' },
      ).pipe(Effect.forkChild);
      yield* paused.started;
      yield* source.readsReached(8);
      yield* paused.release;
      const [first, ...rest] = yield* Fiber.join(loads);
      for (const result of rest) {
        expect(result).toBe(first);
      }
      expect(paused.checks()).toBe(1);
    }),
  ),
);

it.effect('gives each overlapping text its own result and keeps the newest decision', () =>
  Effect.scoped(
    Effect.gen(function* overlappingTextsAdmittedInOrder() {
      yield* TestClock.setTime(Date.parse(observedAt));
      const paused = yield* pauseChecks();
      const older = snapshot();
      const newer = snapshot('shell-build-2');
      const source = yield* configuredSource(yield* encodeSnapshot(older));
      const olderLoad = yield* Effect.forkChild(loadCheckedActiveApplicationComposition(source.authority));
      yield* paused.started;
      source.present(yield* encodeSnapshot(newer));
      const newerLoad = yield* Effect.forkChild(loadCheckedActiveApplicationComposition(source.authority));
      yield* source.readsReached(2);
      for (let turn = 0; turn < 20; turn += 1) {
        yield* Effect.yieldNow;
      }
      expect(paused.checks()).toBe(1);
      yield* paused.release;
      expect((yield* Fiber.join(olderLoad)).snapshot.composition.revision).toBe(older.composition.revision);
      const admitted = yield* Fiber.join(newerLoad);
      expect(admitted.snapshot.composition.revision).toBe(newer.composition.revision);
      expect(paused.checks()).toBe(2);
      expect(yield* loadCheckedActiveApplicationComposition(source.authority)).toBe(admitted);
      expect(paused.checks()).toBe(2);
    }),
  ),
);

it.effect('never lets an older successful check refill the entry after a newer text failed', () =>
  Effect.scoped(
    Effect.gen(function* olderSuccessCannotOverwriteNewerFailure() {
      yield* TestClock.setTime(Date.parse(observedAt));
      const paused = yield* pauseChecks();
      const valid = snapshot();
      const encoded = yield* encodeSnapshot(valid);
      const source = yield* configuredSource(encoded);
      const validLoad = yield* Effect.forkChild(loadCheckedActiveApplicationComposition(source.authority));
      yield* paused.started;
      source.present(
        yield* encodeSnapshot({ ...valid, composition: { ...valid.composition, revision: 'f'.repeat(64) } }),
      );
      const invalidLoad = yield* Effect.forkChild(
        Effect.flip(loadCheckedActiveApplicationComposition(source.authority)),
      );
      yield* source.readsReached(2);
      yield* paused.release;
      expect((yield* Fiber.join(validLoad)).snapshot.composition.revision).toBe(valid.composition.revision);
      expect((yield* Fiber.join(invalidLoad)).cause).toMatchObject({
        reason: 'Application Composition revision does not match its immutable content',
      });
      expect(paused.checks()).toBe(2);
      source.present(encoded);
      yield* loadCheckedActiveApplicationComposition(source.authority);
      expect(paused.checks()).toBe(3);
    }),
  ),
);

it.effect('keeps one entry per built service, so two services over different sources do not share one', () =>
  Effect.scoped(
    Effect.gen(function* separateEntriesPerService() {
      yield* TestClock.setTime(Date.parse(observedAt));
      const { checks } = yield* countChecks();
      const first = snapshot();
      const second = snapshot('shell-build-2');
      const one = yield* configuredSource(yield* encodeSnapshot(first));
      const two = yield* configuredSource(yield* encodeSnapshot(second));
      for (let load = 0; load < 3; load += 1) {
        expect((yield* loadActiveApplicationComposition(one.authority)).composition.revision).toBe(
          first.composition.revision,
        );
        expect((yield* loadActiveApplicationComposition(two.authority)).composition.revision).toBe(
          second.composition.revision,
        );
      }
      expect(checks()).toBe(2);
    }),
  ),
);

it.effect('returns the new revision once the source rotates to a different valid snapshot', () =>
  Effect.scoped(
    Effect.gen(function* rotationReturnsNewRevision() {
      yield* TestClock.setTime(Date.parse(observedAt));
      const previous = snapshot();
      const rotated = snapshot('shell-build-2');
      expect(rotated.composition.revision).not.toBe(previous.composition.revision);
      const source = yield* countedConfiguredSource(yield* encodeSnapshot(previous));
      expect((yield* loadActiveApplicationComposition(source.authority)).composition.revision).toBe(
        previous.composition.revision,
      );
      source.present(yield* encodeSnapshot(rotated));
      const current = yield* loadCheckedActiveApplicationComposition(source.authority);
      expect(current.snapshot.composition.revision).toBe(rotated.composition.revision);
      expect(yield* source.catalogs.loadForRevision(rotated.composition.revision)).toBe(current.catalog);
      const stale = yield* Effect.flip(source.catalogs.loadForRevision(previous.composition.revision));
      expect(Schema.is(TenantModuleStateValidationUnavailableError)(stale)).toBe(true);
      expect(source.checks()).toBe(2);
    }),
  ),
);

it.effect('fails closed while the source read fails and reuses the kept text when the source recovers', () =>
  Effect.scoped(
    Effect.gen(function* sourceFailureFailsClosed() {
      yield* TestClock.setTime(Date.parse(observedAt));
      const encoded = yield* encodeSnapshot(snapshot());
      const source = yield* countedConfiguredSource(encoded);
      const first = yield* loadCheckedActiveApplicationComposition(source.authority);
      source.failReads(new ActiveApplicationCompositionSourceReadError({ reason: 'Source read fixture failure' }));
      expect(yield* Effect.flip(loadActiveApplicationComposition(source.authority))).toBeInstanceOf(
        ActiveApplicationCompositionUnavailableError,
      );
      const unavailable = yield* Effect.flip(source.catalogs.loadForRevision(first.snapshot.composition.revision));
      expect(Schema.is(TenantModuleStateValidationUnavailableError)(unavailable)).toBe(true);
      source.present(encoded);
      expect(yield* loadCheckedActiveApplicationComposition(source.authority)).toBe(first);
      expect(source.checks()).toBe(1);
    }),
  ),
);

it.effect('rejects a kept text when the clock is before its observation and drops its entry', () =>
  Effect.scoped(
    Effect.gen(function* clockBeforeObservationRejected() {
      const inside = Date.parse(observedAt) + 500;
      yield* TestClock.setTime(inside);
      const source = yield* countedConfiguredSource(yield* encodeSnapshot(snapshot()));
      const first = yield* loadCheckedActiveApplicationComposition(source.authority);
      yield* TestClock.setTime(Date.parse(observedAt) - 1);
      const early = yield* Effect.flip(loadCheckedActiveApplicationComposition(source.authority));
      expect(early.cause).toBe('Application Composition authority is expired or not yet valid');
      expect(source.checks()).toBe(1);
      yield* TestClock.setTime(inside);
      const rechecked = yield* loadCheckedActiveApplicationComposition(source.authority);
      expect(rechecked).not.toBe(first);
      expect(source.checks()).toBe(2);
    }),
  ),
);

const principal = Schema.decodeSync(TrustedPrincipalContextSchema)({
  authBindingId: '00000000-0000-4000-8000-000000000004',
  authContextRef: 'better-auth-session:composition-test',
  authMethod: 'session',
  principalId: '00000000-0000-4000-8000-000000000003',
  tenantId: '00000000-0000-4000-8000-000000000001',
});

it.effect('lets an action resolver over the configured service reuse one check until the lease ends', () =>
  Effect.scoped(
    Effect.gen(function* consumerReusesConfiguredCheck() {
      yield* TestClock.setTime(Date.parse(observedAt));
      const input = snapshot();
      const source = yield* countedConfiguredSource(yield* encodeSnapshot(input));
      const resolve = makeActionCompositionRevisionResolver(source.authority, input.composition.shell.deployment);
      for (let request = 0; request < 10; request += 1) {
        expect(yield* resolve(principal)).toBe(input.composition.revision);
      }
      expect(source.checks()).toBe(1);
      yield* TestClock.setTime(Date.parse(validUntil));
      expect(Schema.is(ActionTransactionError)(yield* Effect.flip(resolve(principal)))).toBe(true);
    }),
  ),
);

/** A clock that reads `before` for its first `switchAfter` time reads and `after` from then on. */
const steppingClock = Effect.fn('test.steppingClock')(function* steppingClock(before: number, after: number) {
  const base = yield* Clock.Clock;
  const state = { reads: 0, switchAfter: Number.POSITIVE_INFINITY };
  const read = () => {
    const reading = state.reads;
    state.reads += 1;
    return reading < state.switchAfter ? before : after;
  };
  const clock: Clock.Clock = {
    currentTimeMillis: Effect.sync(read),
    currentTimeMillisUnsafe: read,
    currentTimeNanos: base.currentTimeNanos,
    currentTimeNanosUnsafe: () => base.currentTimeNanosUnsafe(),
    monotonicTimeNanos: base.monotonicTimeNanos,
    monotonicTimeNanosUnsafe: () => base.monotonicTimeNanosUnsafe(),
    sleep: (duration) => base.sleep(duration),
  };
  return { clock, state };
});

it.effect('rejects a catalog whose lease ends between its checked read and its return', () =>
  Effect.scoped(
    Effect.gen(function* catalogLeaseEndsAfterCheckedRead() {
      yield* TestClock.setTime(Date.parse(observedAt));
      const input = snapshot();
      const source = yield* configuredSource(yield* encodeSnapshot(input));
      yield* loadCheckedActiveApplicationComposition(source.authority);
      const { clock, state } = yield* steppingClock(Date.parse(observedAt), Date.parse(validUntil));
      yield* loadCheckedActiveApplicationComposition(source.authority).pipe(Effect.provideService(Clock.Clock, clock));
      state.switchAfter = state.reads;
      state.reads = 0;
      const ended = yield* Effect.flip(
        source.catalogs.loadForRevision(input.composition.revision).pipe(Effect.provideService(Clock.Clock, clock)),
      );
      expect(Schema.is(TenantModuleStateValidationUnavailableError)(ended)).toBe(true);
      expect(state.reads).toBeGreaterThan(state.switchAfter);
    }),
  ),
);

it.effect('narrows every read by its condition and returns the checked value of its own read', () =>
  Effect.scoped(
    Effect.gen(function* narrowAppliesCondition() {
      yield* TestClock.setTime(Date.parse(observedAt));
      const source = yield* configuredSource(yield* encodeSnapshot(snapshot()));
      const original = yield* loadCheckedActiveApplicationComposition(source.authority);
      let admit = true;
      const seen: CheckedActiveApplicationComposition[] = [];
      const failures: ActiveApplicationCompositionUnavailableError[] = [];
      const narrowed = narrowActiveApplicationComposition(
        source.authority,
        (checked) => {
          seen.push(checked);
          return admit ? Effect.void : Effect.fail(new ActiveApplicationCompositionUnavailableError({ reason: 'no' }));
        },
        (failure) => Effect.sync(() => failures.push(failure)),
      );
      expect(yield* loadCheckedActiveApplicationComposition(narrowed)).toBe(original);
      expect(yield* loadActiveApplicationComposition(narrowed)).toBe(original.snapshot);
      admit = false;
      const refused = yield* Effect.flip(loadCheckedActiveApplicationComposition(narrowed));
      expect(refused.reason).toBe('no');
      expect(failures).toEqual([refused]);
      expect(seen).toEqual([original, original, original]);
    }),
  ),
);

it.effect('rejects a narrowed read whose lease ends while its condition runs', () =>
  Effect.scoped(
    Effect.gen(function* narrowChecksLeaseAfterCondition() {
      yield* TestClock.setTime(Date.parse(observedAt));
      const authority = makeActiveApplicationCompositionService(Effect.succeed(snapshot()));
      const narrowed = narrowActiveApplicationComposition(authority, () => TestClock.setTime(Date.parse(validUntil)));
      const ended = yield* Effect.flip(loadCheckedActiveApplicationComposition(narrowed));
      expect(ended.cause).toBe('Application Composition authority is expired or not yet valid');
    }),
  ),
);

it.effect('never returns what a narrowing condition makes, nor a value it kept after the lease ended', () =>
  Effect.scoped(
    Effect.gen(function* narrowCannotForgeOrReplay() {
      yield* TestClock.setTime(Date.parse(observedAt));
      const input = snapshot();
      const authority = makeActiveApplicationCompositionService(Effect.succeed(input));
      const wrapperForm = () =>
        narrowActiveApplicationComposition(
          authority,
          // @ts-expect-error A narrowing takes a condition on the checked value, never a wrapper around the read.
          (read: ReturnType<typeof loadCheckedActiveApplicationComposition>) => read,
        );
      expect(wrapperForm).toBeTypeOf('function');
      const forged: ActiveApplicationCompositionSnapshot = {
        ...snapshot('shell-build-forged'),
        validUntil: yield* Schema.decodeEffect(Schema.DateTimeUtcFromString)(observedAt),
      };
      let kept: CheckedActiveApplicationComposition | undefined;
      const narrowed = narrowActiveApplicationComposition(authority, (checked) => {
        kept ??= checked;
        return Effect.succeed({ ...kept, snapshot: forged });
      });
      const resolve = makeActionCompositionRevisionResolver(narrowed, input.composition.shell.deployment);
      const returned = yield* loadCheckedActiveApplicationComposition(narrowed);
      expect(returned.snapshot).not.toBe(forged);
      expect(returned.snapshot).toEqual(input);
      expect(yield* resolve(principal)).toBe(input.composition.revision);
      yield* TestClock.setTime(Date.parse(validUntil));
      expect(yield* Effect.flip(loadCheckedActiveApplicationComposition(narrowed))).toBeInstanceOf(
        ActiveApplicationCompositionUnavailableError,
      );
      expect(Schema.is(ActionTransactionError)(yield* Effect.flip(resolve(principal)))).toBe(true);
    }),
  ),
);

it.effect('accepts only a service built by this module and rejects the expired probe snapshot', () =>
  Effect.gen(function* handBuiltServiceRefused() {
    yield* TestClock.setTime(Date.parse(validUntil));
    const expired = snapshot();
    const built = makeActiveApplicationCompositionService(Effect.succeed(expired));
    const members = {};
    // @ts-expect-error A checked service is made only by this module's constructors, never by an object literal.
    const forged: ActiveApplicationCompositionServiceContract = members;
    expect(forged).toBe(members);
    // @ts-expect-error A mock of the service lacks the brand only this module can write.
    const mocked = Layer.mock(ActiveApplicationCompositionService, members);
    expect(Layer.isLayer(mocked)).toBe(true);
    const constructed: ActiveApplicationCompositionServiceContract = Reflect.construct(
      ActiveApplicationCompositionServiceContract,
      [Symbol('not the module token'), loadCheckedActiveApplicationComposition(built)],
    );
    expect(constructed).toBeInstanceOf(ActiveApplicationCompositionServiceContract);
    expect(Exit.hasDies(yield* Effect.exit(loadActiveApplicationComposition(constructed)))).toBe(true);
    expect(Exit.hasDies(yield* Effect.exit(loadCheckedActiveApplicationComposition(constructed)))).toBe(true);
    const resolve = makeActionCompositionRevisionResolver(built, expired.composition.shell.deployment);
    expect(Schema.is(ActionTransactionError)(yield* Effect.flip(resolve(principal)))).toBe(true);
  }),
);

/**
 * An expired snapshot, its real built service, and unchecked reads that would hand the expired snapshot to anyone who
 * trusted a member of whatever object carries the service type.
 */
const expiredProbe = Effect.fn('test.expiredProbe')(function* expiredProbe() {
  yield* TestClock.setTime(Date.parse(observedAt));
  const expired = snapshot();
  const { catalog } = yield* checkActiveApplicationCompositionSnapshot(expired);
  yield* TestClock.setTime(Date.parse(validUntil));
  const unchecked = Effect.succeed(expired);
  const uncheckedChecked = Effect.succeed({ catalog, snapshot: expired });
  return {
    built: makeActiveApplicationCompositionService(unchecked),
    expired,
    unchecked,
    uncheckedChecked,
  };
});

/** The action resolver refuses `service` and keeps, as its cause, the unavailable error of the failed read. */
const refusedByActionResolver = Effect.fn('test.refusedByActionResolver')(function* refusedByActionResolver(
  service: ActiveApplicationCompositionServiceContract,
  expired: ActiveApplicationCompositionSnapshot,
) {
  const resolve = makeActionCompositionRevisionResolver(service, expired.composition.shell.deployment);
  const failure = yield* Effect.flip(resolve(principal));
  expect(Schema.is(ActionTransactionError)(failure)).toBe(true);
  const retained = getActionTransactionErrorCause(failure);
  const unavailable = retained === undefined ? undefined : Cause.squash(retained);
  expect(unavailable).toBeInstanceOf(ActiveApplicationCompositionUnavailableError);
  return unavailable;
});

const refusal = { cause: 'The service was not built by the Active Application Composition module' };

it.effect('refuses a Layer.mock of a copy of a built service with unchecked reads', () =>
  Effect.scoped(
    Effect.gen(function* copiedMockRefused() {
      const probe = yield* expiredProbe();
      const unchecked = { load: probe.unchecked, loadChecked: probe.uncheckedChecked };
      const copy = Object.assign(unchecked, probe.built);
      const context = yield* Layer.build(Layer.mock(ActiveApplicationCompositionService, copy));
      const mocked = Context.get(context, ActiveApplicationCompositionService);
      expect(mocked).not.toBe(probe.built);
      expect(yield* refusedByActionResolver(mocked, probe.expired)).toMatchObject(refusal);
    }),
  ),
);

it.effect('refuses a proxy of a built service whose getters return unchecked reads', () =>
  Effect.scoped(
    Effect.gen(function* proxyRefused() {
      const probe = yield* expiredProbe();
      const forgedMembers = new Map<PropertyKey, unknown>([
        ['load', probe.unchecked],
        ['loadChecked', probe.uncheckedChecked],
      ]);
      const proxy = new Proxy(probe.built, { get: (_target, key) => forgedMembers.get(key) });
      const context = yield* Layer.build(Layer.succeed(ActiveApplicationCompositionService, proxy));
      const provided = Context.get(context, ActiveApplicationCompositionService);
      expect(yield* refusedByActionResolver(provided, probe.expired)).toMatchObject(refusal);
    }),
  ),
);

it.effect('refuses an Object.assign copy and cannot patch the class or its prototype', () =>
  Effect.gen(function* assignedAndPatchedRefused() {
    const probe = yield* expiredProbe();
    const unchecked = { load: probe.unchecked, loadChecked: probe.uncheckedChecked };
    const assigned = Object.assign(unchecked, probe.built);
    expect(yield* refusedByActionResolver(assigned, probe.expired)).toMatchObject(refusal);
    expect(Object.isFrozen(ActiveApplicationCompositionServiceContract)).toBe(true);
    expect(Object.isFrozen(ActiveApplicationCompositionServiceContract.prototype)).toBe(true);
    for (const member of ['load', 'loadChecked', 'narrow']) {
      expect(() =>
        Object.defineProperty(ActiveApplicationCompositionServiceContract.prototype, member, {
          get: () => probe.unchecked,
        }),
      ).toThrow(TypeError);
    }
    expect(() =>
      Object.defineProperty(ActiveApplicationCompositionServiceContract, 'checkingEveryRead', {
        value: () => probe.built,
      }),
    ).toThrow(TypeError);
    expect(yield* refusedByActionResolver(probe.built, probe.expired)).toMatchObject({
      cause: 'Application Composition authority is expired or not yet valid',
    });
  }),
);

const refuseAll = () => Effect.fail(new ActiveApplicationCompositionUnavailableError({ reason: 'no' }));

it.effect('narrows only the service it is given: a copy with a narrow member of its own fails closed', () =>
  Effect.scoped(
    Effect.gen(function* forgedNarrowRefused() {
      yield* TestClock.setTime(Date.parse(observedAt));
      const built = makeActiveApplicationCompositionService(Effect.succeed(snapshot()));
      const unrestricted = { narrow: () => built };
      const assigned = Object.assign(unrestricted, built);
      const proxy = new Proxy(built, { get: (_target, key) => (key === 'narrow' ? unrestricted.narrow : undefined) });
      for (const copy of [assigned, proxy]) {
        const narrowed = narrowActiveApplicationComposition(copy, refuseAll);
        expect(narrowed).not.toBe(built);
        expect(yield* Effect.flip(loadCheckedActiveApplicationComposition(narrowed))).toMatchObject(refusal);
      }
      const honest = yield* Effect.flip(
        loadCheckedActiveApplicationComposition(narrowActiveApplicationComposition(built, refuseAll)),
      );
      expect(honest.reason).toBe('no');
      expect(Object.keys(built)).toEqual([]);
      expect(Object.getOwnPropertyNames(ActiveApplicationCompositionServiceContract.prototype)).toEqual([
        'constructor',
      ]);
    }),
  ),
);

it.effect('hands each caller a read of its own and never dispatches through a supplied load', () =>
  Effect.gen(function* isolatedReads() {
    yield* TestClock.setTime(Date.parse(observedAt));
    const built = makeActiveApplicationCompositionService(Effect.succeed(snapshot()));
    expect(loadCheckedActiveApplicationComposition(built)).not.toBe(loadCheckedActiveApplicationComposition(built));
    const copied = {};
    const foreign = Object.assign(copied, built);
    expect(loadCheckedActiveApplicationComposition(foreign)).not.toBe(loadCheckedActiveApplicationComposition(foreign));
    yield* TestClock.setTime(Date.parse(validUntil));
    const expired = Effect.succeed(snapshot());
    let piped = 0;
    const load = Object.assign(Effect.succeed(snapshot()), {
      pipe: () => {
        piped += 1;
        return expired;
      },
    });
    const overHostileLoad = makeActiveApplicationCompositionService(load);
    const ended = yield* Effect.flip(loadActiveApplicationComposition(overHostileLoad));
    expect(ended.cause).toBe('Application Composition authority is expired or not yet valid');
    expect(piped).toBe(0);
  }),
);
