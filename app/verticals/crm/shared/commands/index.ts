// Central command union + dispatcher (owned by crm-scaffold). Feature lanes never edit this file: they add
// commands to their own shared/commands/<area>.ts arrays, which are spread in here.
import { Effect, Schema } from 'effect';
import type { CommandChange, CommandContext, CrmCommandFailure } from './context.ts';
import type { CrmState } from '../domain/state.ts';
import { AiChangesCommandSchema, aiChangesCommandSchemas, applyAiChangesCommand } from './ai-changes.ts';
import { ClientsCommandSchema, applyClientsCommand, clientsCommandSchemas } from './clients.ts';
import { ImportsCommandSchema, applyImportsCommand, importsCommandSchemas } from './imports.ts';
import { TeamCommandSchema, applyTeamCommand, teamCommandSchemas } from './team.ts';
import { VisitsCommandSchema, applyVisitsCommand, visitsCommandSchemas } from './visits.ts';

export const CrmCommandSchema = Schema.Union([
  ...clientsCommandSchemas,
  ...visitsCommandSchemas,
  ...importsCommandSchemas,
  ...aiChangesCommandSchemas,
  ...teamCommandSchemas,
]);
export type CrmCommand = typeof CrmCommandSchema.Type;

const isClientsCommand = Schema.is(ClientsCommandSchema);
const isVisitsCommand = Schema.is(VisitsCommandSchema);
const isImportsCommand = Schema.is(ImportsCommandSchema);
const isAiChangesCommand = Schema.is(AiChangesCommandSchema);
const isTeamCommand = Schema.is(TeamCommandSchema);

/** Commands a non-human principal (API key, agent bot) may not run. Lanes may extend via their own lists. */
export const nonHumanForbiddenCrmCommands: ReadonlySet<string> = new Set([
  'ArchiveClient',
  'AssignClient',
  // AI level C: only people decide on and revert AI proposals.
  'AiDecideChanges',
  'AiRevertBatch',
  // Team and identity links are people's decisions.
  'LinkClientParty',
  'RegisterSalesperson',
  'SetSalespersonActive',
]);
/** AI level C: an API key may run ONLY these commands in demo.crm (everything else is a proposal). */
export { nonHumanAllowedCrmCommands } from './ai-changes.ts';

export const dispatchCrmCommand = (
  state: CrmState,
  command: CrmCommand,
  context: CommandContext,
): Effect.Effect<CommandChange, CrmCommandFailure> => {
  if (isClientsCommand(command)) {
    return applyClientsCommand(state, command, context);
  }
  if (isVisitsCommand(command)) {
    return applyVisitsCommand(state, command, context);
  }
  if (isImportsCommand(command)) {
    return applyImportsCommand(state, command, context);
  }
  if (isAiChangesCommand(command)) {
    return applyAiChangesCommand(state, command, context);
  }
  if (isTeamCommand(command)) {
    return applyTeamCommand(state, command, context);
  }
  return Effect.die(new Error(`Unrouted CRM command ${String((command as { readonly _tag?: unknown })._tag)}`));
};
