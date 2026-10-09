import { Context, Effect } from 'effect';

import type {
  ExternalAuthenticationSubject,
  ResolveExternalSubjectResultSchema,
} from '../external-identity-contracts.ts';
import type { ScopedTransactionExecutor } from '../../db/scoped-transaction.ts';
import { ExternalIdentityRepository, externalIdentityRepositoryFromTransaction } from './repository.ts';
import type { ExternalIdentityAdmissionContext, ExternalIdentityRepositoryService } from './repository.ts';
import type { ExternalIdentityFailure } from './errors.ts';

export type ResolveExternalSubjectResult = (typeof ResolveExternalSubjectResultSchema)['Type'];

export interface ResolveExternalSubjectInput {
  readonly admission: ExternalIdentityAdmissionContext;
  readonly subject: ExternalAuthenticationSubject;
  readonly tenantId: string;
}

/** Receiver-owned admission capability supplied by trusted operation composition. */
export class ExternalIdentityAdmission extends Context.Service<
  ExternalIdentityAdmission,
  ExternalIdentityAdmissionContext
>()('@app/core-runtime/auth/external-identity/resolve/ExternalIdentityAdmission') {}

/** Resolves one exact, freshly admitted external subject to its active binding. */
export const resolveExternalSubject = (
  input: ResolveExternalSubjectInput,
): Effect.Effect<ResolveExternalSubjectResult, ExternalIdentityFailure, ExternalIdentityRepository> =>
  ExternalIdentityRepository.pipe(Effect.flatMap((repository) => repository.resolve(input)));

/** Owner-local transaction composition seam used by Shell/Core. */
export const resolveExternalSubjectFromTransaction = (
  transaction: ScopedTransactionExecutor,
): ExternalIdentityRepositoryService['resolve'] => externalIdentityRepositoryFromTransaction(transaction).resolve;
