import { expect, test } from 'effect-rstest';

import { agentDraftProblem, agentModuleOptions } from '../../api/auth/agent-entities-model.ts';

const options = agentModuleOptions([
  { access: 'write', moduleId: 'work.tasks' },
  { access: 'read', moduleId: 'facility.operations' },
]);

const valid = {
  displayName: 'Asistent provozu',
  existingNames: [],
  memberIds: ['p1', 'p2'],
  modules: [{ access: 'write', moduleId: 'work.tasks' }],
  operatorPrincipalIds: ['p1'],
  options,
  ownerPrincipalId: 'p2',
} as const;

test('module options carry the highest access and are sorted by Czech label', () => {
  expect(options).toEqual([
    { label: 'Provoz', maxAccess: 'read', moduleId: 'facility.operations' },
    { label: 'Úkoly a projekty', maxAccess: 'write', moduleId: 'work.tasks' },
  ]);
});

test('a valid draft has no problem', () => {
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

test('a draft without modules is rejected', () => {
  expect(agentDraftProblem({ ...valid, modules: [] })).toBe('Vyberte aspoň jeden modul.');
});

test('a module listed twice is rejected', () => {
  expect(
    agentDraftProblem({
      ...valid,
      modules: [
        { access: 'read', moduleId: 'work.tasks' },
        { access: 'write', moduleId: 'work.tasks' },
      ],
    }),
  ).toBe('Každý modul vyberte jen jednou.');
});

test('write on a module the company offers only read for is rejected', () => {
  expect(agentDraftProblem({ ...valid, modules: [{ access: 'write', moduleId: 'facility.operations' }] })).toBe(
    'Provoz: zápis tu nemá žádná role, agent ho dostat nemůže.',
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
