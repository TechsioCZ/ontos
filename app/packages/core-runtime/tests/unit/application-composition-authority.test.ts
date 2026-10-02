// @effect-diagnostics strictEffectProvide:off -- Test-owned composition service entrypoints; expires: 2026-12-31.
import { createHash } from 'node:crypto';

import { ConfigProvider, DateTime, Effect, Layer, Schema } from 'effect';
import { TestClock } from 'effect/testing';
import { FetchHttpClient } from 'effect/unstable/http';
import { expect, it } from 'effect-rstest';

import { ActiveApplicationCompositionSourceLive } from '../../src/modules/active-application-composition-source.node.ts';
import { ActiveApplicationCompositionSourceReadError } from '../../src/modules/active-application-composition-source-errors.ts';
import {
  ActiveApplicationCompositionConfigLive,
  ActiveApplicationCompositionService,
  ActiveApplicationCompositionSnapshotSchema,
  ActiveApplicationCompositionUnavailableError,
  canonicalizeApplicationComposition,
  makeActiveApplicationCompositionLayer,
} from '../../src/index.ts';

const unrevisedComposition = {
  modules: [],
  revision: '0'.repeat(64),
  schemaVersion: '2',
  shell: {
    contributionAbi: { id: 'ontos.shell-contributions', version: '1' },
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
} as const;
const revision = createHash('sha256').update(canonicalizeApplicationComposition(unrevisedComposition)).digest('hex');
const composition = { ...unrevisedComposition, revision };

const encodedSnapshot = {
  composition,
  observedAt: '2026-09-22T09:59:00.000Z',
  validUntil: '2026-09-22T10:01:00.000Z',
} as const;
const snapshot = Schema.decodeSync(ActiveApplicationCompositionSnapshotSchema)(encodedSnapshot);
const snapshotJsonSchema = Schema.fromJsonString(ActiveApplicationCompositionSnapshotSchema);
const snapshotJson = Schema.encodeSync(snapshotJsonSchema)(snapshot);
const invalidSnapshotJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))({
  ...encodedSnapshot,
  validUntil: encodedSnapshot.observedAt,
});

const loadConfiguredSnapshot = (environment: Readonly<Record<string, string>>, body: string, onRead: () => void) =>
  Effect.gen(function* loadSnapshot() {
    const authority = yield* ActiveApplicationCompositionService.pipe(
      Effect.provide(
        ActiveApplicationCompositionConfigLive.pipe(
          Layer.provide(ActiveApplicationCompositionSourceLive),
          Layer.provide(
            FetchHttpClient.layer.pipe(
              Layer.provide(
                Layer.succeed(FetchHttpClient.Fetch, () => {
                  onRead();
                  return Promise.resolve(new Response(body));
                }),
              ),
            ),
          ),
          Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(environment))),
        ),
      ),
    );
    return yield* authority.load;
  });

it.effect('delivers one decoded, bounded active Application Composition snapshot', () =>
  Effect.gen(function* decodedSnapshot() {
    yield* TestClock.setTime(Date.parse('2026-09-22T10:00:00.000Z'));
    const authority = yield* ActiveApplicationCompositionService.pipe(
      Effect.provide(
        ActiveApplicationCompositionConfigLive.pipe(
          Layer.provide(ActiveApplicationCompositionSourceLive),
          Layer.provide(
            FetchHttpClient.layer.pipe(
              Layer.provide(Layer.succeed(FetchHttpClient.Fetch, () => Promise.resolve(new Response(snapshotJson)))),
            ),
          ),
          Layer.provide(
            ConfigProvider.layer(
              ConfigProvider.fromUnknown({
                ONTOS_ACTIVE_APPLICATION_COMPOSITION_URL: 'https://authority.example/active',
              }),
            ),
          ),
        ),
      ),
    );
    const loadedSnapshot = yield* authority.load;

    expect(Schema.is(ActiveApplicationCompositionSnapshotSchema)(loadedSnapshot)).toBe(true);
    expect(loadedSnapshot.composition).toEqual(composition);
    expect(loadedSnapshot.composition.revision).toBe(revision);
    expect(DateTime.formatIso(loadedSnapshot.observedAt)).toBe(encodedSnapshot.observedAt);
    expect(DateTime.formatIso(loadedSnapshot.validUntil)).toBe(encodedSnapshot.validUntil);
  }),
);

