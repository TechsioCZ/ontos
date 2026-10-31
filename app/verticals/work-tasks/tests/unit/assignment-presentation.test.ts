import { expect, it } from 'effect-rstest';
import { assignmentLabel, principalKey } from '../../shared/assignment.ts';
import { Effect, Schema } from 'effect';
import { SingleWorkCommandSchema } from '../../shared/actions/apply-command.ts';
import { TaskRefSchema } from '../../shared/resources/task.ts';
import {
  assignmentOptions,
  assignmentPatch,
  selectedPrincipal,
} from '../../src/routes/[lang]/ukoly/assignment-options.ts';

const tenantId = '20000000-0000-4000-8000-000000000001';
const human = { principalId: '40000000-0000-4000-8000-000000000001', tenantId };
const agent = { principalId: '40000000-0000-4000-8000-000000000002', tenantId };
const departed = { principalId: '40000000-0000-4000-8000-000000000003', tenantId };
const principals = [
  { displayName: 'Human', principalRef: human },
  { displayName: 'Agent', principalRef: agent },
];

it('offers governed human and agent candidates with their complete principal identity', () => {
  expect(assignmentOptions(principals)).toEqual([
    { displayValue: 'Human', label: 'Human', value: principalKey(human) },
    { displayValue: 'Agent', label: 'Agent', value: principalKey(agent) },
  ]);
  expect(selectedPrincipal(principals, principalKey(agent))).toEqual(agent);
  expect(selectedPrincipal(principals, agent.principalId)).toBeUndefined();
  expect(selectedPrincipal(principals, principalKey({ ...agent, tenantId: human.principalId }))).toBeUndefined();
});

it.effect('the edit form encodes a changed selection, explicit unassignment, and unchanged omission distinctly', () =>
  Effect.gen(function* editAssignmentPatch() {
    const taskRef = yield* Schema.decodeUnknownEffect(TaskRefSchema)({
      moduleId: 'work.tasks',
      resourceId: 'task-1',
      resourceType: 'work.tasks.task',
      tenantId,
    });
    for (const [previous, selected] of [
      [undefined, human],
      [human, agent],
    ] as const) {
      const encoded = yield* Schema.encodeEffect(SingleWorkCommandSchema)({
        _tag: 'UpdateTask',
        ...assignmentPatch(previous, selected),
        taskRef,
      });
      expect(encoded).toHaveProperty('ownerPrincipalRef', selected);
    }
    const unassigned = selectedPrincipal(principals, '');
    const clear = yield* Schema.encodeEffect(SingleWorkCommandSchema)({
      _tag: 'UpdateTask',
      ...assignmentPatch(human, unassigned),
      taskRef,
    });
    expect(clear).toHaveProperty('ownerPrincipalRef', null);
    expect(assignmentPatch(unassigned, unassigned)).toEqual({});
    expect(assignmentPatch(human, { ...human })).toEqual({});
    expect(assignmentPatch(departed, { ...departed })).toEqual({});
    const otherTenant = { ...human, tenantId: agent.principalId };
    expect(assignmentPatch(human, otherTenant)).toHaveProperty('ownerPrincipalRef');
  }),
);

it('keeps historical departed work labeled without adding its owner to assignment choices', () => {
  const names = new Map([[principalKey(departed), 'Former colleague']]);
  expect(assignmentLabel(departed, names, true)).toBe('Odešel – přeřadit');
  expect(selectedPrincipal(principals, principalKey(departed))).toBeUndefined();
  expect(assignmentOptions(principals).some(({ value }) => value === principalKey(departed))).toBe(false);
});

it('labels closed unlinked history neutrally without a reassignment call to action', () => {
  expect(assignmentLabel(undefined, new Map(), false, true)).toBe('Řešitel bez přihlášení');
  expect(assignmentLabel(undefined, new Map(), true, true)).toBe('Nepřiřazeno – přeřadit');
});

it('does not describe an unlinked migration row as a departed account', () => {
  expect(assignmentLabel(undefined, new Map(), true)).toBe('Nepřiřazeno – přeřadit');
  expect(assignmentLabel(undefined, new Map())).toBe('—');
  expect(assignmentLabel(human, new Map())).toBe('Účet mimo seznam');
  expect(assignmentLabel(agent, new Map([[principalKey(agent), 'Agent']]))).toBe('Agent');
});
