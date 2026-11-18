import { DateTime, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { EmployeeIdSchema } from '../../shared/resources/employee.ts';
import type { Employee } from '../../shared/apis/records.ts';
import {
  draftErrors,
  draftFromEmployee,
  employeeSaveResult,
} from '../../src/routes/[lang]/prodej/zamestnanci/employee-model.ts';

const now = DateTime.makeUnsafe('2026-11-01T09:00:00Z');
const jana: Employee = {
  active: true,
  createdAt: now,
  department: 'Obchod',
  email: 'jana.novakova@najempark.demo',
  fullName: 'Jana Nováková',
  id: Schema.decodeUnknownSync(EmployeeIdSchema)('6f1d3c2a-9b8e-4d7f-8a6b-5c4d3e2f1a01'),
  role: 'SALES_REP',
  updatedAt: now,
};

it('maps the answer to the edit Save onto the save bar: a revision means saved, proposed stays proposed', () => {
  expect(employeeSaveResult(12)).toBe(12);
  expect(employeeSaveResult('proposed')).toBe('proposed');
  expect(employeeSaveResult('conflict')).toBe('conflict');
  expect(employeeSaveResult('duplicateEmail')).toBe('failed');
  expect(employeeSaveResult('forbidden')).toBe('failed');
  expect(employeeSaveResult('failed')).toBe('failed');
});

it('never saves a draft with an empty name or a malformed e-mail', () => {
  const draft = draftFromEmployee(jana);
  expect(draftErrors(draft)).toEqual([]);
  expect(draftErrors({ ...draft, fullName: ' ' })).toContain('fullName');
  expect(draftErrors({ ...draft, email: 'jana@' })).toContain('email');
});
