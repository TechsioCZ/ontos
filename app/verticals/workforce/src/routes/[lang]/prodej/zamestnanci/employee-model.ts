import type { RevisionedSaveResult } from '@app/admin-ui';
import { matchesSearch } from '@app/admin-ui';
import { Effect, Option, Random, Schema, Struct } from 'effect';
import {
  EmployeeDepartmentSchema,
  EmployeeEmailSchema,
  EmployeeFullNameMaxLength,
  EmployeeFullNameSchema,
  EmployeeIdSchema,
  EmployeePhoneInputSchema,
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

/** Name or e-mail match that ignores case and diacritics, so `novak` finds Jana Nováková. An empty query matches all. */
export const filterEmployees = (items: readonly Employee[], filters: EmployeeFilters): Employee[] =>
  items.filter(
    (employee) =>
      (!filters.activeOnly || employee.active) &&
      (filters.role === null || employee.role === filters.role) &&
      (filters.department === null || employee.department === filters.department) &&
      (matchesSearch(employee.fullName, filters.query) || matchesSearch(employee.email, filters.query)),
  );

export interface EmployeeDraft {
  readonly active: boolean;
  readonly department: string;
  readonly email: string;
  readonly fullName: string;
  readonly phone: string;
  readonly principalRef?: NonNullable<Employee['principalRef']>;
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
  ...Struct.pick(employee, ['principalRef']),
  role: employee.role,
});

/** True when every field of two drafts holds the same value, so saving would change nothing. */
export const sameDraft = (left: EmployeeDraft, right: EmployeeDraft): boolean =>
  left.active === right.active &&
  left.department === right.department &&
  left.email === right.email &&
  left.fullName === right.fullName &&
  left.phone === right.phone &&
  left.principalRef?.principalId === right.principalRef?.principalId &&
  left.principalRef?.tenantId === right.principalRef?.tenantId &&
  left.role === right.role;

/** The fields the list shows, trimmed as the server stores them. The page applies them to the rows before the reread. */
export const listedFieldsOf = (
  draft: EmployeeDraft,
): Pick<Employee, 'active' | 'department' | 'email' | 'fullName' | 'principalRef' | 'role'> => ({
  active: draft.active,
  department: draft.department.trim(),
  email: draft.email.trim(),
  fullName: draft.fullName.trim(),
  ...Struct.pick(draft, ['principalRef']),
  role: draft.role,
});

const errorKey = 'workforce.pages.employees.errors';

const fits =
  (schema: Schema.Codec<string, string>) =>
  (value: string): boolean =>
    Option.isSome(Schema.decodeOption(schema)(value));

/**
 * A text the person types, checked with the Action's own field schema (which trims it, as the server does). A failure
 * reads as the field's message, an i18n key the form translates.
 */
const typedText = (accepts: (value: string) => boolean, message: (value: string) => string) =>
  Schema.String.check(Schema.makeFilter((value: string) => accepts(value) || message(value)));

/** A name over the stored limit gets its own message instead of "required". */
export const FullNameTextSchema = typedText(fits(EmployeeFullNameSchema), (value) =>
  value.trim().length > EmployeeFullNameMaxLength ? `${errorKey}.fullNameTooLong` : `${errorKey}.fullName`,
);
export const EmailTextSchema = typedText(fits(EmployeeEmailSchema), () => `${errorKey}.email`);
export const DepartmentTextSchema = typedText(fits(EmployeeDepartmentSchema), () => `${errorKey}.department`);
/** An empty phone is no phone; anything typed is checked like the Action checks it. */
export const PhoneTextSchema = typedText(
  (value) => value.trim() === '' || fits(EmployeePhoneInputSchema)(value),
  () => `${errorKey}.phone`,
);

/** The typed fields of a draft, checked by the same schemas the form shows its field messages from. */
const EmployeeTextsSchema = Schema.Struct({
  department: DepartmentTextSchema,
  email: EmailTextSchema,
  fullName: FullNameTextSchema,
  phone: PhoneTextSchema,
});

