#!/usr/bin/env node
/**
 * Returns a `draining` Application Composition to `active` when no publisher is alive to do it: the operator's form of
 * the failing publisher's own restore, through the same transition (`abandonApplicationCompositionDrain`).
 *
 * - It proves no publisher is alive on the session it holds for the whole run: the environment-wide publication lock
 *   is taken without waiting (`pg_try_advisory_lock`), and the command refuses at once if another session holds it.
 * - It refuses unless the authority row is exactly `--revision`, `draining` and unexpired. A `sealed` or `migrated`
 *   revision is never returned: its seal precedes the schema migration.
 * - It writes exactly one row to `core.application_composition_drain_abandonments` (operator, reason, session user,
 *   transaction, time, the lease it found), whose triggers apply the transition in the same statement.
 * - It prints what it did, never a payload.
 */
import { NodeRuntime, NodeServices } from '@effect/platform-node';
import { Console, DateTime, Effect, Layer, Schema } from 'effect';
import { Command, Flag } from 'effect/cli';

import { CoreDatabase } from '../packages/core-runtime/src/db/client.ts';
import { abandonApplicationCompositionDrain } from '../packages/core-runtime/src/modules/application-composition-authority.ts';
import {
  ApplicationCompositionAuthorityAdminDatabaseLive,
  withApplicationCompositionPublicationTryLock,
} from './application-composition-authority-publication.mts';

export class CompositionAbandonDrainCommandError extends Schema.TaggedError<CompositionAbandonDrainCommandError>()(
  'CompositionAbandonDrainCommandError',
  { reason: Schema.String },
) {}

const MAX_OPERATOR_LENGTH = 200;
const MAX_REASON_LENGTH = 2000;
const BoundedText = (maximum: number) =>
  Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(maximum), Schema.isPattern(/^[^\r\n\t]*$/u));

/** One exact draining revision and the durable operator evidence for returning it to active. */
export const CompositionAbandonDrainArgumentsSchema = Schema.Struct({
  operator: BoundedText(MAX_OPERATOR_LENGTH),
  reason: BoundedText(MAX_REASON_LENGTH),
  revision: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
});
export type CompositionAbandonDrainFlags = typeof CompositionAbandonDrainArgumentsSchema.Encoded;

/** Validates operator input before any database connection is opened. */
export const decodeCompositionAbandonDrainArguments = (flags: CompositionAbandonDrainFlags) =>
  Schema.decodeEffect(CompositionAbandonDrainArgumentsSchema)(flags).pipe(
    Effect.mapError(
      () =>
        new CompositionAbandonDrainCommandError({
          reason:
            'Expected a 64-hex --revision, and a single-line --operator (at most ' +
            `${String(MAX_OPERATOR_LENGTH)} characters) and --reason (at most ${String(MAX_REASON_LENGTH)})`,
        }),
    ),
  );

/** The command's whole effect, for tests: the try-lock proof, then the one recorded transition. */
export const abandonDrainAsOperator = Effect.fn('CompositionAbandonDrain.run')(function* abandonDrainAsOperator(
  flags: CompositionAbandonDrainFlags,
) {
  const input = yield* decodeCompositionAbandonDrainArguments(flags);
  const database = yield* CoreDatabase;
  return yield* withApplicationCompositionPublicationTryLock(
    database.executor.transaction((transaction) =>
      abandonApplicationCompositionDrain(transaction, {
        initiatedBy: 'operator',
        operatorName: input.operator,
        reason: input.reason,
        revision: input.revision,
      }),
    ),
  );
});

const instant = (at: Date) => DateTime.formatIso(DateTime.makeUnsafe(at));

const command = Command.make(
  'composition-abandon-drain',
  {
    operator: Flag.String('operator').pipe(Flag.withDescription('Who decides, recorded with the abandonment')),
    reason: Flag.String('reason').pipe(Flag.withDescription('Why, recorded with the abandonment')),
    revision: Flag.String('revision').pipe(Flag.withDescription('The draining revision to return to active')),
  },
  (flags) =>
    abandonDrainAsOperator(flags).pipe(
      Effect.flatMap((recorded) =>
        Console.log(
          `Returned revision ${flags.revision} from draining to active with durable admission open. ` +
            `Drain abandonment ${recorded.drainAbandonmentId} recorded by ${recorded.recordedBy} at ` +
            `${instant(recorded.recordedAt)}; the lease is valid until ${instant(recorded.leaseValidUntil)}.`,
        ),
      ),
    ),
).pipe(
  Command.withDescription('Return a draining Application Composition to active when no publisher is alive'),
  Command.provide(() => ApplicationCompositionAuthorityAdminDatabaseLive),
);

export const main = Command.run({ version: '1.0.0' })(command);

if (import.meta.main) {
  NodeRuntime.runMain(
    Layer.build(Layer.effectDiscard(main).pipe(Layer.provide(NodeServices.layer))).pipe(Effect.scoped),
  );
}
