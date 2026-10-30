/**
 * How Pronájmy judges agent proposals for the platform approval queue (the agent review read): the lease a command
 * changes, the undo plan, whether the change is still in place and whether the person may write. Pronájmy has no
 * before -> after lines of its own. Pure; the read handler supplies the lease read as the person.
 */
import { Function as EffectFunction, Match, Option, Schema } from 'effect';
import type { Types } from 'effect';
import { agentRecordHolds } from '@app/shared-contracts/agent-diff';
import type { AgentCommand, AgentRevertPlan } from '@app/shared-contracts/agent-proposals';
import { AGENT_CREATED_ID_PLACEHOLDER, AGENT_REVERT_UNAVAILABLE } from '@app/shared-contracts/agent-proposals';
import type { AgentReviewItem, AgentReviewItemRequest } from '@app/shared-contracts/agent-review';
import { AGENT_REVERT_MISSING_BEFORE, agentRevertCommands, agentRevertNone } from '@app/shared-contracts/agent-revert';

type Rec = Schema.JsonObject;
type CommandDraft = Partial<Types.Mutable<AgentCommand>>;
type ReviewItemDraft = { -readonly [Key in keyof AgentReviewItem]: AgentReviewItem[Key] };

const isRecord = Schema.is(Schema.JsonObject);

export const RENT_STATE_UNAVAILABLE = 'Změnu stavu nájmu nelze automaticky vrátit.';

/** Resource id of the lease the command changes when it is one that is read live, undefined otherwise. */
export const targetOccupancyId = (command: AgentCommand): string | undefined =>
  Match.value(command['_tag']).pipe(
    Match.whenOr('SetRentTerms', 'UpdateDraft', () => {
      const ref = command['occupancyRef'];
      return isRecord(ref)
        ? Option.getOrUndefined(Schema.decodeUnknownOption(Schema.String)(ref['resourceId']))
        : undefined;
    }),
    Match.orElse(EffectFunction.constUndefined),
  );

export const occupancyRevert = (command: AgentCommand, before: Rec | undefined, tenantId: string): AgentRevertPlan => {
  const { occupancyRef } = command;
  return Match.value(command).pipe(
    Match.when({ _tag: 'SetRentTerms' }, () => {
      const { rentTerms } = before ?? {};
      return isRecord(rentTerms)
        ? agentRevertCommands([{ _tag: 'SetRentTerms', occupancyRef, rentTerms }])
        : agentRevertNone(AGENT_REVERT_MISSING_BEFORE);
    }),
    Match.when({ _tag: 'UpdateDraft' }, () => {
      const startDate = Schema.decodeUnknownOption(Schema.String)(before?.['startDate']);
      if (before === undefined || Option.isNone(startDate)) {
        return agentRevertNone(AGENT_REVERT_MISSING_BEFORE);
      }
      const { rentTerms } = before;
      const restored: CommandDraft = {
        _tag: 'UpdateDraft',
        endDate: before['endDate'] ?? null,
        occupancyRef,
        startDate: startDate.value,
      };
      if (isRecord(rentTerms)) {
        restored['rentTerms'] = rentTerms;
      }
      return agentRevertCommands([restored]);
    }),
    Match.when({ _tag: 'CreateDraft' }, () =>
      agentRevertCommands(
        [
          {
            _tag: 'Cancel',
            occupancyRef: {
              moduleId: 'property.leasing',
              resourceId: AGENT_CREATED_ID_PLACEHOLDER,
              resourceType: 'property.leasing.occupancy',
              tenantId,
            },
          },
        ],
        'resourceRef.resourceId',
      ),
    ),
    Match.whenOr({ _tag: 'Confirm' }, { _tag: 'Activate' }, { _tag: 'Complete' }, { _tag: 'Cancel' }, () =>
      agentRevertNone(RENT_STATE_UNAVAILABLE),
    ),
    Match.orElse(() => agentRevertNone()),
  );
};

/** Why „Vrátit vše“ will not undo the command once approved; undefined when Pronájmy declares an undo for it. */
export const revertUnavailableReasonOf = (command: AgentCommand): string | undefined =>
  Match.value(command['_tag']).pipe(
    Match.whenOr('SetRentTerms', 'UpdateDraft', 'CreateDraft', EffectFunction.constUndefined),
    Match.whenOr('Confirm', 'Activate', 'Complete', 'Cancel', () => RENT_STATE_UNAVAILABLE),
    Match.orElse(() => AGENT_REVERT_UNAVAILABLE),
  );

/** Does the lease still hold what the approved command set? Undefined when there is nothing to compare. */
export const occupancyStillInPlace = (command: AgentCommand, current: Rec | undefined): boolean | undefined =>
  Match.value(command).pipe(
    Match.when(
      { _tag: 'SetRentTerms' },
      () => current !== undefined && agentRecordHolds(command['rentTerms'], current['rentTerms']),
    ),
    Match.when({ _tag: 'UpdateDraft' }, () => current !== undefined && current['startDate'] === command['startDate']),
    Match.orElse(EffectFunction.constUndefined),
  );

/**
 * What the person reading may know about one proposal. `read` is undefined when their lease read failed;
 * `occupancy` is the live lease (wire JSON; undefined: not found for them).
 */
export interface OccupancyReviewInput {
  readonly occupancy: Rec | undefined;
  readonly read: { readonly canWrite: boolean | undefined } | undefined;
  readonly request: AgentReviewItemRequest;
  readonly tenantId: string;
}

export const reviewOccupancyProposal = ({
  occupancy,
  read,
  request,
  tenantId,
}: OccupancyReviewInput): AgentReviewItem => {
  const { command, key, stage } = request;
  const targeted = targetOccupancyId(command) !== undefined;
  if (stage === 'history') {
    return { key, visible: true };
  }
  if (stage === 'undo') {
    // Undo only over a lease read just now; a failed read leaves the change alone.
    const inPlace = occupancyStillInPlace(command, occupancy);
    const review: ReviewItemDraft = { key, visible: !targeted || occupancy !== undefined };
    if (inPlace !== undefined) {
      review.stillInPlace = inPlace;
    }
    return review;
  }
  const missing = targeted && read !== undefined && occupancy === undefined;
  const reason = revertUnavailableReasonOf(command);
  const review: ReviewItemDraft = {
    key,
    revert: occupancyRevert(command, occupancy, tenantId),
    visible: !missing,
  };
  if (read?.canWrite === false) {
    review.blockedReason = 'V tomto modulu nemáte oprávnění k zápisu.';
  }
  if (reason !== undefined) {
    review.revertUnavailableReason = reason;
  }
  return review;
};
