import { Context, Schema } from 'effect';
import type { Effect } from 'effect';

import type { ReadHandlerUnavailable } from '../reads/errors.ts';
import { ProviderSubjectIdSchema } from './external-identity-contracts.ts';

/** Bounded non-secret login facts. Only the admitted Core Read may invoke this private provider. */
export const StaffRoleTemplateEmailSchema = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(254));
export const StaffRoleTemplateEmailsSchema = Schema.Array(StaffRoleTemplateEmailSchema).check(Schema.isMaxLength(6));
export const StaffRoleTemplateAccountSchema = Schema.Struct({
  email: StaffRoleTemplateEmailSchema,
  providerSubjectId: ProviderSubjectIdSchema,
});
export const StaffRoleTemplateAccountsSchema = Schema.Array(StaffRoleTemplateAccountSchema).check(
  Schema.isMaxLength(6),
);

/** Auth owns the email-to-retained-user lookup; these facts are neither principals nor grants. */
export class StaffRoleTemplateAccountProvider extends Context.Service<
  StaffRoleTemplateAccountProvider,
  {
    readonly lookup: (
      emails: typeof StaffRoleTemplateEmailsSchema.Type,
    ) => Effect.Effect<typeof StaffRoleTemplateAccountsSchema.Type, ReadHandlerUnavailable>;
  }
>()('@app/core-runtime/auth/staff-role-template-account-provider/StaffRoleTemplateAccountProvider') {}
