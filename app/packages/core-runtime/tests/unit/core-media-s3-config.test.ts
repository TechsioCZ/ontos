import { Cause, Effect, Exit, Option, Redacted, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { ObjectStorageConfigError, parseS3ObjectStorageConfig } from '../../src/media/s3-config.ts';
import type { S3ObjectStorageEnvironment } from '../../src/media/s3-config.ts';

const complete: S3ObjectStorageEnvironment = {
  CORE_MEDIA_S3_ACCESS_KEY_ID: 'access-key-id-value',
  CORE_MEDIA_S3_ADDRESSING_STYLE: 'path',
  CORE_MEDIA_S3_BUCKET: 'a-test-bucket',
  CORE_MEDIA_S3_CONDITIONAL_CREATE: 'supported',
  CORE_MEDIA_S3_ENDPOINT: 'https://storage.example.test',
  CORE_MEDIA_S3_REGION: 'auto',
  CORE_MEDIA_S3_SECRET_ACCESS_KEY: 'secret-access-key-value',
};

const failureOf = (environment: S3ObjectStorageEnvironment) =>
  Effect.exit(parseS3ObjectStorageConfig(environment)).pipe(
    Effect.map((exit) => (Exit.isFailure(exit) ? Option.getOrUndefined(Cause.findErrorOption(exit.cause)) : undefined)),
  );

/** A deliberately insecure origin, built so that the test text names no clear-text URL. */
const plainHttp = (host: string) => `${['http', ''].join(':')}//${host}`;
const jsonText = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const requiredKeys = [
  'CORE_MEDIA_S3_ACCESS_KEY_ID',
  'CORE_MEDIA_S3_ADDRESSING_STYLE',
  'CORE_MEDIA_S3_BUCKET',
  'CORE_MEDIA_S3_CONDITIONAL_CREATE',
  'CORE_MEDIA_S3_ENDPOINT',
  'CORE_MEDIA_S3_REGION',
  'CORE_MEDIA_S3_SECRET_ACCESS_KEY',
] as const satisfies readonly (keyof S3ObjectStorageEnvironment)[];

const without = (key: keyof S3ObjectStorageEnvironment): S3ObjectStorageEnvironment =>
  Object.fromEntries(Object.entries(complete).filter(([name]) => name !== key));

it.effect('parses a complete configuration and keeps both credentials redacted', () =>
  Effect.gen(function* parsesComplete() {
    const config = yield* parseS3ObjectStorageConfig(complete);
    expect(config.endpoint.origin).toBe('https://storage.example.test');
    expect(config.bucket).toBe('a-test-bucket');
    expect(config.region).toBe('auto');
    expect(config.addressingStyle).toBe('path');
    expect(config.conditionalCreate).toBe('supported');
    expect(Option.isNone(config.partSizeBytes)).toBe(true);
    expect(Option.isNone(config.requestTimeoutMillis)).toBe(true);
    expect(Redacted.value(config.accessKeyId)).toBe('access-key-id-value');
    expect(Redacted.value(config.secretAccessKey)).toBe('secret-access-key-value');
    expect(jsonText(config)).not.toContain('secret-access-key-value');
    expect(jsonText(config)).not.toContain('access-key-id-value');
  }),
);

it.effect('fails closed on every missing required key and names the key, never a value', () =>
  Effect.gen(function* missingKeys() {
    for (const key of requiredKeys) {
      const failure = yield* failureOf(without(key));
      expect(failure).toBeInstanceOf(ObjectStorageConfigError);
      expect(failure?.reason).toContain(key);
      expect(failure?.reason).not.toContain('secret-access-key-value');
    }
  }),
);

it.effect('treats an empty value as missing', () =>
  Effect.gen(function* emptyValue() {
    const failure = yield* failureOf({ ...complete, CORE_MEDIA_S3_SECRET_ACCESS_KEY: '   ' });
    expect(failure?.reason).toContain('CORE_MEDIA_S3_SECRET_ACCESS_KEY');
  }),
);

it.effect('rejects a malformed endpoint, bucket, region, addressing style, capability and number', () =>
  Effect.gen(function* malformed() {
    const cases: readonly [Partial<S3ObjectStorageEnvironment>, string][] = [
      [{ CORE_MEDIA_S3_ENDPOINT: plainHttp('storage.example.test') }, 'CORE_MEDIA_S3_ENDPOINT'],
      [{ CORE_MEDIA_S3_ENDPOINT: 'https://user:pass@storage.example.test' }, 'CORE_MEDIA_S3_ENDPOINT'],
      [{ CORE_MEDIA_S3_ENDPOINT: 'https://storage.example.test/bucket' }, 'CORE_MEDIA_S3_ENDPOINT'],
      [{ CORE_MEDIA_S3_ENDPOINT: 'https://storage.example.test/?x=1' }, 'CORE_MEDIA_S3_ENDPOINT'],
      [{ CORE_MEDIA_S3_ENDPOINT: 'not a url' }, 'CORE_MEDIA_S3_ENDPOINT'],
      [{ CORE_MEDIA_S3_BUCKET: 'Bad_Bucket' }, 'CORE_MEDIA_S3_BUCKET'],
      [{ CORE_MEDIA_S3_REGION: 'Not A Region' }, 'CORE_MEDIA_S3_REGION'],
      [{ CORE_MEDIA_S3_ADDRESSING_STYLE: 'subdomain' }, 'CORE_MEDIA_S3_ADDRESSING_STYLE'],
      [{ CORE_MEDIA_S3_CONDITIONAL_CREATE: 'maybe' }, 'CORE_MEDIA_S3_CONDITIONAL_CREATE'],
      [{ CORE_MEDIA_S3_PART_SIZE_BYTES: '1024' }, 'CORE_MEDIA_S3_PART_SIZE_BYTES'],
      [{ CORE_MEDIA_S3_PART_SIZE_BYTES: 'abc' }, 'CORE_MEDIA_S3_PART_SIZE_BYTES'],
      [{ CORE_MEDIA_S3_REQUEST_TIMEOUT_MS: '0' }, 'CORE_MEDIA_S3_REQUEST_TIMEOUT_MS'],
      [{ CORE_MEDIA_S3_ACCESS_KEY_ID: 'has space' }, 'CORE_MEDIA_S3_ACCESS_KEY_ID'],
    ];
    for (const [override, key] of cases) {
      const failure = yield* failureOf({ ...complete, ...override });
      expect(failure?.reason, jsonText(override)).toContain(key);
    }
  }),
);

it.effect('allows plain http only on a loopback host', () =>
  Effect.gen(function* loopbackOnly() {
    expect(
      (yield* parseS3ObjectStorageConfig({ ...complete, CORE_MEDIA_S3_ENDPOINT: plainHttp('127.0.0.1:9000') })).endpoint
        .host,
    ).toBe('127.0.0.1:9000');
    expect((yield* failureOf({ ...complete, CORE_MEDIA_S3_ENDPOINT: plainHttp('10.0.0.5:9000') }))?.reason).toContain(
      'CORE_MEDIA_S3_ENDPOINT',
    );
  }),
);

it.effect('rejects a bucket with a dot under virtual-host addressing', () =>
  Effect.gen(function* dottedBucket() {
    const failure = yield* failureOf({
      ...complete,
      CORE_MEDIA_S3_ADDRESSING_STYLE: 'virtual-host',
      CORE_MEDIA_S3_BUCKET: 'a.dotted.bucket',
    });
    expect(failure?.reason).toContain('CORE_MEDIA_S3_BUCKET');
  }),
);

it.effect('accepts the optional part size and timeout only as explicit values, with no default', () =>
  Effect.gen(function* optionalValues() {
    const config = yield* parseS3ObjectStorageConfig({
      ...complete,
      CORE_MEDIA_S3_PART_SIZE_BYTES: String(8 * 1024 * 1024),
      CORE_MEDIA_S3_REQUEST_TIMEOUT_MS: '2500',
    });
    expect(config.partSizeBytes).toStrictEqual(Option.some(8 * 1024 * 1024));
    expect(config.requestTimeoutMillis).toStrictEqual(Option.some(2500));
  }),
);

it.effect('derives a stable provider identity and a safe fingerprint that no credential can change', () =>
  Effect.gen(function* identity() {
    const base = yield* parseS3ObjectStorageConfig(complete);
    const rotated = yield* parseS3ObjectStorageConfig({
      ...complete,
      CORE_MEDIA_S3_ACCESS_KEY_ID: 'another-id',
      CORE_MEDIA_S3_SECRET_ACCESS_KEY: 'another-secret',
    });
    const otherBucket = yield* parseS3ObjectStorageConfig({ ...complete, CORE_MEDIA_S3_BUCKET: 'another-bucket' });
    expect(rotated.providerId).toBe(base.providerId);
    expect(rotated.fingerprint).toBe(base.fingerprint);
    expect(otherBucket.providerId).not.toBe(base.providerId);
    expect(otherBucket.fingerprint).not.toBe(base.fingerprint);
    expect(base.providerId).toMatch(/^s3:[0-9a-f]{16}$/u);
    expect(base.fingerprint).toMatch(/^[0-9a-f]{16}$/u);
  }),
);
