import { Effect, Schema } from 'effect';

import { ConfigureAgentAuditEvidenceSchema } from '../modules/actions/configure-agent.action.ts';
import { defineSystemModuleEntrypoint } from '../modules/module-entrypoint.ts';
import type { ReadLoadContext } from '../reads/context.ts';
import { defineRead } from '../reads/definition.ts';
import { AgentProfileProjectionSchema, agentProfilesFromTransaction } from './agent-profile-projection.ts';

export const AgentProfilesInputSchema = Schema.Struct({
  principalIds: Schema.Array(ConfigureAgentAuditEvidenceSchema.fields.targetPrincipalId).check(
    Schema.isMaxLength(1000),
  ),
});
export const AgentProfilesResultSchema = Schema.Struct({
  profiles: Schema.Array(
    Schema.Struct({
      ...AgentProfileProjectionSchema.fields,
      principalId: ConfigureAgentAuditEvidenceSchema.fields.targetPrincipalId,
    }),
  ),
});

type Services = ReturnType<typeof agentProfilesFromTransaction>;
const load = Effect.fn('AgentProfilesRead.load')(function* load(
  input: typeof AgentProfilesInputSchema.Type,
  context: ReadLoadContext<Services>,
) {
  const profiles = yield* context.services.load(input.principalIds);
  return {
    evidence: { resultCount: profiles.size },
    result: { profiles: [...profiles].map(([principalId, profile]) => ({ ...profile, principalId })) },
  };
});

/**
 * Exact-company profiles for activity consumers. The caller retains activity/module authorization;
 * this read revalidates the original trusted principal and selected-company access, not read_people.
 */
export const agentProfilesRead = defineRead(
  {
    accessKind: 'list',
    entrypoint: defineSystemModuleEntrypoint({
      access: 'read',
      authorization: { kind: 'authenticated_principal' },
      entrypointKey: 'core.identity.agent-profiles',
      moduleKey: 'core.identity',
      role: 'api',
    }),
    evidencePolicy: { captureMode: 'metadata_only', policyKey: 'core.identity.agent-profiles.access.v1' },
    inputSchema: AgentProfilesInputSchema,
    legalEntityScope: 'required',
    owningModuleKey: 'core.identity',
    permissionTarget: 'legal_entity',
    policies: [],
    readKey: 'core.identity.agent-profiles',
    resultSchema: AgentProfilesResultSchema,
    schemaVersion: '1',
  },
  { load },
  (transaction) => Effect.succeed(agentProfilesFromTransaction(transaction)),
  () => ({ kind: 'legal_entity' }),
);
