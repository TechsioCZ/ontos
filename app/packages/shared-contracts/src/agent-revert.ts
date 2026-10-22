// Generic parts of undo plans for approved agent commands. A module builds the plan of its own commands in its agent
// review read (see agent-review.ts); the platform stores it at approval, fills in the id of a record the approved
// command created and runs the plan as the reverting person through the module's own command handler.
import type { AgentCommand, AgentRevertPlan } from './agent-proposals.ts';
import { AGENT_CREATED_ID_PLACEHOLDER, AGENT_REVERT_UNAVAILABLE } from './agent-proposals.ts';

export const AGENT_REVERT_MISSING_BEFORE = 'Chybí původní hodnoty, změnu nelze automaticky vrátit.';
const CREATED_UNKNOWN = 'Nepodařilo se zjistit nově založený záznam, změnu nelze automaticky vrátit.';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const agentRevertNone = (reason: string = AGENT_REVERT_UNAVAILABLE): AgentRevertPlan => ({
  kind: 'none',
  reason,
});

export const agentRevertCommands = (list: readonly AgentCommand[], createdIdPath?: string): AgentRevertPlan => ({
  commands: [...list],
  kind: 'commands',
  ...(createdIdPath === undefined ? {} : { createdIdPath }),
});

/** The previous value of every key of `patch` from `before`; undefined when any of them had no value. */
export const agentRestoredPatch = (
  patch: unknown,
  before: Readonly<Record<string, unknown>> | undefined,
): Record<string, unknown> | undefined => {
  if (!isRecord(patch) || before === undefined) return undefined;
  const restored: Record<string, unknown> = {};
  for (const key of Object.keys(patch)) {
    const previous = before[key];
    if (previous === undefined) return undefined;
    restored[key] = previous;
  }
  return restored;
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
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replaceCreatedId(item, created)]));
  }
  return value;
};

/**
 * Commands with every `$createdId` replaced by the value at `createdIdPath` of the apply result; the commands as
 * they are without a path, undefined when the path names no id.
 */
export const withAgentCreatedId = (
  commands: readonly AgentCommand[],
  createdIdPath: string | undefined,
  applyResult: unknown,
): AgentCommand[] | undefined => {
  if (createdIdPath === undefined) return [...commands];
  const created = valueAtPath(applyResult, createdIdPath);
  if (typeof created !== 'string' || created.length === 0) return undefined;
  return commands.map((command) => replaceCreatedId(command, created) as AgentCommand);
};

/** Fills the created-record id from the apply result. Plans without `createdIdPath` pass through unchanged. */
export const resolveAgentRevertPlan = (
  plan: AgentRevertPlan | null | undefined,
  applyResult: unknown,
): AgentRevertPlan => {
  if (plan === null || plan === undefined) return agentRevertNone();
  if (plan.kind === 'none' || plan.createdIdPath === undefined) return plan;
  const commands = withAgentCreatedId(plan.commands, plan.createdIdPath, applyResult);
  return commands === undefined ? agentRevertNone(CREATED_UNKNOWN) : { commands, kind: 'commands' };
};
