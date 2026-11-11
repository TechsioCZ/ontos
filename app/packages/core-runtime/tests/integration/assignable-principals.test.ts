import { NodeServices } from '@effect/platform-node';
import { Crypto, Effect, Layer, Result, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { TenantIdSchema } from '../../src/access/ids.ts';
import { TenantIntentLoaderLive } from '../../src/access/intent/tenant-intent-loader.ts';
import { loadDatabaseConnectionPair } from '../../src/db/config.ts';
import { CoreDatabase } from '../../src/db/client.ts';
import { DatabaseIdentityEnrollmentContext } from '../../src/db/database-identities.ts';
import { installOperationalScope } from '../../src/db/scoped-transaction.ts';
import { coreRelations } from '../../src/db/schema.ts';
import { AccessEnforcementPortsLive as accessEnforcementLayer } from '../../src/actions/runtime-wiring.ts';
import {
  AssigneeIneligible,
  loadAssignablePrincipalDirectory,
  makeAssignablePrincipals,
} from '../../src/auth/assignable-principals.ts';
import { decodeAccessDeclarationOrThrow } from '../../src/authorization/access-declaration.ts';
import { AccessEnforcementPortsLive as resolveAccessEnforcementPorts } from '../../src/operations/access-gate.ts';
import { makeTestDatabaseFromClient, makeTestPgClient } from '../support/database.ts';
import { FIXTURE_DATABASE_IDENTITY_ENROLLMENT } from '../support/database-identities.ts';
import { createTemplateDatabase, dropDatabase, replacedDatabase } from '../support/access-scenarios/database.ts';
import { insertMembership, scopeOf, seedTenantRows } from '../support/access-scenarios/scenario.ts';

/*
 * The assignee picker reads two tables that do not have to agree: the company directory
 * (`principal_company_memberships`) lists who works for a company, the access intent
 * (`access_memberships`) says who holds a scope in it. A directory member with no access membership has
 * no scope to be decided in, so the read must leave them out and keep answering; it must neither fail
 * as an outage nor write evidence that cannot name a scope. Runs on the real migrated schema with the
 * live enforcement ports, so the divergence is the one production has.
 */

const uid = (value: number) => `00000000-0000-4000-8000-${value.toString().padStart(12, '0')}`;

const TENANT = uid(1);
const COMPANY = uid(2);
const REQUESTER = uid(3);
const WITH_MEMBERSHIP = uid(4);
const WITHOUT_MEMBERSHIP = uid(5);
const SCOPE_TENANT = uid(10);
const SCOPE_COMPANY = uid(11);

const carrier = {
  accessDeclaration: decodeAccessDeclarationOrThrow(
    {
      key: 'work.tasks.api-records.read',
      kind: 'read',
      modes: ['run'],
      placement: { group: 'work', level: 'basic' },
      risk: 'sensitive',
      selectors: ['all', 'assigned', 'entrusted'],
    },
    { access: 'read', authorization: { kind: 'protected' }, moduleKey: 'work.tasks', role: 'api' },
  ),
};

const assignmentDatabase = Effect.gen(function* assignmentDatabaseEffect() {
  const connections = yield* loadDatabaseConnectionPair();
  const crypto = yield* Crypto.Crypto;
  const bootstrap = yield* makeTestPgClient(connections.admin.connectionString, { maxConnections: 1 });
  const name = `assignable_principals_${(yield* crypto.randomUUIDv4()).replaceAll('-', '')}`;
  yield* bootstrap.unsafe(`create database "${name}"`).pipe(Effect.orDie);
  yield* Effect.addFinalizer(() => dropDatabase(bootstrap, name));
  const admin = yield* makeTestPgClient(replacedDatabase(connections.admin.connectionString, name), {
    maxConnections: 2,
  });
  yield* createTemplateDatabase(admin);
  const runtime = yield* makeTestPgClient(replacedDatabase(connections.runtime.connectionString, name), {
    maxConnections: 2,
  });
  return { admin, executor: yield* makeTestDatabaseFromClient(runtime, coreRelations) };
}).pipe(Effect.orDie);

it.layer(NodeServices.layer, { excludeTestServices: true })('assignable principals on PostgreSQL', (suite) => {
  suite.effect(
    'a company member without an access membership is left out without evidence, one without a grant is denied once',
    () =>
      Effect.gen(function* divergingMemberships() {
        const { admin, executor } = yield* assignmentDatabase;
        yield* seedTenantRows(admin, {
          legalEntityIds: [COMPANY],
          moduleKeys: [],
          principals: [REQUESTER, WITH_MEMBERSHIP, WITHOUT_MEMBERSHIP].map((principalId) => ({
            kind: 'human' as const,
            principalId,
          })),
          tenantId: TENANT,
        });
        yield* admin
          .unsafe(
            `insert into core.access_scopes (scope_id, tenant_id, tenant_context_id) values ('${SCOPE_TENANT}', '${TENANT}', '${TENANT}')`,
          )
          .pipe(Effect.orDie);
        yield* admin
          .unsafe(
            `insert into core.access_scopes (scope_id, tenant_id, legal_entity_id) values ('${SCOPE_COMPANY}', '${TENANT}', '${COMPANY}')`,
          )
          .pipe(Effect.orDie);
        // Both are company directory members; only one of them holds the tenant and the company scope.
        yield* admin
          .unsafe(
            `insert into core.principal_company_memberships (tenant_id, legal_entity_id, principal_id, affiliation, status)
             values ('${TENANT}', '${COMPANY}', '${WITH_MEMBERSHIP}', 'employee', 'active'),
                    ('${TENANT}', '${COMPANY}', '${WITHOUT_MEMBERSHIP}', 'employee', 'active')`,
          )
          .pipe(Effect.orDie);
        for (const scopeId of [SCOPE_TENANT, SCOPE_COMPANY]) {
          yield* insertMembership(admin, TenantIdSchema.make(TENANT), {
            kind: 'member',
            principalId: WITH_MEMBERSHIP,
            recordedBy: REQUESTER,
            scopeId,
          });
        }

        const core = Layer.mergeAll(
          Layer.succeed(CoreDatabase, { executor }),
          Layer.succeed(DatabaseIdentityEnrollmentContext, FIXTURE_DATABASE_IDENTITY_ENROLLMENT),
        );
        const intent = TenantIntentLoaderLive.pipe(Layer.provide(core));
        const context = yield* Layer.build(
          accessEnforcementLayer.pipe(Layer.provide(Layer.mergeAll(core, intent, NodeServices.layer))),
        );
        const service = makeAssignablePrincipals(
          yield* resolveAccessEnforcementPorts.pipe(Effect.provideContext(context)),
        );

        const requester = yield* scopeOf({ legalEntityId: COMPANY, principalId: REQUESTER, tenantId: TENANT });
        const directory = yield* executor.transaction((transaction) =>
          installOperationalScope(transaction, requester, FIXTURE_DATABASE_IDENTITY_ENROLLMENT).pipe(
            Effect.flatMap((scoped) => loadAssignablePrincipalDirectory(scoped, requester)),
          ),
        );
        expect(directory.members.map(({ principalRef }) => principalRef.principalId).toSorted()).toEqual([
          WITH_MEMBERSHIP,
          WITHOUT_MEMBERSHIP,
        ]);

        const eligible = yield* service.read(directory, { carrier, scope: requester });
        expect(eligible).toEqual([]);

        const rows = yield* admin
          .unsafe<{
            readonly actor_principal_id: string;
            readonly on_behalf_of_principal_id: string;
            readonly outcome: string;
            readonly scope_id: string;
          }>(
            `select actor_principal_id, on_behalf_of_principal_id, outcome, scope_id
             from core.access_decision_logs where tenant_id = '${TENANT}'`,
          )
          .pipe(Effect.orDie);
        expect(rows).toEqual([
          {
            actor_principal_id: WITH_MEMBERSHIP,
            on_behalf_of_principal_id: REQUESTER,
            outcome: 'DENIED',
            scope_id: SCOPE_COMPANY,
          },
        ]);

        const refused = yield* Effect.result(
          service.resolveAssignee(
            directory,
            { principalId: WITHOUT_MEMBERSHIP, tenantId: TENANT },
            { carrier, scope: requester },
          ),
        );
        expect(Result.isFailure(refused) && Schema.is(AssigneeIneligible)(refused.failure)).toBe(true);
      }),
  );
});
