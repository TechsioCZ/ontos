import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { LegalEntityIdSchema } from '../../src/access/ids.ts';
import { makeTenantIntentLoader } from '../../src/access/intent/tenant-intent-loader.ts';
import { TrustedPrincipalContextSchema } from '../../src/actions/principal-context.ts';
import type { OperationalScope } from '../../src/operations/context.ts';
import { makeTestDatabase } from '../support/database.ts';
import { FIXTURE_DATABASE_IDENTITY_ENROLLMENT } from '../support/database-identities.ts';
import { person, tenant } from './access-decision-support.ts';

/*
 * F4: the company-of-tenant check every tenant-context decision that names a company asks (almost every Shell
 * request, the People page among them). It used to be a scope read with no holders: every scope row of the tenant
 * AND every membership of the tenant, for a yes/no answer. It is now its own lookup of the one scope row. Both are
 * counted here statement by statement through the real intent loader over a scripted database.
 */

const company = LegalEntityIdSchema.make('00000000-0000-4000-8000-000000000081');
const scope: OperationalScope = Object.freeze({
  ...Schema.decodeSync(TrustedPrincipalContextSchema)({
    authBindingId: '00000000-0000-4000-8000-000000000005',
    authContextRef: 'better-auth-session:ownership-cost',
    authMethod: 'session',
    legalEntityId: company,
    principalId: person,
    tenantId: tenant,
  }),
  correlationId: 'ownership-cost',
});

/** Every statement the loader sends, with the scope installed and the company's one scope row present. */
const recording = (statements: string[]) => (statement: string) => {
  statements.push(statement);
  if (statement.includes('current_user')) {
    return Effect.succeed([{ legal_entity_id: company, role: 'ontos_runtime', tenant_id: tenant }]);
  }
  if (statement.includes('"access_scopes"')) {
    return Effect.succeed([{ scopeId: '00000000-0000-4000-8000-000000000003' }]);
  }
  return Effect.succeed([]);
};

const reads = (statements: readonly string[]) => ({
  memberships: statements.filter((statement) => statement.includes('"access_memberships"')).length,
  scopes: statements.filter((statement) => statement.includes('"access_scopes"')).length,
  total: statements.length,
});

it.effect('the company ownership check reads one scope row and no membership', () =>
  Effect.gen(function* ownershipCost() {
    const before: string[] = [];
    const legacy = makeTenantIntentLoader({
      enrollment: FIXTURE_DATABASE_IDENTITY_ENROLLMENT,
      executor: yield* makeTestDatabase(recording(before)),
    });
    // The old check: the scope read itself, asked with no holder.
    yield* legacy.loadScope(scope, { holders: [], legalEntityId: company, tenantId: tenant }).pipe(Effect.ignore);

    const after: string[] = [];
    const loader = makeTenantIntentLoader({
      enrollment: FIXTURE_DATABASE_IDENTITY_ENROLLMENT,
      executor: yield* makeTestDatabase(recording(after)),
    });
    expect(yield* loader.loadCompanyOwnership(scope, { legalEntityId: company, tenantId: tenant })).toBe(true);

    expect(reads(before)).toMatchObject({ memberships: 1, scopes: 1 });
    expect(reads(after)).toMatchObject({ memberships: 0, scopes: 1 });
    expect(reads(after).total).toBe(reads(before).total - 1);
    // The one scope statement names the company: it never reads the tenant's other scope rows.
    const ownershipRead = after.find((statement) => statement.includes('"access_scopes"'));
    expect(ownershipRead).toMatch(/"legal_entity_id" = \$\d+/u);
    expect(ownershipRead).toMatch(/limit \$\d+/u);
  }),
);
