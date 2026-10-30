import { parseDatabaseConnectionPair } from '@app/core-runtime';
import type { DatabaseConnectionPair } from '@app/core-runtime';
import { LegacyCompletionPublicationError } from '@app/core-runtime/legacy-completion-publication';
import { Config, Context, Effect, Layer, Redacted } from 'effect';

export type PrivacyLegacyConnectionPair = DatabaseConnectionPair;
const unavailable = (cause: unknown) =>
  new LegacyCompletionPublicationError({ cause, reason: 'Privacy legacy completion configuration is unavailable' });

export class PrivacyLegacyConnections extends Context.Service<PrivacyLegacyConnections, PrivacyLegacyConnectionPair>()(
  '@app/privacy/scripts/legacy-completion-connections/PrivacyLegacyConnections',
) {}
export const PrivacyLegacyConnectionsLive = Layer.effect(
  PrivacyLegacyConnections,
  Effect.gen(function* loadOperatorConnections() {
    const [runtimeUrl, adminUrl] = yield* Effect.all(
      [Config.Redacted('DATABASE_URL'), Config.Redacted('DATABASE_ADMIN_URL')],
      { concurrency: 2 },
    ).pipe(Effect.mapError(unavailable));
    return yield* parseDatabaseConnectionPair({
      DATABASE_ADMIN_URL: Redacted.value(adminUrl),
      DATABASE_URL: Redacted.value(runtimeUrl),
    }).pipe(Effect.mapError(unavailable));
  }),
);
