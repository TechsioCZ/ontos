import { ConfigProvider, Effect, Match, Predicate } from 'effect';

const nodeFileSystem = process.getBuiltinModule('node:fs');

export const loadDotEnvProvider = Effect.fn('Config.loadDotEnvProvider')(
  function* loadProvider<Failure>(
    envPath: string,
    configFailure: (reason: string, cause: unknown) => Failure
  ) {
    const result = yield* Effect.sync(() => {
      try {
        return {
          contents: nodeFileSystem.readFileSync(envPath, 'utf-8'),
          status: 'loaded',
        } as const;
      } catch (error) {
        if (
          Predicate.hasProperty(error, 'code') &&
          (error.code === 'ENOENT' ||
            error.code === 'NOT_FOUND_DOTENV_ENVIRONMENT')
        ) {
          return { status: 'missing' } as const;
        }
        return {
          error: configFailure(
            `Unable to load the root environment from ${envPath}`,
            error
          ),
          status: 'failed',
        } as const;
      }
    });

    return yield* Match.value(result).pipe(
      Match.discriminatorsExhaustive('status')({
        failed: ({ error }) => Effect.fail(error),
        loaded: ({ contents }) =>
          Effect.succeed(
            ConfigProvider.fromDotEnvContents(contents, {
              preserveEmptyStrings: true,
            })
          ),
        missing: () => Effect.succeed(ConfigProvider.fromUnknown({})),
      })
    );
  }
);
