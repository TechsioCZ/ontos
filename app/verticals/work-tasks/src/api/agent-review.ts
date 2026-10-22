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

type Rec = Readonly<Record<string, unknown>>;

const isRecord = (value: unknown): value is Rec => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The ref of the task an approved CreateTask makes; `$createdId` is filled in from the command's answer. */
const taskRefOfCreated = (tenantId: string) => ({
  moduleId: 'work.tasks',
  resourceId: AGENT_CREATED_ID_PLACEHOLDER,
  resourceType: 'work.tasks.task',
  tenantId,
});

const TASK_STATE_UNAVAILABLE = 'Úkol nelze vrátit do původního stavu.';
const NULLABLE_TASK_KEYS = new Set(['dueDate', 'plannedHours', 'projectId']);

const TASK_STATE_TRANSITIONS: Readonly<Record<string, readonly string[]>> = {
  CANCELLED: [],
  DONE: [],
  IN_PROGRESS: ['WAITING', 'DONE', 'CANCELLED'],
  NEW: ['IN_PROGRESS', 'CANCELLED'],
  WAITING: ['IN_PROGRESS', 'DONE', 'CANCELLED'],
};

const VALUE_OPTIONS = {
  valueLabels: {
    priority: { HIGH: 'Vysoká', LOW: 'Nízká', NORMAL: 'Běžná' },
    state: { CANCELLED: 'Zrušeno', DONE: 'Hotovo', IN_PROGRESS: 'Rozpracováno', NEW: 'Nový', WAITING: 'Čeká' },
  },
};

const TASK_LABELS: Readonly<Record<string, string>> = {
  archived: 'Archivováno',
  assigneeEmployeeId: 'Zaměstnanec',
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
const TARGETED: ReadonlySet<string> = new Set(['UpdateTask', 'ChangeTaskState', 'AssignTask']);
const REVERTIBLE: ReadonlySet<string> = new Set(['CreateTask', 'UpdateTask', 'ChangeTaskState', 'AssignTask']);

/** Resource id of the task the command changes when it is one that is read live, undefined otherwise. */
export const targetTaskId = (command: AgentCommand): string | undefined => {
  const ref = command['taskRef'];
  return TARGETED.has(String(command['_tag'])) && isRecord(ref) && typeof ref['resourceId'] === 'string'
    ? ref['resourceId']
    : undefined;
};

export const taskDiff = (command: AgentCommand, before: Rec | undefined): AgentDiffLine[] | undefined => {
  switch (command['_tag']) {
    case 'CreateTask': {
      return agentFieldLines(command, TASK_LABELS, undefined, TASK_SKIP, VALUE_OPTIONS);
    }
    case 'UpdateTask':
    case 'ChangeTaskState':
    case 'AssignTask':
    case 'SetTaskArchived': {
      return agentFieldLines(command, TASK_LABELS, before, TASK_SKIP, VALUE_OPTIONS);
    }
    default: {
      return undefined;
    }
  }
};

export const taskRevert = (command: AgentCommand, before: Rec | undefined, tenantId: string): AgentRevertPlan => {
  const taskRef = command['taskRef'];
  switch (command['_tag']) {
    case 'CreateTask': {
      const createdRef = taskRefOfCreated(tenantId);
      return agentRevertCommands(
        [
          { _tag: 'ChangeTaskState', state: 'CANCELLED', taskRef: createdRef },
          { _tag: 'SetTaskArchived', archived: true, taskRef: createdRef },
        ],
        'task.ref.resourceId',
      );
    }
    case 'UpdateTask': {
      if (before === undefined) return agentRevertNone(AGENT_REVERT_MISSING_BEFORE);
      const fields: Record<string, unknown> = {};
      for (const key of Object.keys(command)) {
        if (key === '_tag' || key === 'taskRef') continue;
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
    }
    case 'ChangeTaskState': {
      const from = command['state'];
      const to = before?.['state'];
      const allowed = typeof from === 'string' ? (TASK_STATE_TRANSITIONS[from] ?? []) : [];
      return typeof to === 'string' && allowed.includes(to)
        ? agentRevertCommands([{ _tag: 'ChangeTaskState', state: to, taskRef }])
        : agentRevertNone(TASK_STATE_UNAVAILABLE);
    }
    case 'AssignTask': {
      const owner = before?.['ownerPrincipalRef'];
      return isRecord(owner)
        ? agentRevertCommands([{ _tag: 'AssignTask', ownerPrincipalRef: owner, taskRef }])
        : agentRevertNone(AGENT_REVERT_MISSING_BEFORE);
    }
    default: {
      return agentRevertNone();
    }
  }
};

/** Does the task still hold what the approved command set (only the fields the command set are compared)? */
export const taskStillInPlace = (command: AgentCommand, current: Rec | undefined): boolean | undefined => {
  if (!TARGETED.has(String(command['_tag']))) {
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
 * Work Tasks names the comment author from Workforce.
 */
export const provenanceComment = (
  command: AgentCommand,
  proposal: NonNullable<AgentReviewItemRequest['proposal']>,
  tenantId: string,
): AgentFollowUp | undefined => {
  const created = command['_tag'] === 'CreateTask';
  const taskRef = created ? taskRefOfCreated(tenantId) : command['taskRef'];
  if (!isRecord(taskRef)) {
    return undefined;
  }
  return {
    commands: [
      {
        _tag: 'AddTaskComment',
        taskRef,
        text: `Změnu „${proposal.summary}“ navrhl ${proposal.agentLabel}; schváleno na stránce Ke schválení.`,
      },
    ],
    ...(created ? { createdIdPath: 'task.ref.resourceId' } : {}),
    referenceAudiences: ['workforce'],
  };
};

/** What the person reading may know about one proposal. `task` is the live task (undefined: not found for them). */
export interface TaskReviewInput {
  readonly canWrite: boolean | undefined;
  readonly request: AgentReviewItemRequest;
  readonly task: Rec | undefined;
  /** The live task was read (false: not needed, or the read failed). */
  readonly taskRead: boolean;
  readonly tenantId: string;
}

export const reviewTaskProposal = ({ canWrite, request, task, taskRead, tenantId }: TaskReviewInput): AgentReviewItem => {
  const { command, key, proposal, stage } = request;
  const targeted = targetTaskId(command) !== undefined;
  if (stage === 'history') {
    const lines = taskDiff(command, undefined);
    return { key, visible: true, ...(lines === undefined ? {} : { diff: lines }) };
  }
  if (stage === 'undo') {
    // Undo only over a task read just now; a failed read leaves the change alone.
    const inPlace = taskStillInPlace(command, task);
    return { key, visible: !targeted || task !== undefined, ...(inPlace === undefined ? {} : { stillInPlace: inPlace }) };
  }
  const missing = targeted && taskRead && task === undefined;
  const lines = taskDiff(command, task);
  const tag = command['_tag'];
  const name = task?.['title'];
  const followUp = proposal === undefined ? undefined : provenanceComment(command, proposal, tenantId);
  return {
    key,
    revert: taskRevert(command, task, tenantId),
    visible: !missing,
    ...(canWrite === false ? { blockedReason: 'V tomto modulu nemáte oprávnění k zápisu.' } : {}),
    ...(lines === undefined ? {} : { diff: lines }),
    ...(followUp === undefined ? {} : { followUp }),
    ...(typeof tag === 'string' && REVERTIBLE.has(tag) ? {} : { revertUnavailableReason: AGENT_REVERT_UNAVAILABLE }),
    ...(typeof name === 'string' && name !== '' ? { targetName: name.slice(0, 300) } : {}),
  };
};
