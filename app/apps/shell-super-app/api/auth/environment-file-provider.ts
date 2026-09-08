import { NodeFileSystem } from '@effect/platform-node';
import {
  ConfigProvider,
  Context,
  Effect,
  FileSystem,
  Layer,
  Predicate,
} from 'effect';

export const loadEnvironmentFileProvider = <Failure>(
  envPath: string,
  unableToLoadEnvironment: () => Failure
): Effect.Effect<ConfigProvider.ConfigProvider, Failure> =>
  Effect.scoped(
    Layer.build(NodeFileSystem.layer).pipe(
      Effect.map((services) => Context.get(services, FileSystem.FileSystem)),
      Effect.flatMap((fileSystem) => fileSystem.readFileString(envPath)),
      Effect.catchIf(
        (error) => Predicate.isTagged(error.reason, 'NotFound'),
        () => Effect.succeed('')
      ),
      Effect.catchTag('PlatformError', () =>
        Effect.fail(unableToLoadEnvironment())
      ),
      Effect.map((contents) => ConfigProvider.fromDotEnvContents(contents))
    )
  );
