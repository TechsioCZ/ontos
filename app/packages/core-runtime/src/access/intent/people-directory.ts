import { and, eq, inArray } from 'drizzle-orm';
import { Context, Effect, Layer, Option } from 'effect';

import { CoreDatabase } from '../../db/client.ts';
import { DatabaseIdentityEnrollmentContext } from '../../db/database-identities.ts';
import { legalEntities, principalCompanyMemberships, principals, tenants } from '../../db/schema.ts';
import type { OperationalScope } from '../../operations/context.ts';
import type { LegalEntityId, PrincipalId } from '../ids.ts';
import { LegalEntityIdSchema, PrincipalIdSchema } from '../ids.ts';
import type { AccessIntentError } from './errors.ts';
import type { AccessIntentDatabase } from './persistence.ts';
import { runScopedRead } from './persistence.ts';

/*
 * The names an administration screen shows next to intent: a person's display name and kind, and a
 * company's legal name. Intent rows carry identifiers only, so a people or approvals surface asks this
 * directory instead of reading identity tables itself. It is a label source, never an authority: the
 * kind and status it reports describe the row, and every decision is still the gate's.
 *
 * Every read runs inside the request's own tenant scope, so row-level security answers this tenant's
 * rows only — a principal or a company of another tenant is simply absent, exactly like one that does
 * not exist (O66).
 */

/** One principal of the request's tenant, as `core.principals` names it. */
export interface AccessDirectoryPerson {
  readonly displayName: string;
  readonly kind: string;
  readonly principalId: PrincipalId;
  readonly status: string;
}

/** One company of the request's tenant, as `core.legal_entities` names it. */
export interface AccessDirectoryCompany {
  readonly legalEntityId: LegalEntityId;
  readonly legalName: string;
}

/** The names of the request's tenant and of each of its companies. */
export interface AccessDirectoryScopeLabels {
  readonly companies: readonly AccessDirectoryCompany[];
  /** Absent only when the tenant row itself is not visible in the request's scope. */
  readonly tenantName?: string;
}

/**
 * One person's company directory membership (`core.principal_company_memberships`) with the principal it
 * names. It lists admission candidates only: the admission itself re-checks the directory inside its own
 * write transaction, so a row read here is never the reason a person is admitted.
 */
export interface AccessDirectoryCompanyMember {
  readonly affiliation: string | null;
  readonly displayName: string;
  readonly principalId: PrincipalId;
  readonly principalKind: string;
  readonly principalStatus: string;
  /** 'invited', 'active', 'disabled' or 'departed'; only an active human is admitted. */
  readonly status: string;
}

export interface AccessPeopleDirectoryService {
  /** One person's directory membership of one company of this tenant, or none. */
  readonly companyMember: (
    scope: OperationalScope,
    legalEntityId: LegalEntityId,
    principalId: PrincipalId,
  ) => Effect.Effect<Option.Option<AccessDirectoryCompanyMember>, AccessIntentError>;
  /** Every directory membership of one company of this tenant, whatever its status. */
  readonly companyMembers: (
    scope: OperationalScope,
    legalEntityId: LegalEntityId,
  ) => Effect.Effect<readonly AccessDirectoryCompanyMember[], AccessIntentError>;
  /** The named principals of this tenant; an id of another tenant is absent from the answer. */
  readonly people: (
    scope: OperationalScope,
    principalIds: readonly PrincipalId[],
  ) => Effect.Effect<readonly AccessDirectoryPerson[], AccessIntentError>;
  /** The tenant's own name and its companies' legal names, which label the scopes a screen offers. */
  readonly scopeLabels: (scope: OperationalScope) => Effect.Effect<AccessDirectoryScopeLabels, AccessIntentError>;
}

export class AccessPeopleDirectory extends Context.Service<AccessPeopleDirectory, AccessPeopleDirectoryService>()(
  '@app/core-runtime/access/intent/people-directory/AccessPeopleDirectory',
) {}

const NO_CONSTRAINTS: ReadonlySet<string> = new Set();

