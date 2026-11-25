import { Effect, Result } from 'effect';
import { expect, it } from 'effect-rstest';

import { remoteRunSettings } from '../support/s3-remote-guard.ts';

/*
 * The guard in front of the opt-in run of the S3 provider suite against a REAL endpoint. Pure decisions only: nothing
 * here opens a connection. The suite writes to a provider when, and only when, every rule below allows it.
 */

const REMOTE = new URL('https://0123456789abcdef.r2.cloudflarestorage.com');
const LOOPBACK = new URL('http://127.0.0.1:9000');
const OPT_IN = { CORE_MEDIA_S3_ALLOW_REMOTE: '1' } as const;

const decide = (input: Parameters<typeof remoteRunSettings>[0]) => Effect.succeed(remoteRunSettings(input));

it.effect('keeps a loopback endpoint a local run, with or without the flag', () =>
  Effect.gen(function* local() {
    for (const environment of [{}, OPT_IN]) {
      const decision = yield* decide({ bucket: 'anything', endpoint: LOOPBACK, environment });
      expect(decision).toStrictEqual(Result.succeed({ kind: 'local' }));
    }
  }),
);

it.effect('refuses a non-loopback endpoint exactly as before when the flag is absent or not exactly 1', () =>
  Effect.gen(function* refused() {
    for (const environment of [
      {},
      { CORE_MEDIA_S3_ALLOW_REMOTE: '' },
      { CORE_MEDIA_S3_ALLOW_REMOTE: 'true' },
      { CORE_MEDIA_S3_ALLOW_REMOTE: '0' },
      { CORE_MEDIA_S3_ALLOW_REMOTE: 'yes' },
    ]) {
      const decision = yield* decide({ bucket: 'prod-media-d20-test', endpoint: REMOTE, environment });
      expect(decision).toStrictEqual(
        Result.fail('The S3 integration suite writes only to a loopback emulator unless CORE_MEDIA_S3_ALLOW_REMOTE=1'),
      );
    }
  }),
);

it.effect('refuses a bucket whose name does not contain the safety marker, with the default and a configured one', () =>
  Effect.gen(function* marker() {
    const noMarker = yield* decide({ bucket: 'prod-media', endpoint: REMOTE, environment: OPT_IN });
    expect(Result.isFailure(noMarker)).toBe(true);
    expect(Result.isFailure(noMarker) ? noMarker.failure : '').toContain('-d20-test');
    const custom = { ...OPT_IN, CORE_MEDIA_S3_TEST_BUCKET_MARKER: '-scratch' };
    expect(
      Result.isFailure(yield* decide({ bucket: 'prod-media-d20-test', endpoint: REMOTE, environment: custom })),
    ).toBe(true);
    expect(yield* decide({ bucket: 'prod-media-scratch', endpoint: REMOTE, environment: custom })).toStrictEqual(
      Result.succeed({ kind: 'remote', marker: '-scratch' }),
    );
  }),
);

it.effect('allows a remote endpoint only with the flag and a marked bucket, and reports the marker it enforced', () =>
  Effect.gen(function* allowed() {
    const decision = yield* decide({ bucket: 'ontos-core-media-d20-test', endpoint: REMOTE, environment: OPT_IN });
    expect(decision).toStrictEqual(Result.succeed({ kind: 'remote', marker: '-d20-test' }));
  }),
);

it.effect('refuses a marker that is empty or too short to be a safety marker', () =>
  Effect.gen(function* weakMarker() {
    for (const marker of ['', '-', 'a', 'test']) {
      const decision = yield* decide({
        bucket: 'ontos-core-media-d20-test',
        endpoint: REMOTE,
        environment: { ...OPT_IN, CORE_MEDIA_S3_TEST_BUCKET_MARKER: marker },
      });
      expect(Result.isFailure(decision), `marker "${marker}"`).toBe(true);
    }
  }),
);
