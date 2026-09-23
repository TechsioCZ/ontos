// @effect-diagnostics strictEffectProvide:off -- Test-owned composition service entrypoints; expires: 2026-12-31.
import { ConfigProvider, DateTime, Effect, Layer, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  ActiveApplicationCompositionConfigLive,
  ActiveApplicationCompositionService,
  ActiveApplicationCompositionSnapshotSchema,
  ActiveApplicationCompositionUnavailableError,
  makeActiveApplicationCompositionLayer,
} from '../../src/index.ts';

const revision = 'a'.repeat(64);
const composition = {
  modules: [],
  revision,
  schemaVersion: '1',
  shell: {
    contributionAbi: { id: 'ontos.shell-contributions', version: '1' },
    coreCapabilities: [],
    sharedSingletons: [],
  },
} as const;

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

const loadConfiguredSnapshot = (environment: Readonly<Record<string, string>>) =>
  Effect.gen(function* loadSnapshot() {
    return yield* (yield* ActiveApplicationCompositionService).load;
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        ActiveApplicationCompositionConfigLive,
        ConfigProvider.layer(ConfigProvider.fromUnknown(environment)),
      ),
    ),
  );

it.effect('delivers one decoded, bounded active Application Composition snapshot', () =>
  Effect.gen(function* decodedSnapshot() {
    const loadedSnapshot = yield* loadConfiguredSnapshot({
      ONTOS_ACTIVE_APPLICATION_COMPOSITION_SNAPSHOT_JSON: snapshotJson,
    });

    expect(Schema.is(ActiveApplicationCompositionSnapshotSchema)(loadedSnapshot)).toBe(true);
    expect(loadedSnapshot.composition).toEqual(composition);
    expect(loadedSnapshot.composition.revision).toBe(revision);
    expect(DateTime.formatIso(loadedSnapshot.observedAt)).toBe(encodedSnapshot.observedAt);
    expect(DateTime.formatIso(loadedSnapshot.validUntil)).toBe(encodedSnapshot.validUntil);
  }),
);

it.effect('fails with the typed unavailable error when the configured source is missing or invalid', () =>
  Effect.gen(function* unavailableConfig() {
    for (const environment of [
      {},
      {
        ONTOS_ACTIVE_APPLICATION_COMPOSITION_SNAPSHOT_JSON: invalidSnapshotJson,
      },
    ]) {
      const failure = yield* loadConfiguredSnapshot(environment).pipe(Effect.flip);
      expect(Schema.is(ActiveApplicationCompositionUnavailableError)(failure)).toBe(true);
      expect(failure.code).toBe('active_application_composition_unavailable');
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
