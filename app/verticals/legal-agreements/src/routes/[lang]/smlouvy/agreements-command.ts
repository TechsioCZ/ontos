// One agreements command and what came of it: the outcome a draft's Save button and a one-click command both read.
import type { RevisionedSaveResult } from '@app/admin-ui';
import { ActionProposalAcceptedSchema } from '@app/core-runtime/http/action-proposal';
import { makeReferenceGatewayCredentials } from '@app/shared-contracts';
import { Crypto, Effect, Option, Match, PlatformError, Predicate, Schema } from 'effect';
import { ApplyCommandResultSchema, FeedbackSchema, failureFeedback } from '../../../../shared/actions/apply-command.ts';
import type { AgreementsCommand, Feedback } from '../../../../shared/actions/apply-command.ts';
import type { Contract } from '../../../../shared/apis/records.ts';
import { executeApplyCommand } from '../../../api/apply-command-action-client.ts';
import { executeRecords } from '../../../api/records-client.ts';
import {
  contractReferenceAudiences,
  newContractRecord,
  periodUnchangedSince,
  updatePeriodCommand,
} from './agreement-draft.ts';
import type { CreateDraft, CreateReferences, PeriodDraft } from './agreement-draft.ts';

const browserCrypto = Crypto.make({
  digest: (algorithm, data) =>
    Effect.tryPromise({
      catch: (cause) => PlatformError.systemError({ _tag: 'Unknown', cause, method: 'digest', module: 'WebCrypto' }),
      try: globalThis.crypto.subtle.digest.bind(globalThis.crypto.subtle, algorithm, new Uint8Array(data)),
    }).pipe(
      Effect.map((buffer) => new Uint8Array(buffer)),
      Effect.timeoutOrElse({
        duration: '5 seconds',
        orElse: () =>
          Effect.fail(PlatformError.systemError({ _tag: 'TimedOut', method: 'digest', module: 'WebCrypto' })),
      }),
    ),
  randomBytes: (size) => globalThis.crypto.getRandomValues(new Uint8Array(size)),
});
/** A fresh UUID for new records and idempotency keys. */
export const newUuid = browserCrypto.randomUUIDv4();

/**
 * What one command came to: `Saved` with the agreements' new revision and the record it created or changed,
 * `Proposed` when it was parked for approval (nothing changed yet), `Conflict` when the agreements changed since the
 * revision it was sent against, `Failed` with the reason otherwise.
 */
export const ConflictOutcomeSchema = Schema.TaggedStruct('Conflict', {});
export const FailedOutcomeSchema = Schema.TaggedStruct('Failed', { reason: FeedbackSchema });
export const ProposedOutcomeSchema = Schema.TaggedStruct('Proposed', { proposal: ActionProposalAcceptedSchema });
export const SavedOutcomeSchema = Schema.TaggedStruct('Saved', {
  resourceRef: ApplyCommandResultSchema.fields.resourceRef,
  revision: ApplyCommandResultSchema.fields.revision,
});
export const AgreementOutcomeSchema = Schema.Union([
  ConflictOutcomeSchema,
  FailedOutcomeSchema,
  ProposedOutcomeSchema,
  SavedOutcomeSchema,
]);
export type AgreementOutcome = typeof AgreementOutcomeSchema.Type;

export const failedWith = (reason: Feedback): AgreementOutcome => FailedOutcomeSchema.make({ reason });

/** The outcome as the draft controller reads it: the new revision once saved. */
export const revisionedResultOf = (outcome: AgreementOutcome): RevisionedSaveResult =>
  Match.value(outcome).pipe(
    Match.tagsExhaustive({
      Conflict: (): RevisionedSaveResult => 'conflict',
      Failed: (): RevisionedSaveResult => 'failed',
      Proposed: (): RevisionedSaveResult => 'proposed',
      Saved: ({ revision }): RevisionedSaveResult => revision,
    }),
  );

/** The reason of a failed command, for the save bar's error line; None for every other outcome. */
export const failureReasonOf = (outcome: AgreementOutcome): Option.Option<Feedback> =>
  Match.value(outcome).pipe(
    Match.tag('Failed', ({ reason }) => Option.some(reason)),
    Match.orElse(() => Option.none<Feedback>()),
  );

