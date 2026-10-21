// Revert recipes for approved agent commands. Pure data logic: `before` is the wire JSON of the target entity
// captured before the change; the plan runs as the reverting person through the module's own command handler.
import type { AgentCommand, AgentRevertPlan } from './agent-proposals.ts';
import { AGENT_CREATED_ID_PLACEHOLDER, AGENT_REVERT_UNAVAILABLE } from './agent-proposals.ts';

export interface AgentRevertInput {
  readonly before?: Readonly<Record<string, unknown>> | undefined;
  readonly command: AgentCommand;
  readonly tenantId: string;
}

const MISSING_BEFORE = 'Chybí původní hodnoty, změnu nelze automaticky vrátit.';
const CREATED_UNKNOWN = 'Nepodařilo se zjistit nově založený záznam, změnu nelze automaticky vrátit.';
const TASK_STATE_UNAVAILABLE = 'Úkol nelze vrátit do původního stavu.';
const RENT_STATE_UNAVAILABLE = 'Změnu stavu nájmu nelze automaticky vrátit.';
const NULLABLE_TASK_KEYS = new Set(['dueDate', 'plannedHours', 'projectId']);

const TASK_STATE_TRANSITIONS: Readonly<Record<string, readonly string[]>> = {
  CANCELLED: [],
  DONE: [],
  IN_PROGRESS: ['WAITING', 'DONE', 'CANCELLED'],
  NEW: ['IN_PROGRESS', 'CANCELLED'],
  WAITING: ['IN_PROGRESS', 'DONE', 'CANCELLED'],
};

const none = (reason: string): AgentRevertPlan => ({ kind: 'none', reason });

