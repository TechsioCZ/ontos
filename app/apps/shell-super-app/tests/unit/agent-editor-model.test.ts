import { AgentModuleKeySchema, AgentPrincipalIdSchema } from '@app/shared-contracts/agent-proposals';
import { Option, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { AgentEntitySchema, ManageAgentEntityRequestSchema } from '@app/shared-contracts/agent-access';
import type { AgentModuleOption, AgentRolePreset } from '@app/shared-contracts/agent-access';
import {
  configureRequest,
  createRequest,
  draftErrors,
  draftFromAgent,
  draftModules,
  emptyAgentDraft,
  withPreset,
  writeIgnored,
} from '../../src/routes/people/agent-editor-model.ts';

const options: readonly AgentModuleOption[] = [
  { label: 'Provoz', maxAccess: 'read', moduleId: AgentModuleKeySchema.make('facility.operations') },
  { label: 'Úkoly a projekty', maxAccess: 'write', moduleId: AgentModuleKeySchema.make('work.tasks') },
];

const agent = Schema.decodeUnknownSync(AgentEntitySchema)({
  connections: [],
  description: null,
  displayName: 'Asistent provozu',
  hasProfile: true,
  modules: [{ access: 'write', moduleId: AgentModuleKeySchema.make('work.tasks') }],
  operators: [{ displayName: 'Vedení', principalId: AgentPrincipalIdSchema.make('p1') }],
  owner: { displayName: 'Provoz', principalId: AgentPrincipalIdSchema.make('p2') },
  principalId: AgentPrincipalIdSchema.make('a1'),
  status: 'active',
  writePolicy: 'approval',
});

it('maps an agent onto the draft', () => {
  const draft = draftFromAgent(agent);
  expect(draft.description).toBe('');
  expect(draft.ownerPrincipalId).toBe('p2');
  expect(draft.operatorPrincipalIds).toEqual(['p1']);
  expect(draft.modules).toEqual({ 'work.tasks': 'write' });
});

it('copies a role preset and drops modules the company does not offer', () => {
  const preset: AgentRolePreset = {
    key: 'provoz',
    label: 'Provoz',
    modules: [
      { access: 'write', moduleId: AgentModuleKeySchema.make('facility.operations') },
      { access: 'write', moduleId: AgentModuleKeySchema.make('work.tasks') },
      { access: 'read', moduleId: AgentModuleKeySchema.make('unknown.module') },
    ],
  };
  expect(withPreset(emptyAgentDraft, preset, options).modules).toEqual({
    'facility.operations': 'read',
    'work.tasks': 'write',
  });
});

it('lists chosen modules in option order with write capped to the company maximum', () => {
  const draft = { ...emptyAgentDraft, modules: { 'facility.operations': 'write', 'work.tasks': 'write' } } as const;
  expect(draftModules(draft, options)).toEqual([
    { access: 'read', moduleId: AgentModuleKeySchema.make('facility.operations') },
    { access: 'write', moduleId: AgentModuleKeySchema.make('work.tasks') },
  ]);
});

it('reports missing name, owner and modules in order', () => {
  expect(draftErrors(emptyAgentDraft, options)).toEqual(['nameRequired', 'ownerRequired', 'modulesRequired']);
});

it('trims the name and turns a blank description into null', () => {
  const draft = {
    ...emptyAgentDraft,
    description: '   ',
    displayName: '  Asistent  ',
    ownerPrincipalId: AgentPrincipalIdSchema.make('p2'),
  };
  const request = createRequest({ ...draft, modules: { 'work.tasks': 'read' } }, options);
  if (request.operation !== 'create') {
    throw new Error('Expected the create command');
  }
  expect(request.displayName).toBe('Asistent');
  const encoded = Schema.encodeSync(ManageAgentEntityRequestSchema)(request);
  if (encoded.operation !== 'create') {
    expect.unreachable('Expected the encoded create command');
  }
  expect(encoded.description).toBeNull();
  expect(configureRequest({ ...draft, modules: { 'work.tasks': 'read' } }, options, 'a1')).toMatchObject({
    operation: 'configure',
    principalId: AgentPrincipalIdSchema.make('a1'),
  });
});

it('ignores write modules only under the read-only policy', () => {
  const modules = { 'work.tasks': 'write' } as const;
  expect(writeIgnored({ ...emptyAgentDraft, modules, writePolicy: 'read_only' })).toBe(true);
  expect(writeIgnored({ ...emptyAgentDraft, modules, writePolicy: 'approval' })).toBe(false);
});

it('starts an unprofiled agent with an explicit new-draft policy instead of a reported fallback', () => {
  const draft = draftFromAgent({
    ...agent,
    hasProfile: false,
    modules: [],
    owner: Option.none(),
    writePolicy: 'read_only',
  });
  expect(draft.writePolicy).toBe('approval');
  expect(draft.modules).toEqual({});
  expect(draft.ownerPrincipalId).toBeNull();
});
