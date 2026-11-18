import { Effect, Schema } from 'effect';
import { EntityIdSchema } from '../../shared/domain/common.ts';
import type { OpsCommand } from '../../shared/agendas.ts';
import type { CommandOutcome, FailureReason } from '../../src/ui/use-agenda.ts';

/** The id every created record gets in these tests. */
export const createdId = Schema.decodeSync(EntityIdSchema)('created-1');

/** The commands a form sent, answered with `answers` in turn (then with success). */
export interface RecordingRunner {
  readonly run: (command: OpsCommand) => Effect.Effect<CommandOutcome>;
  readonly sent: OpsCommand[];
}

export const recordingRunner = (
  answers: readonly FailureReason[] = [],
  entityIds: readonly (typeof EntityIdSchema.Type)[] = [createdId],
): RecordingRunner => {
  const sent: OpsCommand[] = [];
  const pending = [...answers];
  return {
    run: (command) =>
      Effect.sync((): CommandOutcome => {
        sent.push(command);
        const refusal = pending.shift();
        return refusal === undefined
          ? { ok: true, result: { entityIds, revision: sent.length + 1 } }
          : { ok: false, reason: refusal };
      }),
    sent,
  };
};
