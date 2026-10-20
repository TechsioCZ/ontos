import type { PgClient } from '@effect/sql-pg';
import { addTestGatewayScopeGrantCleanup } from '@app/core-runtime/testing/gateway-scope-grant';
import { NodeCrypto } from '@effect/platform-node';
import { Data, Effect, Redacted } from 'effect';
import { expect, it } from 'effect-rstest';
import type { Row } from 'effect/sql/SqlConnection';
import type { SqlError } from 'effect/sql/SqlError';

import {
  hasPostgreSqlCode,
  openPartyBoundaryClients,
  registerPartyGatewayScope,
} from '../support/database-boundary.ts';

const tenantA = 'e1000000-0000-4000-8000-000000000001';
const tenantB = 'e1000000-0000-4000-8000-000000000002';
const legalEntityA = 'e2000000-0000-4000-8000-000000000001';
const legalEntityB = 'e2000000-0000-4000-8000-000000000002';
const principalA = 'e3000000-0000-4000-8000-000000000001';
const principalB = 'e3000000-0000-4000-8000-000000000002';
const bindingA = 'e4000000-0000-4000-8000-000000000001';
const bindingB = 'e4000000-0000-4000-8000-000000000002';
const invocationA = 'e5000000-0000-4000-8000-000000000001';
const invocationB = 'e5000000-0000-4000-8000-000000000002';
const auditA = 'e6000000-0000-4000-8000-000000000001';
const auditB = 'e6000000-0000-4000-8000-000000000002';
const fixtureTenants = [tenantA, tenantB] as const;
const redemptionIssuer = 'core-evidence-tenant-scope';

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
      'delete from core.data_access_events where tenant_id = any($1::uuid[])',
      'delete from core.audit_events where tenant_id = any($1::uuid[])',
      'delete from core.action_invocations where tenant_id = any($1::uuid[])',
      'delete from core.principal_auth_bindings where tenant_id = any($1::uuid[])',
      'delete from trust.gateway_scope_grants where tenant_id = any($1::uuid[])',
      'delete from core.principals where tenant_id = any($1::uuid[])',
      'delete from core.legal_entities where tenant_id = any($1::uuid[])',
      'delete from core.tenants where tenant_id = any($1::uuid[])',
    ]) {
      yield* query(admin, statement, [tenants]);
    }
    yield* query(admin, 'delete from contacts.gateway_assertion_redemptions where issuer = $1', [redemptionIssuer]);
  });

/** Seeds one principal, binding, legal entity, Party invocation and audit event per tenant as admin. */
const seedFixture = (admin: Client) =>
  Effect.gen(function* seedFixtureEffect() {
    yield* purgeFixture(admin);
    for (const [tenantId, legalEntityId, principalId, bindingId, invocationId, auditId] of [
      [tenantA, legalEntityA, principalA, bindingA, invocationA, auditA],
      [tenantB, legalEntityB, principalB, bindingB, invocationB, auditB],
    ] as const) {
      yield* query(
        admin,
        `insert into core.tenants (tenant_id, slug, name, status, default_locale) values ($1, $2, 'Evidence scope', 'active', 'en')`,
        [tenantId, `evidence-scope-${tenantId}`],
      );
      yield* query(
        admin,
        `insert into core.legal_entities (legal_entity_id, tenant_id, legal_name, registration_country, registration_number, status)
         values ($1::uuid, $2, 'Evidence scope', 'CZ', $1::text, 'active')`,
        [legalEntityId, tenantId],
      );
      yield* query(
        admin,
        `insert into core.principals (principal_id, tenant_id, kind, display_name, status) values ($1, $2, 'human', 'Evidence scope', 'active')`,
        [principalId, tenantId],
      );
      yield* query(
        admin,
        `insert into core.principal_auth_bindings
           (principal_auth_binding_id, tenant_id, principal_id, provider, subject_type, provider_subject_id, status, authentication_namespace_id)
         values ($1::uuid, $2, $3, 'fixture', 'user', $1::text, 'active', 'fixture')`,
        [bindingId, tenantId, principalId],
      );
      yield* query(
        admin,
        `insert into core.action_invocations (action_invocation_id, tenant_id, action_key, status, request_hash)
         values ($1, $2, 'party.registry.fixture', 'received', 'fixture')`,
        [invocationId, tenantId],
      );
      yield* query(
        admin,
        `insert into core.audit_events (audit_event_id, tenant_id, action_invocation_id, auth_method, event_type, outcome,
           outcome_stage, outcome_code, audit_profile)
         values ($1, $2, $3, 'system', 'party.registry.fixture', 'allowed', 'system', 'fixture', 'standard')`,
        [auditId, tenantId, invocationId],
      );
    }
  });

const openFixture = Effect.gen(function* openFixtureEffect() {
  const clients = yield* openPartyBoundaryClients({ runtimeMaxConnections: 1 });
  yield* Effect.addFinalizer(() => purgeFixture(clients.admin).pipe(Effect.orDie));
  yield* seedFixture(clients.admin);
  const scopeA = yield* registerPartyGatewayScope(clients, { tenantId: tenantA });
  yield* addTestGatewayScopeGrantCleanup(clients.admin, [tenantA]);
  return { ...clients, scopeA };
});

