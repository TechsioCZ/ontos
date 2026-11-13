import { AgentPrincipalIdSchema } from '@app/shared-contracts/agent-proposals';
import { Option, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { AgentEntitySchema, ManageAgentEntityRequestSchema } from '@app/shared-contracts/agent-access';
import {
  configureRequest,
  createRequest,
  draftErrors,
  draftFromAgent,
  emptyAgentDraft,
} from '../../src/routes/people/agent-editor-model.ts';

const agent = Schema.decodeUnknownSync(AgentEntitySchema)({
  connections: [],
  description: null,
  displayName: 'Asistent provozu',
  hasProfile: true,
  operators: [{ displayName: 'Vedení', principalId: AgentPrincipalIdSchema.make('p1') }],
  operatorsRevision: 0,
  owner: { displayName: 'Provoz', principalId: AgentPrincipalIdSchema.make('p2') },
  principalId: AgentPrincipalIdSchema.make('a1'),
  roles: [],
  status: 'active',
  usable: [],
  writePolicy: 'approval',
});

it('maps an agent onto the draft', () => {
  const draft = draftFromAgent(agent);
  expect(draft.description).toBe('');
  expect(draft.ownerPrincipalId).toBe('p2');
  expect(draft.operatorPrincipalIds).toEqual(['p1']);
});

it('reports missing name and owner in order; rights are never a draft field, they come from roles', () => {
  expect(draftErrors(emptyAgentDraft)).toEqual(['nameRequired', 'ownerRequired']);
});

it('trims the name and turns a blank description into null, with no module list in any request', () => {
  const draft = {
    ...emptyAgentDraft,
    description: '   ',
    displayName: '  Asistent  ',
    ownerPrincipalId: AgentPrincipalIdSchema.make('p2'),
  };
  const request = createRequest(draft);
  if (request.operation !== 'create') {
    throw new Error('Expected the create command');
  }
  expect(request.displayName).toBe('Asistent');
  const encoded = Schema.encodeSync(ManageAgentEntityRequestSchema)(request);
  if (encoded.operation !== 'create') {
    expect.unreachable('Expected the encoded create command');
  }
  expect(encoded.description).toBeNull();
  expect('modules' in encoded).toBe(false);
  expect(configureRequest(draft, 'a1')).toMatchObject({
    operation: 'configure',
    principalId: AgentPrincipalIdSchema.make('a1'),
  });
});

it('starts an unprofiled agent with an explicit new-draft policy instead of a reported fallback', () => {
  const draft = draftFromAgent({ ...agent, hasProfile: false, owner: Option.none(), writePolicy: 'read_only' });
  expect(draft.writePolicy).toBe('approval');
  expect(draft.ownerPrincipalId).toBeNull();
});
