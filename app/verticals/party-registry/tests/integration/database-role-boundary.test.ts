import {
  PARTY_REGISTRY_DATABASE_IDENTITY_ENROLLMENT,
  PARTY_REGISTRY_REQUEST_IDENTITY,
} from '../../shared/database-identities.ts';
import {
  GatewayAssertionRedemptionService,
  loadDatabaseIdentityConnections,
  makeDatabaseConfigLive,
} from '@app/core-runtime';
import { addTestGatewayScopeGrantCleanup } from '@app/core-runtime/testing/gateway-scope-grant';
import type { PgClient } from '@effect/sql-pg';
import { Context, Data, Effect, Layer, Predicate, Redacted } from 'effect';
import type { SqlError } from 'effect/sql/SqlError';
import { NodeCrypto } from '@effect/platform-node';
import { assert, expect, it } from 'effect-rstest';
import type { Row } from 'effect/sql/SqlConnection';

import { makeTestPgClient } from '../../../../packages/core-runtime/tests/support/database.ts';
import {
  GatewayAssertionRedemptionDatabaseLive,
  GatewayAssertionRedemptionLive,
} from '../../api/auth/gateway-assertion-redemption.ts';
import {
  hasPostgreSqlCode,
  loadSeparatedIdentityConnectionStrings,
  openPartyBoundaryClients,
  PARTY_REGISTRY_GATEWAY_AUDIENCE,
  registerPartyGatewayScope,
} from '../support/database-boundary.ts';

const tenantA = 'd1000000-0000-4000-8000-000000000001';
const tenantB = 'd1000000-0000-4000-8000-000000000002';
const legalEntityA1 = 'd2000000-0000-4000-8000-000000000001';
const legalEntityA2 = 'd2000000-0000-4000-8000-000000000002';
const legalEntityB = 'd2000000-0000-4000-8000-000000000003';
const partyA = 'd3000000-0000-4000-8000-000000000001';
const partyB = 'd3000000-0000-4000-8000-000000000002';
const counterpartyA1 = 'd4000000-0000-4000-8000-000000000001';
const counterpartyA2 = 'd4000000-0000-4000-8000-000000000002';
const foreignInvocationA = 'd5000000-0000-4000-8000-000000000001';
const domainEventA = 'd6000000-0000-4000-8000-000000000001';
const moduleStateA = 'd7000000-0000-4000-8000-000000000001';
const fixtureTenants = [tenantA, tenantB] as const;
const otherModuleKey = 'privacy.core';

type Client = PgClient.PgClient;

const query = (client: Client, statement: string, parameters: readonly unknown[] = []) =>
  client.unsafe<Row>(statement, parameters);

/** Runs `statement` and reports whether PostgreSQL rejected it with `insufficient_privilege` (42501). */
const isDenied = (client: Client, statement: string, parameters: readonly unknown[] = []) =>
  query(client, statement, parameters).pipe(
    Effect.matchEffect({
      onFailure: (error: SqlError) => Effect.succeed(hasPostgreSqlCode('42501')(error)),
      onSuccess: () => Effect.succeed(false),
    }),
  );

/** Carries a probe result out of a transaction that must roll back, since a denied probe aborts it. */
class ProbeRollback<Value> extends Data.TaggedError('ProbeRollback')<{ readonly value: Value }> {}

/** Runs `body` in one transaction and always rolls it back, returning the body's result. */
const inTransaction = <Value>(client: Client, body: Effect.Effect<Value, SqlError>) =>
  client
    .withTransaction(body.pipe(Effect.flatMap((value) => Effect.fail(new ProbeRollback({ value })))))
    .pipe(Effect.catchTag('ProbeRollback', ({ value }) => Effect.succeed(value)));

/** Runs `body` in a rolled-back transaction after establishing the registered gateway scope `assertion`. */
const inScope = <Value>(client: Client, assertion: Redacted.Redacted<string>, body: Effect.Effect<Value, SqlError>) =>
  inTransaction(
    client,
    Effect.gen(function* scopedBody() {
      yield* query(client, 'select * from trust.establish_gateway_scope($1)', [Redacted.value(assertion)]);
      return yield* body;
    }),
  );

