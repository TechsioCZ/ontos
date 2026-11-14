import { expect, test } from 'effect-rstest';

import { DEFAULT_AGENT_PROFILE, foldAgentProfiles } from '@app/core-runtime';
import { demoAgentProfileSetup } from '../../api/auth/demo-seed/agent-profiles.ts';

const principalId = '6300a06d-e532-5f52-8f66-5f1d4752a75e';
const company = '71000000-0000-4000-8000-000000000022';
const foreignCompany = '71000000-0000-4000-8000-000000000020';
const profile = {
  description: 'Hlídá úkoly provozu.',
  displayName: 'Agent',
  legalEntityId: company,
  modules: [{ access: 'write', moduleId: 'work.tasks' }],
  operation: 'configure-agent',
  ownerPrincipalId: null,
  previousProfile: null,
  revision: 1,
  targetPrincipalId: principalId,
  writePolicy: 'approval',
};

test('explicit setup covers six inputs but creates no runtime profile', () => {
  expect(demoAgentProfileSetup).toHaveLength(6);
  for (const input of demoAgentProfileSetup) {
    expect(foldAgentProfiles(input.legalEntityId, [input.principalId], []).get(input.principalId)).toEqual(
      DEFAULT_AGENT_PROFILE,
    );
  }
});

test('an unaudited known demo ID is bez profilu, never a seeded grant or write policy', () => {
  expect(foldAgentProfiles(company, [principalId], []).get(principalId)).toEqual({
    description: null,
    hasProfile: false,
    modules: [],
    ownerPrincipalId: null,
    writePolicy: 'read_only',
  });
});

test('native exact-company audit evidence is the only configured profile', () => {
  expect(foldAgentProfiles(company, [principalId], [{ evidence: profile }]).get(principalId)).toEqual({
    description: profile.description,
    hasProfile: true,
    modules: profile.modules,
    ownerPrincipalId: null,
    writePolicy: 'approval',
  });
});

test('another company cannot supply a profile for the same principal', () => {
  expect(foldAgentProfiles(foreignCompany, [principalId], [{ evidence: profile }]).get(principalId)).toEqual(
    DEFAULT_AGENT_PROFILE,
  );
});

test('profile revisions, not timestamp ties or input order, choose the current configuration', () => {
  const newer = { ...profile, modules: [], revision: 2, writePolicy: 'read_only' };
  const result = foldAgentProfiles(company, [principalId], [{ evidence: newer }, { evidence: profile }]).get(
    principalId,
  );
  expect(result?.modules).toEqual([]);
  expect(result?.writePolicy).toBe('read_only');
});

test('an out-of-order corrupt revision cannot revive an older valid profile', () => {
  expect(
    foldAgentProfiles(
      company,
      [principalId],
      [
        { evidence: { ...profile, revision: 3, writePolicy: 'invented' } },
        { evidence: { ...profile, revision: 2 } },
        { evidence: profile },
      ],
    ).get(principalId),
  ).toEqual(DEFAULT_AGENT_PROFILE);
});

test('malformed latest native evidence fails closed rather than reviving an older profile', () => {
  expect(
    foldAgentProfiles(
      company,
      [principalId],
      [{ evidence: profile }, { evidence: { ...profile, revision: 2, writePolicy: 'invented' } }],
    ).get(principalId),
  ).toEqual(DEFAULT_AGENT_PROFILE);
});
