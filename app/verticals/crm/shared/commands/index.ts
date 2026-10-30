// Central command union + dispatcher (owned by crm-scaffold). Feature lanes never edit this file: they add
// commands to their own shared/commands/<area>.ts arrays, which are spread in here.
import { Match, Schema } from 'effect';
import type { Effect } from 'effect';
import type { CommandChange, CommandContext, CrmCommandFailure } from './context.ts';
import type { PartyLinkInput } from '../domain/clients.ts';
import type { CrmState } from '../domain/state.ts';
import { AiChangesCommandSchema, aiChangesCommandSchemas, applyAiChangesCommand } from './ai-changes.ts';
import { ClientsCommandSchema, applyClientsCommand, clientsCommandSchemas } from './clients.ts';
import {
  CustomerInputsCommandSchema,
  applyCustomerInputsCommand,
  customerInputsCommandSchemas,
} from './customer-inputs.ts';
import { ImportsCommandSchema, applyImportsCommand, importsCommandSchemas } from './imports.ts';
import { TeamCommandSchema, applyTeamCommand, teamCommandSchemas } from './team.ts';
import { VisitsCommandSchema, applyVisitsCommand, visitsCommandSchemas } from './visits.ts';

export const CrmCommandSchema = Schema.Union([
  ...clientsCommandSchemas,
  ...visitsCommandSchemas,
  ...importsCommandSchemas,
  ...aiChangesCommandSchemas,
  ...teamCommandSchemas,
  ...customerInputsCommandSchemas,
]);
export type CrmCommand = typeof CrmCommandSchema.Type;
export type CrmCommandInput = typeof CrmCommandSchema.Encoded;

const isClientsCommand = Schema.is(ClientsCommandSchema);
const isVisitsCommand = Schema.is(VisitsCommandSchema);
const isImportsCommand = Schema.is(ImportsCommandSchema);
const isAiChangesCommand = Schema.is(AiChangesCommandSchema);
const isTeamCommand = Schema.is(TeamCommandSchema);
const isCustomerInputsCommand = Schema.is(CustomerInputsCommandSchema);

/** Party Registry links a command asks to store; each one is verified before the reducer runs (CRM.md §3). */
export const partyLinksOf = (command: CrmCommand): readonly PartyLinkInput[] =>
  Match.value(command).pipe(
    Match.tag('CreateClient', ({ partyRef }) => (partyRef === undefined ? [] : [partyRef])),
    Match.tag('LinkClientParty', ({ partyRef }) => [partyRef]),
    Match.orElse(() => []),
  );

export const dispatchCrmCommand = (
  state: CrmState,
  command: CrmCommand,
  context: CommandContext,
): Effect.Effect<CommandChange, CrmCommandFailure> =>
  Match.value(command).pipe(
    Match.when(isClientsCommand, (value) => applyClientsCommand(state, value, context)),
    Match.when(isVisitsCommand, (value) => applyVisitsCommand(state, value, context)),
    Match.when(isImportsCommand, (value) => applyImportsCommand(state, value, context)),
    Match.when(isAiChangesCommand, (value) => applyAiChangesCommand(state, value, context)),
    Match.when(isTeamCommand, (value) => applyTeamCommand(state, value, context)),
    Match.when(isCustomerInputsCommand, (value) => applyCustomerInputsCommand(state, value, context)),
    Match.exhaustive,
  );
