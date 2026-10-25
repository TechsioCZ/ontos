import { expect, test } from 'effect-rstest';

import { DEFAULT_AGENT_PROFILE, foldAgentProfiles } from '../../src/auth/agent-profile-projection.ts';

const principalId = '6300a06d-e532-5f52-8f66-5f1d4752a75e';
const otherPrincipalId = '6300a06d-e532-5f52-8f66-5f1d4752a75f';
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

test('an unaudited principal has no selected modules or write authority', () => {
  expect(foldAgentProfiles(company, [principalId], []).get(principalId)).toEqual({
    description: null,
    hasProfile: false,
    modules: [],
    ownerPrincipalId: null,
    writePolicy: 'read_only',
  });
});

test('native exact-company evidence is the only configured profile', () => {
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

test('native create-agent evidence also supplies a profile', () => {
  expect(
    foldAgentProfiles(company, [principalId], [{ evidence: { ...profile, operation: 'create-agent' } }]).get(
      principalId,
    )?.hasProfile,
  ).toBe(true);
});

test('profile revisions, not timestamp ties or input order, select current configuration', () => {
  const newer = { ...profile, modules: [], revision: 2, writePolicy: 'read_only' };
  const result = foldAgentProfiles(company, [principalId], [{ evidence: newer }, { evidence: profile }]).get(
    principalId,
  );
  expect(result?.modules).toEqual([]);
  expect(result?.writePolicy).toBe('read_only');
});

test('an out-of-order corrupt authoritative revision cannot revive an older valid profile', () => {
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

test('an unparseable revision blocks even a later valid revision', () => {
  expect(
    foldAgentProfiles(
      company,
      [principalId],
      [{ evidence: { ...profile, revision: 'corrupt' } }, { evidence: { ...profile, revision: 100 } }],
    ).get(principalId),
  ).toEqual(DEFAULT_AGENT_PROFILE);
});

test('corruption in a foreign-company row does not override an exact-company profile', () => {
  expect(
    foldAgentProfiles(
      company,
      [principalId],
      [
        { evidence: profile },
        { evidence: { ...profile, legalEntityId: foreignCompany, revision: 'corrupt', writePolicy: 'invented' } },
      ],
    ).get(principalId)?.hasProfile,
  ).toBe(true);
});

test('only requested principals appear, with defaults for missing evidence', () => {
  const profiles = foldAgentProfiles(company, [otherPrincipalId], [{ evidence: profile }]);
  expect([...profiles]).toEqual([[otherPrincipalId, DEFAULT_AGENT_PROFILE]]);
});

test('non-native operations fail closed even with otherwise valid profile fields', () => {
  expect(
    foldAgentProfiles(company, [principalId], [{ evidence: { ...profile, operation: 'seed-agent' } }]).get(principalId),
  ).toEqual(DEFAULT_AGENT_PROFILE);
});

test('a new valid revision may restore a profile after a lower corrupt revision', () => {
  expect(
    foldAgentProfiles(
      company,
      [principalId],
      [{ evidence: { ...profile, revision: 2, writePolicy: 'invented' } }, { evidence: { ...profile, revision: 3 } }],
    ).get(principalId)?.writePolicy,
  ).toBe('approval');
});
