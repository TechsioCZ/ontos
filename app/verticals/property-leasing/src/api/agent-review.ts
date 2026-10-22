/**
 * How Pronájmy judges agent proposals for the platform approval queue (the agent review read): the lease a command
 * changes, the undo plan, whether the change is still in place and whether the person may write. Pronájmy has no
 * before -> after lines of its own. Pure; the read handler supplies the lease read as the person.
 */
import { agentRecordHolds } from '@app/shared-contracts/agent-diff';
import type { AgentCommand, AgentRevertPlan } from '@app/shared-contracts/agent-proposals';
import { AGENT_CREATED_ID_PLACEHOLDER, AGENT_REVERT_UNAVAILABLE } from '@app/shared-contracts/agent-proposals';
import type { AgentReviewItem, AgentReviewItemRequest } from '@app/shared-contracts/agent-review';
import { AGENT_REVERT_MISSING_BEFORE, agentRevertCommands, agentRevertNone } from '@app/shared-contracts/agent-revert';

type Rec = Readonly<Record<string, unknown>>;

const isRecord = (value: unknown): value is Rec => typeof value === 'object' && value !== null && !Array.isArray(value);

export const RENT_STATE_UNAVAILABLE = 'Změnu stavu nájmu nelze automaticky vrátit.';

/** Commands that change one existing lease, read live for the undo plan and the in-place check. */
const TARGETED: ReadonlySet<string> = new Set(['SetRentTerms', 'UpdateDraft']);
const REVERTIBLE: ReadonlySet<string> = new Set(['SetRentTerms', 'UpdateDraft', 'CreateDraft']);
const STATE_CHANGES: ReadonlySet<string> = new Set(['Confirm', 'Activate', 'Complete', 'Cancel']);

/** Resource id of the lease the command changes when it is one that is read live, undefined otherwise. */
export const targetOccupancyId = (command: AgentCommand): string | undefined => {
  const ref = command['occupancyRef'];
  return TARGETED.has(String(command['_tag'])) && isRecord(ref) && typeof ref['resourceId'] === 'string'
    ? ref['resourceId']
    : undefined;
};

export const occupancyRevert = (command: AgentCommand, before: Rec | undefined, tenantId: string): AgentRevertPlan => {
  const occupancyRef = command['occupancyRef'];
  switch (command['_tag']) {
    case 'SetRentTerms': {
      const rentTerms = before?.['rentTerms'];
      return isRecord(rentTerms)
        ? agentRevertCommands([{ _tag: 'SetRentTerms', occupancyRef, rentTerms }])
        : agentRevertNone(AGENT_REVERT_MISSING_BEFORE);
    }
    case 'UpdateDraft': {
      if (before === undefined || typeof before['startDate'] !== 'string') {
        return agentRevertNone(AGENT_REVERT_MISSING_BEFORE);
      }
      const rentTerms = before['rentTerms'];
      return agentRevertCommands([
        {
          _tag: 'UpdateDraft',
          endDate: before['endDate'] ?? null,
          occupancyRef,
          startDate: before['startDate'],
          ...(isRecord(rentTerms) ? { rentTerms } : {}),
        },
      ]);
    }
    case 'CreateDraft': {
      return agentRevertCommands(
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
      );
    }
    case 'Confirm':
    case 'Activate':
    case 'Complete':
    case 'Cancel': {
      return agentRevertNone(RENT_STATE_UNAVAILABLE);
    }
    default: {
      return agentRevertNone();
    }
  }
};

/** Why „Vrátit vše“ will not undo the command once approved; undefined when Pronájmy declares an undo for it. */
export const revertUnavailableReasonOf = (command: AgentCommand): string | undefined => {
  const tag = String(command['_tag']);
  if (REVERTIBLE.has(tag)) return undefined;
  return STATE_CHANGES.has(tag) ? RENT_STATE_UNAVAILABLE : AGENT_REVERT_UNAVAILABLE;
};

/** Does the lease still hold what the approved command set? Undefined when there is nothing to compare. */
export const occupancyStillInPlace = (command: AgentCommand, current: Rec | undefined): boolean | undefined => {
  switch (command['_tag']) {
    case 'SetRentTerms': {
      return current !== undefined && agentRecordHolds(command['rentTerms'], current['rentTerms']);
    }
    case 'UpdateDraft': {
      return current !== undefined && current['startDate'] === command['startDate'];
    }
    default: {
      return undefined;
    }
  }
};

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

export const reviewOccupancyProposal = ({ occupancy, read, request, tenantId }: OccupancyReviewInput): AgentReviewItem => {
  const { command, key, stage } = request;
  const targeted = targetOccupancyId(command) !== undefined;
  if (stage === 'history') {
    return { key, visible: true };
  }
  if (stage === 'undo') {
    // Undo only over a lease read just now; a failed read leaves the change alone.
    const inPlace = occupancyStillInPlace(command, occupancy);
    return {
      key,
      visible: !targeted || occupancy !== undefined,
      ...(inPlace === undefined ? {} : { stillInPlace: inPlace }),
    };
  }
  const missing = targeted && read !== undefined && occupancy === undefined;
  const reason = revertUnavailableReasonOf(command);
  return {
    key,
    revert: occupancyRevert(command, occupancy, tenantId),
    visible: !missing,
    ...(read?.canWrite === false ? { blockedReason: 'V tomto modulu nemáte oprávnění k zápisu.' } : {}),
    ...(reason === undefined ? {} : { revertUnavailableReason: reason }),
  };
};
