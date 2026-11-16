import { Schema } from 'effect';

/** Why a connection could not be opened; every one is a refusal of the consent, never a partial row. */
export const AgentConnectionRefusalSchema = Schema.Literals([
  'agent_connection_agent_inactive',
  'agent_connection_ended',
  'agent_connection_not_operator',
  'agent_connection_scope_missing',
]);
export type AgentConnectionRefusal = typeof AgentConnectionRefusalSchema.Type;

export class AgentConnectionRefused extends Schema.TaggedError<AgentConnectionRefused>()('AgentConnectionRefused', {
  code: AgentConnectionRefusalSchema,
  reason: Schema.String,
}) {}
