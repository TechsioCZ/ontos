import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { WorkCommandSchema } from '../../shared/actions/apply-command.ts';
import { WorkStateSchema } from '../../shared/apis/records.ts';
import { changedAssignmentTarget } from '../../src/services/assignment-policy.ts';

const tenantId = '20000000-0000-4000-8000-000000000001';
const human = { principalId: '30000000-0000-4000-8000-000000000001', tenantId };
const agent = { principalId: '30000000-0000-4000-8000-000000000002', tenantId };
const collectionRef = {
  moduleId: 'work.tasks',
  resourceId: 'default',
  resourceType: 'work.tasks.task-collection',
  tenantId,
};
const taskRef = { moduleId: 'work.tasks', resourceId: 'task-1', resourceType: 'work.tasks.task', tenantId };
const at = '2026-10-01T10:00:00Z';
const project = {
  createdAt: at,
  id: 'project-1',
  milestones: [],
  plannedEnd: '2026-10-31',
  plannedStart: '2026-10-01',
  responsiblePrincipalRef: human,
  state: 'ACTIVE',
  title: 'Project',
  updatedAt: at,
};
const state = {
  collection: {
    properties: {
      dueDate: { locked: true, type: 'DATE' },
      ownerPrincipalRef: { locked: true, type: 'PRINCIPAL' },
      status: { groups: ['NOT_STARTED', 'IN_PROGRESS', 'DONE'], locked: true, type: 'STATUS' },
      title: { locked: true, type: 'TEXT' },
    },
    ref: collectionRef,
    title: 'Tasks',
  },
  projects: [project],
  tasks: [
    {
      assignmentNeedsReassignment: true,
      collectionRef,
      contextRefs: [],
      createdAt: at,
      ownerPrincipalRef: human,
      priority: 'NORMAL',
      ref: taskRef,
      state: 'NEW',
      title: 'Historical task',
      updatedAt: at,
    },
  ],
};

it.effect('server preflight covers creation, explicit assignment, bulk assignment, and project responsibility', () =>
  Effect.gen(function* mutationTargets() {
    const saved = yield* Schema.decodeUnknownEffect(WorkStateSchema)(state);
    const commands = [
      { _tag: 'CreateTask', ownerPrincipalRef: human, title: 'Human work' },
      { _tag: 'UpdateTask', ownerPrincipalRef: agent, taskRef },
      { _tag: 'AssignTask', ownerPrincipalRef: agent, taskRef },
      { _tag: 'BulkAssignTasks', ids: ['task-1'], ownerPrincipalRef: agent },
      { ...project, _tag: 'CreateProject', responsiblePrincipalRef: agent },
      { ...project, _tag: 'UpdateProject', responsiblePrincipalRef: agent },
    ];
    for (const [index, input] of commands.entries()) {
      const command = yield* Schema.decodeUnknownEffect(WorkCommandSchema)(input);
      expect(changedAssignmentTarget(command, saved)).toEqual(index === 0 ? human : agent);
    }
  }),
);

it.effect(
  'server preflight exempts unrelated edits and unchanged historical references, not explicit reassignment',
  () =>
    Effect.gen(function* preserveHistoricalAssignments() {
      const saved = yield* Schema.decodeUnknownEffect(WorkStateSchema)(state);
      for (const input of [
        { _tag: 'UpdateTask', taskRef, title: 'Updated title' },
        { _tag: 'UpdateTask', ownerPrincipalRef: human, taskRef, title: 'Updated title' },
        { ...project, _tag: 'UpdateProject', title: 'Updated project' },
        { _tag: 'BulkAssignTasks', ids: ['task-1'], ownerPrincipalRef: null },
        { _tag: 'AddTaskComment', taskRef, text: 'Keep this historical work' },
      ]) {
        const command = yield* Schema.decodeUnknownEffect(WorkCommandSchema)(input);
        expect(changedAssignmentTarget(command, saved)).toBeUndefined();
      }
      const explicit = yield* Schema.decodeUnknownEffect(WorkCommandSchema)({
        _tag: 'AssignTask',
        ownerPrincipalRef: human,
        taskRef,
      });
      expect(changedAssignmentTarget(explicit, saved)).toEqual(human);
    }),
);

it.effect('server preflight compares full tenant identity, never just the principal id', () =>
  Effect.gen(function* exactIdentity() {
    const saved = yield* Schema.decodeUnknownEffect(WorkStateSchema)(state);
    const crossTenant = { ...human, tenantId: agent.principalId };
    const command = yield* Schema.decodeUnknownEffect(WorkCommandSchema)({
      _tag: 'UpdateTask',
      ownerPrincipalRef: crossTenant,
      taskRef,
    });
    expect(changedAssignmentTarget(command, saved)).toEqual(crossTenant);
  }),
);
