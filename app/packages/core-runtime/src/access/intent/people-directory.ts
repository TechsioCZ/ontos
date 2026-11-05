import { eq, inArray } from 'drizzle-orm';
import { Context, Effect, Layer } from 'effect';

import { CoreDatabase } from '../../db/client.ts';
import { legalEntities, principals, tenants } from '../../db/schema.ts';
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

export interface AccessPeopleDirectoryService {
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

  return Object.freeze({ people, scopeLabels });
};

export const AccessPeopleDirectoryLive: Layer.Layer<AccessPeopleDirectory, never, CoreDatabase> = Layer.effect(
  AccessPeopleDirectory,
  Effect.gen(function* accessPeopleDirectoryLayer() {
    const database = yield* CoreDatabase;
    return makeAccessPeopleDirectory(database);
  }),
);
