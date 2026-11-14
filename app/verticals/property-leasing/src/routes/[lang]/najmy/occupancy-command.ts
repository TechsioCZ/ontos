// The Save commands of the lease and stay form and what came of them: the outcome the form's draft controller reads.
import type { RevisionedSaveResult, SaveOutcome } from '@app/admin-ui';
import { ActionProposalAcceptedSchema } from '@app/core-runtime/http/action-proposal';
import { Effect, Match, Option, Predicate, Schema } from 'effect';
import { ApplyCommandResultSchema, FeedbackSchema, failureFeedback } from '../../../../shared/actions/apply-command.ts';
import type { Feedback, OccupancyCommand } from '../../../../shared/actions/apply-command.ts';
import type { Occupancy } from '../../../../shared/apis/records.ts';
import { executeRecords } from '../../../api/records-client.ts';
import type { OccupancyDraft } from './editor-state.ts';
import { newUuid, sendLeasingCommand } from './leasing-save.ts';
import type { OnProposal, UnchangedSince } from './leasing-save.ts';
import { draftUnchangedSince, leaseDraftRecord, stayDraftRecord, updateDraftCommand } from './occupancy-draft.ts';
import type { DraftReferences } from './occupancy-draft.ts';

/**
 * What one Save came to: `Saved` with the leases' new revision and the record it created or changed, `Proposed` when
 * it was parked for approval (nothing changed yet), `Conflict` when the edited record changed since the draft was
 * read, `Failed` with the reason otherwise.
 */
export const ConflictOutcomeSchema = Schema.TaggedStruct('Conflict', {});
export const FailedOutcomeSchema = Schema.TaggedStruct('Failed', { reason: FeedbackSchema });
export const ProposedOutcomeSchema = Schema.TaggedStruct('Proposed', { proposal: ActionProposalAcceptedSchema });
export const SavedOutcomeSchema = Schema.TaggedStruct('Saved', {
  resourceRef: ApplyCommandResultSchema.fields.resourceRef,
  revision: ApplyCommandResultSchema.fields.revision,
});
export const OccupancyOutcomeSchema = Schema.Union([
  ConflictOutcomeSchema,
  FailedOutcomeSchema,
  ProposedOutcomeSchema,
  SavedOutcomeSchema,
]);
export type OccupancyOutcome = typeof OccupancyOutcomeSchema.Type;

export const failedWith = (reason: Feedback): OccupancyOutcome => FailedOutcomeSchema.make({ reason });

/** The outcome as the draft controller reads it: the new revision once saved. */
export const revisionedResultOf = (outcome: OccupancyOutcome): RevisionedSaveResult =>
  Match.value(outcome).pipe(
    Match.tagsExhaustive({
      Conflict: (): RevisionedSaveResult => 'conflict',
      Failed: (): RevisionedSaveResult => 'failed',
      Proposed: (): RevisionedSaveResult => 'proposed',
      Saved: ({ revision }): RevisionedSaveResult => revision,
    }),
  );

/** The reason of a failed save, for the save bar's error line; None for every other outcome. */
export const failureReasonOf = (outcome: OccupancyOutcome): Option.Option<Feedback> =>
  Match.value(outcome).pipe(
    Match.tag('Failed', ({ reason }) => Option.some(reason)),
    Match.orElse(() => Option.none<Feedback>()),
  );

const isOccupancyConflict = <E extends { readonly _tag: string }>(error: E): boolean =>
  Predicate.isTagged(error, 'ApplyCommandActionConflictProblem') &&
  Predicate.hasProperty(error, 'code') &&
  error.code === 'occupancy_conflict';

/**
 * Sends one command against `expectedRevision` and answers its outcome; it never fails. The revision covers every
 * lease and stay, so a conflict is resent once against a fresh read while `unchanged` holds for it.
 */
export const sendOccupancyCommand = (
  command: OccupancyCommand,
  expectedRevision: number,
  unchanged: UnchangedSince,
): Effect.Effect<OccupancyOutcome> =>
  sendLeasingCommand(command, expectedRevision).pipe(
    Effect.catchTag('ApplyCommandActionConflictProblem', (conflict) =>
      conflict.code === 'occupancy_conflict'
        ? executeRecords({}, 'property-leasing.records').pipe(
            Effect.flatMap((fresh) =>
              unchanged(fresh) ? sendLeasingCommand(command, fresh.revision) : Effect.fail(conflict),
            ),
          )
        : Effect.fail(conflict),
    ),
    Effect.match({
      onFailure: (failure): OccupancyOutcome =>
        isOccupancyConflict(failure) ? ConflictOutcomeSchema.make({}) : failedWith(failureFeedback(failure)),
      onSuccess: (result): OccupancyOutcome =>
        Schema.is(ActionProposalAcceptedSchema)(result)
          ? ProposedOutcomeSchema.make({ proposal: result })
          : SavedOutcomeSchema.make({ resourceRef: result.resourceRef, revision: result.revision }),
    }),
  );

