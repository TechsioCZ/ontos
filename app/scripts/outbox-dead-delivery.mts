#!/usr/bin/env node
import { NodeRuntime, NodeServices } from '@effect/platform-node';
import { Console, Effect, Layer, Option, Schema } from 'effect';
import { Command, Flag } from 'effect/cli';

import { CoreDatabase } from '../packages/core-runtime/src/db/client.ts';
import {
  describeDeadOutboxDeliveries,
  listDeadOutboxDeliveries,
  resolveDeadOutboxDelivery,
} from '../packages/core-runtime/src/outbox/dead-delivery-resolution.ts';
import { ApplicationCompositionAuthorityAdminDatabaseLive } from './application-composition-authority-publication.mts';

export class OutboxDeadDeliveryCommandError extends Schema.TaggedError<OutboxDeadDeliveryCommandError>()(
  'OutboxDeadDeliveryCommandError',
  { reason: Schema.String },
) {}

const WORKER_KEY_PATTERN = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*\.[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const COMPOSITION_REVISION_PATTERN = /^[a-f0-9]{64}$/u;
const LOWERCASE_PATTERN = /^[^A-Z]*$/u;
const MAX_OPERATOR_LENGTH = 200;
const MAX_REASON_LENGTH = 2000;
const MAX_LIST_LIMIT = 500;

const canonicalUuid = Schema.String.check(Schema.isUUID(), Schema.isPattern(LOWERCASE_PATTERN));
const TenantIdSchema = canonicalUuid.pipe(Schema.brand('OutboxResolutionTenantId'));
const MessageIdSchema = canonicalUuid.pipe(Schema.brand('OutboxResolutionMessageId'));
const WorkerKeySchema = Schema.String.check(Schema.isPattern(WORKER_KEY_PATTERN)).pipe(
  Schema.brand('OutboxResolutionWorkerKey'),
);
const RevisionSchema = Schema.String.check(Schema.isPattern(COMPOSITION_REVISION_PATTERN)).pipe(
  Schema.brand('OutboxResolutionCompositionRevision'),
);
const BoundedText = (maximum: number) =>
  Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(maximum), Schema.isPattern(/^[^\r\n\t]*$/u));

/** One exact dead delivery and the durable operator evidence for acting on it. */
export const OutboxDeadDeliveryResolutionArgumentsSchema = Schema.Struct({
  messageId: MessageIdSchema,
  operator: BoundedText(MAX_OPERATOR_LENGTH),
  reason: BoundedText(MAX_REASON_LENGTH),
  tenantId: TenantIdSchema,
  workerKey: WorkerKeySchema,
});
export type OutboxDeadDeliveryResolutionFlags = typeof OutboxDeadDeliveryResolutionArgumentsSchema.Encoded;

export const OutboxDeadDeliveryListArgumentsSchema = Schema.Struct({
  limit: Schema.Int.check(Schema.isBetween({ maximum: MAX_LIST_LIMIT, minimum: 1 })),
  tenantId: Schema.optional(TenantIdSchema),
  trackedRevision: Schema.optional(RevisionSchema),
});
export type OutboxDeadDeliveryListFlags = typeof OutboxDeadDeliveryListArgumentsSchema.Encoded;

const invalidArguments = (reason: string) => () => new OutboxDeadDeliveryCommandError({ reason });

/** Validates operator input before any database connection is opened. */
export const decodeOutboxDeadDeliveryResolutionArguments = (flags: OutboxDeadDeliveryResolutionFlags) =>
  Schema.decodeEffect(OutboxDeadDeliveryResolutionArgumentsSchema)(flags).pipe(
    Effect.mapError(
      invalidArguments(
        'Expected lowercase --tenant-id and --message-id UUIDs, an owned --worker-key, and a single-line ' +
          `--operator (at most ${String(MAX_OPERATOR_LENGTH)} characters) and --reason (at most ${String(MAX_REASON_LENGTH)})`,
      ),
    ),
  );

export const decodeOutboxDeadDeliveryListArguments = (flags: OutboxDeadDeliveryListFlags) =>
  Schema.decodeEffect(OutboxDeadDeliveryListArgumentsSchema)(flags).pipe(
    Effect.mapError(
      invalidArguments(
        `Expected an optional lowercase --tenant-id UUID, an optional 64-hex --tracked-revision, and --limit from 1 to ${String(MAX_LIST_LIMIT)}`,
      ),
    ),
  );

