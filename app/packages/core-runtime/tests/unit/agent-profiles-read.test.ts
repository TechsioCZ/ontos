import { Option, Predicate, Schema } from 'effect';
import { expect, test } from 'effect-rstest';

import { TrustedPrincipalContextSchema } from '../../src/actions/principal-context.ts';
import {
  AgentProfilesInputSchema,
  AgentProfilesResultSchema,
  agentProfilesRead,
} from '../../src/auth/agent-profiles-read.ts';
import { DEFAULT_AGENT_PROFILE } from '../../src/auth/agent-profile-projection.ts';
import { getReadPermissionTargetResolver } from '../../src/reads/definition.ts';

const principalId = '6300a06d-e532-5f52-8f66-5f1d4752a75e';
const scope = {
  ...Schema.decodeSync(TrustedPrincipalContextSchema)({
    authBindingId: '00000000-0000-4000-8000-000000000005',
    authContextRef: 'better-auth-session:agent-profiles-read',
    authMethod: 'session',
    legalEntityId: '71000000-0000-4000-8000-000000000022',
    principalId,
    tenantId: '00000000-0000-4000-8000-000000000001',
  }),
  correlationId: 'agent-profiles-read-test',
};

test('activity profiles require selected-company access, never identity read_people or module management', () => {
  const resolver = getReadPermissionTargetResolver(agentProfilesRead);
  if (!Predicate.isFunction(resolver)) {
    throw new TypeError('Expected the exact-company permission resolver');
  }
  expect(resolver({ principalIds: [principalId] }, scope)).toEqual({ kind: 'legal_entity' });
  expect(agentProfilesRead.descriptor.entrypoint.authorization).toEqual({ kind: 'authenticated_principal' });
  expect(agentProfilesRead.descriptor.legalEntityScope).toBe('required');
  expect(agentProfilesRead.descriptor.permissionTarget).toBe('legal_entity');
});

test('profile read accepts only a bounded UUID principal list and no caller-selected scope', () => {
  const decode = Schema.decodeUnknownOption(AgentProfilesInputSchema);
  expect(Option.isSome(decode({ principalIds: [principalId] }))).toBe(true);
  expect(Option.isSome(decode({ principalIds: [] }))).toBe(true);
  expect(Option.isSome(decode({ principalIds: ['not-a-principal'] }))).toBe(false);
  expect(Option.isSome(decode({ principalIds: Array.from({ length: 1001 }, () => principalId) }))).toBe(false);
  expect(Object.keys(AgentProfilesInputSchema.fields)).toEqual(['principalIds']);
});

test('profile read returns typed fail-closed records rather than audit evidence', () => {
  expect(Schema.is(AgentProfilesResultSchema)({ profiles: [{ ...DEFAULT_AGENT_PROFILE, principalId }] })).toBe(true);
  expect(Object.keys(AgentProfilesResultSchema.fields)).toEqual(['profiles']);
  expect(agentProfilesRead.descriptor.evidencePolicy).toEqual({
    captureMode: 'metadata_only',
    policyKey: 'core.identity.agent-profiles.access.v1',
  });
});