/** A draft the save may send: every typed field passes its schema. */
export const isSendableDraft = (draft: EmployeeDraft): boolean => Schema.is(EmployeeTextsSchema)(draft);

/** The employee form's values: the draft as its controls hold it, plus the e-mail the server last refused. */
export interface EmployeeValues {
  readonly active: boolean;
  readonly department: string;
  readonly email: string;
  readonly fullName: string;
  readonly phone: string;
  /** `""` is no login account. */
  readonly principalId: string;
  readonly role: string;
  /** The e-mail another Employee already uses, as the server refused it; `""` while none was refused. */
  readonly takenEmail: string;
}

export const valuesOfDraft = (draft: EmployeeDraft): EmployeeValues => ({
  active: draft.active,
  department: draft.department,
  email: draft.email,
  fullName: draft.fullName,
  phone: draft.phone,
  principalId: draft.principalRef?.principalId ?? '',
  role: draft.role,
  takenEmail: '',
});

type PrincipalRef = NonNullable<Employee['principalRef']>;

/**
 * The draft the form's values stand for. The account is the one of `principals` (the accounts the form offers) the
 * form picked. The role choice offers employee roles only; a value outside them keeps the role the form opened with.
 */
export const draftOfValues = (
  values: EmployeeValues,
  principals: readonly PrincipalRef[],
  opened: EmployeeDraft,
): EmployeeDraft => {
  const principalRef = principals.find(({ principalId }) => principalId === values.principalId);
  const draft: EmployeeDraft = {
    active: values.active,
    department: values.department,
    email: values.email,
    fullName: values.fullName,
    phone: values.phone,
    role: roleFromValue(values.role) ?? opened.role,
  };
  return principalRef === undefined ? draft : { ...draft, principalRef };
};

/** The filter bar's values: `allOption` is no role or department filter. */
export interface EmployeeFilterValues {
  readonly activeOnly: boolean;
  readonly department: string;
  readonly query: string;
  readonly role: string;
}

export const noFilterValues: EmployeeFilterValues = {
  activeOnly: false,
  department: allOption,
  query: '',
  role: allOption,
};

export const filtersOfValues = (values: EmployeeFilterValues): EmployeeFilters => ({
  activeOnly: values.activeOnly,
  department: departmentFromValue(values.department),
  query: values.query,
  role: roleFromValue(values.role),
});

/** The organisational fields of a draft. Phone is omitted when empty; the contract cannot clear it. */
const employeeFields = (draft: EmployeeDraft) => {
  const base = {
    active: draft.active,
    department: draft.department.trim(),
    email: draft.email.trim(),
    fullName: draft.fullName.trim(),
    ...Struct.pick(draft, ['principalRef']),
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

export const updateCommand = (employee: Employee, draft: EmployeeDraft): WorkforceCommand => {
  const { principalRef, ...fields } = employeeFields(draft);
  const relink =
    principalRef !== undefined &&
    (principalRef.principalId !== employee.principalRef?.principalId ||
      principalRef.tenantId !== employee.principalRef?.tenantId);
  return {
    _tag: 'UpdateEmployee',
    id: employee.id,
    patch: relink ? { ...fields, principalRef } : fields,
  };
};

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

export const CommitOutcomeSchema = Schema.Literals(['saved', 'conflict', 'duplicateEmail', 'forbidden', 'failed']);
export type CommitOutcome = typeof CommitOutcomeSchema.Type;
export const isCommitOutcome = Schema.is(CommitOutcomeSchema);

/** What one Save of the edit panel answers: a revision once saved, `proposed` when parked for approval, else why not. */
export type EditCommitResult = CommitOutcome | 'proposed' | number;

/** Maps the answer to the edit panel's Save onto the save bar: a revision means saved. */
export const employeeSaveResult = (result: EditCommitResult): RevisionedSaveResult => {
  if (result === 'proposed' || !isCommitOutcome(result)) {
    return result;
  }
  return result === 'saved' || result === 'conflict' ? result : 'failed';
};