it.effect('fails with the typed unavailable error when the configured source is missing or invalid', () =>
  Effect.gen(function* unavailableConfig() {
    yield* TestClock.setTime(Date.parse('2026-09-22T10:00:00.000Z'));
    for (const { environment, expectedRequests } of [
      { environment: {}, expectedRequests: 0 },
      {
        environment: { ONTOS_ACTIVE_APPLICATION_COMPOSITION_URL: 'https://authority.example/active' },
        expectedRequests: 1,
      },
    ]) {
      let requests = 0;
      const failure = yield* loadConfiguredSnapshot(environment, invalidSnapshotJson, () => {
        requests += 1;
      }).pipe(Effect.flip);
      expect(Schema.is(ActiveApplicationCompositionUnavailableError)(failure)).toBe(true);
      expect(failure.code).toBe('active_application_composition_unavailable');
      expect(requests).toBe(expectedRequests);
      if (expectedRequests === 0) {
        expect(Schema.is(ActiveApplicationCompositionSourceReadError)(failure.cause)).toBe(true);
        expect(failure.cause).toMatchObject({
          reason: 'The ONTOS_ACTIVE_APPLICATION_COMPOSITION_URL configuration is required',
        });
      } else {
        expect(Schema.isSchemaError(failure.cause)).toBe(true);
        expect(String(failure.cause)).toContain(
          'active Application Composition validity must end after it was observed',
        );
      }
    }
  }),
);

it.effect('preserves a typed source-unavailable failure through the service layer', () => {
  const unavailable = new ActiveApplicationCompositionUnavailableError({
    reason: 'Deployment composition publisher is unavailable',
  });
  return Effect.gen(function* sourceUnavailable() {
    const failure = yield* (yield* ActiveApplicationCompositionService).load.pipe(Effect.flip);
    expect(failure).toBe(unavailable);
  }).pipe(Effect.provide(makeActiveApplicationCompositionLayer(Effect.fail(unavailable))));
});

it.effect('the snapshot authority lease bounds source caching and cannot be extended', () =>
  Effect.gen(function* cachedAuthorityExpiry() {
    yield* TestClock.setTime(Date.parse('2026-09-22T10:00:00.000Z'));
    const expires = yield* Schema.decodeEffect(Schema.DateTimeUtcFromString)('2026-09-22T10:00:00.500Z');
    const body = yield* Schema.encodeEffect(snapshotJsonSchema)({ ...snapshot, validUntil: expires });
    let requests = 0;
    const nativeHttp = FetchHttpClient.layer.pipe(
      Layer.provide(
        Layer.succeed(FetchHttpClient.Fetch, () => {
          requests += 1;
          return Promise.resolve(new Response(body));
        }),
      ),
    );
    const authority = yield* ActiveApplicationCompositionService.pipe(
      Effect.provide(
        ActiveApplicationCompositionConfigLive.pipe(
          Layer.provide(ActiveApplicationCompositionSourceLive),
          Layer.provide(nativeHttp),
          Layer.provide(
            ConfigProvider.layer(
              ConfigProvider.fromUnknown({
                ONTOS_ACTIVE_APPLICATION_COMPOSITION_URL: 'https://authority.example/active',
              }),
            ),
          ),
        ),
      ),
    );
    expect(requests).toBe(0);
    expect((yield* authority.load).composition.revision).toBe(revision);
    expect(requests).toBe(1);
    yield* TestClock.adjust('400 millis');
    expect((yield* authority.load).composition.revision).toBe(revision);
    expect(requests).toBe(1);
    yield* TestClock.adjust('100 millis');
    const failure = yield* Effect.flip(authority.load);
    expect(failure.cause).toBe('Application Composition authority is expired or not yet valid');
    expect(requests).toBe(2);
  }),
);

it.effect('builds the live authority service before source configuration is available', () => {
  let requestCount = 0;
  return Effect.gen(function* coldAuthorityBootstrap() {
    const service = yield* ActiveApplicationCompositionService.pipe(
      Effect.provide(
        ActiveApplicationCompositionConfigLive.pipe(
          Layer.provide(ActiveApplicationCompositionSourceLive),
          Layer.provide(
            FetchHttpClient.layer.pipe(
              Layer.provide(
                Layer.mergeAll(
                  Layer.succeed(FetchHttpClient.RequestInit, { cache: 'no-store', redirect: 'manual' }),
                  Layer.succeed(FetchHttpClient.Fetch, () => {
                    requestCount += 1;
                    return Promise.reject(new Error('Bootstrap must not perform HTTP'));
                  }),
                ),
              ),
            ),
          ),
          Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({}))),
        ),
      ),
    );
    expect(requestCount).toBe(0);

    const failure = yield* service.load.pipe(
      Effect.provide(
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({
            ONTOS_ACTIVE_APPLICATION_COMPOSITION_URL: 'https://authority.example/active',
          }),
        ),
      ),
      Effect.flip,
    );
    expect(Schema.is(ActiveApplicationCompositionUnavailableError)(failure)).toBe(true);
    expect(Schema.is(ActiveApplicationCompositionSourceReadError)(failure.cause)).toBe(true);
    expect(failure.cause).toMatchObject({
      reason: 'The ONTOS_ACTIVE_APPLICATION_COMPOSITION_URL configuration is required',
    });
    expect(requestCount).toBe(0);
  });
});
