import { expect, test } from 'effect-rstest';

import {
  DEFAULT_AGENT_PROFILE,
  foldAgentProfiles,
  moduleLabel,
  seededAgentProfiles,
} from '../../api/auth/agent-store-model.ts';

const OBCHOD_B = 'e931e0fd-adba-56fd-9e17-e5f3adb3efa0';
const HANAK_C = '6300a06d-e532-5f52-8f66-5f1d4752a75e';
const UNKNOWN = '00000000-0000-4000-8000-000000000000';

const configure = (targetPrincipalId: string, writePolicy: unknown, modulesJson: unknown) => ({
  modulesJson,
  operation: 'configure-agent',
  targetPrincipalId,
  writePolicy,
});

test('seeded agent profiles cover six principals with two of each policy', () => {
  const entries = Object.values(seededAgentProfiles);
  expect(entries).toHaveLength(6);
  const policies = entries.map((entry) => entry.writePolicy);
  expect(policies.filter((policy) => policy === 'read_only')).toHaveLength(2);
  expect(policies.filter((policy) => policy === 'direct')).toHaveLength(2);
  expect(policies.filter((policy) => policy === 'approval')).toHaveLength(2);
});

test('fold returns the seed for a seeded id and the default for an unknown id', () => {
  const profiles = foldAgentProfiles([OBCHOD_B, UNKNOWN], []);
  expect(profiles.get(OBCHOD_B)?.seeded).toBe(true);
  expect(profiles.get(OBCHOD_B)?.writePolicy).toBe('direct');
  expect(profiles.get(UNKNOWN)).toEqual(DEFAULT_AGENT_PROFILE);
});

test('a valid configure-agent evidence overrides the seed', () => {
  const modulesJson = JSON.stringify([{ access: 'read', moduleId: 'demo.crm' }]);
  const profiles = foldAgentProfiles([HANAK_C], [configure(HANAK_C, 'direct', modulesJson)]);
  expect(profiles.get(HANAK_C)).toEqual({
    description: null,
    modules: [{ access: 'read', moduleId: 'demo.crm' }],
    ownerPrincipalId: null,
    seeded: false,
    writePolicy: 'direct',
  });
});

test('evidence with an invalid modulesJson is ignored', () => {
  const profiles = foldAgentProfiles([HANAK_C], [configure(HANAK_C, 'direct', 'not json')]);
  expect(profiles.get(HANAK_C)?.seeded).toBe(true);
  expect(profiles.get(HANAK_C)?.writePolicy).toBe('approval');
});

test('later evidence wins over earlier evidence', () => {
  const first = configure(HANAK_C, 'read_only', JSON.stringify([]));
  const second = configure(HANAK_C, 'approval', JSON.stringify([{ access: 'write', moduleId: 'demo.crm' }]));
  const profiles = foldAgentProfiles([HANAK_C], [first, second]);
  expect(profiles.get(HANAK_C)).toEqual({
    description: null,
    modules: [{ access: 'write', moduleId: 'demo.crm' }],
    ownerPrincipalId: null,
    seeded: false,
    writePolicy: 'approval',
  });
});

test('create-agent evidence carries description and owner', () => {
  const agent = '11111111-1111-4111-8111-111111111111';
  const owner = '72000000-0000-4000-8000-000000000022';
  const modulesJson = JSON.stringify([{ access: 'write', moduleId: 'work.tasks' }]);
  const profiles = foldAgentProfiles(
    [agent],
    [
      {
        description: 'Hlídá úkoly provozu.',
        modulesJson,
        operation: 'create-agent',
        ownerPrincipalId: owner,
        targetPrincipalId: agent,
        writePolicy: 'approval',
      },
    ],
  );
  expect(profiles.get(agent)).toEqual({
    description: 'Hlídá úkoly provozu.',
    modules: [{ access: 'write', moduleId: 'work.tasks' }],
    ownerPrincipalId: owner,
    seeded: false,
    writePolicy: 'approval',
  });
});

test('a later configure-agent without description clears it', () => {
  const agent = '11111111-1111-4111-8111-111111111111';
  const modulesJson = JSON.stringify([{ access: 'read', moduleId: 'work.tasks' }]);
  const created = {
    description: 'Popis',
    modulesJson,
    operation: 'create-agent',
    ownerPrincipalId: null,
    targetPrincipalId: agent,
    writePolicy: 'direct',
  };
  const configured = {
    description: null,
    modulesJson,
    operation: 'configure-agent',
    ownerPrincipalId: null,
    targetPrincipalId: agent,
    writePolicy: 'direct',
  };
  expect(foldAgentProfiles([agent], [created, configured]).get(agent)?.description).toBeNull();
});

test('moduleLabel returns the Czech label or the module id', () => {
  expect(moduleLabel('demo.crm')).toBe('CRM – klienti a návštěvy');
  expect(moduleLabel('x.y')).toBe('x.y');
});
