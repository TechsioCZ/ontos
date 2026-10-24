import type { PrincipalRef } from '@app/core-runtime/permissions/principal-ref';
import { PrincipalRefSchema } from '@app/core-runtime/permissions/principal-ref';
import { Option, Result, Schema, Struct } from 'effect';
import { ProjectSchema, TaskSchema, WorkStateSchema } from '../../shared/apis/records.ts';
import type { Task, WorkProject, WorkState } from '../../shared/apis/records.ts';

export const EmployeeIdSchema = Schema.String.check(Schema.isUUID()).pipe(Schema.brand('LegacyEmployeeId'));
/** One-off migration input only. Runtime records and commands never decode employee assignments. */
export const EmployeeAssignmentMigrationInputSchema = Schema.Struct({
  ...WorkStateSchema.fields,
  projects: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        ...ProjectSchema.fields,
        responsibleEmployeeId: Schema.optionalKey(EmployeeIdSchema),
      }),
    ),
  ),
  tasks: Schema.Array(
    Schema.Struct({
      ...TaskSchema.fields,
      assigneeEmployeeId: Schema.optionalKey(EmployeeIdSchema),
    }),
  ),
});
export type EmployeeAssignmentMigrationInput = typeof EmployeeAssignmentMigrationInputSchema.Type;
export const AssignmentOverrideSchema = Schema.Struct({
  after: Schema.OptionFromNullOr(PrincipalRefSchema),
  before: Schema.OptionFromNullOr(PrincipalRefSchema),
  employeeId: EmployeeIdSchema,
  kind: Schema.Literals(['task', 'project']),
  resource: Schema.String,
});
export class AssignmentMigrationScopeMismatch extends Schema.TaggedError<AssignmentMigrationScopeMismatch>()(
  'AssignmentMigrationScopeMismatch',
  { reason: Schema.String },
) {
  override get message() {
    return this.reason;
  }
}

/** Pure owner transformation. The old assignee, not seeded management ownership, wins. */
export const prepareEmployeeAssignmentMigration = (
  input: EmployeeAssignmentMigrationInput,
  employeePrincipals: ReadonlyMap<string, PrincipalRef>,
  tenantId: string,
) => {
  for (const principal of employeePrincipals.values()) {
    if (principal.tenantId !== tenantId) {
      return Result.fail(
        new AssignmentMigrationScopeMismatch({ reason: 'Employee mapping must belong to the exact tenant' }),
      );
    }
  }
  const overrides: (typeof AssignmentOverrideSchema.Type)[] = [];
  const tasks = input.tasks.map((task): Task => {
    const { assigneeEmployeeId, ...canonical } = task;
    if (assigneeEmployeeId === undefined) {
      return canonical;
    }
    const principal = employeePrincipals.get(assigneeEmployeeId);
    overrides.push({
      after: Option.fromUndefinedOr(principal),
      before: Option.fromUndefinedOr(canonical.ownerPrincipalRef),
      employeeId: assigneeEmployeeId,
      kind: 'task',
      resource: task.ref.resourceId,
    });
    const unowned = Struct.omit(canonical, [
      'assignmentNeedsReassignment',
      'assignmentWithoutLogin',
      'ownerPrincipalRef',
    ]);
    if (principal !== undefined) {
      return { ...unowned, ownerPrincipalRef: principal };
    }
    const historical = { ...unowned, assignmentWithoutLogin: true };
    return task.state === 'DONE' || task.state === 'CANCELLED'
      ? historical
      : { ...historical, assignmentNeedsReassignment: true };
  });
  const projects = input.projects?.map((project): WorkProject => {
    const { responsibleEmployeeId, ...canonical } = project;
    if (responsibleEmployeeId === undefined) {
      return canonical;
    }
    const principal = employeePrincipals.get(responsibleEmployeeId);
    overrides.push({
      after: Option.fromUndefinedOr(principal),
      before: Option.fromUndefinedOr(canonical.responsiblePrincipalRef),
      employeeId: responsibleEmployeeId,
      kind: 'project',
      resource: project.id,
    });
    const unowned = Struct.omit(canonical, [
      'assignmentNeedsReassignment',
      'assignmentWithoutLogin',
      'responsiblePrincipalRef',
    ]);
    if (principal !== undefined) {
      return { ...unowned, responsiblePrincipalRef: principal };
    }
    const historical = { ...unowned, assignmentWithoutLogin: true };
    return project.state === 'DONE' ? historical : { ...historical, assignmentNeedsReassignment: true };
  });
  const state: WorkState = projects === undefined ? { ...input, tasks } : { ...input, projects, tasks };
  if (
    state.collection.ref.tenantId !== tenantId ||
    tasks.some(
      (task) =>
        task.ref.tenantId !== tenantId ||
        task.collectionRef.tenantId !== tenantId ||
        (task.ownerPrincipalRef !== undefined && task.ownerPrincipalRef.tenantId !== tenantId),
    ) ||
    (projects ?? []).some(
      (project) =>
        project.responsiblePrincipalRef !== undefined && project.responsiblePrincipalRef.tenantId !== tenantId,
    )
  ) {
    return Result.fail(
      new AssignmentMigrationScopeMismatch({ reason: 'Work assignments must belong to the exact tenant' }),
    );
  }
  return Result.succeed({ overrides, state });
};

export const migrateEmployeeAssignments = (
  input: EmployeeAssignmentMigrationInput,
  employeePrincipals: ReadonlyMap<string, PrincipalRef>,
  tenantId: string,
) => Result.map(prepareEmployeeAssignmentMigration(input, employeePrincipals, tenantId), ({ state }) => state);
