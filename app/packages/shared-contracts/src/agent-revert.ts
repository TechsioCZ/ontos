// Generic parts of undo plans for approved agent commands. A module builds the plan of its own commands in its agent
// review read (see agent-review.ts); the platform stores it at approval, fills in the id of a record the approved
// command created and runs the plan as the reverting person through the module's own command handler.
import { Schema } from 'effect';

import type { AgentCommand, AgentCommandSource, AgentCommandSourceValue, AgentRevertPlan } from './agent-proposals.ts';
import {
  AGENT_CREATED_ID_PLACEHOLDER,
  AGENT_REVERT_UNAVAILABLE,
  AgentCommandSourceSchema,
  AgentCommandValueSchema,
  agentCommandOf,
} from './agent-proposals.ts';

export const AGENT_REVERT_MISSING_BEFORE = 'Chybí původní hodnoty, změnu nelze automaticky vrátit.';
const CREATED_UNKNOWN = 'Nepodařilo se zjistit nově založený záznam, změnu nelze automaticky vrátit.';

const isSourceRecord = Schema.is(AgentCommandSourceSchema);
const isJsonRecord = Schema.is(Schema.JsonObject);
const isJsonArray = Schema.is(Schema.Array(AgentCommandValueSchema));

export const agentRevertNone = (reason: string = AGENT_REVERT_UNAVAILABLE): AgentRevertPlan => ({
  kind: 'none',
  reason,
});

/** Undo commands a module builds from its records; stored as their JSON (see `agentCommandOf`). */
export const agentRevertCommands = (list: readonly AgentCommandSource[], createdIdPath?: string): AgentRevertPlan => {
  const plan = { commands: list.map(agentCommandOf), kind: 'commands' as const };
  return createdIdPath === undefined ? plan : { ...plan, createdIdPath };
};

/** The previous value of every key of `patch` from `before`; undefined when any of them had no value. */
export const agentRestoredPatch = (
  patch: AgentCommandSourceValue,
  before: AgentCommandSource | undefined,
): AgentCommandSource | undefined => {
  if (!isSourceRecord(patch) || before === undefined) {
    return undefined;
  }
  const restored: Record<string, AgentCommandSourceValue> = {};
  for (const key of Object.keys(patch)) {
    const previous = before[key];
    if (previous === undefined) {
      return undefined;
    }
    restored[key] = previous;
  }
  return restored;
};

/** Value at a dot path; numeric segments index arrays. Returns undefined when the path is missing. */
export const valueAtPath = (value: Schema.Json | undefined, path: string): Schema.Json | undefined => {
  let current = value;
  for (const segment of path.split('.')) {
    if (isJsonArray(current)) {
      current = current[Number(segment)];
    } else if (isJsonRecord(current)) {
      current = current[segment];
    } else {
      return undefined;
    }
  }
  return current;
};

const replaceCreatedId = (value: Schema.Json, created: string): Schema.Json => {
  if (value === AGENT_CREATED_ID_PLACEHOLDER) {
    return created;
  }
  if (isJsonArray(value)) {
    return value.map((item) => replaceCreatedId(item, created));
  }
  if (isJsonRecord(value)) {
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
  applyResult: Schema.Json | undefined,
): AgentCommand[] | undefined => {
  if (createdIdPath === undefined) {
    return [...commands];
  }
  const created = valueAtPath(applyResult, createdIdPath);
  if (!Schema.is(Schema.String)(created) || created.length === 0) {
    return undefined;
  }
  return commands.map((command) =>
    Object.fromEntries(Object.entries(command).map(([key, value]) => [key, replaceCreatedId(value, created)])),
  );
};

/** Fills the created-record id from the apply result. Plans without `createdIdPath` pass through unchanged. */
export const resolveAgentRevertPlan = (
  plan: AgentRevertPlan | null | undefined,
  applyResult: Schema.Json | undefined,
): AgentRevertPlan => {
  if (plan === null || plan === undefined) {
    return agentRevertNone();
  }
  if (plan.kind === 'none' || plan.createdIdPath === undefined) {
    return plan;
  }
  const commands = withAgentCreatedId(plan.commands, plan.createdIdPath, applyResult);
  return commands === undefined ? agentRevertNone(CREATED_UNKNOWN) : { commands, kind: 'commands' };
};
