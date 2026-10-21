import type { ConnectionSummary } from '@app/shared-contracts/agent-access';
import { expect, test } from 'effect-rstest';

import {
  accessSummary,
  connectGuide,
  draftFromConnection,
  draftProblem,
  draftToRequest,
  failureText,
  policyChoices,
  setModuleChoice,
} from '../../../../src/routes/[lang]/profile/connected-apps-model.ts';

const mod = (moduleId: string, label: string, read: boolean, write: boolean) => ({ label, moduleId, read, write });

const connection = (overrides: Partial<ConnectionSummary>): ConnectionSummary => ({
  acting: { displayName: 'Jana Nováková', kind: 'human', principalId: 'p-1' },
  allModules: false,
  client: { clientId: 'c-1', host: 'claude.ai', kind: 'cimd', logoUri: null, name: 'Claude' },
  createdAt: '2026-10-01T08:00:00.000Z',
  delegatedBy: null,
  grantId: 'g-1',
  lastUsedAt: null,
  legalEntityId: 'le-1',
  legalName: 'Obchodní firma',
  limits: {
    maxWritePolicy: 'direct',
    modules: [mod('crm', 'CRM', true, true), mod('sklad', 'Sklad', true, true)],
  },
  modules: [mod('crm', 'CRM', true, true)],
  profileId: 'pr-1',
  revokeReason: null,
  revokedAt: null,
  status: 'active',
  tenantId: 't-1',
  user: { displayName: 'Jana Nováková', principalId: 'p-1' },
  writePolicy: 'direct',
  ...overrides,
});

test('accessSummary names the modules and counts the rest', () => {
  expect(accessSummary(connection({ allModules: true }))).toBe('Vše');
  expect(accessSummary(connection({ modules: [] }))).toBe('Nic');
  const four = [
    mod('a', 'A', true, false),
    mod('b', 'B', true, false),
    mod('c', 'C', true, false),
    mod('d', 'D', true, false),
  ];
  expect(accessSummary(connection({ modules: four }))).toBe('A, B, C a další 1');
});

test('policyChoices disables what the agent or the person may not do', () => {
  const agent = connection({
    acting: { displayName: 'Agent A', kind: 'agent', principalId: 'a-1' },
    limits: { maxWritePolicy: 'approval', modules: [] },
  });
  const agentChoices = policyChoices(agent);
  expect(agentChoices.map((choice) => choice.value)).toEqual(['read_only', 'approval', 'direct']);
  expect(agentChoices.map((choice) => choice.disabled)).toEqual([false, false, true]);
  expect(agentChoices[2]?.disabledReason).toBe('Agent smí jen navrhovat změny (nastavení agenta).');

  const human = connection({ limits: { maxWritePolicy: 'approval', modules: [] } });
  const humanChoices = policyChoices(human);
  expect(humanChoices[2]?.disabled).toBe(true);
  expect(humanChoices[2]?.disabledReason).toBe('Víc vaše oprávnění nedovolují.');
  expect(humanChoices[1]?.disabledReason).toBeNull();
});

test('draftFromConnection and draftToRequest round trip the grant', () => {
  const c = connection({
    limits: {
      maxWritePolicy: 'direct',
      modules: [mod('sklad', 'Sklad', true, true), mod('crm', 'CRM', true, true), mod('fin', 'Finance', true, true)],
    },
    modules: [mod('crm', 'CRM', true, false), mod('sklad', 'Sklad', true, true)],
    writePolicy: 'approval',
  });
  const draft = draftFromConnection(c);
  expect(draft.modules).toEqual({ crm: 'read', fin: 'none', sklad: 'write' });
  expect(draftToRequest('g-1', draft)).toEqual({
    allModules: false,
    grantId: 'g-1',
    modules: [
      { access: 'read', moduleId: 'crm' },
      { access: 'write', moduleId: 'sklad' },
    ],
    writePolicy: 'approval',
  });
  expect(draftToRequest('g-1', { ...draft, allModules: true }).modules).toEqual([]);
  expect(draftToRequest('g-1', setModuleChoice(draft, 'fin', 'write')).modules.map((grant) => grant.moduleId)).toEqual([
    'crm',
    'fin',
    'sklad',
  ]);
});

test('draftProblem asks for at least one module unless everything is allowed', () => {
  const empty = { allModules: false, modules: { crm: 'none', sklad: 'none' }, writePolicy: 'approval' as const };
  expect(draftProblem(empty)).toBe('Vyberte alespoň jeden modul.');
  expect(draftProblem({ ...empty, allModules: true })).toBeUndefined();
  expect(draftProblem(setModuleChoice(empty, 'crm', 'read'))).toBeUndefined();
});

test('failureText prefers the server detail', () => {
  expect(failureText('invalid', 'Neznámý modul fin.')).toBe('Neznámý modul fin.');
  expect(failureText('forbidden', null)).toBe('Tuto akci nemůžete provést.');
  expect(failureText('signedOut', null)).toBe('Přihlášení vypršelo. Přihlaste se znovu.');
});

test('connectGuide puts the MCP address into the Claude Code command', () => {
  const url = 'https://ontos.example.test/mcp';
  const claudeCode = connectGuide(url).find((step) => step.id === 'claude-code');
  expect(claudeCode?.command).toBe(`claude mcp add --transport http ontos ${url}`);
  expect(connectGuide(url).filter((step) => step.command !== null)).toHaveLength(1);
});
