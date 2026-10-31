// Real PostgreSQL, real migrations, runtime role under FORCE RLS. Needs DATABASE_ADMIN_URL (superuser) and
// DATABASE_URL (ontos_runtime) of any cluster: the test creates its own throwaway database and drops it afterwards.
import { NodeCrypto, NodeFileSystem, NodePath } from '@effect/platform-node';
import { expect, it } from 'effect-rstest';
import { PgClient } from '@effect/sql-pg';
import { Config, ConfigProvider, Context, Crypto, Effect, FileSystem, Layer, Path, Redacted, Schema } from 'effect';
import { Reactivity } from 'effect/reactivity';
import type { EmailTransportRuntime } from '../../src/transport-runtime.ts';
import { EmailDeliveryService } from '../../src/server.ts';
import { RentReminderInputSchema } from '../../src/dispatcher/contract.ts';
import { dispatchEmailBatchWith } from '../../src/dispatcher/dispatch.ts';
import { listDeliveries } from '../../src/dispatcher/ledger.ts';
import { inDeliveryScope } from '../../src/dispatcher/scope.ts';
import type { DeliveryScope } from '../../src/dispatcher/scope.ts';
import { readRentReminders } from '../../src/dispatcher/sources.ts';

const withDatabase = (url: string, name: string) => {
  const parsed = new URL(url);
  parsed.pathname = `/${name}`;
  return parsed.toString();
};
const migration = Effect.fn('EmailDeliveryTest.migration')(function* readMigration(name: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const migrationPath = yield* path.fromFileUrl(
    new URL(`../../../core-runtime/drizzle/${name}/migration.sql`, import.meta.url),
  );
  const content = yield* fileSystem.readFileString(migrationPath);
  return content.split('--> statement-breakpoint').filter((statement) => statement.trim() !== '');
});

const SeedFinanceStateJsonSchema = Schema.fromJsonString(
  Schema.Struct({
    invoices: Schema.Array(Schema.Never),
    reminders: Schema.Array(Schema.toEncoded(RentReminderInputSchema.fields.reminder)),
  }),
);

const reminder = (id: string, recipient: string, text: string) => ({
  createdAt: '2026-10-22T06:00:00.000Z',
  deliveryMode: 'EMAIL',
  id,
  invoiceResourceId: `invoice-${id}`,
  recipient,
  text,
});

class DeliveryTestFixture extends Context.Service<
  DeliveryTestFixture,
  {
    readonly admin: PgClient.PgClient;
    readonly scopeA1: DeliveryScope;
    readonly scopeA2: DeliveryScope;
    readonly scopeB: DeliveryScope;
  }
>()('@app/email-delivery/tests/integration/tenant-scoped-dispatch.test/DeliveryTestFixture') {}

const sent: { readonly recipient: string; readonly subject: string; readonly text: string }[] = [];
const transport: EmailTransportRuntime = {
  deliveryLayer: (_from, recipient) =>
    Layer.succeed(EmailDeliveryService, {
      send: (message) =>
        Effect.sync(() => {
          sent.push({ recipient, subject: message.subject, text: Redacted.value(message.text) });
          return { accepted: true as const, id: `message-${sent.length}` };
        }),
    }),
  kind: 'smtp',
  provider: { configured: true, label: 'recording transport' },
};

