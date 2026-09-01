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
import type {
  InstalledModuleCatalogError,
  ShellInstalledModuleCatalog,
} from './installed-module-catalog.ts';

export type InstalledOutboxMatch<Requirements = OutboxRuntime> = (
  input: MatchOutboxMessagesInput,
) => Effect.Effect<
  OutboxMatchResult,
  OutboxPersistenceError | OutboxWorkerDescriptorError,
  Requirements
>;

/** One explicit provenance seam from the validated installed catalog into Core matching. */
export function matchInstalledOutboxMessagesOnce(
  catalog: InstalledModuleCatalog,
): Effect.Effect<
  OutboxMatchResult,
  OutboxPersistenceError | OutboxWorkerDescriptorError,
  OutboxRuntime
>;
export function matchInstalledOutboxMessagesOnce<Requirements>(
  catalog: InstalledModuleCatalog,
  match: InstalledOutboxMatch<Requirements>,
): Effect.Effect<
  OutboxMatchResult,
  OutboxPersistenceError | OutboxWorkerDescriptorError,
  Requirements
>;
export function matchInstalledOutboxMessagesOnce<Requirements>(
  catalog: InstalledModuleCatalog,
  match?: InstalledOutboxMatch<Requirements>,
) {
  const input = { subscriptions: catalog.outboxSubscriptions };
  return match === undefined ? matchOutboxMessages(input) : match(input);
}

export interface InstalledOutboxMatcherLayerOptions {
  readonly intervalMs?: number;
  readonly loadCatalog?: Effect.Effect<
    InstalledModuleCatalog,
    InstalledModuleCatalogError,
    ShellInstalledModuleCatalog
  >;
  readonly match?: InstalledOutboxMatch;
}

/**
 * Runs Core matching in the Shell/Core process. Failures are observable but never prevent
 * authentication or other unrelated Shell capabilities from starting.
 */
export const createInstalledOutboxMatcherLayer = (
  options: InstalledOutboxMatcherLayerOptions = {},
): Layer.Layer<never, never, OutboxRuntime | ShellInstalledModuleCatalog> => {
  const loadCatalog = options.loadCatalog ?? installedModuleCatalog;
  const match = options.match ?? matchOutboxMessages;
  const intervalMs = options.intervalMs ?? 1000;
  const tick = loadCatalog.pipe(
    Effect.flatMap((catalog) => matchInstalledOutboxMessagesOnce(catalog, match)),
    Effect.tap((result) =>
      result.messagesMatched > 0
        ? Effect.annotateLogs(Effect.logInfo('Installed Outbox catalog matching completed'), {
            deliveriesCreated: result.deliveriesCreated,
            messagesMatched: result.messagesMatched,
          })
        : Effect.void,
    ),
    Effect.catchCause((cause) =>
      Effect.logError('Installed Outbox catalog matching failed', cause),
    ),
  );
  const loop = tick.pipe(
    Effect.repeat(Schedule.spaced(Duration.millis(intervalMs))),
    Effect.asVoid,
  );
  return Layer.effectDiscard(loop.pipe(Effect.forkScoped, Effect.asVoid));
};
