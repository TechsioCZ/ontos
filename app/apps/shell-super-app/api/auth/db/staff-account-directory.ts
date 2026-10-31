import { Context } from 'effect';
import type { Effect } from 'effect';
import type {
  ReadHandlerUnavailable,
  StaffRoleTemplateAccountsSchema,
  StaffRoleTemplateEmailsSchema,
} from '@app/core-runtime';

/** Auth-private, non-secret directory. Core's admitted role-template Read is its only consumer. */
export class StaffAccountDirectory extends Context.Service<
  StaffAccountDirectory,
  {
    readonly lookup: (
      emails: typeof StaffRoleTemplateEmailsSchema.Type,
    ) => Effect.Effect<typeof StaffRoleTemplateAccountsSchema.Type, ReadHandlerUnavailable>;
  }
>()('@app/shell-super-app/api/auth/db/staff-account-directory/StaffAccountDirectory') {}
