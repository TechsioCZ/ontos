import { DateTime, Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { WorkforceDuplicateEmail, WorkforceNotFound } from '../../shared/actions/apply-command.ts';
import type { WorkforceCommand } from '../../shared/actions/apply-command.ts';
import { EmployeePhoneInputSchema, EmployeePhoneSchema } from '../../shared/apis/records.ts';
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

const otherEmployeeId = Schema.decodeUnknownSync(EmployeeIdSchema)('6f1d3c2a-9b8e-4d7f-8a6b-5c4d3e2f1a01');

it.effect('rejects a second Employee with an e-mail already in use, ignoring case', () =>
  Effect.gen(function* rejectDuplicateEmail() {
    const created = yield* evolveEmployeeState(emptyState, createCommand, { now });
    const failure = yield* Effect.flip(
      evolveEmployeeState(
        created.state,
        { ...createCommand, email: 'Jana.Novakova@siampark.demo', id: otherEmployeeId },
        { now },
      ),
    );
    expect(Schema.is(WorkforceDuplicateEmail)(failure)).toBe(true);
  }),
);

it.effect('rejects an update that moves an Employee onto another Employee e-mail', () =>
  Effect.gen(function* rejectDuplicateEmailOnUpdate() {
    const first = yield* evolveEmployeeState(emptyState, createCommand, { now });
    const second = yield* evolveEmployeeState(
      first.state,
      { ...createCommand, email: 'petr.svoboda@siampark.demo', id: otherEmployeeId },
      { now },
    );
    const failure = yield* Effect.flip(
      evolveEmployeeState(
        second.state,
        { _tag: 'UpdateEmployee', id: otherEmployeeId, patch: { email: 'jana.novakova@siampark.demo' } },
        { now },
      ),
    );
    expect(Schema.is(WorkforceDuplicateEmail)(failure)).toBe(true);
  }),
);

it.effect('keeps a row editable when it already shares its e-mail with another row', () =>
  Effect.gen(function* editLegacyDuplicate() {
    const created = yield* evolveEmployeeState(emptyState, createCommand, { now });
    const legacy: WorkforceState = {
      employees: created.state.employees.flatMap((employee) => [employee, { ...employee, id: otherEmployeeId }]),
    };
    const saved = yield* evolveEmployeeState(
      legacy,
      {
        _tag: 'UpdateEmployee',
        id: otherEmployeeId,
        patch: { department: 'Export', email: 'Jana.Novakova@siampark.demo' },
      },
      { now },
    );
    expect(saved.employees.map((employee) => employee.department)).toEqual(['Export']);
  }),
);

it('accepts a formatted phone number on input and rejects text', () => {
  expect(Schema.is(EmployeePhoneInputSchema)('+420 777 000 001')).toBe(true);
  expect(Schema.is(EmployeePhoneInputSchema)('abc')).toBe(false);
});

it('still reads a stored phone saved before the input format rule', () => {
  expect(Schema.is(EmployeePhoneSchema)('abc')).toBe(true);
});
