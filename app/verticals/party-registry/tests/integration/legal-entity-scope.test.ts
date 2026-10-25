import type { PgClient } from '@effect/sql-pg';
import { NodeCrypto } from '@effect/platform-node';
import { Crypto, Data, Effect, Redacted } from 'effect';
import { expect, it } from 'effect-rstest';
import type { Row } from 'effect/unstable/sql/SqlConnection';
import type { SqlError } from 'effect/unstable/sql/SqlError';

import {
  hasPostgreSqlCode,
  openPartyBoundaryClients,
  registerPartyGatewayScope,
} from '../support/database-boundary.ts';

type Client = PgClient.PgClient;
const query = (client: Client, statement: string, parameters: readonly unknown[] = []) =>
  client.unsafe<Row>(statement, parameters);
class ProbeRollback<Value> extends Data.TaggedError('LegalEntityProbeRollback')<{ readonly value: Value }> {}

/** Each probe, including successful writes, rolls back and keeps the registered grant unchanged. */
const inScope = <Value>(client: Client, assertion: Redacted.Redacted<string>, body: Effect.Effect<Value, SqlError>) =>
  client
    .withTransaction(
      Effect.gen(function* scopedProbe() {
        yield* query(client, 'select * from trust.establish_gateway_scope($1)', [Redacted.value(assertion)]);
        const value = yield* body;
        return yield* new ProbeRollback({ value });
      }),
    )
    .pipe(Effect.catchTag('LegalEntityProbeRollback', ({ value }) => Effect.succeed(value)));

const denied = (client: Client, statement: string, parameters: readonly unknown[]) =>
  query(client, statement, parameters).pipe(
    Effect.match({
      onFailure: hasPostgreSqlCode('42501'),
      onSuccess: () => false,
    }),
  );

