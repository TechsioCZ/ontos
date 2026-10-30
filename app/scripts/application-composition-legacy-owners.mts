import { createHash } from 'node:crypto';

import { privacyLegacyCompletionOwner } from '@app/privacy/admin/legacy-completion';
import {
  LegacyCompletionPublication,
  LegacyCompletionPublicationError,
  LegacyCompletionRetainedObservationSchema,
} from '@app/core-runtime/legacy-completion-publication';
import { Config, Effect, FileSystem, Layer, Path, Redacted, Schema } from 'effect';
import { parseDatabaseConnectionPair } from '../packages/core-runtime/src/db/config.ts';

const evidenceDirectoryUnavailable = 'The operator legacy completion evidence directory is unavailable';

const unavailable = (reason: string, cause?: unknown) => new LegacyCompletionPublicationError({ cause, reason });

/** Operator-only deployment wiring. Runtime applications never receive this capability. */
export const ApplicationCompositionLegacyOwnersLive = Layer.effect(
  LegacyCompletionPublication,
  Effect.gen(function* configureLegacyOwnerPublicationEvidence() {
    const filesystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* Config.String('ONTOS_LEGACY_COMPLETION_EVIDENCE_DIRECTORY').pipe(
      Effect.mapError((cause) => unavailable('The operator legacy completion evidence directory is required', cause)),
    );
    if (!path.isAbsolute(directory)) {
      return yield* unavailable('The operator legacy completion evidence directory must be absolute');
    }
    yield* filesystem
      .makeDirectory(directory, { mode: 0o700, recursive: true })
      .pipe(Effect.mapError((cause) => unavailable(evidenceDirectoryUnavailable, cause)));
    const canonicalDirectory = yield* filesystem
      .realPath(directory)
      .pipe(Effect.mapError((cause) => unavailable(evidenceDirectoryUnavailable, cause)));
    const status = yield* filesystem
      .stat(canonicalDirectory)
      .pipe(Effect.mapError((cause) => unavailable(evidenceDirectoryUnavailable, cause)));
    if (status.type !== 'Directory' || status.mode % 0o100 !== 0) {
      return yield* unavailable('The operator legacy completion evidence directory must be private');
    }
    const [runtimeUrl, adminUrl] = yield* Effect.all(
      [Config.Redacted('DATABASE_URL'), Config.Redacted('DATABASE_ADMIN_URL')],
      { concurrency: 1 },
    ).pipe(Effect.mapError((cause) => unavailable('The configured native database pair is required', cause)));
    const { runtime } = yield* parseDatabaseConnectionPair({
      DATABASE_ADMIN_URL: Redacted.value(adminUrl),
      DATABASE_URL: Redacted.value(runtimeUrl),
    }).pipe(Effect.mapError((cause) => unavailable('The configured native database pair is invalid', cause)));
    return {
      owners: [privacyLegacyCompletionOwner],
      retainEvidence: Effect.fn('LegacyCompletionPublication.retainEvidence')(function* retainEvidence(observation) {
        const name = createHash('sha256').update(observation.evidenceReference).digest('hex');
        const encoded = yield* Schema.encodeEffect(
          Schema.fromJsonString(Schema.toCodecJson(LegacyCompletionRetainedObservationSchema)),
        )(observation).pipe(
          Effect.mapError((cause) => unavailable('The native legacy completion observation is invalid', cause)),
        );
        yield* filesystem
          .writeFileString(path.join(canonicalDirectory, `${name}.json`), encoded, { flag: 'wx', mode: 0o600 })
          .pipe(
            Effect.mapError((cause) =>
              unavailable('The native legacy completion observation could not be retained', cause),
            ),
          );
      }),
      runtimeTarget: { databaseName: runtime.database, host: runtime.host, port: runtime.port, user: runtime.user },
      runtimeUser: runtime.user,
    } satisfies (typeof LegacyCompletionPublication)['Service'];
  }),
);
