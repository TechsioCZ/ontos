import { Option } from 'effect';
import { expect, it } from 'effect-rstest';

import { AGENT_CREATED_ID_PLACEHOLDER, isAgentCommandSourceNumber, agentCommandOf } from '../../src/agent-proposals.ts';
import type { AgentCommandSource } from '../../src/agent-proposals.ts';
import {
  agentRestoredPatch,
  agentRevertCommands,
  agentRevertNone,
  resolveAgentRevertPlan,
  valueAtPath,
  withAgentCreatedId,
} from '../../src/agent-revert.ts';

const absent = Option.getOrUndefined(Option.none<string>());
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
  expect(resolveAgentRevertPlan(plan, absent)).toBe(plan);
});

it('follow-up commands get the created id from the apply result', () => {
  expect(withAgentCreatedId([{ _tag: 'Note', ref: createdRef }], 'entityIds.0', { entityIds: ['E-1'] })).toEqual([
    { _tag: 'Note', ref: { resourceId: 'E-1', resourceType: 'x.record' } },
  ]);
  expect(withAgentCreatedId([{ _tag: 'Note' }], absent, absent)).toEqual([{ _tag: 'Note' }]);
  expect(withAgentCreatedId([{ _tag: 'Note' }], 'id', {})).toBeUndefined();
});

it('a restored patch needs every changed field to have had a value', () => {
  const absentBefore = Option.getOrUndefined(Option.none<AgentCommandSource>());
  expect(agentRestoredPatch({ phone: '2' }, { name: 'x', phone: '1' })).toEqual({ phone: '1' });
  expect(agentRestoredPatch({ phone: '2', web: 'w' }, { phone: '1' })).toBeUndefined();
  expect(agentRestoredPatch({ phone: '2' }, absentBefore)).toBeUndefined();
});

it('reads values at dot paths with array indexes', () => {
  expect(valueAtPath({ a: [{ b: 'c' }] }, 'a.0.b')).toBe('c');
  expect(valueAtPath({ a: 1 }, 'a.b')).toBeUndefined();
});

it('preserves command normalization for absent properties, nonfinite numbers and array positions', () => {
  expect(
    agentCommandOf({
      nested: { kept: null, nonfinite: Number.POSITIVE_INFINITY, omitted: absent },
      omitted: absent,
      values: [absent, Number.NaN, { kept: false, omitted: absent }],
    }),
  ).toEqual({ nested: { kept: null, nonfinite: null }, values: [null, null, { kept: false }] });
});

it('replaces every nested placeholder without altering the stored source commands', () => {
  const commands = [{ _tag: 'Restore', nested: [{ ref: createdRef }], untouched: null }];
  expect(withAgentCreatedId(commands, 'ids.0', { ids: ['created'] })).toEqual([
    { _tag: 'Restore', nested: [{ ref: { resourceId: 'created', resourceType: 'x.record' } }], untouched: null },
  ]);
  expect(commands[0]?.nested[0]?.ref.resourceId).toBe(AGENT_CREATED_ID_PLACEHOLDER);
  expect(withAgentCreatedId(commands, 'ids.0', { ids: [0] })).toBeUndefined();
  expect(withAgentCreatedId(commands, 'ids.0', { ids: [''] })).toBeUndefined();
});

it('declares the complete pre-JSON number domain and normalizes all nonfinite values to null', () => {
  for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    expect(isAgentCommandSourceNumber(value)).toBe(true);
    expect(agentCommandOf({ nested: { value }, value, values: [value] })).toEqual({
      nested: { value: null },
      value: null,
      values: [null],
    });
  }
  for (const value of [0, -0, 12.5]) {
    expect(isAgentCommandSourceNumber(value)).toBe(true);
    expect(Object.is(agentCommandOf({ value })['value'], value)).toBe(true);
  }
  expect(isAgentCommandSourceNumber('Infinity')).toBe(false);
  expect(isAgentCommandSourceNumber(null)).toBe(false);
});

it('replaces exact placeholder values but keeps placeholder keys, suffix text, and other scalars unchanged', () => {
  const commands = [
    {
      _tag: 'Link',
      [AGENT_CREATED_ID_PLACEHOLDER]: AGENT_CREATED_ID_PLACEHOLDER,
      enabled: false,
      nested: [null, 3, AGENT_CREATED_ID_PLACEHOLDER, { id: AGENT_CREATED_ID_PLACEHOLDER }],
      note: `${AGENT_CREATED_ID_PLACEHOLDER}-suffix`,
    },
  ];
  expect(withAgentCreatedId(commands, 'entityIds.0', { entityIds: ['record'] })).toEqual([
    {
      _tag: 'Link',
      [AGENT_CREATED_ID_PLACEHOLDER]: 'record',
      enabled: false,
      nested: [null, 3, 'record', { id: 'record' }],
      note: `${AGENT_CREATED_ID_PLACEHOLDER}-suffix`,
    },
  ]);
  expect(commands[0]?.nested[2]).toBe(AGENT_CREATED_ID_PLACEHOLDER);
});
