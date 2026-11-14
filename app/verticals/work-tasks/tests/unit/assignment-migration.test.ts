import { Result, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { WorkStateSchema } from '../../shared/apis/records.ts';
import {
  AssignmentMigrationScopeMismatch,
  EmployeeAssignmentMigrationInputSchema,
  migrateEmployeeAssignments as migrate,
} from '../../src/services/migrate-employee-assignments.ts';

const migrateEmployeeAssignments = (
  input: typeof EmployeeAssignmentMigrationInputSchema.Encoded,
  links: Parameters<typeof migrate>[1],
  tenant: string,
) => Result.getOrThrow(migrate(Schema.decodeUnknownSync(EmployeeAssignmentMigrationInputSchema)(input), links, tenant));

const tenantId = '20000000-0000-4000-8000-000000000001';
const human = { principalId: '40000000-0000-4000-8000-000000000001', tenantId };
const agent = { principalId: '40000000-0000-4000-8000-000000000002', tenantId };
const collectionRef = {
  moduleId: 'work.tasks',
  resourceId: 'default',
  resourceType: 'work.tasks.task-collection',
  tenantId,
} as const;
const at = '2026-10-01T10:00:00Z';
const task = {
  collectionRef,
  contextRefs: [],
  createdAt: at,
  priority: 'NORMAL',
  ref: { moduleId: 'work.tasks', resourceId: 'task-a', resourceType: 'work.tasks.task', tenantId },
  state: 'NEW',
  title: 'Migrated task',
  updatedAt: at,
} as const;
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
  projects: [
    {
      createdAt: at,
      id: 'project-a',
      milestones: [],
      plannedEnd: '2026-10-31',
      plannedStart: '2026-10-01',
      state: 'ACTIVE',
      title: 'Project',
      updatedAt: at,
    },
  ],
  tasks: [task],
} as const;

it('migrates reviewed linked logins for tasks and projects without inventing identities', () => {
  const migrated = migrateEmployeeAssignments(
    {
      ...state,
      projects: [
        { ...state.projects[0], responsibleEmployeeId: '50000000-0000-4000-8000-000000000001' },
        { ...state.projects[0], responsibleEmployeeId: '50000000-0000-4000-8000-000000000002' },
      ],
      tasks: [
        { ...task, assigneeEmployeeId: '50000000-0000-4000-8000-000000000001' },
        { ...task, assigneeEmployeeId: '50000000-0000-4000-8000-000000000002' },
      ],
    },
    new Map([['50000000-0000-4000-8000-000000000001', human]]),
    tenantId,
  );
  expect(migrated.tasks[0]?.ownerPrincipalRef).toEqual(human);
  expect(migrated.projects?.[0]?.responsiblePrincipalRef).toEqual(human);
  expect(migrated.tasks[1]).toMatchObject({ assignmentNeedsReassignment: true });
  expect(migrated.projects?.[1]).toMatchObject({ assignmentNeedsReassignment: true });
  expect(migrated.tasks[1]?.ownerPrincipalRef).toBeUndefined();
  expect(migrated.projects?.[1]?.responsiblePrincipalRef).toBeUndefined();
  expect(migrated.tasks[0]).not.toHaveProperty('assigneeEmployeeId');
  expect(migrated.projects?.[0]).not.toHaveProperty('responsibleEmployeeId');
});

it('preserves already canonical human and agent assignments and is idempotent', () => {
  const migrated = migrateEmployeeAssignments(
    {
      ...state,
      projects: [{ ...state.projects[0], responsiblePrincipalRef: human }],
      tasks: [{ ...task, ownerPrincipalRef: agent }],
    },
    new Map([['50000000-0000-4000-8000-000000000001', human]]),
    tenantId,
  );
  expect(migrated.tasks[0]?.ownerPrincipalRef).toEqual(agent);
  expect(migrated.tasks[0]?.assignmentNeedsReassignment).toBeUndefined();
  expect(migrateEmployeeAssignments(Schema.encodeSync(WorkStateSchema)(migrated), new Map(), tenantId)).toEqual(
    migrated,
  );
});

it('keeps closed unlinked work neutral while flagging only open work for reassignment', () => {
  const employeeId = '50000000-0000-4000-8000-000000000002';
  const migrated = migrateEmployeeAssignments(
    {
      ...state,
      projects: [{ ...state.projects[0], responsibleEmployeeId: employeeId, state: 'DONE' }],
      tasks: [
        { ...task, assigneeEmployeeId: employeeId, state: 'NEW' },
        { ...task, assigneeEmployeeId: employeeId, ref: { ...task.ref, resourceId: 'closed' }, state: 'DONE' },
        { ...task, assigneeEmployeeId: employeeId, ref: { ...task.ref, resourceId: 'cancelled' }, state: 'CANCELLED' },
      ],
    },
    new Map(),
    tenantId,
  );
  expect(migrated.tasks[0]).toMatchObject({ assignmentNeedsReassignment: true, assignmentWithoutLogin: true });
  for (const historical of [migrated.tasks[1], migrated.tasks[2], migrated.projects?.[0]]) {
    expect(historical).toMatchObject({ assignmentWithoutLogin: true });
    expect(historical).not.toHaveProperty('assignmentNeedsReassignment');
  }
});

it('rejects cross-tenant reviewed login links rather than manufacturing a local principal', () => {
  const result = migrate(
    Schema.decodeUnknownSync(EmployeeAssignmentMigrationInputSchema)(state),
    new Map([['employee', { ...human, tenantId: agent.principalId }]]),
    tenantId,
  );
  expect(Result.isFailure(result)).toBe(true);
  if (Result.isFailure(result)) {
    expect(Schema.is(AssignmentMigrationScopeMismatch)(result.failure)).toBe(true);
    expect(result.failure.reason).toContain('exact tenant');
  }
});

it('legacy employee assignment overrides seeded management ownership, or clears it when unlinked', () => {
  const migrated = migrateEmployeeAssignments(
    {
      ...state,
      tasks: [
        { ...task, assigneeEmployeeId: '50000000-0000-4000-8000-000000000001', ownerPrincipalRef: agent },
        { ...task, assigneeEmployeeId: '50000000-0000-4000-8000-000000000002', ownerPrincipalRef: agent },
      ],
    },
    new Map([['50000000-0000-4000-8000-000000000001', human]]),
    tenantId,
  );
  expect(migrated.tasks[0]?.ownerPrincipalRef).toEqual(human);
  expect(migrated.tasks[1]?.ownerPrincipalRef).toBeUndefined();
  expect(migrated.tasks[1]?.assignmentNeedsReassignment).toBe(true);
});