const DeliveryTestLive = Layer.effectContext(
  Effect.gen(function* makeDeliveryFixture() {
    const crypto = yield* Crypto.Crypto;
    const database = `email_dispatch_${(yield* crypto.randomUUIDv4()).replaceAll('-', '')}`;
    const tenantA = yield* crypto.randomUUIDv4();
    const tenantB = yield* crypto.randomUUIDv4();
    const entityA1 = yield* crypto.randomUUIDv4();
    const entityA2 = yield* crypto.randomUUIDv4();
    const entityB = yield* crypto.randomUUIDv4();
    const scopeA1 = { legalEntityId: entityA1, tenantId: tenantA };
    const scopeA2 = { legalEntityId: entityA2, tenantId: tenantA };
    const scopeB = { legalEntityId: entityB, tenantId: tenantB };
    const adminUrl = yield* Config.Redacted('DATABASE_ADMIN_URL');
    const runtimeUrl = yield* Config.Redacted('DATABASE_URL');
    const server = yield* PgClient.makeClient({ url: adminUrl });
    // Register cleanup immediately after CREATE succeeds, including failed setup paths.
    yield* Effect.acquireRelease(server.unsafe(`create database ${database}`), () =>
      server.unsafe(`drop database if exists ${database} with (force)`).pipe(Effect.orDie),
    );
    yield* server.unsafe(`grant connect on database ${database} to ontos_runtime`);
    const admin = yield* PgClient.makeClient({ url: Redacted.make(withDatabase(Redacted.value(adminUrl), database)) });
    const initialMigration = yield* migration('20261021222824_email-delivery');
    const tenantMigration = yield* migration('20261022052927_email-delivery-tenant-scope');
    // Minimal owner tables with the same RLS shape as finance-billing's migration.
    yield* Effect.forEach(
      [
        'create schema core',
        'create table core.legal_entities (tenant_id uuid not null, legal_entity_id uuid not null, legal_name text, primary key (tenant_id, legal_entity_id))',
        'create schema finance_billing',
        'create table finance_billing.finance_states (tenant_id uuid not null, legal_entity_id uuid not null, state jsonb not null, primary key (tenant_id, legal_entity_id))',
        'alter table finance_billing.finance_states enable row level security',
        'alter table finance_billing.finance_states force row level security',
        `create policy finance_billing_scope_select on finance_billing.finance_states for select to ontos_runtime
       using (tenant_id = nullif(current_setting('ontos.tenant_id', true), '')::uuid
         and legal_entity_id = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid)`,
        'grant usage on schema core, finance_billing to ontos_runtime',
        'grant select on all tables in schema core, finance_billing to ontos_runtime',
        ...initialMigration,
        ...tenantMigration,
        "update demo_email.settings set value = '2026-10-22T00:00:00.000Z' where key = 'enabled_since'",
      ],
      (statement) => admin.unsafe(statement),
      { discard: true },
    );
    yield* Effect.forEach(
      [
        [
          tenantA,
          entityA1,
          'Firma A1 s.r.o.',
          [reminder('a1', 'jana@firma-a.cz', 'A1-only text'), reminder('a1-seeded', 'ucetni@demo.ontos', 'A1 seeded')],
        ],
        [tenantA, entityA2, 'Firma A2 s.r.o.', [reminder('a2', 'eva@firma-a2.cz', 'A2-only text')]],
        [tenantB, entityB, 'Firma B a.s.', [reminder('b', 'petr@firma-b.cz', 'B-only text')]],
      ] as const,
      ([tenant, entity, name, reminders]) =>
        Effect.gen(function* seedCompany() {
          yield* admin.unsafe('insert into core.legal_entities values ($1, $2, $3)', [tenant, entity, name]);
          yield* admin.unsafe('insert into finance_billing.finance_states values ($1, $2, $3::jsonb)', [
            tenant,
            entity,
            yield* Schema.encodeEffect(SeedFinanceStateJsonSchema)({ invoices: [], reminders }),
          ]);
        }),
      { discard: true },
    );
    const runtime = yield* PgClient.makeClient({
      url: Redacted.make(withDatabase(Redacted.value(runtimeUrl), database)),
    });
    return Context.make(PgClient.PgClient, runtime).pipe(
      Context.add(DeliveryTestFixture, { admin, scopeA1, scopeA2, scopeB }),
    );
  }),
).pipe(
  Layer.provide(Reactivity.layer),
  Layer.provideMerge(Layer.mergeAll(NodeCrypto.layer, NodeFileSystem.layer, NodePath.layer)),
  Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv())),
);

