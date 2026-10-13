import { Effect, Option, Random, Schema } from 'effect';
import {
  EmployeeDepartmentSchema,
  EmployeeEmailSchema,
  EmployeeFullNameSchema,
  EmployeeIdSchema,
  EmployeePhoneSchema,
} from '../../../../../shared/apis/records.ts';
import type { Employee, EmployeeId, EmployeeRole } from '../../../../../shared/apis/records.ts';
import type { WorkforceCommand } from '../../../../../shared/actions/apply-command.ts';

export const employeeRoles: readonly EmployeeRole[] = ['SALES_HEAD', 'SALES_REP', 'ACCOUNTANT', 'WAREHOUSE', 'SUPPORT'];

/** Sentinel select value that means "no filter". */
export const allOption = 'ALL';

export interface EmployeeFilters {
  readonly activeOnly: boolean;
  readonly department: string | null;
  readonly query: string;
  readonly role: EmployeeRole | null;
}

export const noFilters: EmployeeFilters = { activeOnly: false, department: null, query: '', role: null };

export const hasActiveFilters = (filters: EmployeeFilters): boolean =>
  filters.activeOnly || filters.department !== null || filters.query.trim() !== '' || filters.role !== null;

export const roleFromValue = (value: string | undefined): EmployeeRole | null =>
  employeeRoles.find((role) => role === value) ?? null;

export const departmentFromValue = (value: string | undefined): string | null =>
  value === undefined || value === allOption ? null : value;

const byName = (left: Employee, right: Employee): number => left.fullName.localeCompare(right.fullName, 'cs');

export const sortEmployees = (items: readonly Employee[]): Employee[] => items.toSorted(byName);

/** Distinct department names in Czech collation order. */
export const departmentsOf = (items: readonly Employee[]): string[] =>
  [...new Set(items.map((employee) => employee.department))].toSorted((left, right) => left.localeCompare(right, 'cs'));

export const filterEmployees = (items: readonly Employee[], filters: EmployeeFilters): Employee[] => {
  const query = filters.query.trim().toLocaleLowerCase('cs');
  return items.filter(
    (employee) =>
      (!filters.activeOnly || employee.active) &&
      (filters.role === null || employee.role === filters.role) &&
      (filters.department === null || employee.department === filters.department) &&
      (query === '' ||
        employee.fullName.toLocaleLowerCase('cs').includes(query) ||
        employee.email.toLocaleLowerCase('cs').includes(query)),
  );
};

export interface EmployeeDraft {
  readonly active: boolean;
  readonly department: string;
  readonly email: string;
  readonly fullName: string;
  readonly phone: string;
  readonly role: EmployeeRole;
}

export const emptyDraft: EmployeeDraft = {
  active: true,
  department: '',
  email: '',
  fullName: '',
  phone: '',
  role: 'SALES_REP',
};

export const draftFromEmployee = (employee: Employee): EmployeeDraft => ({
  active: employee.active,
  department: employee.department,
  email: employee.email,
  fullName: employee.fullName,
  phone: employee.phone ?? '',
  role: employee.role,
});

export const DraftFieldSchema = Schema.Literals(['department', 'email', 'fullName', 'phone']);
export type DraftField = typeof DraftFieldSchema.Type;

export const isDepartmentName = (value: string): boolean =>
  Option.isSome(Schema.decodeOption(EmployeeDepartmentSchema)(value));

const isFullName = (value: string): boolean => Option.isSome(Schema.decodeOption(EmployeeFullNameSchema)(value));
const isEmail = (value: string): boolean => Option.isSome(Schema.decodeOption(EmployeeEmailSchema)(value));
const isPhone = (value: string): boolean => Option.isSome(Schema.decodeOption(EmployeePhoneSchema)(value));

/** Field-level problems of a draft, checked against the same schemas the server uses. */
export const draftErrors = (draft: EmployeeDraft): DraftField[] => {
  const errors: DraftField[] = [];
  if (!isFullName(draft.fullName.trim())) {
    errors.push('fullName');
  }
  if (!isEmail(draft.email.trim())) {
    errors.push('email');
  }
  if (!isDepartmentName(draft.department.trim())) {
    errors.push('department');
  }
  if (draft.phone.trim() !== '' && !isPhone(draft.phone.trim())) {
    errors.push('phone');
  }
  return errors;
};

/** The organisational fields of a draft. Phone is omitted when empty; the contract cannot clear it. */
const employeeFields = (draft: EmployeeDraft) => {
  const base = {
    active: draft.active,
    department: draft.department.trim(),
    email: draft.email.trim(),
    fullName: draft.fullName.trim(),
    role: draft.role,
  };
  const phone = draft.phone.trim();
  return phone === '' ? base : { ...base, phone };
};

export const createCommand = (id: EmployeeId, draft: EmployeeDraft): WorkforceCommand => ({
  _tag: 'CreateEmployee',
  id,
  ...employeeFields(draft),
});

export const updateCommand = (id: EmployeeId, draft: EmployeeDraft): WorkforceCommand => ({
  _tag: 'UpdateEmployee',
  id,
  patch: employeeFields(draft),
});

export const bulkCommand = (
  ids: readonly EmployeeId[],
  patch: { readonly active?: boolean; readonly department?: string; readonly role?: EmployeeRole },
): WorkforceCommand => ({ _tag: 'BulkUpdateEmployees', ids: [...ids], patch });

// The upper bound of nextIntBetween is inclusive, so 0..15 is the full hex digit range.
const hexDigit = Random.nextIntBetween(0, 15).pipe(Effect.map((value) => value.toString(16)));

const hexRun = (length: number): Effect.Effect<string> =>
  Effect.all(
    Array.from({ length }, () => hexDigit),
    { concurrency: 1 },
  ).pipe(Effect.map((digits) => digits.join('')));

/** A 32-digit token from Effect-injected randomness, for request correlation and idempotency keys. */
export const newRequestToken: Effect.Effect<string> = hexRun(32);

// RFC 4122 variant digits are 8, 9, a and b.
const variantDigit = Random.nextIntBetween(8, 11).pipe(Effect.map((value) => value.toString(16)));

/** Client-supplied identity for a new Employee: an RFC 4122 version 4 UUID. */
export const newEmployeeId: Effect.Effect<EmployeeId> = Effect.all(
  [hexRun(8), hexRun(4), hexRun(3), variantDigit, hexRun(3), hexRun(12)],
  { concurrency: 1 },
).pipe(
  Effect.flatMap(([head, middle, version, variant, rest, tail]) =>
    Schema.decodeEffect(EmployeeIdSchema)(`${head}-${middle}-4${version}-${variant}${rest}-${tail}`),
  ),
  // The generated string is a well-formed UUID by construction, so a decode failure is a defect.
  Effect.orDie,
);

export const CommitOutcomeSchema = Schema.Literals(['saved', 'conflict', 'forbidden', 'failed']);
export type CommitOutcome = typeof CommitOutcomeSchema.Type;
