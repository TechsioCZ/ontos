import { expect, it } from 'effect-rstest';

import { AGENT_CREATED_ID_PLACEHOLDER } from '../../src/agent-proposals.ts';
import {
  agentRestoredPatch,
  agentRevertCommands,
  agentRevertNone,
  resolveAgentRevertPlan,
  valueAtPath,
  withAgentCreatedId,
} from '../../src/agent-revert.ts';

const createdRef = { resourceId: AGENT_CREATED_ID_PLACEHOLDER, resourceType: 'x.record' };

it('resolving a plan replaces the created id and drops createdIdPath', () => {
  const plan = agentRevertCommands([{ _tag: 'Cancel', ref: createdRef }], 'record.ref.resourceId');
  expect(resolveAgentRevertPlan(plan, { record: { ref: { resourceId: 'R-9' } } })).toEqual({
    commands: [{ _tag: 'Cancel', ref: { resourceId: 'R-9', resourceType: 'x.record' } }],
    kind: 'commands',
  });
});

it('resolving without the created id is not revertible', () => {
  const plan = agentRevertCommands([{ _tag: 'Cancel', ref: createdRef }], 'entityIds.0');
  expect(resolveAgentRevertPlan(plan, { entityIds: [] })).toMatchObject({ kind: 'none' });
  expect(resolveAgentRevertPlan(null, {})).toEqual(agentRevertNone());
});

it('plans without createdIdPath pass through unchanged', () => {
  const plan = agentRevertCommands([{ _tag: 'Restore', id: 'a' }]);
  expect(resolveAgentRevertPlan(plan, undefined)).toBe(plan);
});

it('follow-up commands get the created id from the apply result', () => {
  expect(withAgentCreatedId([{ _tag: 'Note', ref: createdRef }], 'entityIds.0', { entityIds: ['E-1'] })).toEqual([
    { _tag: 'Note', ref: { resourceId: 'E-1', resourceType: 'x.record' } },
  ]);
  expect(withAgentCreatedId([{ _tag: 'Note' }], undefined, undefined)).toEqual([{ _tag: 'Note' }]);
  expect(withAgentCreatedId([{ _tag: 'Note' }], 'id', {})).toBeUndefined();
});

it('a restored patch needs every changed field to have had a value', () => {
  expect(agentRestoredPatch({ phone: '2' }, { name: 'x', phone: '1' })).toEqual({ phone: '1' });
  expect(agentRestoredPatch({ phone: '2', web: 'w' }, { phone: '1' })).toBeUndefined();
  expect(agentRestoredPatch({ phone: '2' }, undefined)).toBeUndefined();
});

it('reads values at dot paths with array indexes', () => {
  expect(valueAtPath({ a: [{ b: 'c' }] }, 'a.0.b')).toBe('c');
  expect(valueAtPath({ a: 1 }, 'a.b')).toBeUndefined();
});
