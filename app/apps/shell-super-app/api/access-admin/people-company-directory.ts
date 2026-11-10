import type { OperationalScope } from '@app/core-runtime';
import { DatabaseIdentityEnrollmentContext } from '@app/core-runtime';
import { PrincipalIdSchema } from '@app/core-runtime/access/ids';
import type { LegalEntityId, PrincipalId } from '@app/core-runtime/access/ids';
import { loadAssignmentPreflightSnapshot } from '@app/core-runtime/auth/assignable-principals';
import { CoreDatabase } from '@app/core-runtime/db/client';
import { Context, Effect, Layer } from 'effect';

import type { AccessAdminProblem } from '../../shared/access-admin-api.ts';
import { accessAdminUnavailableProblem } from './session.ts';

/*
 * The company directory Lidé draws its admission candidates from (`core.principal_company_memberships`).
 * It is read in that company's own scope, so row-level security shows the company's rows, through Core's
 * own company-scoped directory read. It names people and the status the company recorded; whether they
 * may be admitted is still Core's rule, checked again inside the admission's own transaction. An
 * unreadable directory is a retryable 503, never an empty list.
 */

/** One row of a company's own directory: who the company lists, and whether that listing is active. */
export interface AccessCompanyDirectoryMember {
  readonly displayName: string;
  readonly membershipStatus: string;
  readonly principalId: PrincipalId;
  readonly principalStatus: string;
}

export interface AccessCompanyDirectoryService {
  readonly companyMembers: (
    scope: OperationalScope,
    legalEntityId: LegalEntityId,
  ) => Effect.Effect<readonly AccessCompanyDirectoryMember[], AccessAdminProblem>;
}

export class AccessCompanyDirectory extends Context.Service<AccessCompanyDirectory, AccessCompanyDirectoryService>()(
  '@app/shell-super-app/api/access-admin/people-company-directory/AccessCompanyDirectory',
) {}

/** A retry that keeps Core's failure as its cause, never a smaller answer. */
const directoryUnavailable = (cause: unknown): AccessAdminProblem =>
  Object.defineProperty(
    {
      ...accessAdminUnavailableProblem(),
      detail: 'Access administration is temporarily unavailable (access_intent_unavailable). Please retry.',
    },
    'cause',
    { enumerable: false, value: cause },
  );

/** The company directory of this process, read in one short company-scoped transaction per question. */
export const AccessCompanyDirectoryLive: Layer.Layer<
  AccessCompanyDirectory,
  never,
  CoreDatabase | DatabaseIdentityEnrollmentContext
> = Layer.effect(
  AccessCompanyDirectory,
  Effect.gen(function* accessCompanyDirectoryLayer() {
    const database = yield* CoreDatabase;
    const enrollment = yield* DatabaseIdentityEnrollmentContext;
    return {
      companyMembers: (scope, legalEntityId) =>
        loadAssignmentPreflightSnapshot({ ...scope, legalEntityId }, () => Effect.void).pipe(
          Effect.provideService(CoreDatabase, database),
          Effect.provideService(DatabaseIdentityEnrollmentContext, enrollment),
          Effect.map(({ directory }) =>
            directory.members.map((member): AccessCompanyDirectoryMember => ({
              displayName: member.displayName,
              membershipStatus: member.membershipStatus,
              principalId: PrincipalIdSchema.make(member.principalRef.principalId),
              principalStatus: member.principalStatus,
            })),
          ),
          Effect.mapError(directoryUnavailable),
        ),
    };
  }),
);
