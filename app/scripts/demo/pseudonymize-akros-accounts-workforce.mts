import { Array as Arr, Effect, Option, Order, Schema } from 'effect';

import { WorkforceCommandSchema } from '../../verticals/workforce/shared/actions/apply-command.ts';
import { EmployeeSchema } from '../../verticals/workforce/shared/apis/records.ts';
import { demoTenantId } from './fixture-ids.mts';
import { accountPseudonymFailure as fail } from './pseudonymize-akros-accounts-policy.mts';
import type { PseudonymAccount, PseudonymEmployee } from './pseudonymize-akros-accounts-policy.mts';
import type { SeedClient } from './seed-client.mts';

const Records = Schema.Struct({ items: Schema.Array(Schema.toEncoded(EmployeeSchema)), revision: Schema.Int });
const commandSchema = Schema.toEncoded(WorkforceCommandSchema);
type EmployeeRow = typeof EmployeeSchema.Encoded;

const linkedPrincipal = (row: EmployeeRow) => Option.fromUndefinedOr(row.principalRef?.principalId);
const samePrincipal = Option.makeEquivalence((a: string, b: string) => a === b);

/** Rename only the AKROS-branded name/address and follow the migrated login; the employee identity is kept. */
export const pseudonymEmployee = (employee: EmployeeRow, accounts: readonly PseudonymAccount[]): PseudonymEmployee => {
  const oldPrincipalId = linkedPrincipal(employee);
  const account = accounts.find(
    (row) =>
      row.oldEmail === employee.email || (Option.isSome(oldPrincipalId) && row.oldPrincipalId === oldPrincipalId.value),
  );
  return {
    email: employee.email.replace(/@akros\.demo$/iu, '@sroubarna.demo'),
    fullName: employee.fullName.replaceAll(/akros/giu, 'ŠroubShop'),
    id: employee.id,
    newPrincipalId: account === undefined ? oldPrincipalId : Option.some(account.newPrincipalId),
    oldEmail: employee.email,
    oldFullName: employee.fullName,
    oldPrincipalId,
  };
};

const isPseudonymEmployee = (row: EmployeeRow, accounts: readonly PseudonymAccount[]) =>
  /akros/iu.test(row.fullName) ||
  /@akros\.demo$/iu.test(row.email) ||
  accounts.some((account) => row.principalRef?.principalId === account.oldPrincipalId);

export const discoverPseudonymEmployees = Effect.fn('PseudonymAccount.discoverEmployees')(function* discoverEmployees(
  client: SeedClient,
  accounts: readonly PseudonymAccount[],
) {
  const records = yield* client.read('workforce', Records);
  return Arr.sort(
    records.items.filter((row) => isPseudonymEmployee(row, accounts)).map((row) => pseudonymEmployee(row, accounts)),
    Order.mapInput(Order.String, ({ id }: PseudonymEmployee) => id),
  );
});

const matches = (row: EmployeeRow, email: string, fullName: string, principalId: Option.Option<string>) =>
  row.email === email && row.fullName === fullName && samePrincipal(linkedPrincipal(row), principalId);

/** Governed UpdateEmployee per reviewed row; a row changed since review is never overwritten. */
export const reconcilePseudonymEmployees = Effect.fn('PseudonymAccount.reconcileEmployees')(
  function* reconcileEmployees(client: SeedClient, employees: readonly PseudonymEmployee[], apply: boolean) {
    for (const employee of employees) {
      const records = yield* client.read('workforce', Records);
      const row = records.items.find(({ id }) => id === employee.id);
      if (row === undefined) {
        return yield* fail('A reviewed workforce employee no longer exists');
      }
      if (!matches(row, employee.email, employee.fullName, employee.newPrincipalId)) {
        if (!apply) {
          return yield* fail('Workforce employee name, email or account reference has not been pseudonymized');
        }
        if (!matches(row, employee.oldEmail, employee.oldFullName, employee.oldPrincipalId)) {
          return yield* fail('Workforce employee changed after review; no overwrite performed');
        }
        yield* client.apply(
          'workforce',
          commandSchema,
          {
            _tag: 'UpdateEmployee',
            id: employee.id,
            patch: {
              email: employee.email,
              fullName: employee.fullName,
              ...Option.match(employee.newPrincipalId, {
                onNone: () => ({}),
                onSome: (principalId) => ({ principalRef: { principalId, tenantId: demoTenantId } }),
              }),
            },
          },
          records.revision,
        );
        const after = yield* client.read('workforce', Records);
        const updated = after.items.find(({ id }) => id === employee.id);
        if (updated === undefined || !matches(updated, employee.email, employee.fullName, employee.newPrincipalId)) {
          return yield* fail('Governed workforce employee update did not verify');
        }
      }
    }
    return employees.length;
  },
);
