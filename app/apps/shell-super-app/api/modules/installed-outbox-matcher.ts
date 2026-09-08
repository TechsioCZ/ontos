import { matchOutboxMessages } from '@app/core-runtime';
import type {
  InstalledModuleCatalog,
  MatchOutboxMessagesInput,
  OutboxRuntime,
  OutboxMatchResult,
  OutboxPersistenceError,
  OutboxWorkerDescriptorError,
} from '@app/core-runtime';
import { Duration, Effect, Layer, Schedule } from 'effect';

import { installedModuleCatalog } from './installed-module-catalog.ts';
import type { ShellInstalledModuleCatalog } from './installed-module-catalog.ts';

export type InstalledOutboxMatch<Requirements = OutboxRuntime> = (
  input: MatchOutboxMessagesInput
) => Effect.Effect<
  OutboxMatchResult,
  OutboxPersistenceError | OutboxWorkerDescriptorError,
  Requirements
>;

/** One explicit provenance seam from the validated installed catalog into Core matching. */
export function matchInstalledOutboxMessagesOnce(
  catalog: InstalledModuleCatalog
): Effect.Effect<
  OutboxMatchResult,
  OutboxPersistenceError | OutboxWorkerDescriptorError,
  OutboxRuntime
>;
export function matchInstalledOutboxMessagesOnce<Requirements>(
  catalog: InstalledModuleCatalog,
  match: InstalledOutboxMatch<Requirements>
): Effect.Effect<
  OutboxMatchResult,
  OutboxPersistenceError | OutboxWorkerDescriptorError,
  Requirements
>;
export function matchInstalledOutboxMessagesOnce<Requirements>(
  catalog: InstalledModuleCatalog,
  match?: InstalledOutboxMatch<Requirements>
) {
  const input = { subscriptions: catalog.outboxSubscriptions };
  return match === undefined ? matchOutboxMessages(input) : match(input);
}

/**
 * Runs Core matching in the Shell/Core process. Failures are observable but never prevent
 * authentication or other unrelated Shell capabilities from starting.
 */
const installedOutboxMatcherTick = installedModuleCatalog.pipe(
  Effect.flatMap((catalog) => matchInstalledOutboxMessagesOnce(catalog)),
  Effect.tap((result) =>
    result.messagesMatched > 0
      ? Effect.annotateLogs(
          Effect.logInfo('Installed Outbox catalog matching completed'),
          {
            deliveriesCreated: result.deliveriesCreated,
            messagesMatched: result.messagesMatched,
          }
        )
      : Effect.void
  ),
  Effect.matchEffect({
    onFailure: (error) =>
      Effect.logError('Installed Outbox catalog matching failed', error),
    onSuccess: () => Effect.void,
  })
);

const installedOutboxMatcherLoop = installedOutboxMatcherTick.pipe(
  Effect.repeat(Schedule.spaced(Duration.millis(1000))),
  Effect.asVoid
);

export const InstalledOutboxMatcherLive: Layer.Layer<
  never,
  never,
  OutboxRuntime | ShellInstalledModuleCatalog
> = Layer.effectDiscard(
  installedOutboxMatcherLoop.pipe(Effect.forkScoped, Effect.asVoid)
);