const insertInvocationStatement = `insert into core.action_invocations (action_invocation_id, tenant_id, action_key, status, request_hash)
  values (gen_random_uuid(), $1, 'party.registry.fixture', 'received', 'fixture')`;

const insertAuditStatement = `insert into core.audit_events (tenant_id, action_invocation_id, auth_method, event_type, outcome,
    outcome_stage, outcome_code, audit_profile)
  values ($1, $2, 'system', 'party.registry.fixture', 'allowed', 'system', 'fixture', 'standard')`;

const insertDataAccessStatement = `insert into core.data_access_events (tenant_id, principal_id, auth_method, access_kind,
    serving_module_key, result_count, evidence_policy_key, evidence_capture_mode, outcome, outcome_stage, outcome_code)
  values ($1, $2, 'system', 'read', 'party.registry', 0, 'fixture', 'metadata_only', 'allowed', 'execution', 'fixture')`;

const identityReads = (client: Client) =>
  Effect.all({
    audits: query(client, 'select action_invocation_id::text as id from core.audit_events'),
    bindings: query(client, 'select principal_auth_binding_id::text as id from core.principal_auth_bindings'),
    invocations: query(client, 'select action_invocation_id::text as id from core.action_invocations'),
    legalEntities: query(client, 'select legal_entity_id::text as id from core.legal_entities'),
    principals: query(
      client,
      'select principal_id::text as id from core.principals where principal_id = any($1::uuid[])',
      [[principalA, principalB]],
    ),
  });

it.layer(NodeCrypto.layer, { excludeTestServices: true })((suite) => {
  suite.effect('confines Party Core evidence and identity reads to the trusted tenant', () =>
    Effect.gen(function* testEffect() {
      const { runtime, scopeA } = yield* openFixture;

      expect(yield* inScope(runtime, scopeA, identityReads(runtime))).toEqual({
        audits: [{ id: invocationA }],
        bindings: [{ id: bindingA }],
        invocations: [{ id: invocationA }],
        legalEntities: [{ id: legalEntityA }],
        principals: [{ id: principalA }],
      });
      expect(yield* inTransaction(runtime, identityReads(runtime))).toEqual({
        audits: [],
        bindings: [],
        invocations: [],
        legalEntities: [],
        principals: [],
      });
    }),
  );

  suite.effect('rejects Party Core evidence writes for another tenant', () =>
    Effect.gen(function* testEffect() {
      const { runtime, scopeA } = yield* openFixture;

      // Own-tenant writes pass, so each denial below comes from the tenant predicate alone.
      yield* inScope(
        runtime,
        scopeA,
        Effect.all([
          query(runtime, insertInvocationStatement, [tenantA]),
          query(runtime, insertAuditStatement, [tenantA, invocationA]),
          query(runtime, insertDataAccessStatement, [tenantA, principalA]),
        ]),
      );

      for (const [statement, parameters] of [
        [insertInvocationStatement, [tenantB]],
        [insertAuditStatement, [tenantB, invocationB]],
        [insertDataAccessStatement, [tenantB, principalB]],
        ['update core.action_invocations set tenant_id = $1 where action_invocation_id = $2', [tenantB, invocationA]],
      ] as const) {
        const denied = yield* inScope(runtime, scopeA, isDenied(runtime, statement, parameters));
        expect({ denied, statement }).toEqual({ denied: true, statement });
      }

      const updated = yield* inScope(
        runtime,
        scopeA,
        query(
          runtime,
          `update core.action_invocations set status = 'failed' where action_invocation_id = $1 returning action_invocation_id`,
          [invocationB],
        ),
      );
      expect(updated).toEqual([]);
    }),
  );

  suite.effect('prunes gateway assertion redemptions only through the expired-row routine', () =>
    Effect.gen(function* testEffect() {
      const { admin, runtime } = yield* openFixture;
      yield* query(
        admin,
        `insert into contacts.gateway_assertion_redemptions (issuer, audience, jti, expires_at, redeemed_at) values
           ($1, 'party-registry', gen_random_uuid(), now() - interval '1 hour', now() - interval '2 hours'),
           ($1, 'party-registry', 'e7000000-0000-4000-8000-000000000001', now() + interval '1 hour', now())`,
        [redemptionIssuer],
      );

      expect(
        yield* isDenied(runtime, 'delete from contacts.gateway_assertion_redemptions where issuer = $1', [
          redemptionIssuer,
        ]),
      ).toBe(true);
      // A caller-supplied cutoff in the future cannot reach rows that have not expired.
      yield* query(runtime, `select contacts.prune_expired_gateway_assertion_redemptions(now() + interval '1 day')`);
      expect(
        yield* query(
          admin,
          'select jti::text as jti from contacts.gateway_assertion_redemptions where issuer = $1 order by jti',
          [redemptionIssuer],
        ),
      ).toEqual([{ jti: 'e7000000-0000-4000-8000-000000000001' }]);
    }),
  );
});