it.layer(DeliveryTestLive, { excludeTestServices: true })('per-tenant dispatch under RLS', (test) => {
  test.effect('the runtime role sees no tenant rows without a scope', () =>
    Effect.gen(function* verifyTenantDispatch() {
      const sql = yield* PgClient.PgClient;
      const counts = yield* sql<{ readonly deliveries: number; readonly states: number }>`
        select (select count(*)::int from finance_billing.finance_states) as states,
          (select count(*)::int from demo_email.deliveries) as deliveries`;
      expect(counts).toEqual([{ deliveries: 0, states: 0 }]);
    }),
  );

  test.effect('the cross-tenant listing returns ids and scopes only', () =>
    Effect.gen(function* verifyTenantDispatch() {
      const sql = yield* PgClient.PgClient;
      const crypto = yield* Crypto.Crypto;
      const workerTenantId = yield* crypto.randomUUIDv4();
      const workerEntityId = yield* crypto.randomUUIDv4();
      const rows = yield* sql<{
        readonly delivery_id: string;
        readonly legal_entity_id: string;
        readonly tenant_id: string;
      }>`select * from demo_email.pending_deliveries(10, ${workerTenantId}::uuid, ${workerEntityId}::uuid)`;
      expect(rows.map((row) => Object.keys(row).toSorted((left, right) => left.localeCompare(right)))).toEqual(
        Array.from({ length: 4 }, () => ['delivery_id', 'legal_entity_id', 'tenant_id']),
      );
      expect(rows.map((row) => row.delivery_id).toSorted((left, right) => left.localeCompare(right))).toEqual([
        'rent-reminder:a1',
        'rent-reminder:a1-seeded',
        'rent-reminder:a2',
        'rent-reminder:b',
      ]);
    }),
  );

  test.effect("rows of tenant A are never read in tenant B's context, nor across legal entities", () =>
    Effect.gen(function* verifyTenantDispatch() {
      const { scopeA1, scopeA2, scopeB } = yield* DeliveryTestFixture;
      const ids = ['a1', 'a2', 'b'];
      // Even when B's context asks for A's ids with A's own predicates, RLS returns nothing of A.
      expect(yield* inDeliveryScope(scopeB, readRentReminders(scopeA1, ids))).toEqual([]);
      expect(yield* inDeliveryScope(scopeA2, readRentReminders(scopeA1, ids))).toEqual([]);
      const inB = yield* inDeliveryScope(scopeB, readRentReminders(scopeB, ids));
      expect(inB.map((row) => [row.tenantId, row.reminder.id])).toEqual([[scopeB.tenantId, 'b']]);
    }),
  );

  test.effect('each scope sends its own content, seeded addresses are SKIPPED, and nothing is sent twice', () =>
    Effect.gen(function* verifyTenantDispatch() {
      const { admin, scopeA1, scopeA2, scopeB } = yield* DeliveryTestFixture;
      const result = yield* dispatchEmailBatchWith(transport, {});
      expect(result).toEqual({ configured: true, processed: 4, skipped: 1 });
      expect(sent.map((email) => email.recipient).toSorted((left, right) => left.localeCompare(right))).toEqual([
        'eva@firma-a2.cz',
        'jana@firma-a.cz',
        'petr@firma-b.cz',
      ]);
      for (const [recipient, own] of [
        ['jana@firma-a.cz', 'A1-only text'],
        ['eva@firma-a2.cz', 'A2-only text'],
        ['petr@firma-b.cz', 'B-only text'],
      ] as const) {
        const email = sent.find((candidate) => candidate.recipient === recipient);
        expect(email?.text.startsWith(own)).toBe(true);
        expect(['A1-only', 'A2-only', 'B-only'].filter((marker) => email?.text.includes(marker) === true)).toHaveLength(
          1,
        );
      }
      const ledger = yield* admin.unsafe<{
        dedupe_key: string;
        legal_entity_id: string;
        status: string;
        tenant_id: string;
      }>(
        'select dedupe_key, tenant_id::text, legal_entity_id::text, status from demo_email.deliveries order by dedupe_key',
      );
      expect(ledger).toEqual([
        {
          dedupe_key: 'rent-reminder:a1',
          legal_entity_id: scopeA1.legalEntityId,
          status: 'SENT',
          tenant_id: scopeA1.tenantId,
        },
        {
          dedupe_key: 'rent-reminder:a1-seeded',
          legal_entity_id: scopeA1.legalEntityId,
          status: 'SKIPPED',
          tenant_id: scopeA1.tenantId,
        },
        {
          dedupe_key: 'rent-reminder:a2',
          legal_entity_id: scopeA2.legalEntityId,
          status: 'SENT',
          tenant_id: scopeA1.tenantId,
        },
        {
          dedupe_key: 'rent-reminder:b',
          legal_entity_id: scopeB.legalEntityId,
          status: 'SENT',
          tenant_id: scopeB.tenantId,
        },
      ]);
      expect(yield* dispatchEmailBatchWith(transport, {})).toEqual({
        configured: true,
        processed: 0,
        skipped: 0,
      });
      expect(sent).toHaveLength(3);
    }),
  );

  test.effect("company receipts show only the company's own ledger rows", () =>
    Effect.gen(function* verifyTenantDispatch() {
      const { scopeB } = yield* DeliveryTestFixture;
      const crypto = yield* Crypto.Crypto;
      const principalId = yield* crypto.randomUUIDv4();
      const receipts = yield* listDeliveries({
        scope: { kind: 'company', principalId, ...scopeB },
        source: 'rent-reminder',
        subjectIds: ['a1', 'a2', 'b'],
        subjectNumbers: [],
      });
      expect(receipts.map((receipt) => [receipt.subjectId, receipt.status])).toEqual([['b', 'SENT']]);
    }),
  );
});
