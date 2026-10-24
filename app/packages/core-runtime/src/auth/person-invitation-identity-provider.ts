import { Context } from 'effect';
import type { Effect } from 'effect';

import type { ScopedTransactionExecutor } from '../db/scoped-transaction.ts';
import type { PrincipalManagementError } from './principal-management-errors.ts';

/** Provider-owned login rows; Core never receives a password or the invitation secret. */
export interface PersonInvitationIdentityInput {
  readonly displayName: string;
  readonly email: string;
  readonly expiresAt: Date;
  readonly providerSubjectId: string;
  readonly verificationId: string;
}

export interface PersonInvitationIdentityWriter {
  readonly provision: (input: PersonInvitationIdentityInput) => Effect.Effect<void, PrincipalManagementError>;
}

/**
 * The owning Action factory binds this provider to its already-scoped SQL transaction.
 * A separate connection, HTTP call, SMTP send, or nested transaction cannot provide atomic invitation creation.
 */
export class PersonInvitationIdentityProvider extends Context.Service<
  PersonInvitationIdentityProvider,
  {
    readonly fromTransaction: (transaction: ScopedTransactionExecutor) => PersonInvitationIdentityWriter;
  }
>()('@app/core-runtime/auth/person-invitation-identity-provider/PersonInvitationIdentityProvider') {}
