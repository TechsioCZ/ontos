import { Config, ConfigProvider, Effect, Option, Schema } from 'effect';

import { ObjectStorageConfigError, loadS3ObjectStorageConfig } from '../../src/media/s3-config.ts';

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

const configuredEndpoint = Config.schema(Schema.Trim, 'CORE_MEDIA_S3_ENDPOINT').pipe(
  Config.option,
  Config.map(Option.filter((value) => value.length > 0)),
);

/**
 * The settings of the S3-compatible emulator, or a skipped test.
 *
 * Skipped only when no endpoint is configured at all. The loader reads its settings concurrently, so which missing
 * setting it reports first is not stable; the endpoint is therefore judged here, and a partial or malformed
 * configuration beside a configured endpoint fails the test. An endpoint that is not loopback fails too, so the suite
 * can never write test objects to a real provider. The root environment file is deliberately not consulted.
 */
export const emulatorConfig = (ctx: { readonly skip: () => void }) =>
  configuredEndpoint.parse(ConfigProvider.fromEnv({ preserveEmptyStrings: true })).pipe(
    Effect.orDie,
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.sync(() => ctx.skip()).pipe(Effect.andThen(Effect.never)),
        onSome: () =>
          loadS3ObjectStorageConfig({ envPath: '/nonexistent/core-media-s3-test.env' }).pipe(
            Effect.filterOrFail(
              (settings) => LOOPBACK.has(settings.endpoint.hostname),
              () =>
                new ObjectStorageConfigError({ reason: 'The S3 integration suite writes only to a loopback emulator' }),
            ),
            Effect.orDie,
          ),
      }),
    ),
  );
