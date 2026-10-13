import { Effect, Match, Random, Schema } from 'effect';
import { executeApplyCommand } from '../../../../api/apply-command-action-client.ts';
import { executeRecords } from '../../../../api/records-client.ts';
import { browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';
import type { MerchandiseCommand } from '../../../../../shared/actions/apply-command.ts';
import type { RecordsResponse } from '../../../../../shared/apis/records.ts';

/**
 * `conflict` is a stale revision (someone else changed the data); `rejected` is a business rule the
 * current state refuses, such as an issue larger than the stock on hand.
 */
const FailureReasonSchema = Schema.Literals(['conflict', 'forbidden', 'invalid', 'rejected', 'unavailable']);
export type FailureReason = typeof FailureReasonSchema.Type;

export type LoadOutcome =
  | { readonly ok: true; readonly response: RecordsResponse }
  | { readonly ok: false; readonly reason: FailureReason };

export type CommandOutcome =
  | { readonly ok: true; readonly revision: number }
  | { readonly ok: false; readonly reason: FailureReason };

type RecordsFailure = Effect.Error<ReturnType<typeof executeRecords>>;
type CommandFailure = Effect.Error<ReturnType<typeof executeApplyCommand>>;

/** Effect-injected randomness for correlation and idempotency identifiers. */
const newId = Effect.map(
  Effect.all([Random.nextInt, Random.nextInt, Random.nextInt], { concurrency: 1 }),
  ([first, second, third]) => `merchandise:products:${first}:${second}:${third}`,
);

/** Maps the records read's typed problems onto the four UI outcomes. Anything unlisted reads as unavailable. */
const recordsReason = (error: RecordsFailure): FailureReason =>
  Match.value(error).pipe(
    Match.tag('RecordsPolicyConflictProblem', (): FailureReason => 'conflict'),
    Match.tag('RecordsAuthenticationProblem', 'RecordsForbiddenProblem', (): FailureReason => 'forbidden'),
    Match.tag('RecordsInvalidProblem', 'RecordsPolicyProblem', (): FailureReason => 'invalid'),
    Match.orElse((): FailureReason => 'unavailable'),
  );

/** Maps the apply-command problems onto the UI outcomes. Anything unlisted reads as unavailable. */
const commandReason = (error: CommandFailure): FailureReason =>
  Match.value(error).pipe(
    Match.tag('ApplyCommandActionConflictProblem', (problem): FailureReason =>
      problem.code === 'merchandise_lifecycle_conflict' ? 'rejected' : 'conflict',
    ),
    Match.tag('ApplyCommandActionIneligibleProblem', (): FailureReason => 'rejected'),
    Match.tag(
      'ApplyCommandActionAuthenticationProblem',
      'ApplyCommandActionForbiddenProblem',
      (): FailureReason => 'forbidden',
    ),
    Match.tag('ApplyCommandActionInvalidProblem', (): FailureReason => 'invalid'),
    Match.orElse((): FailureReason => 'unavailable'),
  );

/** Full records read: products with derived stock, indicators, movements and the write capability. */
export const loadProducts = (onOutcome: (outcome: LoadOutcome) => void): void => {
  void browserRuntime.runPromise(
    newId.pipe(
      Effect.flatMap((correlation) => executeRecords({}, correlation)),
      Effect.match({
        onFailure: (error): LoadOutcome => ({ ok: false, reason: recordsReason(error) }),
        onSuccess: (response): LoadOutcome => ({ ok: true, response }),
      }),
      Effect.map(onOutcome),
    ),
  );
};

/** One command against the single merchandise apply-command action. Each call gets its own idempotency key. */
export const runCommand = (
  command: MerchandiseCommand,
  expectedRevision: number,
  onOutcome: (outcome: CommandOutcome) => void,
): void => {
  void browserRuntime.runPromise(
    newId.pipe(
      Effect.flatMap((idempotencyKey) =>
        executeApplyCommand({ command, expectedRevision }, idempotencyKey, { idempotencyKey }),
      ),
      Effect.match({
        onFailure: (error): CommandOutcome => ({ ok: false, reason: commandReason(error) }),
        onSuccess: (result): CommandOutcome => ({ ok: true, revision: result.revision }),
      }),
      Effect.map(onOutcome),
    ),
  );
};