const purgeFixture = (admin: Client) =>
  Effect.gen(function* purgeFixtureEffect() {
    const tenants = [...fixtureTenants];
    for (const statement of [
      'delete from core.search_index_entries where tenant_id = any($1::uuid[])',
      'delete from core.data_access_events where tenant_id = any($1::uuid[])',
      'delete from core.outbox_messages where tenant_id = any($1::uuid[])',
      'delete from core.domain_events where tenant_id = any($1::uuid[])',
      'delete from core.action_invocations where tenant_id = any($1::uuid[])',
      'delete from core.tenant_module_states where tenant_id = any($1::uuid[])',
      'delete from contacts.organization_engagement_profiles where tenant_id = any($1::uuid[])',
      'delete from contacts.person_engagement_profiles where tenant_id = any($1::uuid[])',
      'delete from party.counterparties where tenant_id = any($1::uuid[])',
      'delete from party.parties where tenant_id = any($1::uuid[])',
      'delete from core.legal_entities where tenant_id = any($1::uuid[])',
      'delete from core.tenants where tenant_id = any($1::uuid[])',
    ]) {
      yield* query(admin, statement, [tenants]);
    }
  });

const counterpartyValues = (counterpartyId: string, legalEntityId: string) => [
  counterpartyId,
  tenantA,
  partyA,
  legalEntityId,
  foreignInvocationA,
];

const insertCounterpartyStatement = `insert into party.counterparties (
  counterparty_id, tenant_id, party_id, legal_entity_id, creation_reason, evidence_refs, source_record_refs,
  provenance_source, provenance_method, accepted_by_action_invocation_id, accepted_by_principal_id, policy_version
) values ($1, $2, $3, $4, 'boundary fixture', '["fixture"]'::jsonb, '[]'::jsonb, 'fixture', 'fixture', $5,
  'd8000000-0000-4000-8000-000000000001', 'fixture-v1')`;

/** Seeds tenants A/B, legal entities, Party, Contacts, Search and Core rows as admin. */
const seedFixture = (admin: Client) =>
  Effect.gen(function* seedFixtureEffect() {
    yield* purgeFixture(admin);
    for (const tenantId of fixtureTenants) {
      yield* query(
        admin,
        `insert into core.tenants (tenant_id, slug, name, status, default_locale) values ($1, $2, 'Role boundary', 'active', 'en')`,
        [tenantId, `role-boundary-${tenantId}`],
      );
    }
    for (const [legalEntityId, tenantId] of [
      [legalEntityA1, tenantA],
      [legalEntityA2, tenantA],
      [legalEntityB, tenantB],
    ] as const) {
      yield* query(
        admin,
        `insert into core.legal_entities (legal_entity_id, tenant_id, legal_name, registration_country, registration_number, status)
         values ($1::uuid, $2, 'Secret Legal Name', 'CZ', $1::text, 'active')`,
        [legalEntityId, tenantId],
      );
    }
    for (const [partyId, tenantId] of [
      [partyA, tenantA],
      [partyB, tenantB],
    ] as const) {
      yield* query(
        admin,
        `insert into party.parties (party_id, tenant_id, current_type, current_display_name) values ($1, $2, 'ORGANIZATION', 'Boundary Org')`,
        [partyId, tenantId],
      );
      yield* query(
        admin,
        'insert into contacts.organization_engagement_profiles (tenant_id, party_resource_id) values ($1, $2)',
        [tenantId, partyId],
      );
      yield* query(
        admin,
        'insert into contacts.person_engagement_profiles (tenant_id, party_resource_id) values ($1, $2)',
        [tenantId, partyId],
      );
      yield* query(
        admin,
        `insert into core.search_index_entries (tenant_id, source_module_key, source_resource_type, source_resource_id, title, body_text)
         values ($1, 'party.registry', 'party', $2, 'Boundary Org', 'Boundary Org')`,
        [tenantId, partyId],
      );
    }
    yield* query(admin, insertCounterpartyStatement, counterpartyValues(counterpartyA1, legalEntityA1));
    yield* query(admin, insertCounterpartyStatement, counterpartyValues(counterpartyA2, legalEntityA2));
    yield* query(
      admin,
      `insert into core.action_invocations (action_invocation_id, tenant_id, action_key, status, request_hash)
       values ($1, $2, 'privacy.core.fixture', 'received', 'fixture')`,
      [foreignInvocationA, tenantA],
    );
    yield* query(
      admin,
      `insert into core.domain_events (domain_event_id, tenant_id, producer_module_key, event_type, subject_module_key, subject_resource_type, subject_resource_id)
       values ($1, $2, 'party.registry', 'party.registry.fixture.v1', 'party.registry', 'party', $3)`,
      [domainEventA, tenantA, partyA],
    );
    yield* query(
      admin,
      `insert into core.tenant_module_states (tenant_module_state_id, tenant_id, module_key, state) values ($1, $2, 'party.registry', 'active')`,
      [moduleStateA, tenantA],
    );
  });

