/**
 * How Úkoly judges agent proposals for the platform approval queue (the agent review read): the task a command
 * changes, its before -> after lines, the undo plan, whether the change is still in place, and the comment that
 * names the proposing agent once a person approved it. Pure; the read handler supplies the task read as the person.
 */
import { agentFieldLines, agentRecordHolds } from '@app/shared-contracts/agent-diff';
import type { AgentCommand, AgentDiffLine, AgentRevertPlan } from '@app/shared-contracts/agent-proposals';
import { AGENT_CREATED_ID_PLACEHOLDER, AGENT_REVERT_UNAVAILABLE } from '@app/shared-contracts/agent-proposals';
import type { AgentFollowUp, AgentReviewItem, AgentReviewItemRequest } from '@app/shared-contracts/agent-review';
import { AGENT_REVERT_MISSING_BEFORE, agentRevertCommands, agentRevertNone } from '@app/shared-contracts/agent-revert';
import { Match, Option, Predicate, Schema } from 'effect';
import { TaskStateSchema } from '../../shared/apis/records.ts';
import type { TaskState } from '../../shared/apis/records.ts';

type Rec = Schema.JsonObject;

const isRecord = Schema.is(Schema.JsonObject);

/** The ref of the task an approved CreateTask makes; `$createdId` is filled in from the command's answer. */
const taskRefOfCreated = (tenantId: string) => ({
  moduleId: 'work.tasks',
  resourceId: AGENT_CREATED_ID_PLACEHOLDER,
  resourceType: 'work.tasks.task',
  tenantId,
});

const TASK_STATE_UNAVAILABLE = 'Úkol nelze vrátit do původního stavu.';
const NULLABLE_TASK_KEYS = new Set(['dueDate', 'plannedHours', 'projectId']);

const TASK_STATE_TRANSITIONS = {
  CANCELLED: [],
  DONE: [],
  IN_PROGRESS: ['WAITING', 'DONE', 'CANCELLED'],
  NEW: ['IN_PROGRESS', 'CANCELLED'],
  WAITING: ['IN_PROGRESS', 'DONE', 'CANCELLED'],
} satisfies Readonly<Record<TaskState, readonly TaskState[]>>;

const VALUE_OPTIONS = {
  valueLabels: {
    priority: { HIGH: 'Vysoká', LOW: 'Nízká', NORMAL: 'Běžná' },
    state: { CANCELLED: 'Zrušeno', DONE: 'Hotovo', IN_PROGRESS: 'Rozpracováno', NEW: 'Nový', WAITING: 'Čeká' },
  },
};

const TASK_LABELS = {
  archived: 'Archivováno',
  contextRefs: 'Souvislosti',
  description: 'Popis',
  dueDate: 'Termín',
  opportunityId: 'Obchodní případ',
  ownerPrincipalRef: 'Řešitel',
  partyId: 'Zákazník',
  plannedHours: 'Plánované hodiny',
  priority: 'Priorita',
  projectId: 'Projekt',
  state: 'Stav',
  title: 'Název úkolu',
};
const TASK_SKIP: ReadonlySet<string> = new Set(['taskRef']);

/** Commands that change one existing task, read live for `before`, the undo plan and the in-place check. */
const targetsExistingTask = (command: AgentCommand): boolean =>
  Match.value(command).pipe(
    Match.whenOr({ _tag: 'UpdateTask' }, { _tag: 'ChangeTaskState' }, { _tag: 'AssignTask' }, () => true),
    Match.orElse(() => false),
  );
const isRevertibleTaskCommand = (command: AgentCommand): boolean =>
  Match.value(command).pipe(
    Match.whenOr(
      { _tag: 'CreateTask' },
      { _tag: 'UpdateTask' },
      { _tag: 'ChangeTaskState' },
      { _tag: 'AssignTask' },
      () => true,
    ),
    Match.orElse(() => false),
  );

/** Resource id of the task the command changes when it is one that is read live, undefined otherwise. */
export const targetTaskId = (command: AgentCommand): string | undefined => {
  const ref = command['taskRef'];
  return targetsExistingTask(command) && isRecord(ref) && Schema.is(Schema.String)(ref['resourceId'])
    ? ref['resourceId']
    : undefined;
};

export const taskDiff = (command: AgentCommand, before?: Rec): AgentDiffLine[] | undefined =>
  Match.value(command).pipe(
    Match.when({ _tag: 'CreateTask' }, () =>
      agentFieldLines(command, TASK_LABELS, undefined, TASK_SKIP, VALUE_OPTIONS),
    ),
    Match.whenOr(
      { _tag: 'UpdateTask' },
      { _tag: 'ChangeTaskState' },
      { _tag: 'AssignTask' },
      { _tag: 'SetTaskArchived' },
      () => agentFieldLines(command, TASK_LABELS, before, TASK_SKIP, VALUE_OPTIONS),
    ),
    Match.option,
    Option.getOrUndefined,
  );

