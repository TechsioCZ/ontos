import { Config, Context, Effect, Layer, Option, Redacted, Result, Schema } from 'effect';
import type { Scope } from 'effect';
import { FetchHttpClient } from 'effect/http';

import {
  ObjectStorageConfigError,
  loadS3ObjectStorageConfig,
  parseS3ObjectStorageConfig,
} from '../../src/media/s3-config.ts';
import type { S3ObjectStorageConfigValue } from '../../src/media/s3-config.ts';
import { R2_MOCK_LABEL, startR2BehaviourMock } from './r2-behaviour-mock.ts';
import type { R2BehaviourMockOptions } from './r2-behaviour-mock.ts';
import { remoteRunSettings } from './s3-remote-guard.ts';
import { cleanupRecordedKeys } from './s3-run-cleanup.ts';

/*
 * The provider-under-test matrix of the Core Media S3 suites. A suite is registered once per provider below, so the
 * same assertions run against every row and each result names the row it came from:
 *
 *   emulator            MinIO (or any S3-compatible emulator) named by CORE_MEDIA_S3_*, loopback only. Not R2.
 *   remote              ONLY with CORE_MEDIA_S3_ALLOW_REMOTE=1: the same CORE_MEDIA_S3_* naming a REAL endpoint and a
 *                       throwaway bucket whose name contains the safety marker (see s3-remote-guard.ts). Evidence for
 *                       that endpoint and nothing else. Never run by CI or by an agent.
 *   r2-mock             the R2-behaviour MOCK built from documentation (tests/support/r2-behaviour-mock.ts), path style.
 *   r2-mock-virtual     the same mock addressed virtual-hosted (`<bucket>.localhost`).
 *   r2-mock-write-limit the same mock with the documented limit of one write per second to one key switched on; the
 *                       suite spaces a second write to a key by a little more than a second on this row.
 *
 * None of the first, third, fourth and fifth rows is Cloudflare R2. A row that is not configured is skipped, never passed.
 */

/** The root environment file is deliberately not consulted: a test must never pick up a real provider. */
const NO_ENVIRONMENT_FILE = '/nonexistent/core-media-s3-test.env';
/** R2 documents "Concurrent writes to the same object name (key)" at a rate above 1 per second as HTTP 429. */
const SAME_KEY_WRITE_SPACING_MILLIS = 1100;

const EMULATOR = 'emulator';
const REMOTE = 'remote';
const MOCK_PATH = 'r2-mock';
const MOCK_VIRTUAL = 'r2-mock-virtual';
const MOCK_WRITE_LIMIT = 'r2-mock-write-limit';
const S3ProviderIdSchema = Schema.Literals([EMULATOR, REMOTE, MOCK_PATH, MOCK_VIRTUAL, MOCK_WRITE_LIMIT]);
export type S3ProviderId = typeof S3ProviderIdSchema.Type;

export interface S3ProviderState {
  /** The statuses a request without credentials may get from this row (R2 documents 401 Unauthorized). */
  readonly anonymousStatuses: readonly number[];
  /** None when the row is not configured: the test is skipped. */
  readonly config: Option.Option<S3ObjectStorageConfigValue>;
  readonly id: S3ProviderId;
  readonly label: string;
  /** Records a key the run created, so the cleanup of a remote run can remove exactly those keys. */
  readonly record: (key: string) => Effect.Effect<void>;
  /** A second write to one key waits this long on a row that rate-limits writes to one key. */
  readonly sameKeyWriteSpacingMillis: number;
}

export class S3ProviderUnderTest extends Context.Service<S3ProviderUnderTest, S3ProviderState>()(
  '@app/core-runtime/tests/S3ProviderUnderTest',
) {}

export interface S3ProviderDescriptor {
  readonly id: S3ProviderId;
  readonly label: string;
  readonly layer: Layer.Layer<S3ProviderUnderTest>;
}

const EMULATOR_LABEL = 'S3-compatible emulator (MinIO), NOT R2';
const REMOTE_LABEL = 'REMOTE S3 endpoint, operator-run throwaway bucket (evidence for that endpoint only)';

