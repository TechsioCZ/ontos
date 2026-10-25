import { Option, Predicate, Schema } from 'effect';
import { expect, test } from 'effect-rstest';

import { TrustedPrincipalContextSchema } from '../../src/actions/principal-context.ts';
import { DEFAULT_AGENT_PROFILE } from '../../src/auth/agent-profile-projection.ts';
import {
  AgentOperatorCommandSchema,
  CompanyAgentDirectoryInputSchema,
  CompanyAgentDirectoryResultSchema,
  companyAgentDirectoryRead,
} from '../../src/auth/company-agent-directory-read.ts';
import { ReplaceAgentOperatorsAuditEvidenceSchema } from '../../src/modules/actions/agent-operator-command.ts';
import { getReadPermissionTargetResolver } from '../../src/reads/definition.ts';

const agentId = '6300a06d-e532-5f52-8f66-5f1d4752a75e';
const humanId = '6300a06d-e532-5f52-8f66-5f1d4752a75f';
const scope = {
  ...Schema.decodeSync(TrustedPrincipalContextSchema)({
    authBindingId: '00000000-0000-4000-8000-000000000005',
    authContextRef: 'better-auth-session:company-agent-directory',
    authMethod: 'session',
    legalEntityId: '71000000-0000-4000-8000-000000000022',
    principalId: humanId,
    tenantId: '00000000-0000-4000-8000-000000000001',
  }),
  correlationId: 'company-agent-directory-test',
};

test('directory preserves tenant OR selected-company read_people without manage_people or identity module gates', () => {
  const resolver = getReadPermissionTargetResolver(companyAgentDirectoryRead);
  if (!Predicate.isFunction(resolver)) {
    throw new TypeError('Expected the directory permission resolver');
  }
  expect(resolver({}, scope)).toEqual({
    kind: 'any_of',
    targets: [
      { kind: 'tenant', permission: 'read_people' },
      { kind: 'legal_entity', permission: 'read_people' },
    ],
  });
  expect(companyAgentDirectoryRead.descriptor.entrypoint.authorization).toEqual({ kind: 'authenticated_principal' });
  expect(companyAgentDirectoryRead.descriptor.legalEntityScope).toBe('required');
  expect(Object.keys(CompanyAgentDirectoryInputSchema.fields)).toEqual([]);
});

test('directory command metadata shares the native Action evidence bounds exactly', () => {
  expect(AgentOperatorCommandSchema.fields.desiredOperatorPrincipalIds).toBe(
    ReplaceAgentOperatorsAuditEvidenceSchema.fields.desiredOperatorPrincipalIds,
  );
  expect(AgentOperatorCommandSchema.fields.revision).toBe(ReplaceAgentOperatorsAuditEvidenceSchema.fields.revision);
  const decode = Schema.decodeUnknownOption(AgentOperatorCommandSchema);
  expect(Option.isSome(decode({ desiredOperatorPrincipalIds: [], revision: 1 }))).toBe(true);
  expect(Option.isSome(decode({ desiredOperatorPrincipalIds: [], revision: 0 }))).toBe(false);
  expect(Option.isSome(decode({ desiredOperatorPrincipalIds: [humanId, humanId], revision: 1 }))).toBe(false);
  expect(Option.isSome(decode({ desiredOperatorPrincipalIds: ['foreign'], revision: 1 }))).toBe(false);
});

test('directory distinguishes no committed command from a committed empty desired set for every agent status', () => {
  for (const status of ['active', 'disabled', 'archived']) {
    for (const operatorCommand of [null, { desiredOperatorPrincipalIds: [], revision: 1 }]) {
      expect(
        Schema.is(CompanyAgentDirectoryResultSchema)({
          agents: [
            {
              ...DEFAULT_AGENT_PROFILE,
              displayName: 'Agent',
              operatorCommand,
              operatorPrincipalIds: [humanId],
              principalId: agentId,
              status,
            },
          ],
          members: [agentId, humanId],
          people: [{ displayName: 'Čeněk', principalId: humanId }],
        }),
      ).toBe(true);
    }
  }
});

test('directory membership is independently represented, not inferred from returned humans or agents', () => {
  expect(Schema.is(CompanyAgentDirectoryResultSchema)({ agents: [], members: [humanId, agentId], people: [] })).toBe(
    true,
  );
  expect(companyAgentDirectoryRead.descriptor.evidencePolicy).toEqual({
    captureMode: 'metadata_only',
    policyKey: 'core.identity.company-agent-directory.access.v1',
  });
});