export const taskRevert = (command: AgentCommand, before: Rec | undefined, tenantId: string): AgentRevertPlan => {
  const { taskRef } = command;
  return Match.value(command).pipe(
    Match.when({ _tag: 'CreateTask' }, () => {
      const createdRef = taskRefOfCreated(tenantId);
      return agentRevertCommands(
        [
          { _tag: 'ChangeTaskState', state: 'CANCELLED', taskRef: createdRef },
          { _tag: 'SetTaskArchived', archived: true, taskRef: createdRef },
        ],
        'task.ref.resourceId',
      );
    }),
    Match.when({ _tag: 'UpdateTask' }, () => {
      if (before === undefined) {
        return agentRevertNone(AGENT_REVERT_MISSING_BEFORE);
      }
      const fields: Record<string, Schema.Json> = {};
      for (const key of Object.keys(command)) {
        if (key === '_tag' || key === 'taskRef') {
          continue;
        }
        const previous = before[key];
        if (previous !== undefined) {
          fields[key] = previous;
        } else if (NULLABLE_TASK_KEYS.has(key)) {
          fields[key] = null;
        } else {
          return agentRevertNone(AGENT_REVERT_MISSING_BEFORE);
        }
      }
      return agentRevertCommands([{ _tag: 'UpdateTask', taskRef, ...fields }]);
    }),
    Match.when({ _tag: 'ChangeTaskState' }, () => {
      const from = Schema.decodeUnknownOption(TaskStateSchema)(command['state']);
      const to = Schema.decodeUnknownOption(TaskStateSchema)(before?.['state']);
      if (Option.isNone(from) || Option.isNone(to)) {
        return agentRevertNone(TASK_STATE_UNAVAILABLE);
      }
      const allowed: readonly TaskState[] = TASK_STATE_TRANSITIONS[from.value];
      return allowed.includes(to.value)
        ? agentRevertCommands([{ _tag: 'ChangeTaskState', state: to.value, taskRef }])
        : agentRevertNone(TASK_STATE_UNAVAILABLE);
    }),
    Match.when({ _tag: 'AssignTask' }, () => {
      const owner = before?.['ownerPrincipalRef'];
      return isRecord(owner)
        ? agentRevertCommands([{ _tag: 'AssignTask', ownerPrincipalRef: owner, taskRef }])
        : agentRevertNone(AGENT_REVERT_MISSING_BEFORE);
    }),
    Match.orElse(() => agentRevertNone()),
  );
};

/** Does the task still hold what the approved command set (only the fields the command set are compared)? */
export const taskStillInPlace = (command: AgentCommand, current?: Rec): boolean | undefined => {
  if (!targetsExistingTask(command)) {
    return undefined;
  }
  if (current === undefined) {
    return false;
  }
  const { _tag: _ignored, taskRef: _ref, ...fields } = command;
  return Object.entries(fields).every(([key, value]) => agentRecordHolds(value, current[key]));
};

/**
 * Task history only knows the approving person, so a comment on the task names the agent that proposed the change.
 * Work Tasks snapshots the comment author's Core principal display name.
 */
export const provenanceComment = (
  command: AgentCommand,
  proposal: NonNullable<AgentReviewItemRequest['proposal']>,
  tenantId: string,
): AgentFollowUp | undefined => {
  const created = Predicate.isTagged('CreateTask')(command);
  const taskRef = created ? taskRefOfCreated(tenantId) : command['taskRef'];
  if (!isRecord(taskRef)) {
    return undefined;
  }
  const followUp: AgentFollowUp = {
    commands: [
      {
        _tag: 'AddTaskComment',
        taskRef,
        text: `Změnu „${proposal.summary}“ navrhl ${proposal.agentLabel}; schváleno na stránce Ke schválení.`,
      },
    ],
    referenceAudiences: [],
  };
  if (created) {
    Object.assign(followUp, { createdIdPath: 'task.ref.resourceId' });
  }
  return followUp;
};

/** What the person reading may know about one proposal. `task` is the live task (undefined: not found for them). */
export interface TaskReviewInput {
  readonly canWrite: boolean | undefined;
  readonly request: AgentReviewItemRequest;
  readonly task?: Rec | undefined;
  /** The live task was read (false: not needed, or the read failed). */
  readonly taskRead: boolean;
  readonly tenantId: string;
}

export const reviewTaskProposal = ({
  canWrite,
  request,
  task,
  taskRead,
  tenantId,
}: TaskReviewInput): AgentReviewItem => {
  const { command, key, proposal, stage } = request;
  const targeted = targetTaskId(command) !== undefined;
  if (stage === 'history') {
    const lines = taskDiff(command);
    const review: AgentReviewItem = { key, visible: true };
    if (lines !== undefined) {
      Object.assign(review, { diff: lines });
    }
    return review;
  }
  if (stage === 'undo') {
    // Undo only over a task read just now; a failed read leaves the change alone.
    const inPlace = taskStillInPlace(command, task);
    const review: AgentReviewItem = { key, visible: !targeted || task !== undefined };
    if (inPlace !== undefined) {
      Object.assign(review, { stillInPlace: inPlace });
    }
    return review;
  }
  const missing = targeted && taskRead && task === undefined;
  const lines = taskDiff(command, task);
  const name = task?.['title'];
  const followUp = proposal === undefined ? undefined : provenanceComment(command, proposal, tenantId);
  const review: AgentReviewItem = { key, revert: taskRevert(command, task, tenantId), visible: !missing };
  if (canWrite === false) {
    Object.assign(review, { blockedReason: 'V tomto modulu nemáte oprávnění k zápisu.' });
  }
  if (lines !== undefined) {
    Object.assign(review, { diff: lines });
  }
  if (followUp !== undefined) {
    Object.assign(review, { followUp });
  }
  if (!isRevertibleTaskCommand(command)) {
    Object.assign(review, { revertUnavailableReason: AGENT_REVERT_UNAVAILABLE });
  }
  if (Schema.is(Schema.String)(name) && name !== '') {
    Object.assign(review, { targetName: name.slice(0, 300) });
  }
  return review;
};
