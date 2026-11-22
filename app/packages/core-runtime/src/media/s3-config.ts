import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { Config, ConfigProvider, Data, Effect, Option, Redacted, Schema } from 'effect';
import { Hex } from 'effect/encoding';

import { loadDotEnvProvider } from '../environment/dotenv-provider.ts';
import { APP_ENV_PATH } from '../environment/workspace-environment.ts';

/*
 * The configuration of the S3-compatible object store behind Core Media. Every value comes from the environment
 * (key names in `.env.example`, values from the deployment's secret and configuration path). Nothing here names a
 * provider, endpoint, bucket, region or limit: the user supplies them, and a missing or malformed one fails closed.
 */

/** The smallest part an S3 multipart upload accepts, except for its last part (an S3 protocol constant). */
export const S3_MINIMUM_PART_BYTES = 5 * 1024 * 1024;
/** The largest part an S3 multipart upload accepts (an S3 protocol constant). */
export const S3_MAXIMUM_PART_BYTES = 5 * 1024 * 1024 * 1024;

const VIRTUAL_HOST = 'virtual-host';
const S3AddressingStyleSchema = Schema.Literals(['path', VIRTUAL_HOST]);
type S3AddressingStyle = typeof S3AddressingStyleSchema.Type;

/** Whether the provider honours `If-None-Match: *` on writes. Stated by the deployment, never assumed. */
const S3ConditionalCreateSchema = Schema.Literals(['supported', 'unsupported']);
type S3ConditionalCreateMode = typeof S3ConditionalCreateSchema.Type;

export type S3ObjectStorageEnvironment = Readonly<
  Partial<
    Record<
      | 'CORE_MEDIA_S3_ACCESS_KEY_ID'
      | 'CORE_MEDIA_S3_ADDRESSING_STYLE'
      | 'CORE_MEDIA_S3_BUCKET'
      | 'CORE_MEDIA_S3_CONDITIONAL_CREATE'
      | 'CORE_MEDIA_S3_ENDPOINT'
      | 'CORE_MEDIA_S3_PART_SIZE_BYTES'
      | 'CORE_MEDIA_S3_REGION'
      | 'CORE_MEDIA_S3_REQUEST_TIMEOUT_MS'
      | 'CORE_MEDIA_S3_SECRET_ACCESS_KEY',
      string
    >
  >
>;

type ConfigKey = keyof S3ObjectStorageEnvironment;

/** A configuration failure names the key that is wrong, never its value. */
export class ObjectStorageConfigError extends Data.TaggedError('ObjectStorageConfigError')<{
  readonly cause?: unknown;
  readonly reason: string;
}> {}

export interface S3ObjectStorageConfigValue {
  readonly accessKeyId: Redacted.Redacted;
  readonly addressingStyle: S3AddressingStyle;
  readonly bucket: string;
  readonly conditionalCreate: S3ConditionalCreateMode;
  /** The endpoint origin (scheme, host and optional port), with no path. */
  readonly endpoint: URL;
  /** A safe, non-reversible digest of every non-secret setting, for evidence. It never covers a credential. */
  readonly fingerprint: string;
  /** None means the provider's protocol minimum part size. */
  readonly partSizeBytes: Option.Option<number>;
  /** The stable identity recorded as `storageProvider`: it changes when the endpoint or bucket changes. */
  readonly providerId: string;
  readonly region: string;
  /** None means the adapter adds no timeout of its own: the caller's budget bounds the request. A configured value bounds the wait for the response head of each request; answer bodies and read streams are bounded by the caller's budget. */
  readonly requestTimeoutMillis: Option.Option<number>;
  readonly secretAccessKey: Redacted.Redacted;
}

const failure = (reason: string) => new ObjectStorageConfigError({ reason });
const failureWithCause = (reason: string, cause: unknown) => new ObjectStorageConfigError({ cause, reason });

const LOOPBACK_HOST = /^(?:127\.0\.0\.1|localhost|\[::1\])$/u;
/** An IPv4 address or a bracketed IPv6 address: a host that cannot carry the bucket as a subdomain. */
const IP_LITERAL_HOST = /^(?:\d{1,3}(?:\.\d{1,3}){3}|\[.*\])$/u;
const BUCKET_NAME = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u;
const REGION_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const CREDENTIAL_TEXT = /^[!-~]{1,512}$/u;
const POSITIVE_INTEGER = /^[1-9][0-9]{0,15}$/u;