const isAgreementsConflict = <E extends { readonly _tag: string }>(error: E): boolean =>
  Predicate.isTagged(error, 'ApplyCommandActionConflictProblem') &&
  Predicate.hasProperty(error, 'code') &&
  error.code === 'agreements_conflict';

export interface SendOptions {
  /** Owner modules whose references the command carries; each gets a reference credential. */
  readonly audiences: readonly string[];
  /**
   * Whether fresh agreements still hold what the command was built from. The revision covers every agreement, so a
   * conflict is resent once against a fresh read while this holds; without it a conflict stays a conflict.
   */
  readonly unchanged?: ((contracts: readonly Contract[]) => boolean) | undefined;
}

const sendOnce = (command: AgreementsCommand, expectedRevision: number, audiences: readonly string[]) =>
  Effect.all(
    { idempotencyKey: newUuid, referenceCredentials: makeReferenceGatewayCredentials(audiences) },
    { concurrency: 2 },
  ).pipe(
    Effect.flatMap(({ idempotencyKey, referenceCredentials }) =>
      executeApplyCommand({ command, expectedRevision }, 'legal-agreements.command', {
        idempotencyKey,
        referenceCredentials,
      }),
    ),
  );

/**
 * Sends one command against `expectedRevision` and answers its outcome; it never fails. What is sent is the command
 * as given: the outcome only reports, it never rebuilds the command from newer data.
 */
export const sendAgreementsCommand = (
  command: AgreementsCommand,
  expectedRevision: number,
  { audiences, unchanged }: SendOptions,
): Effect.Effect<AgreementOutcome> =>
  sendOnce(command, expectedRevision, audiences).pipe(
    Effect.catchTag('ApplyCommandActionConflictProblem', (conflict) =>
      conflict.code === 'agreements_conflict' && unchanged !== undefined
        ? executeRecords({}, 'legal-agreements.records').pipe(
            Effect.flatMap((fresh) =>
              unchanged(fresh.contracts) ? sendOnce(command, fresh.revision, audiences) : Effect.fail(conflict),
            ),
          )
        : Effect.fail(conflict),
    ),
    Effect.match({
      onFailure: (failure): AgreementOutcome =>
        isAgreementsConflict(failure) ? ConflictOutcomeSchema.make({}) : failedWith(failureFeedback(failure)),
      onSuccess: (result): AgreementOutcome =>
        Schema.is(ActionProposalAcceptedSchema)(result)
          ? ProposedOutcomeSchema.make({ proposal: result })
          : SavedOutcomeSchema.make({ resourceRef: result.resourceRef, revision: result.revision }),
    }),
  );

/**
 * The Save button of the new-contract form: one new contract against `expectedRevision`. A conflict caused by
 * another agreement is resent once, as a new contract cannot overwrite anyone's change.
 */
export const createAgreement = (
  draft: CreateDraft,
  { expectedRevision, references }: { readonly expectedRevision: number; readonly references: CreateReferences },
): Effect.Effect<AgreementOutcome> =>
  newUuid.pipe(
    Effect.map((resourceId) => newContractRecord(draft, references, resourceId)),
    Effect.matchEffect({
      onFailure: (failure) => failure.pipe(failureFeedback, failedWith, Effect.succeed),
      onSuccess: Option.match({
        onNone: () => Effect.succeed(failedWith('validation')),
        onSome: (record) =>
          sendAgreementsCommand({ _tag: 'CreateContract', record }, expectedRevision, {
            audiences: contractReferenceAudiences(record),
            unchanged: () => true,
          }),
      }),
    }),
  );

/**
 * The Save button of the period form: the contract as the draft read it, with the typed period, against the
 * revision the draft builds on. Someone else's change of this contract stays a conflict; never an overwrite.
 */
export const savePeriodDraft = (
  draft: PeriodDraft,
  expectedRevision: number,
  confirmed: PeriodDraft,
): Effect.Effect<AgreementOutcome> =>
  sendAgreementsCommand(updatePeriodCommand(draft), expectedRevision, {
    audiences: contractReferenceAudiences(draft.record),
    unchanged: periodUnchangedSince(confirmed),
  });