const recordNothing = () => Effect.void;

const unconfigured = {
  anonymousStatuses: [403],
  config: Option.none(),
  id: EMULATOR,
  label: EMULATOR_LABEL,
  record: recordNothing,
  sameKeyWriteSpacingMillis: 0,
} satisfies S3ProviderState;

const optionalSetting = (name: 'CORE_MEDIA_S3_ALLOW_REMOTE' | 'CORE_MEDIA_S3_TEST_BUCKET_MARKER') =>
  Config.option(Config.String(name)).pipe(
    Effect.orDie,
    Effect.map(Option.match({ onNone: () => ({}), onSome: (value) => ({ [name]: value }) })),
  );

/** The keys a remote run created, removed best-effort when the run ends: exactly those keys, nothing else. */
const withRunCleanup = (config: S3ObjectStorageConfigValue) =>
  Effect.gen(function* runCleanup() {
    const created = new Set<string>();
    yield* Effect.addFinalizer(() =>
      cleanupRecordedKeys(config, [...created]).pipe(
        Effect.flatMap((report) => Effect.logInfo(`S3 run cleanup: ${JSON.stringify(report)}`)),
        Effect.provide(FetchHttpClient.layer),
      ),
    );
    return (key: string) =>
      Effect.sync(() => {
        created.add(key);
      });
  });

/** The CORE_MEDIA_S3_* row: an emulator on loopback, or (opt-in, guarded) a real endpoint. */
const configuredState = Effect.gen(function* configuredState() {
  const endpoint = yield* Config.option(Config.String('CORE_MEDIA_S3_ENDPOINT')).pipe(Effect.orDie);
  if (Option.isNone(endpoint)) {
    return unconfigured;
  }
  const config = yield* loadS3ObjectStorageConfig({ envPath: NO_ENVIRONMENT_FILE }).pipe(Effect.orDie);
  const environment = {
    ...(yield* optionalSetting('CORE_MEDIA_S3_ALLOW_REMOTE')),
    ...(yield* optionalSetting('CORE_MEDIA_S3_TEST_BUCKET_MARKER')),
  };
  const decision = remoteRunSettings({ bucket: config.bucket, endpoint: config.endpoint, environment });
  if (Result.isFailure(decision)) {
    return yield* Effect.die(new ObjectStorageConfigError({ reason: decision.failure }));
  }
  if (decision.success.kind === 'local') {
    return { ...unconfigured, config: Option.some(config) } satisfies S3ProviderState;
  }
  yield* Effect.logWarning(
    `REMOTE RUN: the S3 provider suite will WRITE to the real endpoint of configuration ${config.fingerprint}, bucket marker "${decision.success.marker}" present. Only the keys this run creates are removed afterwards.`,
  );
  return {
    anonymousStatuses: [401, 403],
    config: Option.some(config),
    id: REMOTE,
    label: REMOTE_LABEL,
    record: yield* withRunCleanup(config),
    sameKeyWriteSpacingMillis: SAME_KEY_WRITE_SPACING_MILLIS,
  } satisfies S3ProviderState;
});

interface MockRow {
  readonly id: typeof MOCK_PATH | typeof MOCK_VIRTUAL | typeof MOCK_WRITE_LIMIT;
  readonly label: string;
  readonly mock: R2BehaviourMockOptions;
  readonly spacingMillis: number;
  readonly virtualHosted: boolean;
}

const MOCK_ROWS: readonly MockRow[] = [
  { id: MOCK_PATH, label: `${R2_MOCK_LABEL}, path-style`, mock: {}, spacingMillis: 0, virtualHosted: false },
  { id: MOCK_VIRTUAL, label: `${R2_MOCK_LABEL}, virtual-hosted`, mock: {}, spacingMillis: 0, virtualHosted: true },
  {
    id: MOCK_WRITE_LIMIT,
    label: `${R2_MOCK_LABEL}, path-style, one write per second per key`,
    mock: { sameKeyWriteIntervalMillis: 1000 },
    spacingMillis: SAME_KEY_WRITE_SPACING_MILLIS,
    virtualHosted: false,
  },
];

