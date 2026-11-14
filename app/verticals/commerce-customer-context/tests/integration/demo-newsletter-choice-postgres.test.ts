import {
  ActionAuthorizationPreflightDatabaseLive,
  findPostgresFailure,
  loadDatabaseConnectionPair,
} from '@app/core-runtime';
import { Array as EffectArray, DateTime, Effect, Layer, Option, Order, Result, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { CoreDatabase, makeCoreDatabase } from '../../../../packages/core-runtime/src/db/client.ts';
import { makeTestPgClient } from '../../../../packages/core-runtime/tests/support/database.ts';
import {
  readDemoNewsletterChoice,
  writeDemoNewsletterChoice,
} from '../../api/portal-auth/consent/choice-persistence.ts';
import type { StoredChoiceSchema } from '../../api/portal-auth/consent/choice-persistence.ts';
import { ConsentConflictProblemSchema, UpdateCustomerOwnConsentSchema } from '../../shared/portal-auth/consent-api.ts';
import { CommerceEnrollmentOwnerTransactionRunnerLive } from '../../src/enrollment/orchestration/owner-transaction-runner.ts';

const tenantId = 'd1000000-0000-4000-8000-000000000001';
const legalEntityId = 'd2000000-0000-4000-8000-000000000002';
const partyId = 'd3000000-0000-4000-8000-000000000003';
const requestId = 'd4000000-0000-4000-8000-000000000004';
const withdrawalRequestId = 'd4000000-0000-4000-8000-000000000005';
const anotherRequestId = 'd4000000-0000-4000-8000-000000000006';
const noticeVersionId = 'demo-newsletter.cs.v1';
const scope = { legalEntityId, partyId, tenantId };
type ChoiceScope = typeof scope;

type Choice = typeof StoredChoiceSchema.Encoded;

interface WriteInput {
  readonly decision: Choice['decision'];
  readonly expectedRevision: number;
  readonly noticeVersionId: string;
  readonly requestId: string;
}
const grant: WriteInput = { decision: 'GRANTED', expectedRevision: 0, noticeVersionId, requestId };
const withdrawal: WriteInput = {
  decision: 'WITHDRAWN',
  expectedRevision: 1,
  noticeVersionId,
  requestId: withdrawalRequestId,
};

const fixture = Effect.fn('DemoNewsletterChoice.fixture')(function* choiceFixture(party: string) {
  const connections = yield* loadDatabaseConnectionPair({ envPath: '/dev/null' });
  const admin = yield* makeTestPgClient(connections.admin.connectionString);
  const runtime = yield* makeTestPgClient(connections.runtime.connectionString);
  const ownedScope = { ...scope, partyId: party };
  const cleanup = admin`delete from commerce_customer_context.demo_newsletter_choices
    where tenant_id in (${tenantId}::uuid, 'd1000000-0000-4000-8000-000000000007'::uuid)
      and party_id = ${party}::uuid`;
  yield* cleanup;
  yield* Effect.addFinalizer(() => cleanup.pipe(Effect.orDie));
  const scoped = <A, E, R>(effect: Effect.Effect<A, E, R>, installedScope: ChoiceScope = ownedScope) =>
    runtime.withTransaction(
      Effect.gen(function* scopedTransaction() {
        yield* runtime`select set_config('ontos.tenant_id', ${installedScope.tenantId}, true),
          set_config('ontos.legal_entity_id', ${installedScope.legalEntityId}, true)`;
        return yield* effect;
      }),
    );
  const read = (target: ChoiceScope = ownedScope) =>
    runtime<{ choice: Choice }>`select * from commerce_customer_context.read_demo_newsletter_choice(
      ${target.tenantId}::uuid, ${target.legalEntityId}::uuid, ${target.partyId}::uuid)`;
  const write = (input: WriteInput = grant, target: ChoiceScope = ownedScope) =>
    runtime<{ choice: Choice }>`select * from commerce_customer_context.write_demo_newsletter_choice(
      ${target.tenantId}::uuid, ${target.legalEntityId}::uuid, ${target.partyId}::uuid,
      ${input.expectedRevision}::integer, ${input.decision}::text, ${input.noticeVersionId}::text,
      ${input.requestId}::uuid)`;
  return { admin, connections, read, runtime, scope: ownedScope, scoped, write };
});

it.live(
  'creates one scoped demo newsletter choice through the runtime routines',
  Effect.fn('DemoNewsletterChoice.postgres')(function* choicePostgres() {
    const connections = yield* loadDatabaseConnectionPair({ envPath: '/dev/null' });
    const admin = yield* makeTestPgClient(connections.admin.connectionString);
    const runtime = yield* makeTestPgClient(connections.runtime.connectionString);
    const cleanup = admin`delete from commerce_customer_context.demo_newsletter_choices where tenant_id = ${tenantId}::uuid`;
    // Read first so the baseline fails at the real missing routine, not a cleanup/table query.
    const initial = yield* runtime.withTransaction(
      Effect.gen(function* readInitial() {
        yield* runtime`select set_config('ontos.tenant_id', ${tenantId}, true), set_config('ontos.legal_entity_id', ${legalEntityId}, true)`;
        return yield* runtime<{ choice: Choice }>`
          select * from commerce_customer_context.read_demo_newsletter_choice(${tenantId}::uuid, ${legalEntityId}::uuid, ${partyId}::uuid)`;
      }),
    );
    expect(initial).toEqual([]);
    yield* cleanup;
    yield* Effect.addFinalizer(() => cleanup.pipe(Effect.orDie));
    const rows = yield* runtime.withTransaction(
      Effect.gen(function* writeInitial() {
        yield* runtime`select set_config('ontos.tenant_id', ${tenantId}, true), set_config('ontos.legal_entity_id', ${legalEntityId}, true)`;
        return yield* runtime<{ choice: Choice }>`
          select * from commerce_customer_context.write_demo_newsletter_choice(
            ${tenantId}::uuid, ${legalEntityId}::uuid, ${partyId}::uuid, 0::integer,
            'GRANTED'::text, ${noticeVersionId}::text, ${requestId}::uuid)`;
      }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.choice).toEqual({
      changedAt: expect.any(String),
      decision: 'GRANTED',
      noticeVersionId,
      requestId,
      revision: 1,
    });
  }),
);

it.live(
  'keeps the latest unchanged replay and rejects changed payloads and stale grants after withdrawal',
  Effect.fn('DemoNewsletterChoice.replayPostgres')(function* replayPostgres() {
    const { read, scoped, write } = yield* fixture('d3000000-0000-4000-8000-000000000010');
    const created = yield* scoped(write());
    expect(yield* scoped(write())).toEqual(created);
    for (const input of [
      { ...grant, decision: 'WITHDRAWN' },
      { ...grant, noticeVersionId: 'other-notice' },
      { ...grant, expectedRevision: 1 },
      { ...grant, requestId: anotherRequestId },
    ] satisfies WriteInput[]) {
      expect(yield* scoped(write(input))).toEqual([]);
      expect(yield* scoped(read())).toEqual(created);
    }
    const withdrawn = yield* scoped(write(withdrawal));
    expect(withdrawn[0]?.choice).toEqual({
      changedAt: expect.any(String),
      decision: 'WITHDRAWN',
      noticeVersionId,
      requestId: withdrawalRequestId,
      revision: 2,
    });
    expect(yield* scoped(write(withdrawal))).toEqual(withdrawn);
    expect(yield* scoped(write())).toEqual([]);
    expect(yield* scoped(write({ ...grant, expectedRevision: 1, requestId: anotherRequestId }))).toEqual([]);
    expect(yield* scoped(read())).toEqual(withdrawn);
  }),
);

it.live(
  'isolates tenant, legal entity and Party and refuses mismatched or absent transaction scope',
  Effect.fn('DemoNewsletterChoice.isolationPostgres')(function* isolationPostgres() {
    const {
      admin,
      read,
      runtime,
      scope: ownScope,
      scoped,
      write,
    } = yield* fixture('d3000000-0000-4000-8000-000000000011');
    const retained = yield* scoped(write());
    for (const target of [
      { ...ownScope, tenantId: 'd1000000-0000-4000-8000-000000000007' },
      { ...ownScope, legalEntityId: 'd2000000-0000-4000-8000-000000000008' },
      { ...ownScope, partyId: 'd3000000-0000-4000-8000-000000000009' },
    ]) {
      const cleanup = admin`delete from commerce_customer_context.demo_newsletter_choices
        where tenant_id = ${target.tenantId}::uuid and legal_entity_id = ${target.legalEntityId}::uuid
          and party_id = ${target.partyId}::uuid`;
      yield* cleanup;
      yield* Effect.addFinalizer(() => cleanup.pipe(Effect.orDie));
      expect(yield* scoped(read(target), target)).toEqual([]);
      // Identical request IDs in other scopes are independent choices, not global idempotency keys.
      const independent = yield* scoped(write(grant, target), target);
      expect(independent[0]?.choice.revision).toBe(1);
      expect(yield* scoped(read())).toEqual(retained);
    }
    for (const query of [
      read({ ...ownScope, tenantId: 'd1000000-0000-4000-8000-000000000007' }),
      read({ ...ownScope, legalEntityId: 'd2000000-0000-4000-8000-000000000008' }),
      write(grant, { ...ownScope, tenantId: 'd1000000-0000-4000-8000-000000000007' }),
      write(grant, { ...ownScope, legalEntityId: 'd2000000-0000-4000-8000-000000000008' }),
      runtime`select * from commerce_customer_context.demo_newsletter_choices`,
      runtime`insert into commerce_customer_context.demo_newsletter_choices(tenant_id, legal_entity_id, party_id,
        decision, revision, notice_version, last_request_id) values
        (${tenantId}::uuid, ${legalEntityId}::uuid, ${ownScope.partyId}::uuid, 'GRANTED', 1, ${noticeVersionId}, ${requestId}::uuid)`,
      runtime`update commerce_customer_context.demo_newsletter_choices set decision = 'GRANTED'`,
      runtime`delete from commerce_customer_context.demo_newsletter_choices`,
    ]) {
      const rejected = yield* scoped(query).pipe(Effect.result);
      expect(Result.isFailure(rejected)).toBe(true);
      if (Result.isFailure(rejected)) {
        expect(Option.getOrUndefined(findPostgresFailure(rejected.failure))?.code).toBe('42501');
      }
    }
    for (const query of [read(), write()]) {
      const rejected = yield* query.pipe(Effect.result);
      expect(Result.isFailure(rejected)).toBe(true);
      if (Result.isFailure(rejected)) {
        expect(Option.getOrUndefined(findPostgresFailure(rejected.failure))?.code).toBe('42501');
      }
    }
    const security = yield* admin<{ relforcerowsecurity: boolean; relrowsecurity: boolean }>`
      select relrowsecurity, relforcerowsecurity from pg_catalog.pg_class
        where oid = 'commerce_customer_context.demo_newsletter_choices'::regclass`;
    expect(security).toEqual([{ relforcerowsecurity: true, relrowsecurity: true }]);
    const routines = yield* admin<{ private: boolean; safe: boolean }>`
      select not exists (
        select 1 from pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) acl
          where acl.grantee = 0 and acl.privilege_type = 'EXECUTE'
      ) as private, p.prosecdef and
        'search_path=pg_catalog, commerce_customer_context, pg_temp' = any(p.proconfig) as safe
      from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'commerce_customer_context'
        and p.proname in ('read_demo_newsletter_choice', 'write_demo_newsletter_choice')`;
    expect(routines).toEqual([
      { private: true, safe: true },
      { private: true, safe: true },
    ]);
  }),
);

it.live(
  'allows only one competing first write and one competing update at each expected revision',
  Effect.fn('DemoNewsletterChoice.concurrentPostgres')(function* concurrentPostgres() {
    const { admin, read, scope: ownScope, scoped, write } = yield* fixture('d3000000-0000-4000-8000-000000000012');
    const firstWrites = yield* Effect.all(
      [scoped(write()), scoped(write({ ...grant, decision: 'WITHDRAWN', requestId: anotherRequestId }))],
      { concurrency: 'unbounded' },
    );
    expect(
      EffectArray.sort(
        firstWrites.map((rows) => rows.length),
        Order.Number,
      ),
    ).toEqual([0, 1]);
    expect((yield* scoped(read()))[0]?.choice.revision).toBe(1);
    const updates = yield* Effect.all(
      [
        scoped(write({ ...withdrawal, requestId: withdrawalRequestId })),
        scoped(write({ ...grant, expectedRevision: 1, requestId: 'd4000000-0000-4000-8000-000000000013' })),
      ],
      { concurrency: 'unbounded' },
    );
    expect(
      EffectArray.sort(
        updates.map((rows) => rows.length),
        Order.Number,
      ),
    ).toEqual([0, 1]);
    expect((yield* scoped(read()))[0]?.choice.revision).toBe(2);
    const count = yield* admin<{ count: number }>`
      select count(*)::integer as count from commerce_customer_context.demo_newsletter_choices
        where tenant_id = ${tenantId}::uuid and legal_entity_id = ${legalEntityId}::uuid
          and party_id = ${ownScope.partyId}::uuid`;
    expect(count).toEqual([{ count: 1 }]);
  }),
);

it.live(
  'round-trips server timestamps and conflicts through the production owner runner and choice adapter',
  Effect.fn('DemoNewsletterChoice.adapterPostgres')(function* adapterPostgres() {
    const { connections, scope: ownScope } = yield* fixture('d3000000-0000-4000-8000-000000000014');
    const database = yield* makeCoreDatabase(connections.runtime);
    const productionRunner = CommerceEnrollmentOwnerTransactionRunnerLive.pipe(
      Layer.provide(ActionAuthorizationPreflightDatabaseLive),
      Layer.provide(Layer.succeed(CoreDatabase, database)),
    );
    yield* Effect.gen(function* roundTripChoice() {
      expect(Option.isNone(yield* readDemoNewsletterChoice(ownScope))).toBe(true);
      const input = yield* Schema.decodeUnknownEffect(UpdateCustomerOwnConsentSchema)({
        ...grant,
        noticeAcknowledged: true,
      });
      const retained = yield* writeDemoNewsletterChoice(ownScope, input);
      expect(retained.revision).toBe(1);
      expect(DateTime.formatIso(retained.changedAt)).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/u);
      expect(yield* writeDemoNewsletterChoice(ownScope, input)).toEqual(retained);
      expect(Option.getOrThrow(yield* readDemoNewsletterChoice(ownScope))).toEqual(retained);
      const conflict = yield* Effect.flip(
        writeDemoNewsletterChoice(ownScope, {
          ...input,
          decision: 'WITHDRAWN',
        }),
      );
      expect(Schema.is(ConsentConflictProblemSchema)(conflict)).toBe(true);
      const withdrawn = yield* Schema.decodeUnknownEffect(UpdateCustomerOwnConsentSchema)({
        ...withdrawal,
        noticeAcknowledged: false,
      });
      expect((yield* writeDemoNewsletterChoice(ownScope, withdrawn)).decision).toBe('WITHDRAWN');
      expect((yield* writeDemoNewsletterChoice(ownScope, withdrawn)).revision).toBe(2);
      const stale = yield* Effect.flip(writeDemoNewsletterChoice(ownScope, input));
      expect(Schema.is(ConsentConflictProblemSchema)(stale)).toBe(true);
    }).pipe(Effect.provide(productionRunner));
  }),
);