const commands = (list: AgentCommand[], createdIdPath?: string): AgentRevertPlan => ({
  commands: [...list],
  kind: 'commands',
  ...(createdIdPath === undefined ? {} : { createdIdPath }),
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const taskRevert = ({ before, command, tenantId }: AgentRevertInput): AgentRevertPlan => {
  const taskRef = command['taskRef'];
  const createdRef = {
    moduleId: 'siampark.work',
    resourceId: AGENT_CREATED_ID_PLACEHOLDER,
    resourceType: 'siampark.work.task',
    tenantId,
  };
  switch (command['_tag']) {
    case 'CreateTask':
      return commands(
        [
          { _tag: 'ChangeTaskState', state: 'CANCELLED', taskRef: createdRef },
          { _tag: 'SetTaskArchived', archived: true, taskRef: createdRef },
        ],
        'task.ref.resourceId',
      );
    case 'UpdateTask': {
      if (before === undefined) return none(MISSING_BEFORE);
      const fields: Record<string, unknown> = {};
      for (const key of Object.keys(command)) {
        if (key === '_tag' || key === 'taskRef') continue;
        const previous = before[key];
        if (previous !== undefined) {
          fields[key] = previous;
        } else if (NULLABLE_TASK_KEYS.has(key)) {
          fields[key] = null;
        } else {
          return none(MISSING_BEFORE);
        }
      }
      return commands([{ _tag: 'UpdateTask', taskRef, ...fields }]);
    }
    case 'ChangeTaskState': {
      const from = command['state'];
      const to = before?.['state'];
      const allowed = typeof from === 'string' ? (TASK_STATE_TRANSITIONS[from] ?? []) : [];
      if (typeof to === 'string' && allowed.includes(to)) {
        return commands([{ _tag: 'ChangeTaskState', state: to, taskRef }]);
      }
      return none(TASK_STATE_UNAVAILABLE);
    }
    case 'AssignTask': {
      const owner = before?.['ownerPrincipalRef'];
      return isRecord(owner)
        ? commands([{ _tag: 'AssignTask', ownerPrincipalRef: owner, taskRef }])
        : none(MISSING_BEFORE);
    }
    default:
      return none(AGENT_REVERT_UNAVAILABLE);
  }
};

const merchandiseRevert = ({ before, command }: AgentRevertInput): AgentRevertPlan => {
  switch (command['_tag']) {
    case 'ChangePrice': {
      if (before === undefined) return none(MISSING_BEFORE);
      const id = command['id'];
      const variantId = command['variantId'];
      if (typeof variantId === 'string') {
        const variants = before['variants'];
        const variant = Array.isArray(variants)
          ? variants.find((entry: unknown) => isRecord(entry) && entry['id'] === variantId)
          : undefined;
        return isRecord(variant) && typeof variant['priceMinor'] === 'number'
          ? commands([{ _tag: 'ChangePrice', id, priceMinor: variant['priceMinor'], variantId }])
          : none(MISSING_BEFORE);
      }
      const price = before['currentPriceMinor'];
      return typeof price === 'number'
        ? commands([{ _tag: 'ChangePrice', id, priceMinor: price }])
        : none(MISSING_BEFORE);
    }
    case 'UpdateProduct': {
      const patch = command['patch'];
      if (!isRecord(patch) || before === undefined) return none(MISSING_BEFORE);
      const restoredPatch: Record<string, unknown> = {};
      for (const key of Object.keys(patch)) {
        const previous = before[key];
        if (previous === undefined) return none(MISSING_BEFORE);
        restoredPatch[key] = previous;
      }
      return commands([{ _tag: 'UpdateProduct', id: command['id'], patch: restoredPatch }]);
    }
    case 'CreateProduct':
      return commands(
        [{ _tag: 'UpdateProduct', id: AGENT_CREATED_ID_PLACEHOLDER, patch: { active: false } }],
        'entityIds.0',
      );
    default:
      return none(AGENT_REVERT_UNAVAILABLE);
  }
};

const occupancyRevert = ({ before, command, tenantId }: AgentRevertInput): AgentRevertPlan => {
  const occupancyRef = command['occupancyRef'];
  switch (command['_tag']) {
    case 'SetRentTerms': {
      const rentTerms = before?.['rentTerms'];
      return isRecord(rentTerms)
        ? commands([{ _tag: 'SetRentTerms', occupancyRef, rentTerms }])
        : none(MISSING_BEFORE);
    }
    case 'UpdateDraft': {
      if (before === undefined || typeof before['startDate'] !== 'string') return none(MISSING_BEFORE);
      const rentTerms = before['rentTerms'];
      return commands([
        {
          _tag: 'UpdateDraft',
          occupancyRef,
          startDate: before['startDate'],
          endDate: before['endDate'] ?? null,
          ...(isRecord(rentTerms) ? { rentTerms } : {}),
        },
      ]);
    }
    case 'CreateDraft':
      return commands(
        [
          {
            _tag: 'Cancel',
            occupancyRef: {
              moduleId: 'siampark.occupancy',
              resourceId: AGENT_CREATED_ID_PLACEHOLDER,
              resourceType: 'siampark.occupancy.occupancy',
              tenantId,
            },
          },
        ],
        'resourceRef.resourceId',
      );
    case 'Confirm':
    case 'Activate':
    case 'Complete':
    case 'Cancel':
      return none(RENT_STATE_UNAVAILABLE);
    default:
      return none(AGENT_REVERT_UNAVAILABLE);
  }
};

export const buildAgentRevertPlan = (appId: string, input: AgentRevertInput): AgentRevertPlan => {
  switch (appId) {
    case 'siampark-work':
      return taskRevert(input);
    case 'merchandise':
      return merchandiseRevert(input);
    case 'siampark-occupancy':
      return occupancyRevert(input);
    default:
      return none(AGENT_REVERT_UNAVAILABLE);
  }
};

/** Value at a dot path; numeric segments index arrays. Returns undefined when the path is missing. */
export const valueAtPath = (value: unknown, path: string): unknown => {
  let current: unknown = value;
  for (const segment of path.split('.')) {
    if (Array.isArray(current)) {
      current = current[Number(segment)];
    } else if (isRecord(current)) {
      current = current[segment];
    } else {
      return undefined;
    }
  }
  return current;
};

const replaceCreatedId = (value: unknown, created: string): unknown => {
  if (value === AGENT_CREATED_ID_PLACEHOLDER) return created;
  if (Array.isArray(value)) return value.map((item: unknown) => replaceCreatedId(item, created));
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, replaceCreatedId(item, created)]),
    );
  }
  return value;
};

/** Fills the created-record id from the apply result. Plans without `createdIdPath` pass through unchanged. */
export const resolveAgentRevertPlan = (
  plan: AgentRevertPlan | null | undefined,
  applyResult: unknown,
): AgentRevertPlan => {
  if (plan === null || plan === undefined) return none(AGENT_REVERT_UNAVAILABLE);
  if (plan.kind === 'none' || plan.createdIdPath === undefined) return plan;
  const created = valueAtPath(applyResult, plan.createdIdPath);
  if (typeof created !== 'string' || created.length === 0) return none(CREATED_UNKNOWN);
  return {
    commands: plan.commands.map((command) => replaceCreatedId(command, created) as AgentCommand),
    kind: 'commands',
  };
};