const makeAccessPeopleDirectory = (database: AccessIntentDatabase): AccessPeopleDirectoryService => {
  const people: AccessPeopleDirectoryService['people'] = Effect.fn('AccessPeopleDirectory.people')(
    function* peopleEffect(scope: OperationalScope, principalIds: readonly PrincipalId[]) {
      const wanted = [...new Set(principalIds)];
      if (wanted.length === 0) {
        return [];
      }
      const rows = yield* runScopedRead(database, scope, NO_CONSTRAINTS, (transaction) =>
        transaction
          .select({
            displayName: principals.displayName,
            kind: principals.kind,
            principalId: principals.principalId,
            status: principals.status,
          })
          .from(principals)
          .where(inArray(principals.principalId, wanted)),
      );
      return rows.map((row): AccessDirectoryPerson => ({
        displayName: row.displayName,
        kind: row.kind,
        principalId: PrincipalIdSchema.make(row.principalId),
        status: row.status,
      }));
    },
  );

  const scopeLabels: AccessPeopleDirectoryService['scopeLabels'] = Effect.fn('AccessPeopleDirectory.scopeLabels')(
    function* scopeLabelsEffect(scope: OperationalScope) {
      const [tenantRows, companyRows] = yield* runScopedRead(database, scope, NO_CONSTRAINTS, (transaction) =>
        Effect.all(
          [
            transaction.select({ name: tenants.name }).from(tenants).where(eq(tenants.tenantId, scope.tenantId)),
            transaction
              .select({ legalEntityId: legalEntities.legalEntityId, legalName: legalEntities.legalName })
              .from(legalEntities),
          ],
          { concurrency: 1 },
        ),
      );
      const companies = companyRows.map((row): AccessDirectoryCompany => ({
        legalEntityId: LegalEntityIdSchema.make(row.legalEntityId),
        legalName: row.legalName,
      }));
      const [tenant] = tenantRows;
      return tenant === undefined ? { companies } : { companies, tenantName: tenant.name };
    },
  );

  /**
   * The directory rows are company-scoped by row security, so they are read in that company's scope,
   * minted from the request's own (O66): from a tenant-context request they would otherwise be hidden,
   * and an unreadable directory fails as unavailable instead of answering empty.
   */
  const readCompanyMembers = (scope: OperationalScope, legalEntityId: LegalEntityId, principalId?: PrincipalId) =>
    runScopedRead(database, { ...scope, legalEntityId }, NO_CONSTRAINTS, (transaction) =>
      transaction
        .select({
          affiliation: principalCompanyMemberships.affiliation,
          displayName: principals.displayName,
          principalId: principalCompanyMemberships.principalId,
          principalKind: principals.kind,
          principalStatus: principals.status,
          status: principalCompanyMemberships.status,
        })
        .from(principalCompanyMemberships)
        .innerJoin(
          principals,
          and(
            eq(principals.tenantId, principalCompanyMemberships.tenantId),
            eq(principals.principalId, principalCompanyMemberships.principalId),
          ),
        )
        .where(
          and(
            eq(principalCompanyMemberships.tenantId, scope.tenantId),
            eq(principalCompanyMemberships.legalEntityId, legalEntityId),
            principalId === undefined ? undefined : eq(principalCompanyMemberships.principalId, principalId),
          ),
        ),
    ).pipe(
      Effect.map((rows) =>
        rows.map((row): AccessDirectoryCompanyMember => ({
          affiliation: row.affiliation,
          displayName: row.displayName,
          principalId: PrincipalIdSchema.make(row.principalId),
          principalKind: row.principalKind,
          principalStatus: row.principalStatus,
          status: row.status,
        })),
      ),
    );

  const companyMember: AccessPeopleDirectoryService['companyMember'] = (scope, legalEntityId, principalId) =>
    readCompanyMembers(scope, legalEntityId, principalId).pipe(Effect.map((rows) => Option.fromUndefinedOr(rows[0])));

  const companyMembers: AccessPeopleDirectoryService['companyMembers'] = (scope, legalEntityId) =>
    readCompanyMembers(scope, legalEntityId);

  return Object.freeze({ companyMember, companyMembers, people, scopeLabels });
};

export const AccessPeopleDirectoryLive: Layer.Layer<
  AccessPeopleDirectory,
  never,
  CoreDatabase | DatabaseIdentityEnrollmentContext
> = Layer.effect(
  AccessPeopleDirectory,
  Effect.gen(function* accessPeopleDirectoryLayer() {
    const database = yield* CoreDatabase;
    const enrollment = yield* DatabaseIdentityEnrollmentContext;
    return makeAccessPeopleDirectory({ enrollment, executor: database.executor });
  }),
);