const isAcceptedOrigin = (url: URL): boolean => {
  const transportAllowed = url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK_HOST.test(url.hostname));
  return (
    transportAllowed &&
    url.hostname.length > 0 &&
    url.username.length === 0 &&
    url.password.length === 0 &&
    url.pathname === '/' &&
    url.search.length === 0 &&
    url.hash.length === 0
  );
};

const parseEndpoint = (text: string): Option.Option<URL> =>
  Option.fromUndefinedOr(URL.canParse(text) ? new URL(text) : undefined).pipe(
    Option.filter(isAcceptedOrigin),
    Option.map((url) => new URL(url.origin)),
  );

const optionText = (value: Option.Option<number>): string =>
  value.pipe(
    Option.map(String),
    Option.getOrElse(() => ''),
  );

const fingerprintOf = (settings: {
  readonly addressingStyle: S3AddressingStyle;
  readonly bucket: string;
  readonly conditionalCreate: S3ConditionalCreateMode;
  readonly endpoint: URL;
  readonly partSizeBytes: Option.Option<number>;
  readonly region: string;
  readonly requestTimeoutMillis: Option.Option<number>;
}) =>
  Hex.encode(
    sha256(
      utf8ToBytes(
        [
          'core.media.s3.config',
          settings.endpoint.origin,
          settings.bucket,
          settings.region,
          settings.addressingStyle,
          settings.conditionalCreate,
          optionText(settings.partSizeBytes),
          optionText(settings.requestTimeoutMillis),
        ].join('\0'),
      ),
    ),
  ).slice(0, 16);

const providerIdOf = (endpoint: URL, bucket: string) => {
  const digest = Hex.encode(sha256(utf8ToBytes(['core.media.s3.provider', endpoint.origin, bucket].join('\0'))));
  return `s3:${digest.slice(0, 16)}`;
};

const required = (provider: ConfigProvider.ConfigProvider, name: ConfigKey) =>
  Config.schema(Schema.Trim, name)
    .parse(provider)
    .pipe(Effect.mapError((cause) => failureWithCause(`${name} is required`, cause)));

const optional = (provider: ConfigProvider.ConfigProvider, name: ConfigKey) =>
  Config.schema(Schema.Trim, name)
    .pipe(Config.option, Config.map(Option.filter((value) => value.length > 0)))
    .parse(provider)
    .pipe(Effect.mapError((cause) => failureWithCause(`${name} must be a string`, cause)));

const credential = (provider: ConfigProvider.ConfigProvider, name: ConfigKey) =>
  Config.Redacted(name)
    .pipe(Config.map((value) => Redacted.make(Redacted.value(value).trim())))
    .parse(provider)
    .pipe(
      Effect.mapError((cause) => failureWithCause(`${name} is required`, cause)),
      Effect.filterOrFail(
        (value) => CREDENTIAL_TEXT.test(Redacted.value(value)),
        () => failure(`${name} must be a printable credential without whitespace`),
      ),
    );

const positiveInteger = (name: ConfigKey, text: Option.Option<string>) =>
  Option.match(text, {
    onNone: () => Effect.succeed(Option.none<number>()),
    onSome: (value) =>
      POSITIVE_INTEGER.test(value)
        ? Effect.succeed(Option.some(Number(value)))
        : Effect.fail(failure(`${name} must be a positive integer`)),
  });