const openFixture = Effect.gen(function* openLegalEntityFixture() {
  const clients = yield* openPartyBoundaryClients({ runtimeMaxConnections: 1 });
  const crypto = yield* Crypto.Crypto;
  const ids = yield* Effect.all({
    tenant: crypto.randomUUIDv4,
    l1: crypto.randomUUIDv4,
    l2: crypto.randomUUIDv4,
    party: crypto.randomUUIDv4,
    principal: crypto.randomUUIDv4,
    c1: crypto.randomUUIDv4,
    c2: crypto.randomUUIDv4,
    r1: crypto.randomUUIDv4,
    r2: crypto.randomUUIDv4,
    i1: crypto.randomUUIDv4,
    i2: crypto.randomUUIDv4,
    globalInvocation: crypto.randomUUIDv4,
  });
  const selected = yield* registerPartyGatewayScope(clients, { tenantId: ids.tenant, legalEntityId: ids.l1 });
  const tenantWide = yield* registerPartyGatewayScope(clients, { tenantId: ids.tenant });
  const { admin } = clients;
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* purgeLegalEntityFixture() {
      for (const table of [
        'party.counterparty_role_admin_read_models',
        'party.counterparty_admin_read_models',
        'party.counterparty_role_periods',
        'party.counterparties',
        'party.parties',
        'core.search_index_entries',
        'core.domain_events',
        'core.data_access_events',
        'core.audit_events',
        'core.action_invocations',
      ]) {
        yield* query(admin, `delete from ${table} where tenant_id = $1`, [ids.tenant]);
      }
      yield* query(admin, 'delete from core.principals where principal_id = $1', [ids.principal]);
      yield* query(admin, 'delete from core.legal_entities where legal_entity_id = $1', [ids.l2]);
    }).pipe(Effect.orDie),
  );
  yield* query(
    admin,
    `insert into core.legal_entities (legal_entity_id, tenant_id, legal_name, registration_country, registration_number, status)
    values ($1::uuid, $2, 'L2 scope fixture', 'CZ', $1::text, 'active')`,
    [ids.l2, ids.tenant],
  );
  yield* query(
    admin,
    `insert into core.principals (principal_id, tenant_id, kind, display_name, status)
    values ($1, $2, 'human', 'Legal entity fixture', 'active')`,
    [ids.principal, ids.tenant],
  );
  yield* query(
    admin,
    `insert into party.parties (party_id, tenant_id, current_type, current_display_name)
    values ($1, $2, 'ORGANIZATION', 'Global Party')`,
    [ids.party, ids.tenant],
  );
  for (const [entity, counterparty, role, invocation] of [
    [ids.l1, ids.c1, ids.r1, ids.i1],
    [ids.l2, ids.c2, ids.r2, ids.i2],
  ]) {
    yield* query(
      admin,
      `insert into party.counterparties (counterparty_id, tenant_id, legal_entity_id, party_id,
      creation_reason, evidence_refs, source_record_refs, provenance_source, provenance_method,
      accepted_by_action_invocation_id, accepted_by_principal_id, policy_version)
      values ($1, $2, $3, $4, 'fixture', '["fixture"]', '[]', 'fixture', 'fixture', $5, $6, '1')`,
      [counterparty, ids.tenant, entity, ids.party, invocation, ids.principal],
    );
    yield* query(
      admin,
      `insert into party.counterparty_role_periods (role_period_id, tenant_id, legal_entity_id, counterparty_id,
      role_type, add_reason, add_evidence_refs, valid_from, provenance_source, provenance_method,
      accepted_by_action_invocation_id, accepted_by_principal_id, policy_version)
      values ($1, $2, $3, $4, 'CUSTOMER', 'fixture', '["fixture"]', now(), 'fixture', 'fixture', $5, $6, '1')`,
      [role, ids.tenant, entity, counterparty, invocation, ids.principal],
    );
    yield* query(
      admin,
      `insert into party.counterparty_admin_read_models (counterparty_id, tenant_id, legal_entity_id, stored_party_id, created_at)
      values ($1, $2, $3, $4, now())`,
      [counterparty, ids.tenant, entity, ids.party],
    );
    yield* query(
      admin,
      `insert into party.counterparty_role_admin_read_models (role_period_id, tenant_id, counterparty_id,
      role_type, add_reason, add_evidence_refs, valid_from, recorded_at, state, provenance_source, provenance_method)
      values ($1, $2, $3, 'CUSTOMER', 'fixture', '["fixture"]', now(), now(), 'ACTIVE', 'fixture', 'fixture')`,
      [role, ids.tenant, counterparty],
    );
  }
  for (const [entity, invocation, resource] of [
    [ids.l1, ids.i1, ids.c1],
    [ids.l2, ids.i2, ids.c2],
    [null, ids.globalInvocation, ids.party],
  ]) {
    yield* query(
      admin,
      `insert into core.action_invocations (action_invocation_id, tenant_id, legal_entity_id, action_key, status, request_hash)
      values ($1, $2, $3, 'party.registry.fixture', 'received', 'fixture')`,
      [invocation, ids.tenant, entity],
    );
    yield* query(
      admin,
      `insert into core.audit_events (tenant_id, legal_entity_id, action_invocation_id, auth_method,
      event_type, outcome, outcome_stage, outcome_code, audit_profile)
      values ($1, $2, $3, 'system', 'party.registry.fixture', 'allowed', 'system', 'fixture', 'standard')`,
      [ids.tenant, entity, invocation],
    );
    yield* query(
      admin,
      `insert into core.search_index_entries (tenant_id, legal_entity_id, source_module_key, source_resource_type,
      source_resource_id, title, body_text) values ($1, $2, 'party.registry', 'party.registry.fixture', $3, 'Fixture', 'private fixture')`,
      [ids.tenant, entity, resource],
    );
  }
  return { ...clients, ids, selected, tenantWide };
});

