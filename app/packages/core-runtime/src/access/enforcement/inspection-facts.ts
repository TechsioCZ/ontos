import { and, eq } from 'drizzle-orm';
import { Context, Effect, Layer, Option } from 'effect';

import { recoverSqlTransactionError } from '../../actions/repository.ts';
import { CoreDatabase } from '../../db/client.ts';
import { DatabaseIdentityEnrollmentContext } from '../../db/database-identities.ts';
import type { DatabaseIdentityEnrollment } from '../../db/database-identities.ts';
import { installOperationalScope } from '../../db/scoped-transaction.ts';
import { legalEntities, principalCompanyMemberships, principals, tenants } from '../../db/schema.ts';
import type { CoreDatabaseExecutor } from '../../db/types.ts';
import type { OperationalScope } from '../../operations/context.ts';
import type { PrincipalStatus } from '../../db/schema.ts';
import type { CompanyAffiliation, CompanyMembershipStatus } from '../../permissions/company-membership.ts';
import { SubjectInspectionUnavailable } from './inspection-contract.ts';

/** Identity/lifecycle facts only. Canonical access intent and the graph still prove membership and rights. */
export interface SubjectIdentityFacts {
  readonly companyStatus?: string;
  readonly membership?: {
    readonly affiliation: CompanyAffiliation | null;
    readonly status: CompanyMembershipStatus;
  };
  readonly principalStatus: PrincipalStatus;
  readonly tenantStatus: string;
}

export interface SubjectIdentityFactsSource {
  readonly read: (input: {
    readonly legalEntityId?: string;
    readonly principalId: string;
    readonly requesterScope: OperationalScope;
  }) => Effect.Effect<Option.Option<SubjectIdentityFacts>, SubjectInspectionUnavailable>;
}

export class SubjectInspectionIdentitySource extends Context.Service<
  SubjectInspectionIdentitySource,
  SubjectIdentityFactsSource
>()('@app/core-runtime/access/enforcement/inspection-facts/SubjectInspectionIdentitySource') {}

export const makeDrizzleSubjectIdentityFacts = (database: {
  readonly enrollment: DatabaseIdentityEnrollment;
  readonly executor: CoreDatabaseExecutor;
}): SubjectIdentityFactsSource => ({
  read: (input) =>
    database.executor
      .transaction(
        Effect.fn('SubjectInspection.identityFacts')(function* identityFacts(transaction) {
          const { legalEntityId, principalId, requesterScope } = input;
          // A query may narrow a company request to tenant context, never select another company.
          if (legalEntityId !== undefined && legalEntityId !== requesterScope.legalEntityId) {
            return yield* new SubjectInspectionUnavailable({
              reason: 'Inspection company differs from requester scope',
            });
          }
          const scoped = yield* installOperationalScope(transaction, requesterScope, database.enrollment);
          const [row] = yield* scoped
            .select({ principalStatus: principals.status, tenantStatus: tenants.status })
            .from(principals)
            .innerJoin(tenants, eq(tenants.tenantId, principals.tenantId))
            .where(and(eq(principals.tenantId, requesterScope.tenantId), eq(principals.principalId, principalId)))
            .limit(1);
          if (row === undefined) {
            return Option.none<SubjectIdentityFacts>();
          }
          if (legalEntityId === undefined) {
            return Option.some(row);
          }
          const [company] = yield* scoped
            .select({ status: legalEntities.status })
            .from(legalEntities)
            .where(
              and(eq(legalEntities.tenantId, requesterScope.tenantId), eq(legalEntities.legalEntityId, legalEntityId)),
            )
            .limit(1);
          if (company === undefined) {
            return Option.none<SubjectIdentityFacts>();
          }
          const [membership] = yield* scoped
            .select({
              affiliation: principalCompanyMemberships.affiliation,
              status: principalCompanyMemberships.status,
            })
            .from(principalCompanyMemberships)
            .where(
              and(
                eq(principalCompanyMemberships.tenantId, requesterScope.tenantId),
                eq(principalCompanyMemberships.legalEntityId, legalEntityId),
                eq(principalCompanyMemberships.principalId, principalId),
              ),
            )
            .limit(1);
          // Absence grants nothing. The canonical intent reader still requires actual memberships,
          // including its tenant-owner exception; a retained disabled/departed directory row denies.
          const facts = { ...row, companyStatus: company.status };
          return Option.some(membership === undefined ? facts : { ...facts, membership });
        }),
      )
      .pipe(
        recoverSqlTransactionError,
        Effect.mapError(
          (cause) => new SubjectInspectionUnavailable({ cause, reason: 'Subject identity facts are unavailable' }),
        ),
      ),
});

export const SubjectInspectionIdentitySourceLive: Layer.Layer<
  SubjectInspectionIdentitySource,
  never,
  CoreDatabase | DatabaseIdentityEnrollmentContext
> = Layer.effect(
  SubjectInspectionIdentitySource,
  Effect.gen(function* subjectIdentityFactsLive() {
    const database = yield* CoreDatabase;
    const enrollment = yield* DatabaseIdentityEnrollmentContext;
    return makeDrizzleSubjectIdentityFacts({ enrollment, executor: database.executor });
  }),
);