/** A new lease or stay cannot overwrite anyone's change: a conflict is resent once against a fresh read. */
const always: UnchangedSince = () => true;

/** The Save of a form that adds a record (a registration sheet, a prepared notice, a logged entry): one command. */
export type AdditionSave = (command: OccupancyCommand) => Effect.Effect<OccupancyOutcome>;

/** Sends an addition once; it overwrites nothing, so a conflict is resent once against a fresh read. */
export const sendAddition = (command: OccupancyCommand, expectedRevision: number): Effect.Effect<OccupancyOutcome> =>
  sendOccupancyCommand(command, expectedRevision, always);

/**
 * An addition's outcome as its form reads it. A conflict left after the resend is a failed save with its reason, never
 * a held conflict: there is no newer version of a record that does not exist yet, so Uložit sends the typed input again.
 */
export const additionResultOf = (
  outcome: OccupancyOutcome,
): { readonly reason: Option.Option<Feedback>; readonly status: SaveOutcome } =>
  Match.value(outcome).pipe(
    Match.tagsExhaustive({
      Conflict: () => ({ reason: Option.some<Feedback>('conflict'), status: 'failed' as const }),
      Failed: ({ reason }) => ({ reason: Option.some(reason), status: 'failed' as const }),
      Proposed: () => ({ reason: Option.none<Feedback>(), status: 'proposed' as const }),
      Saved: () => ({ reason: Option.none<Feedback>(), status: 'saved' as const }),
    }),
  );

/**
 * Runs an addition's Save for its draft controller and tells `onReason` why it failed (None otherwise), for the save
 * bar's error line; a failure before the command was sent (no new id) counts as `unavailable`.
 */
export const additionSaveOutcome = <E>(
  send: Effect.Effect<OccupancyOutcome, E>,
  onReason: (reason: Option.Option<Feedback>) => void,
): Effect.Effect<SaveOutcome> =>
  send.pipe(
    Effect.orElseSucceed(() => failedWith('unavailable')),
    Effect.map(additionResultOf),
    Effect.tap(({ reason }) =>
      Effect.sync(() => {
        onReason(reason);
      }),
    ),
    Effect.map(({ status }) => status),
  );

/**
 * Settles an addition as the page's own commands do: the lease's related lists are invalidated whatever came of it;
 * a saved addition re-reads the page so it is listed, a conflict too so the current data is shown, and a change parked
 * for approval is reported.
 */
export const settleAddition = (
  send: Effect.Effect<OccupancyOutcome>,
  {
    invalidate,
    onProposal,
    reload,
  }: {
    readonly invalidate: () => void;
    readonly onProposal: OnProposal;
    readonly reload: Effect.Effect<void>;
  },
): Effect.Effect<OccupancyOutcome> =>
  send.pipe(
    Effect.ensuring(Effect.sync(invalidate)),
    Effect.tap((outcome) =>
      Match.value(outcome).pipe(
        Match.tag('Saved', 'Conflict', () => reload),
        Match.tag('Proposed', ({ proposal }) =>
          Effect.sync(() => {
            onProposal(proposal);
          }),
        ),
        Match.orElse(() => Effect.void),
      ),
    ),
  );

/** The Save button of a new lease or stay: one CreateDraft against the leases as read now. */
export const createOccupancy = (
  draft: OccupancyDraft,
  {
    expectedRevision,
    kind,
    references,
  }: { readonly expectedRevision: number; readonly kind: 'lease' | 'stay'; readonly references: DraftReferences },
): Effect.Effect<OccupancyOutcome> =>
  newUuid.pipe(
    Effect.map((resourceId) => (kind === 'lease' ? leaseDraftRecord : stayDraftRecord)(draft, references, resourceId)),
    Effect.matchEffect({
      onFailure: (failure) => failure.pipe(failureFeedback, failedWith, Effect.succeed),
      onSuccess: Option.match({
        onNone: () => Effect.succeed(failedWith('validation')),
        onSome: (record) => sendOccupancyCommand({ _tag: 'CreateDraft', record }, expectedRevision, always),
      }),
    }),
  );

/**
 * The Save button of a lease draft: its period and rent against the revision the draft was read at. Someone else's
 * change of this draft stays a conflict; never an overwrite.
 */
export const saveLeaseDraft = (
  record: Pick<Occupancy, 'occupancyRef'>,
  draft: OccupancyDraft,
  { confirmed, expectedRevision }: { readonly confirmed: OccupancyDraft; readonly expectedRevision: number },
): Effect.Effect<OccupancyOutcome> =>
  Option.match(updateDraftCommand(record.occupancyRef, draft), {
    onNone: () => Effect.succeed(failedWith('validation')),
    onSome: (command) =>
      sendOccupancyCommand(command, expectedRevision, draftUnchangedSince(record.occupancyRef.resourceId, confirmed)),
  });