it.layer(NodeCrypto.layer, { excludeTestServices: true })('sealed legal-entity scope', (suite) => {
  suite.effect('hides other-entity base rows, both projections, Search documents and Core evidence', () =>
    Effect.gen(function* selectScope() {
      const { runtime, ids, selected, tenantWide } = yield* openFixture;
      for (const [table, column, expectedSelected, expectedWide] of [
        ['party.counterparties', 'counterparty_id', [ids.c1], [ids.c1, ids.c2]],
        ['party.counterparty_role_periods', 'role_period_id', [ids.r1], [ids.r1, ids.r2]],
        ['party.counterparty_admin_read_models', 'counterparty_id', [ids.c1], [ids.c1, ids.c2]],
        ['party.counterparty_role_admin_read_models', 'role_period_id', [ids.r1], [ids.r1, ids.r2]],
        ['core.search_index_entries', 'source_resource_id', [ids.c1, ids.party], [ids.c1, ids.c2, ids.party]],
        [
          'core.action_invocations',
          'action_invocation_id',
          [ids.i1, ids.globalInvocation],
          [ids.i1, ids.i2, ids.globalInvocation],
        ],
        [
          'core.audit_events',
          'action_invocation_id',
          [ids.i1, ids.globalInvocation],
          [ids.i1, ids.i2, ids.globalInvocation],
        ],
      ] as const) {
        for (const [assertion, expected] of [
          [selected, expectedSelected],
          [tenantWide, expectedWide],
        ] as const) {
          const rows = yield* inScope(
            runtime,
            assertion,
            query(runtime, `select ${column}::text as id from ${table} where ${column}::text = any($1::text[])`, [
              [...expectedWide],
            ]),
          );
          expect(rows.map(({ id }) => id).toSorted(), table).toEqual([...expected].toSorted());
        }
        expect(
          yield* query(runtime, `select ${column} from ${table} where ${column}::text = any($1::text[])`, [
            [...expectedWide],
          ]),
          table,
        ).toEqual([]);
      }
    }),
  );

  suite.effect('blocks cross-entity projection UPDATE and DELETE while preserving own and tenant-wide writes', () =>
    Effect.gen(function* projectionWrites() {
      const { runtime, ids, selected, tenantWide } = yield* openFixture;
      for (const [table, key, own, other, assignment] of [
        ['party.counterparty_admin_read_models', 'counterparty_id', ids.c1, ids.c2, 'archived_at = now()'],
        [
          'party.counterparty_role_admin_read_models',
          'role_period_id',
          ids.r1,
          ids.r2,
          "add_reason = 'updated fixture'",
        ],
      ]) {
        expect(
          yield* inScope(
            runtime,
            selected,
            query(runtime, `update ${table} set ${assignment} where ${key} = $1 returning ${key}`, [other]),
          ),
        ).toEqual([]);
        for (const [assertion, id] of [
          [selected, own],
          [tenantWide, other],
        ] as const) {
          expect(
            (yield* inScope(
              runtime,
              assertion,
              query(runtime, `update ${table} set ${assignment} where ${key} = $1 returning ${key}`, [id]),
            )).length,
          ).toBe(1);
          // Remove dependent role projections first when proving a parent deletion can succeed.
          expect(
            (yield* inScope(
              runtime,
              assertion,
              Effect.gen(function* deleteProjection() {
                if (table === 'party.counterparty_admin_read_models') {
                  yield* query(
                    runtime,
                    'delete from party.counterparty_role_admin_read_models where counterparty_id = $1',
                    [id],
                  );
                }
                return yield* query(runtime, `delete from ${table} where ${key} = $1 returning ${key}`, [id]);
              }),
            )).length,
          ).toBe(1);
        }
        expect(
          yield* inScope(
            runtime,
            selected,
            query(runtime, `delete from ${table} where ${key} = $1 returning ${key}`, [other]),
          ),
        ).toEqual([]);
      }
      expect(
        yield* inScope(
          runtime,
          selected,
          denied(
            runtime,
            'update party.counterparty_admin_read_models set legal_entity_id = $1 where counterparty_id = $2',
            [ids.l2, ids.c1],
          ),
        ),
      ).toBe(true);
      expect(
        yield* inScope(
          runtime,
          selected,
          denied(
            runtime,
            'update party.counterparty_role_admin_read_models set counterparty_id = $1 where role_period_id = $2',
            [ids.c2, ids.r1],
          ),
        ),
      ).toBe(true);
    }),
  );

  suite.effect('confines invocation updates and rejects cross-entity evidence attribution, not global evidence', () =>
    Effect.gen(function* evidenceWrites() {
      const { runtime, ids, selected, tenantWide } = yield* openFixture;
      const update =
        "update core.action_invocations set status = 'failed' where action_invocation_id = $1 returning action_invocation_id";
      expect(yield* inScope(runtime, selected, query(runtime, update, [ids.i2]))).toEqual([]);
      for (const [assertion, id] of [
        [selected, ids.i1],
        [selected, ids.globalInvocation],
        [tenantWide, ids.i2],
      ] as const) {
        expect((yield* inScope(runtime, assertion, query(runtime, update, [id]))).length).toBe(1);
      }
      expect(
        yield* inScope(
          runtime,
          selected,
          denied(runtime, 'update core.action_invocations set legal_entity_id = $1 where action_invocation_id = $2', [
            ids.l2,
            ids.i1,
          ]),
        ),
      ).toBe(true);
      const evidenceInserts = [
        `insert into core.action_invocations (tenant_id, legal_entity_id, action_key, status, request_hash)
        values ($1, $2, 'party.registry.fixture', 'received', 'fixture')`,
        `insert into core.audit_events (tenant_id, legal_entity_id, action_invocation_id, auth_method, event_type, outcome,
        outcome_stage, outcome_code, audit_profile) values ($1, $2, '${ids.i1}', 'system', 'fixture', 'allowed', 'system', 'fixture', 'standard')`,
        `insert into core.data_access_events (tenant_id, legal_entity_id, principal_id, auth_method, access_kind,
        serving_module_key, result_count, evidence_policy_key, evidence_capture_mode, outcome, outcome_stage, outcome_code)
        values ($1, $2, '${ids.principal}', 'system', 'read', 'party.registry', 0, 'fixture', 'metadata_only', 'allowed', 'execution', 'fixture')`,
        `insert into core.domain_events (tenant_id, legal_entity_id, producer_module_key, event_type, subject_module_key, subject_resource_type, subject_resource_id)
        values ($1, $2, 'party.registry', 'fixture', 'party.registry', 'party.registry.party', '${ids.party}')`,
      ];
      for (const statement of evidenceInserts) {
        expect(yield* inScope(runtime, selected, denied(runtime, statement, [ids.tenant, ids.l2])), statement).toBe(
          true,
        );
        for (const [assertion, entity] of [
          [selected, ids.l1],
          [selected, null],
          [tenantWide, ids.l2],
          [tenantWide, null],
        ] as const) {
          yield* inScope(runtime, assertion, query(runtime, statement, [ids.tenant, entity]));
        }
      }
    }),
  );

  suite.effect('keeps Search and append-only evidence UPDATE and DELETE forbidden even within an entity', () =>
    Effect.gen(function* readOnlyAndAppendOnly() {
      const { runtime, ids, selected } = yield* openFixture;
      for (const entity of [ids.l1, ids.l2]) {
        for (const [table, assignment] of [
          ['core.search_index_entries', "title = 'tampered'"],
          ['core.audit_events', "outcome_code = 'tampered'"],
          ['core.data_access_events', "outcome_code = 'tampered'"],
          ['core.domain_events', "event_type = 'tampered'"],
        ]) {
          for (const statement of [
            `update ${table} set ${assignment} where tenant_id = $1 and legal_entity_id = $2`,
            `delete from ${table} where tenant_id = $1 and legal_entity_id = $2`,
          ]) {
            expect(yield* inScope(runtime, selected, denied(runtime, statement, [ids.tenant, entity])), statement).toBe(
              true,
            );
          }
        }
        expect(
          yield* inScope(
            runtime,
            selected,
            denied(runtime, 'delete from core.action_invocations where tenant_id = $1 and legal_entity_id = $2', [
              ids.tenant,
              entity,
            ]),
          ),
        ).toBe(true);
      }
    }),
  );
});
