// The Save commands of the lease and stay form and what came of them: the outcome the form's draft controller reads.
import type { RevisionedSaveResult } from '@app/admin-ui';
import { ActionProposalAcceptedSchema } from '@app/core-runtime/http/action-proposal';
import { Effect, Match, Option, Predicate, Schema } from 'effect';
import { ApplyCommandResultSchema, FeedbackSchema, failureFeedback } from '../../../../shared/actions/apply-command.ts';
import type { Feedback, OccupancyCommand } from '../../../../shared/actions/apply-command.ts';
import type { Occupancy } from '../../../../shared/apis/records.ts';
import { executeRecords } from '../../../api/records-client.ts';
import type { OccupancyDraft } from './editor-state.ts';
import { newUuid, sendLeasingCommand } from './leasing-save.ts';
import type { UnchangedSince } from './leasing-save.ts';
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
