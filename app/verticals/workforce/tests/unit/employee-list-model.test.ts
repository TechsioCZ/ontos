import { DateTime, Predicate, Schema, Struct } from 'effect';
import { expect, it } from 'effect-rstest';
import { EmployeeIdSchema } from '../../shared/resources/employee.ts';
import { EmployeePhoneInputSchema } from '../../shared/apis/records.ts';
import type { Employee } from '../../shared/apis/records.ts';
import {
  createCommand,
  draftFromEmployee,
  errorFieldKey,
  filterEmployees,
  noFilters,
  sameDraft,
  updateCommand,
} from '../../src/routes/[lang]/prodej/zamestnanci/employee-model.ts';

const now = DateTime.makeUnsafe('2026-10-13T09:00:00Z');

const employee = (id: string, fullName: string, email: string): Employee => ({
  active: true,
  createdAt: now,
  department: 'Obchod',
  email,
  fullName,
  id: Schema.decodeUnknownSync(EmployeeIdSchema)(id),
  role: 'SALES_REP',
  updatedAt: now,
});

const jana = employee('6f1d3c2a-9b8e-4d7f-8a6b-5c4d3e2f1a01', 'Jana Nováková', 'jana.novakova@najempark.demo');
const people = [jana, employee('6f1d3c2a-9b8e-4d7f-8a6b-5c4d3e2f1a02', 'Tomáš Černý', 'tomas.cerny@najempark.demo')];

it('finds a name or e-mail whether or not the query has diacritics', () => {
  const names = (query: string) => filterEmployees(people, { ...noFilters, query }).map((person) => person.fullName);
  expect(names('novak')).toEqual(['Jana Nováková']);
  expect(names('novák')).toEqual(['Jana Nováková']);
  expect(names('CERNY')).toEqual(['Tomáš Černý']);
  expect(names('tomas.cerny')).toEqual(['Tomáš Černý']);
  expect(names('zzz')).toEqual([]);
  expect(names('   ')).toEqual(['Jana Nováková', 'Tomáš Černý']);
});

it('gives a name over the stored limit its own message key', () => {
  const draft = draftFromEmployee(jana);
  expect(errorFieldKey({ ...draft, fullName: 'Jan '.repeat(60) }, 'fullName')).toBe('fullNameTooLong');
  expect(errorFieldKey({ ...draft, fullName: '' }, 'fullName')).toBe('fullName');
  expect(errorFieldKey({ ...draft, fullName: 'Jana Nováková' }, 'email')).toBe('email');
});

it('recognises an unchanged draft so saving it closes the panel instead of writing', () => {
  const draft = draftFromEmployee(jana);
  expect(sameDraft(draft, { ...draft })).toBe(true);
  expect(sameDraft(draft, { ...draft, role: 'SALES_HEAD' })).toBe(false);
  expect(sameDraft(draft, { ...draft, phone: '+420 777 123 456' })).toBe(false);
});

it('carries the selected login principal into the employee command without granting rights', () => {
  const principalRef = {
    principalId: '4c589117-5ecf-4b8a-a1ce-171093e26614',
    tenantId: '6bce2eda-3c92-4010-9900-046ca4deed76',
  };
  const draft = { ...draftFromEmployee(jana), principalRef };
  const command = createCommand(jana.id, draft);
  expect(Predicate.isTagged('CreateEmployee')(command)).toBe(true);
  expect(Struct.omit(command, ['_tag'])).toEqual({
    active: jana.active,
    department: jana.department,
    email: jana.email,
    fullName: jana.fullName,
    id: jana.id,
    principalRef,
    role: jana.role,
  });
  expect(sameDraft(draftFromEmployee(jana), draft)).toBe(false);
  expect(draftFromEmployee({ ...jana, principalRef }).principalRef).toEqual(principalRef);
});

it('only revalidates a linked principal when the employee form changes the account', () => {
  const principalRef = {
    principalId: '4c589117-5ecf-4b8a-a1ce-171093e26614',
    tenantId: '6bce2eda-3c92-4010-9900-046ca4deed76',
  };
  const linked = { ...jana, principalRef };
  const draft = { ...draftFromEmployee(linked), department: 'Support' };
  const unchangedAccount = updateCommand(linked, draft);
  expect(Predicate.isTagged('UpdateEmployee')(unchangedAccount)).toBe(true);
  if (Predicate.isTagged('UpdateEmployee')(unchangedAccount)) {
    expect(unchangedAccount.patch.principalRef).toBeUndefined();
    expect(unchangedAccount.patch.department).toBe('Support');
  }
  const relinked = updateCommand(jana, draft);
  expect(Predicate.isTagged('UpdateEmployee')(relinked)).toBe(true);
  if (Predicate.isTagged('UpdateEmployee')(relinked)) {
    expect(relinked.patch.principalRef).toEqual(principalRef);
  }
});

it('accepts a phone of six to fifteen digits and rejects longer numbers', () => {
  expect(Schema.is(EmployeePhoneInputSchema)('+420 777 123 456')).toBe(true);
  expect(Schema.is(EmployeePhoneInputSchema)('123456')).toBe(true);
  expect(Schema.is(EmployeePhoneInputSchema)('123456789012345')).toBe(true);
  expect(Schema.is(EmployeePhoneInputSchema)('12345')).toBe(false);
  expect(Schema.is(EmployeePhoneInputSchema)('123456789012345678901234567890')).toBe(false);
});