const resolutionFlags = {
  messageId: Flag.String('message-id').pipe(Flag.withDescription('Dead delivery Outbox message id')),
  operator: Flag.String('operator').pipe(Flag.withDescription('Who decides, recorded with the resolution')),
  reason: Flag.String('reason').pipe(Flag.withDescription('Why, recorded with the resolution')),
  tenantId: Flag.String('tenant-id').pipe(Flag.withDescription('Tenant that owns the message')),
  workerKey: Flag.String('worker-key').pipe(Flag.withDescription('Consumer Worker key of the delivery')),
};

const resolveCommand = (action: 'redrive' | 'release', description: string) =>
  Command.make(action, resolutionFlags, (flags) =>
    Effect.gen(function* resolveDeadDelivery() {
      const input = yield* decodeOutboxDeadDeliveryResolutionArguments(flags);
      const database = yield* CoreDatabase;
      const receipt = yield* database.executor.transaction((transaction) =>
        resolveDeadOutboxDelivery(transaction, {
          action,
          operatorName: input.operator,
          outboxMessageId: input.messageId,
          reason: input.reason,
          tenantId: input.tenantId,
          workerKey: input.workerKey,
        }),
      );
      yield* Console.log(
        `${receipt.action === 'redrive' ? 'Redrove' : 'Released'} delivery ${receipt.outboxDeliveryId} ` +
          `(${describeDeadOutboxDeliveries([{ ...receipt, attemptsCount: receipt.deadAttemptsCount }])}); ` +
          `now ${receipt.deliveryStatus}, recorded by ${receipt.recordedBy} at ${receipt.recordedAt.toISOString()}`,
      );
    }),
  ).pipe(
    Command.withDescription(description),
    Command.provide(() => ApplicationCompositionAuthorityAdminDatabaseLive),
  );

const listCommand = Command.make(
  'list',
  {
    limit: Flag.Int('limit').pipe(Flag.withDefault(100)),
    tenantId: Flag.String('tenant-id').pipe(Flag.optional),
    trackedRevision: Flag.String('tracked-revision').pipe(Flag.optional),
  },
  ({ limit, tenantId, trackedRevision }) =>
    Effect.gen(function* listDeadDeliveries() {
      const flags = {
        limit,
        tenantId: Option.getOrUndefined(tenantId),
        trackedRevision: Option.getOrUndefined(trackedRevision),
      } satisfies OutboxDeadDeliveryListFlags;
      const input = yield* decodeOutboxDeadDeliveryListArguments(flags);
      const database = yield* CoreDatabase;
      const dead = yield* listDeadOutboxDeliveries(database.executor, input);
      if (dead.length === 0) {
        return yield* Console.log('No dead Outbox deliveries match.');
      }
      for (const delivery of dead) {
        yield* Console.log(
          `${describeDeadOutboxDeliveries([delivery])} consumer=${delivery.consumerModuleKey} ` +
            `trackedRevision=${delivery.completionOriginalRevision ?? 'none'} deadSince=${delivery.updatedAt.toISOString()} ` +
            `lastError=${delivery.lastError ?? 'none'}`,
        );
      }
      return yield* Effect.void;
    }),
).pipe(
  Command.withDescription('List dead Outbox deliveries, optionally only those tracked for one composition'),
  Command.provide(() => ApplicationCompositionAuthorityAdminDatabaseLive),
);

const cli = Command.make('outbox-dead-delivery').pipe(
  Command.withSubcommands([
    listCommand,
    resolveCommand('redrive', 'Return one dead delivery to pending with a fresh attempt budget'),
    resolveCommand('release', 'Resolve one dead delivery without delivery, clearing its completion debt'),
  ]),
);

export const main = Command.run({ version: '1.0.0' })(cli);

if (import.meta.main) {
  NodeRuntime.runMain(
    Layer.build(Layer.effectDiscard(main).pipe(Layer.provide(NodeServices.layer))).pipe(Effect.scoped),
  );
}
