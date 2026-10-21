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
    modules: [{ access: 'read', moduleId: 'demo.crm' }],
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
    modules: [{ access: 'write', moduleId: 'demo.crm' }],
    seeded: false,
    writePolicy: 'approval',
  });
});

test('moduleLabel returns the Czech label or the module id', () => {
  expect(moduleLabel('demo.crm')).toBe('CRM – klienti a návštěvy');
  expect(moduleLabel('x.y')).toBe('x.y');
});
