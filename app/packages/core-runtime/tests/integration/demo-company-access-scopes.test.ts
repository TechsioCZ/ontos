import { NodeServices } from '@effect/platform-node';
import { Crypto, Effect } from 'effect';
import { expect, it } from 'effect-rstest';

import { legalEntityScopeId } from '../../src/access/bootstrap/persistence.ts';
import { LegalEntityIdSchema, TenantIdSchema } from '../../src/access/ids.ts';
import { loadDatabaseConnectionPair } from '../../src/db/config.ts';
import { coreRelations } from '../../src/db/schema.ts';
import { installOperationalScope } from '../../src/db/scoped-transaction.ts';
import { configureDemoCompaniesFromTransaction } from '../../src/install/demo-company-configuration.ts';
import {
  additionalDemoCompanies,
  commercialDemoCompany,
  demoCompanyTenantId,
  rentalDemoCompany,
} from '../../src/install/demo-company-profiles.ts';
import { createTemplateDatabase, replacedDatabase } from '../support/access-scenarios/database.ts';
import { makeTestDatabaseFromClient, makeTestPgClient } from '../support/database.ts';
import { FIXTURE_DATABASE_IDENTITY_ENROLLMENT } from '../support/database-identities.ts';

/*
 * A company created after tenant setup gets its access scope and fence in the same transaction that creates it, under
 * the tenant's own row policy: without one the gate can never decide a grant in it. The demo company configuration is
 * the one product path that creates companies after setup. Access records are never removed, so the case runs in a
 * database of its own (the fixed demo tenant could not be cleaned up from a shared one).
 */

const principalId = '70000000-0000-4000-8000-0000000000f1';
const tenantId = TenantIdSchema.make(demoCompanyTenantId);
const companies = [
  commercialDemoCompany.legalEntityId,
  rentalDemoCompany.legalEntityId,
  ...additionalDemoCompanies.map((company) => company.legalEntityId),
].map((legalEntityId) => LegalEntityIdSchema.make(legalEntityId));

interface ScopeRow {
  readonly legal_entity_id: string;
  readonly revision: number;
  readonly scope_id: string;
  readonly state: string;
}

const expectedRows: readonly ScopeRow[] = companies
  .map((legalEntityId) => ({
    legal_entity_id: legalEntityId,
    revision: 1,
    scope_id: legalEntityScopeId(tenantId, legalEntityId),
    state: 'Ready',
  }))
  .toSorted((left, right) => left.legal_entity_id.localeCompare(right.legal_entity_id));

it.layer(NodeServices.layer)('demo company configuration', (suite) => {
  suite.effect('creates the access scope and fence of every company it manages, in the same transaction', () =>
    Effect.gen(function* demoCompanyScopes() {
      const crypto = yield* Crypto.Crypto;
      const connections = yield* loadDatabaseConnectionPair({ envPath: '/dev/null' }).pipe(Effect.orDie);
      const bootstrap = yield* makeTestPgClient(connections.admin.connectionString, { maxConnections: 1 });
      const database = `demo_company_scopes_${(yield* crypto.randomUUIDv4()).replaceAll('-', '')}`;
      yield* bootstrap.unsafe(`create database "${database}"`).pipe(Effect.orDie);
      yield* Effect.addFinalizer(() =>
        bootstrap.unsafe(`drop database if exists "${database}" with (force)`).pipe(Effect.orDie),
      );
      const admin = yield* makeTestPgClient(replacedDatabase(connections.admin.connectionString, database), {
        maxConnections: 1,
      });
      yield* createTemplateDatabase(admin);
      yield* Effect.forEach(
        [
          `insert into core.tenants (tenant_id, name, slug, status, default_locale)
             values ('${demoCompanyTenantId}', 'Demo company scopes', 'demo-company-scopes', 'active', 'cs')`,
          `insert into core.principals (principal_id, tenant_id, kind, status, display_name)
             values ('${principalId}', '${demoCompanyTenantId}', 'human', 'active', 'Demo administrator')`,
          `insert into core.legal_entities
               (legal_entity_id, tenant_id, legal_name, registration_country, registration_number, status)
             values ('${commercialDemoCompany.legalEntityId}', '${demoCompanyTenantId}',
                     '${commercialDemoCompany.legalName}', 'CZ', 'DEMO-NAJEMPARK', 'active')`,
        ],
        (statement) => admin.unsafe(statement).pipe(Effect.orDie),
        { concurrency: 1, discard: true },
      );
      const runtime = yield* makeTestPgClient(replacedDatabase(connections.runtime.connectionString, database), {
        maxConnections: 1,
      });
      const executor = yield* makeTestDatabaseFromClient(runtime, coreRelations);
      // The Action's own transaction, under the tenant's own row policy, as the product runs it.
      const configure = executor
        .transaction((transaction) =>
          installOperationalScope(
            transaction,
            {
              authContextRef: 'better-auth-session:demo-company-scopes',
              authMethod: 'session',
              correlationId: 'demo-company-scopes',
              principalId,
              tenantId: demoCompanyTenantId,
            },
            FIXTURE_DATABASE_IDENTITY_ENROLLMENT,
          ).pipe(Effect.flatMap((scoped) => configureDemoCompaniesFromTransaction(scoped, demoCompanyTenantId))),
        )
        .pipe(Effect.orDie);
      const scopeRows = admin
        .unsafe<ScopeRow>(
          `select s.legal_entity_id, s.scope_id, f.revision, f.state
             from core.access_scopes s join core.access_scope_fences f using (tenant_id, scope_id)
            where s.tenant_id = '${demoCompanyTenantId}' and s.legal_entity_id is not null
            order by s.legal_entity_id`,
        )
        .pipe(Effect.orDie);

      yield* configure;
      expect(yield* scopeRows).toEqual(expectedRows);
      // A rerun writes nothing twice and leaves every fence as it was.
      yield* configure;
      expect(yield* scopeRows).toEqual(expectedRows);
    }).pipe(Effect.scoped),
  );
});
