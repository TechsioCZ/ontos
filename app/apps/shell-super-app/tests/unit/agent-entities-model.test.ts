import { AgentModuleKeySchema } from '@app/shared-contracts/agent-proposals';
import { expect, test } from 'effect-rstest';

import { agentDraftProblem, usableModulesOf } from '../../api/auth/agent-entities-model.ts';

/** Labels the composed modules declare in their contributions. */
const LABELS = new Map([
  ['facility.operations', 'Provoz'],
  ['work.tasks', 'Úkoly a projekty'],
]);
const labelOf = (moduleId: string): string => LABELS.get(moduleId) ?? moduleId;

const valid = {
  displayName: 'Asistent provozu',
  existingNames: [],
  memberIds: ['p1', 'p2'],
  operatorPrincipalIds: ['p1'],
  ownerPrincipalId: 'p2',
} as const;

test('a valid draft has no problem; an agent needs no module list, its rights come from roles', () => {
  expect(agentDraftProblem(valid)).toBeNull();
});

test('an empty name is rejected first', () => {
  expect(agentDraftProblem({ ...valid, displayName: '   ' })).toBe('Vyplňte název agenta.');
});

test('a name that matches an existing one ignores case', () => {
  expect(agentDraftProblem({ ...valid, existingNames: ['asistent PROVOZU'] })).toBe(
    'Agent s tímto názvem už ve firmě je.',
  );
});

test('an owner who is not an active person of the company is rejected', () => {
  expect(agentDraftProblem({ ...valid, ownerPrincipalId: 'p3' })).toBe(
    'Za agenta může odpovídat jen aktivní člověk z firmy.',
  );
});

test('an operator who is not an active person of the company is rejected', () => {
  expect(agentDraftProblem({ ...valid, operatorPrincipalIds: ['p3'] })).toBe(
    'Agenta mohou připojit jen aktivní lidé z firmy.',
  );
});

test('what an agent can use is shown per installed module, direct before approval, sorted by Czech label', () => {
  const installed = new Set(['facility.operations', 'work.tasks']);
  expect(
    usableModulesOf(
      [
        { kind: 'read', moduleKey: 'work.tasks', use: 'direct' },
        { kind: 'action', moduleKey: 'work.tasks', use: 'approval' },
        { kind: 'action', moduleKey: 'work.tasks', use: 'direct' },
        { kind: 'action', moduleKey: 'facility.operations', use: 'approval' },
        { kind: 'read', moduleKey: 'not.installed', use: 'direct' },
      ],
      labelOf,
      installed,
    ),
  ).toEqual([
    { label: 'Provoz', moduleId: AgentModuleKeySchema.make('facility.operations'), reads: false, writes: 'approval' },
    { label: 'Úkoly a projekty', moduleId: AgentModuleKeySchema.make('work.tasks'), reads: true, writes: 'direct' },
  ]);
});