const parseWith = Effect.fn('Config.parseS3ObjectStorageConfig')(function* parseWith(
  provider: ConfigProvider.ConfigProvider,
) {
  const raw = yield* Effect.all(
    {
      accessKeyId: credential(provider, 'CORE_MEDIA_S3_ACCESS_KEY_ID'),
      addressingStyle: required(provider, 'CORE_MEDIA_S3_ADDRESSING_STYLE'),
      bucket: required(provider, 'CORE_MEDIA_S3_BUCKET'),
      conditionalCreate: required(provider, 'CORE_MEDIA_S3_CONDITIONAL_CREATE'),
      endpoint: required(provider, 'CORE_MEDIA_S3_ENDPOINT'),
      partSizeBytes: optional(provider, 'CORE_MEDIA_S3_PART_SIZE_BYTES'),
      region: required(provider, 'CORE_MEDIA_S3_REGION'),
      requestTimeoutMillis: optional(provider, 'CORE_MEDIA_S3_REQUEST_TIMEOUT_MS'),
      secretAccessKey: credential(provider, 'CORE_MEDIA_S3_SECRET_ACCESS_KEY'),
    },
    { concurrency: 4 },
  );

  const endpoint = parseEndpoint(raw.endpoint);
  if (Option.isNone(endpoint)) {
    return yield* failure(
      'CORE_MEDIA_S3_ENDPOINT must be an https origin (http only on a loopback host) without credentials, path, query or fragment',
    );
  }
  if (!BUCKET_NAME.test(raw.bucket)) {
    return yield* failure('CORE_MEDIA_S3_BUCKET must be a valid bucket name');
  }
  if (!REGION_NAME.test(raw.region)) {
    return yield* failure('CORE_MEDIA_S3_REGION must be a region name');
  }
  const addressingStyle = yield* Schema.decodeUnknownEffect(S3AddressingStyleSchema)(raw.addressingStyle).pipe(
    Effect.mapError((cause) =>
      failureWithCause('CORE_MEDIA_S3_ADDRESSING_STYLE must be one of: path, virtual-host', cause),
    ),
  );
  if (addressingStyle === VIRTUAL_HOST && IP_LITERAL_HOST.test(endpoint.value.hostname)) {
    return yield* failure(
      'CORE_MEDIA_S3_ENDPOINT must be a DNS name with virtual-host addressing: the bucket is a subdomain of it',
    );
  }
  if (addressingStyle === VIRTUAL_HOST && raw.bucket.includes('.')) {
    return yield* failure('CORE_MEDIA_S3_BUCKET must not contain a dot with virtual-host addressing');
  }
  const conditionalCreate = yield* Schema.decodeUnknownEffect(S3ConditionalCreateSchema)(raw.conditionalCreate).pipe(
    Effect.mapError((cause) =>
      failureWithCause('CORE_MEDIA_S3_CONDITIONAL_CREATE must be one of: supported, unsupported', cause),
    ),
  );
  const partSizeBytes = yield* positiveInteger('CORE_MEDIA_S3_PART_SIZE_BYTES', raw.partSizeBytes);
  if (Option.exists(partSizeBytes, (size) => size < S3_MINIMUM_PART_BYTES || size > S3_MAXIMUM_PART_BYTES)) {
    return yield* failure('CORE_MEDIA_S3_PART_SIZE_BYTES must be within the S3 part size range');
  }
  const requestTimeoutMillis = yield* positiveInteger('CORE_MEDIA_S3_REQUEST_TIMEOUT_MS', raw.requestTimeoutMillis);

  return {
    accessKeyId: raw.accessKeyId,
    addressingStyle,
    bucket: raw.bucket,
    conditionalCreate,
    endpoint: endpoint.value,
    fingerprint: fingerprintOf({
      addressingStyle,
      bucket: raw.bucket,
      conditionalCreate,
      endpoint: endpoint.value,
      partSizeBytes,
      region: raw.region,
      requestTimeoutMillis,
    }),
    partSizeBytes,
    providerId: providerIdOf(endpoint.value, raw.bucket),
    region: raw.region,
    requestTimeoutMillis,
    secretAccessKey: raw.secretAccessKey,
  } satisfies S3ObjectStorageConfigValue;
});

/** Parses the S3 object store settings from an explicit environment. Fails closed on a missing or malformed one. */
export const parseS3ObjectStorageConfig = (
  environment: S3ObjectStorageEnvironment,
): Effect.Effect<S3ObjectStorageConfigValue, ObjectStorageConfigError> =>
  parseWith(ConfigProvider.fromUnknown(environment, { preserveEmptyStrings: true }));

/** Loads the settings from the process environment, falling back to the application's root environment file. */
export const loadS3ObjectStorageConfig = (
  options: { readonly environment?: S3ObjectStorageEnvironment; readonly envPath?: string } = {},
): Effect.Effect<S3ObjectStorageConfigValue, ObjectStorageConfigError> => {
  const environmentProvider =
    options.environment === undefined
      ? ConfigProvider.fromEnv({ preserveEmptyStrings: true })
      : ConfigProvider.fromUnknown(options.environment, { preserveEmptyStrings: true });
  return loadDotEnvProvider(options.envPath ?? APP_ENV_PATH, failureWithCause).pipe(
    Effect.flatMap((fileProvider) => parseWith(ConfigProvider.orElse(environmentProvider, fileProvider))),
  );
};