const openFixture = Effect.gen(function* openFixtureEffect() {
  const connections = yield* loadDatabaseIdentityConnections({
    enrollment: PARTY_REGISTRY_DATABASE_IDENTITY_ENROLLMENT,
  });
  const clients = yield* openPartyBoundaryClients({ runtimeMaxConnections: 1 });
  const separated = yield* loadSeparatedIdentityConnectionStrings;
  const worker = yield* makeTestPgClient(separated.worker, { maxConnections: 1 });
  const sharedRuntime = yield* makeTestPgClient(separated.sharedRuntime, { maxConnections: 1 });
  yield* Effect.addFinalizer(() => purgeFixture(clients.admin).pipe(Effect.orDie));
  yield* seedFixture(clients.admin);
  const scopeA = yield* registerPartyGatewayScope(clients, { tenantId: tenantA });
  const scopeA1 = yield* registerPartyGatewayScope(clients, { legalEntityId: legalEntityA1, tenantId: tenantA });
  yield* addTestGatewayScopeGrantCleanup(clients.admin, [tenantA]);
  return { ...clients, adminUser: connections.admin.user, scopeA, scopeA1, sharedRuntime, worker };
});

const rowCount = (rows: readonly Row[]) => rows.length;

it.layer(NodeCrypto.layer, { excludeTestServices: true })((suite) => {
  suite.effect('confines the Party request role to the trusted tenant and legal entity', () =>
    Effect.gen(function* testEffect() {
      const { runtime, scopeA, scopeA1 } = yield* openFixture;

      for (const table of [
        'party.parties',
        'contacts.organization_engagement_profiles',
        'contacts.person_engagement_profiles',
      ]) {
        const column = table === 'party.parties' ? 'party_id::text' : 'party_resource_id';
        const counts = yield* inScope(
          runtime,
          scopeA,
          Effect.all({
            deleted: query(runtime, `delete from ${table} where tenant_id = $1 returning tenant_id`, [tenantB]),
            ownRows: query(runtime, `select ${column} as ref from ${table}`),
            selected: query(runtime, `select tenant_id from ${table} where tenant_id = $1`, [tenantB]),
            updated: query(
              runtime,
              `update ${table} set tenant_id = tenant_id where tenant_id = $1 returning tenant_id`,
              [tenantB],
            ),
          }),
        );
        expect({
          deleted: rowCount(counts.deleted),
          ownRows: counts.ownRows,
          selected: rowCount(counts.selected),
          table,
          updated: rowCount(counts.updated),
        }).toEqual({ deleted: 0, ownRows: [{ ref: partyA }], selected: 0, table, updated: 0 });
      }

      expect(
        yield* inScope(
          runtime,
          scopeA,
          isDenied(runtime, `insert into party.parties (tenant_id, current_type) values ($1, 'ORGANIZATION')`, [
            tenantB,
          ]),
        ),
      ).toBe(true);
      for (const table of ['contacts.organization_engagement_profiles', 'contacts.person_engagement_profiles']) {
        expect(
          yield* inScope(
            runtime,
            scopeA,
            isDenied(runtime, `insert into ${table} (tenant_id, party_resource_id) values ($1, 'cross-tenant')`, [
              tenantB,
            ]),
          ),
        ).toBe(true);
      }

      const legalEntityRows = yield* inScope(
        runtime,
        scopeA1,
        Effect.all({
          deleted: query(
            runtime,
            'delete from party.counterparties where legal_entity_id = $1 returning counterparty_id',
            [legalEntityA2],
          ),
          visible: query(runtime, 'select counterparty_id::text as id from party.counterparties'),
          updated: query(
            runtime,
            'update party.counterparties set policy_version = policy_version where legal_entity_id = $1 returning counterparty_id',
            [legalEntityA2],
          ),
        }),
      );
      expect({
        deleted: rowCount(legalEntityRows.deleted),
        updated: rowCount(legalEntityRows.updated),
        visible: legalEntityRows.visible,
      }).toEqual({ deleted: 0, updated: 0, visible: [{ id: counterpartyA1 }] });
      expect(
        yield* inScope(
          runtime,
          scopeA1,
          isDenied(
            runtime,
            insertCounterpartyStatement,
            counterpartyValues('d4000000-0000-4000-8000-000000000009', legalEntityA2),
          ),
        ),
      ).toBe(true);
      // A tenant-wide sealed grant sees every legal entity in its tenant, never another tenant.
      expect(
        yield* inScope(
          runtime,
          scopeA,
          query(runtime, 'select counterparty_id from party.counterparties order by counterparty_id'),
        ),
      ).toEqual([{ counterparty_id: counterpartyA1 }, { counterparty_id: counterpartyA2 }]);

      const searchRows = yield* inScope(
        runtime,
        scopeA,
        query(
          runtime,
          `select tenant_id::text as tenant from core.search_index_entries where source_module_key = 'party.registry'`,
        ),
      );
      expect(searchRows).toEqual([{ tenant: tenantA }]);
    }),
  );

  suite.effect('ignores unscoped, legacy-spoofed and RLS-bypass attempts', () =>
    Effect.gen(function* testEffect() {
      const { runtime } = yield* openFixture;

      expect(yield* query(runtime, 'select party_id from party.parties')).toEqual([]);
      expect(yield* query(runtime, 'select tenant_id from core.search_index_entries')).toEqual([]);
      expect(
        yield* isDenied(runtime, `insert into party.parties (tenant_id, current_type) values ($1, 'ORGANIZATION')`, [
          tenantA,
        ]),
      ).toBe(true);

      const spoofed = yield* inTransaction(
        runtime,
        Effect.gen(function* spoofedBody() {
          yield* query(
            runtime,
            `select set_config('ontos.tenant_id', $1, true), set_config('ontos.legal_entity_id', $2, true)`,
            [tenantB, legalEntityB],
          );
          yield* query(runtime, `set local ontos.tenant_id = '${tenantB}'`);
          return yield* Effect.all({
            accessor: query(
              runtime,
              'select trust.current_tenant_id() as tenant, trust.current_legal_entity_id() as legal_entity',
            ),
            contacts: query(runtime, 'select tenant_id from contacts.organization_engagement_profiles'),
            parties: query(runtime, 'select party_id from party.parties'),
            search: query(runtime, 'select tenant_id from core.search_index_entries'),
          });
        }),
      );
      expect(spoofed).toEqual({
        accessor: [{ legal_entity: null, tenant: null }],
        contacts: [],
        parties: [],
        search: [],
      });

      expect(
        yield* inTransaction(
          runtime,
          Effect.gen(function* rowSecurityOffBody() {
            yield* query(runtime, 'set local row_security = off');
            return yield* isDenied(runtime, 'select party_id from party.parties');
          }),
        ),
      ).toBe(true);
    }),
  );

  suite.effect('bounds Core writes and reads of the Party request role to its module and trusted tenant', () =>
    Effect.gen(function* testEffect() {
      const { admin, runtime, scopeA } = yield* openFixture;
      const deniedInScope = (statement: string, parameters: readonly unknown[] = []) =>
        inScope(runtime, scopeA, isDenied(runtime, statement, parameters));
      const domainEventInsert = `insert into core.domain_events (tenant_id, producer_module_key, event_type, subject_module_key, subject_resource_type, subject_resource_id)
        values ($1, $2, 'party.registry.fixture.v1', 'party.registry', 'party', 'boundary')`;
      const outboxInsert = `insert into core.outbox_messages (tenant_id, domain_event_id, producer_module_key, topic)
        values ($1, $2, $3, 'party.registry.fixture.v1')`;

      expect(yield* deniedInScope(domainEventInsert, [tenantB, 'party.registry'])).toBe(true);
      expect(yield* deniedInScope(domainEventInsert, [tenantA, otherModuleKey])).toBe(true);
      expect(yield* deniedInScope(outboxInsert, [tenantB, domainEventA, 'party.registry'])).toBe(true);
      expect(yield* deniedInScope(outboxInsert, [tenantA, domainEventA, otherModuleKey])).toBe(true);
      expect(
        yield* deniedInScope(
          `insert into core.data_access_events (tenant_id, principal_id, auth_method, access_kind, serving_module_key, result_count,
             evidence_policy_key, evidence_capture_mode, outcome, outcome_stage, outcome_code)
           values ($1, 'd8000000-0000-4000-8000-000000000001', 'session', 'read', $2, 0, 'fixture', 'metadata_only', 'allowed', 'execution', 'ok')`,
          [tenantA, otherModuleKey],
        ),
      ).toBe(true);
      const foreignInvocationUpdate = yield* inScope(
        runtime,
        scopeA,
        query(
          runtime,
          `update core.action_invocations set status = 'failed' where action_invocation_id = $1 returning action_invocation_id`,
          [foreignInvocationA],
        ),
      );
      expect(foreignInvocationUpdate).toEqual([]);
      expect(
        yield* query(admin, 'select status from core.action_invocations where action_invocation_id = $1', [
          foreignInvocationA,
        ]),
      ).toEqual([{ status: 'received' }]);

      for (const statement of [
        'select domain_event_id from core.domain_events',
        'select outbox_message_id from core.outbox_messages',
        'select data_access_event_id from core.data_access_events',
        'select display_name from core.principals',
        'select legal_name from core.legal_entities',
        'select evidence_json from core.audit_events',
      ]) {
        expect({ denied: yield* deniedInScope(statement), statement }).toEqual({ denied: true, statement });
      }

      // Lock-only: the trusted tenant row passes FOR UPDATE, but any real UPDATE fails WITH CHECK.
      expect(
        yield* inScope(
          runtime,
          scopeA,
          query(runtime, 'select tenant_id::text as tenant from core.tenants where tenant_id = $1 for update', [
            tenantA,
          ]),
        ),
      ).toEqual([{ tenant: tenantA }]);
      expect(
        yield* deniedInScope('update core.tenants set tenant_id = tenant_id where tenant_id = $1', [tenantA]),
      ).toBe(true);
    }),
  );

  suite.effect('denies caller-controlled tenant login defaults and reconnects without trusted scope', () =>
    Effect.gen(function* runtimeDefaultScope() {
      const { runtime } = yield* openFixture;
      // A failed assertion also rolls back any unexpectedly accepted role change.
      for (const statement of [
        `alter role party_registry_runtime set ontos.tenant_id = '${tenantA}'`,
        'alter role party_registry_runtime reset ontos.tenant_id',
      ]) {
        expect({ denied: yield* inTransaction(runtime, isDenied(runtime, statement)), statement }).toEqual({
          denied: true,
          statement,
        });
      }
      const connections = yield* loadDatabaseIdentityConnections({
        enrollment: PARTY_REGISTRY_DATABASE_IDENTITY_ENROLLMENT,
      });
      const requestConnection = connections.runtime[PARTY_REGISTRY_REQUEST_IDENTITY.id];
      assert.isOk(requestConnection !== undefined);
      const fresh = yield* makeTestPgClient(requestConnection.connectionString, {
        maxConnections: 1,
      });
      expect(yield* fresh.unsafe('select trust.current_tenant_id()::text as trusted')).toEqual([{ trusted: null }]);
      expect(yield* fresh.unsafe('select party_id from party.parties')).toEqual([]);
      // PostgreSQL 18 protects log_parameter_max_length, not the USERSET error-logging counterpart.
      expect(yield* fresh.unsafe("select current_setting('log_parameter_max_length') as length")).toEqual([
        { length: '0' },
      ]);
    }),
  );

  suite.effect('denies DDL, unrelated schemas, sequences, role changes and grant propagation', () =>
    Effect.gen(function* testEffect() {
      const { admin, adminUser, runtime, scopeA } = yield* openFixture;

      const deniedStatements = [
        'create table party.boundary_probe (id int)',
        'create table public.boundary_probe (id int)',
        'create schema boundary_probe',
        'create temp table boundary_probe (id int)',
        'alter table party.parties add column boundary_probe int',
        'drop table party.parties',
        'truncate party.parties',
        'create function party.boundary_probe() returns int language sql as $$ select 1 $$',
        'create index boundary_probe on party.parties (tenant_id)',
        'select * from pricing.prices limit 1',
        'select * from catalog.products limit 1',
        'select * from auth.session limit 1',
        'select * from core.media_assets limit 1',
        'select * from core.outbox_deliveries limit 1',
        `insert into core.tenants (slug, name, status, default_locale) values ('boundary-probe', 'Probe', 'active', 'en')`,
        `insert into core.principals (tenant_id, kind, display_name, status) values ('${tenantA}', 'human', 'Probe', 'active')`,
        `select setval('core.domain_event_tenant_sequence_no_seq', 1)`,
        'alter sequence core.domain_event_tenant_sequence_no_seq restart',
        'set role ontos_runtime',
        'set role party_registry_worker',
        `set role ${adminUser}`,
        `set session authorization ${adminUser}`,
        'alter role party_registry_runtime bypassrls',
        'alter role party_registry_runtime superuser',
        'alter role party_registry_runtime createrole',
        'alter role party_registry_runtime set log_parameter_max_length = -1',
        'alter role party_registry_runtime reset log_parameter_max_length',
        'set local log_parameter_max_length = -1',
        'alter role ontos_runtime nologin',
        'create role boundary_probe',
        'grant party_registry_runtime to ontos_runtime',
      ];
      for (const statement of deniedStatements) {
        expect({ denied: yield* inScope(runtime, scopeA, isDenied(runtime, statement)), statement }).toEqual({
          denied: true,
          statement,
        });
      }

      // A non-owner GRANT only warns; what matters is that no privilege reaches the shared runtime.
      yield* Effect.exit(query(runtime, 'grant select on party.parties to ontos_runtime'));
      yield* Effect.exit(query(runtime, 'grant select on contacts.organization_engagement_profiles to ontos_runtime'));
      expect(
        yield* query(
          admin,
          `select has_table_privilege('ontos_runtime', 'party.parties', 'SELECT') as parties,
                  has_table_privilege('ontos_runtime', 'contacts.organization_engagement_profiles', 'SELECT') as contacts,
                  has_column_privilege('party_registry_runtime', 'core.principals', 'display_name', 'SELECT') as principal_name,
                  has_column_privilege('party_registry_runtime', 'core.legal_entities', 'legal_name', 'SELECT') as legal_name`,
        ),
      ).toEqual([{ contacts: false, legal_name: false, parties: false, principal_name: false }]);
    }),
  );

  suite.effect(
    'keeps the worker lock-only on Core and separates it, the shared runtime and the issuer from Party',
    () =>
      Effect.gen(function* testEffect() {
        const { issuer, scopeA, sharedRuntime, worker } = yield* openFixture;

        // The worker locks Core rows through FOR UPDATE, yet every real UPDATE fails WITH CHECK.
        expect(
          yield* inTransaction(
            worker,
            query(
              worker,
              `select t.tenant_id::text as tenant from core.tenants t
               join core.domain_events e on e.tenant_id = t.tenant_id
               join core.tenant_module_states s on s.tenant_id = t.tenant_id
             where e.domain_event_id = $1 and s.tenant_module_state_id = $2 for update`,
              [domainEventA, moduleStateA],
            ),
          ),
        ).toEqual([{ tenant: tenantA }]);
        // The outbox claim filter reads the tenant lifecycle column, so the worker must be able to evaluate it.
        // A column-scoped grant that omits `status` fails every claim for this worker.
        expect(
          yield* query(
            worker,
            `select exists (select 1 from core.tenants t where t.tenant_id = $1 and t.status = 'active') as claimable`,
            [tenantA],
          ),
        ).toEqual([{ claimable: true }]);
        for (const [statement, parameter] of [
          ['update core.tenants set tenant_id = tenant_id where tenant_id = $1', tenantA],
          ['update core.domain_events set domain_event_id = domain_event_id where domain_event_id = $1', domainEventA],
          [
            'update core.tenant_module_states set tenant_module_state_id = tenant_module_state_id where tenant_module_state_id = $1',
            moduleStateA,
          ],
        ] as const) {
          expect({ denied: yield* inTransaction(worker, isDenied(worker, statement, [parameter])), statement }).toEqual(
            {
              denied: true,
              statement,
            },
          );
        }

        const assertion = Redacted.value(scopeA);
        const separated: readonly (readonly [string, Client, string, readonly unknown[]])[] = [
          [
            'worker',
            worker,
            `insert into party.parties (tenant_id, current_type) values ($1, 'ORGANIZATION')`,
            [tenantA],
          ],
          ['worker', worker, 'select tenant_id from contacts.organization_engagement_profiles', []],
          ['worker', worker, 'select * from trust.establish_gateway_scope($1)', [assertion]],
          ['worker', worker, 'set role party_registry_runtime', []],
          ['ontos_runtime', sharedRuntime, 'select party_id from party.parties', []],
          ['ontos_runtime', sharedRuntime, 'select tenant_id from contacts.person_engagement_profiles', []],
          ['ontos_runtime', sharedRuntime, 'select * from trust.establish_gateway_scope($1)', [assertion]],
          [
            'ontos_runtime',
            sharedRuntime,
            `select trust.register_gateway_scope_grant($1, 'party-registry', gen_random_uuid(), gen_random_uuid(), $2::uuid, null, now() + interval '60 seconds')`,
            [assertion, tenantA],
          ],
          ['ontos_runtime', sharedRuntime, 'set role party_registry_runtime', []],
          ['issuer', issuer, 'select party_id from party.parties', []],
          ['issuer', issuer, 'select tenant_id from core.tenants', []],
          ['issuer', issuer, 'select * from trust.establish_gateway_scope($1)', [assertion]],
          ['issuer', issuer, 'set role party_registry_runtime', []],
        ];
        for (const [identity, client, statement, parameters] of separated) {
          expect({
            denied: yield* inTransaction(client, isDenied(client, statement, parameters)),
            identity,
            statement,
          }).toEqual({
            denied: true,
            identity,
            statement,
          });
        }
      }),
  );

  suite.effect('rejects a replayed jti through the Party redemption runtime', () =>
    Effect.gen(function* testEffect() {
      const { admin } = yield* openPartyBoundaryClients();
      const jti = 'd9000000-0000-4000-8000-000000000001';
      const purge = query(admin, 'delete from contacts.gateway_assertion_redemptions where jti = $1', [jti]);
      yield* Effect.addFinalizer(() => purge.pipe(Effect.orDie));
      yield* purge;
      const redemption = Context.get(
        yield* Layer.build(
          GatewayAssertionRedemptionLive.pipe(
            Layer.provide(GatewayAssertionRedemptionDatabaseLive),
            Layer.provide(makeDatabaseConfigLive(PARTY_REGISTRY_REQUEST_IDENTITY)),
          ),
        ),
        GatewayAssertionRedemptionService,
      );
      // Redemption expiry is checked against PostgreSQL's clock, so the input derives from the database time.
      const [databaseNow] = yield* admin<{ readonly nowSeconds: number }>`
        select floor(extract(epoch from now()))::int as "nowSeconds"
      `;
      const input = {
        audience: PARTY_REGISTRY_GATEWAY_AUDIENCE,
        expiresAtEpochSeconds: (databaseNow?.nowSeconds ?? 0) + 120,
        issuer: 'shell-super-app',
        jti,
      };
      yield* redemption.consume(input);
      const replay = yield* Effect.flip(redemption.consume(input));
      expect(Predicate.isTagged(replay, 'GatewayAssertionReplayError')).toBe(true);
      expect(
        yield* query(
          admin,
          'select count(*)::int as count from contacts.gateway_assertion_redemptions where jti = $1',
          [jti],
        ),
      ).toEqual([{ count: 1 }]);
    }),
  );
});
