import { Effect, Schema } from 'effect';

import { describeDeadOutboxDeliveries } from '../../packages/core-runtime/src/outbox/dead-delivery-resolution.ts';
import type { DeadOutboxDelivery } from '../../packages/core-runtime/src/outbox/dead-delivery-resolution.ts';

export class OutboxDeadStartupBlocked extends Schema.TaggedError<OutboxDeadStartupBlocked>()(
  'OutboxDeadStartupBlocked',
  { reason: Schema.String },
) {}

/** Only explicit catalog absence permits a first install. An inventory error never means absence. */
export const startupDeadOutboxInventory = <CatalogError, CatalogRequirements, ListError, ListRequirements>(
  coreSchemaExists: Effect.Effect<boolean, CatalogError, CatalogRequirements>,
  list: Effect.Effect<readonly DeadOutboxDelivery[], ListError, ListRequirements>,
): Effect.Effect<readonly DeadOutboxDelivery[], CatalogError | ListError, CatalogRequirements | ListRequirements> =>
  coreSchemaExists.pipe(
    Effect.flatMap((exists): Effect.Effect<readonly DeadOutboxDelivery[], ListError, ListRequirements> =>
      exists ? list : Effect.succeed([]),
    ),
  );

/** Fail before owner DDL or authority mutation. Never resolves, ignores, or redrives existing work. */
export const withOutboxDeadStartupGate = <Value, StartupError, Requirements, ListError, ListRequirements>(
  list: Effect.Effect<readonly DeadOutboxDelivery[], ListError, ListRequirements>,
  startup: Effect.Effect<Value, StartupError, Requirements>,
): Effect.Effect<Value, StartupError | OutboxDeadStartupBlocked, Requirements | ListRequirements> =>
  list.pipe(
    Effect.mapError(
      () =>
        new OutboxDeadStartupBlocked({
          reason:
            'Unable to verify the all-tenant dead Outbox inventory; owner migrations and authority publication were not started',
        }),
    ),
    Effect.flatMap((dead): Effect.Effect<Value, StartupError | OutboxDeadStartupBlocked, Requirements> =>
      dead.length === 0
        ? startup
        : Effect.fail(
            new OutboxDeadStartupBlocked({
              reason: `Dead Outbox deliveries block this startup before owner migrations or authority publication. The existing authority was not changed. Resolve each through the audited outbox:dead-delivery CLI; no automatic retry or release: ${describeDeadOutboxDeliveries(dead)}`,
            }),
          ),
    ),
  );
