import { DateTime, Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { WorkforceNotFound } from '../../shared/actions/apply-command.ts';
import type { WorkforceCommand } from '../../shared/actions/apply-command.ts';
import type { WorkforceState } from '../../shared/apis/records.ts';
import { EmployeeIdSchema, employeeResourceDescriptor } from '../../shared/resources/employee.ts';
import { evolveEmployeeState } from '../../src/services/persistence.service.ts';

const employeeId = Schema.decodeUnknownSync(EmployeeIdSchema)('6f1d3c2a-9b8e-4d7f-8a6b-5c4d3e2f1a00');
const now = DateTime.makeUnsafe('2026-10-13T09:00:00Z');
const emptyState: WorkforceState = { employees: [] };

const createCommand: WorkforceCommand = {
  _tag: 'CreateEmployee',
  active: true,
  department: 'Obchod',
  email: 'jana.novakova@siampark.demo',
  fullName: 'Jana Nováková',
  id: employeeId,
  role: 'SALES_REP',
};

it('owns its primary resource type', () => {
  expect(employeeResourceDescriptor.owningModuleId).toBe('demo.workforce');
});

it.effect('creates an Employee, then a bulk update changes its department', () =>
  Effect.gen(function* createThenBulkUpdate() {
    const created = yield* evolveEmployeeState(emptyState, createCommand, { now });
    expect(created.employees.map((employee) => employee.department)).toEqual(['Obchod']);

    const bulk = yield* evolveEmployeeState(
      created.state,
      { _tag: 'BulkUpdateEmployees', ids: [employeeId], patch: { department: 'Export' } },
      { now },
    );
    expect(bulk.employees.map((employee) => employee.department)).toEqual(['Export']);
    expect(bulk.state.employees[0]?.department).toBe('Export');
    expect(bulk.state.employees[0]?.role).toBe('SALES_REP');
  }),
);

it.effect('fails an update of an Employee outside the state', () =>
  Effect.gen(function* updateUnknownEmployee() {
    const failure = yield* Effect.flip(
      evolveEmployeeState(emptyState, { _tag: 'UpdateEmployee', id: employeeId, patch: { active: false } }, { now }),
    );
    expect(Schema.is(WorkforceNotFound)(failure)).toBe(true);
  }),
);