const startMock = (row: MockRow) =>
  Effect.gen(function* startMockEffect() {
    const mock = yield* startR2BehaviourMock(row.mock);
    const config = yield* parseS3ObjectStorageConfig({
      CORE_MEDIA_S3_ACCESS_KEY_ID: Redacted.value(mock.credentials.accessKeyId),
      CORE_MEDIA_S3_ADDRESSING_STYLE: row.virtualHosted ? 'virtual-host' : 'path',
      CORE_MEDIA_S3_BUCKET: mock.bucket,
      CORE_MEDIA_S3_CONDITIONAL_CREATE: 'supported',
      // `localhost` reaches the mock as `<bucket>.localhost`, which is how a virtual-hosted request names its bucket.
      CORE_MEDIA_S3_ENDPOINT: row.virtualHosted ? `http://localhost:${mock.origin.port}` : mock.origin.origin,
      CORE_MEDIA_S3_REGION: 'auto',
      CORE_MEDIA_S3_SECRET_ACCESS_KEY: Redacted.value(mock.credentials.secretAccessKey),
    }).pipe(Effect.orDie);
    return {
      // R2 documents 10002 Unauthorized, HTTP 401, for missing credentials.
      anonymousStatuses: [401],
      config: Option.some(config),
      id: row.id,
      label: row.label,
      // The same bookkeeping and cleanup as a remote run, so the wiring is exercised on every mock row.
      record: yield* withRunCleanup(config),
      sameKeyWriteSpacingMillis: row.spacingMillis,
    } satisfies S3ProviderState;
  });

const providerLayer = <Failure>(state: Effect.Effect<S3ProviderState, Failure, Scope.Scope>) =>
  Layer.effect(S3ProviderUnderTest, state.pipe(Effect.orDie));

export const s3Providers: readonly S3ProviderDescriptor[] = [
  {
    id: EMULATOR,
    label: `${EMULATOR_LABEL}, or the REMOTE endpoint when opted in`,
    layer: providerLayer(configuredState),
  },
  ...MOCK_ROWS.map((row) => ({ id: row.id, label: row.label, layer: providerLayer(startMock(row)) })),
];

/**
 * The settings of the provider row under test. A row that is not configured is SKIPPED (never passed); a supplied
 * non-loopback endpoint without the opt-in fails the suite instead of being written to.
 */
export const s3ProviderConfig = (ctx: { readonly skip: () => void }) =>
  Effect.gen(function* providerConfig() {
    const provider = yield* S3ProviderUnderTest;
    return Option.isSome(provider.config)
      ? provider.config.value
      : yield* Effect.sync(() => {
          ctx.skip();
        }).pipe(Effect.andThen(Effect.never));
  });

/** Records a key the run created (a remote run removes exactly the recorded keys when it ends). */
export const recordKey = (key: string) =>
  Effect.gen(function* recordCreatedKey() {
    const provider = yield* S3ProviderUnderTest;
    yield* provider.record(key);
  });

/** A second write to one key waits out the provider's documented same-key write rate where it has one. */
export const spaceSameKeyWrites = Effect.gen(function* spaceWrites() {
  const provider = yield* S3ProviderUnderTest;
  if (provider.sameKeyWriteSpacingMillis > 0) {
    yield* Effect.sleep(provider.sameKeyWriteSpacingMillis);
  }
});

/**
 * The same provider settings aimed at another origin (the fault proxy). A virtual-hosted row needs a host name that
 * carries the bucket as a subdomain, so its proxy origin is reached as `localhost` rather than `127.0.0.1`.
 */
export const pointAt = (config: S3ObjectStorageConfigValue, origin: URL): S3ObjectStorageConfigValue => {
  if (config.addressingStyle !== 'virtual-host') {
    return { ...config, endpoint: origin };
  }
  const endpoint = new URL(origin.href);
  endpoint.hostname = 'localhost';
  return { ...config, endpoint };
};
