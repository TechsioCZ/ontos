// @effect-diagnostics *:off
// Real PostgreSQL, real migrations, runtime role under FORCE RLS. Needs DATABASE_ADMIN_URL (superuser) and
// DATABASE_URL (ontos_runtime) of any cluster: the test creates its own throwaway database and drops it afterwards.
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from '@rstest/core';
import { PgClient } from '@effect/sql-pg';
import { Effect, Exit, Layer, ManagedRuntime, Redacted, Scope } from 'effect';
import { Reactivity } from 'effect/unstable/reactivity';
import type { EmailTransportRuntime } from '../../src/transport-runtime.ts';
import { dispatchEmailBatchWith } from '../../src/dispatcher/dispatch.ts';
import { listDeliveries } from '../../src/dispatcher/ledger.ts';
import { inDeliveryScope } from '../../src/dispatcher/scope.ts';
import { readRentReminders } from '../../src/dispatcher/sources.ts';

const adminUrl = process.env['DATABASE_ADMIN_URL'];
const runtimeUrl = process.env['DATABASE_URL'];
if (adminUrl === undefined || runtimeUrl === undefined) {
  throw new Error('DATABASE_ADMIN_URL (superuser) and DATABASE_URL (ontos_runtime) are required');
}
const database = `email_dispatch_${randomUUID().replaceAll('-', '')}`;
const withDatabase = (url: string, name: string) => {
  const parsed = new URL(url);
  parsed.pathname = `/${name}`;
  return parsed.toString();
};
const migration = (name: string) =>
  readFileSync(new URL(`../../../core-runtime/drizzle/${name}/migration.sql`, import.meta.url), 'utf8')
    .split('--> statement-breakpoint')
    .filter((statement) => statement.trim() !== '');

const tenantA = randomUUID();
const tenantB = randomUUID();
const entityA1 = randomUUID();
const entityA2 = randomUUID();
const entityB = randomUUID();
const scopeA1 = { legalEntityId: entityA1, tenantId: tenantA };
const scopeA2 = { legalEntityId: entityA2, tenantId: tenantA };
const scopeB = { legalEntityId: entityB, tenantId: tenantB };
const reminder = (id: string, recipient: string, text: string) => ({
  createdAt: '2026-10-22T06:00:00.000Z',
  deliveryMode: 'EMAIL',
  id,
  invoiceResourceId: `invoice-${id}`,
  recipient,
  text,
});

const scope = Effect.runSync(Scope.make());
const client = (url: string) =>
  Effect.runPromise(
    PgClient.makeClient({ url: Redacted.make(url) }).pipe(Effect.provide(Reactivity.layer), Scope.provide(scope)),
  );
let admin: PgClient.PgClient;
let runtime: ManagedRuntime.ManagedRuntime<PgClient.PgClient, never>;
const asRuntime = <A, E>(effect: Effect.Effect<A, E, PgClient.PgClient>) => runtime.runPromise(effect);
const asAdmin = <A extends object>(text: string, values: readonly unknown[] = []) =>
  Effect.runPromise(admin.unsafe<A>(text, values as never));

const sent: { readonly recipient: string; readonly subject: string; readonly text: string }[] = [];
const transport: EmailTransportRuntime = {
  kind: 'smtp',
  provider: { configured: true, label: 'recording transport' },
  makeDelivery: (_from, recipient) => ({
    send: (message) =>
      Effect.sync(() => {
        sent.push({ recipient, subject: message.subject, text: Redacted.value(message.text) });
        return { accepted: true as const, id: `message-${sent.length}` };
      }),
  }),
};

beforeAll(async () => {
  const server = await client(adminUrl);
  await Effect.runPromise(server.unsafe(`create database ${database}`));
  await Effect.runPromise(server.unsafe(`grant connect on database ${database} to ontos_runtime`));
  admin = await client(withDatabase(adminUrl, database));
  // Minimal owner tables with the same RLS shape as finance-billing's migration.
  for (const statement of [
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
    ...migration('20261021222824_email-delivery'),
    ...migration('20261022052927_email-delivery-tenant-scope'),
    "update demo_email.settings set value = '2026-10-22T00:00:00.000Z' where key = 'enabled_since'",
  ])
    await asAdmin(statement);
  for (const [tenant, entity, name, reminders] of [
    [
      tenantA,
      entityA1,
      'Firma A1 s.r.o.',
      [reminder('a1', 'jana@firma-a.cz', 'A1-only text'), reminder('a1-seeded', 'ucetni@demo.ontos', 'A1 seeded')],
    ],
    [tenantA, entityA2, 'Firma A2 s.r.o.', [reminder('a2', 'eva@firma-a2.cz', 'A2-only text')]],
    [tenantB, entityB, 'Firma B a.s.', [reminder('b', 'petr@firma-b.cz', 'B-only text')]],
  ] as const) {
    await asAdmin('insert into core.legal_entities values ($1, $2, $3)', [tenant, entity, name]);
    await asAdmin('insert into finance_billing.finance_states values ($1, $2, $3::jsonb)', [
      tenant,
      entity,
      JSON.stringify({ invoices: [], reminders }),
    ]);
  }
  const runtimeClient = await client(withDatabase(runtimeUrl, database));
  runtime = ManagedRuntime.make(Layer.succeed(PgClient.PgClient, runtimeClient));
});

afterAll(async () => {
  await runtime?.dispose();
  await Effect.runPromise(Scope.close(scope, Exit.void));
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const cleanup = yield* PgClient.makeClient({ url: Redacted.make(adminUrl) });
        yield* cleanup.unsafe(`drop database if exists ${database} with (force)`);
      }).pipe(Effect.provide(Reactivity.layer)),
    ),
  );
});

describe('per-tenant dispatch under RLS', () => {
  test('the runtime role sees no tenant rows without a scope', async () => {
    const counts = await asRuntime(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        return yield* sql<{ readonly states: number; readonly deliveries: number }>`
          select (select count(*)::int from finance_billing.finance_states) as states,
            (select count(*)::int from demo_email.deliveries) as deliveries`;
      }),
    );
    expect(counts).toEqual([{ deliveries: 0, states: 0 }]);
  });

  test('the cross-tenant listing returns ids and scopes only', async () => {
    const rows = await asRuntime(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        return yield* sql<
          Record<string, string>
        >`select * from demo_email.pending_deliveries(10, ${randomUUID()}::uuid, ${randomUUID()}::uuid)`;
      }),
    );
    expect(rows.map((row) => Object.keys(row).sort())).toEqual(
      Array(4).fill(['delivery_id', 'legal_entity_id', 'tenant_id']),
    );
    expect(rows.map((row) => row['delivery_id']).sort()).toEqual([
      'rent-reminder:a1',
      'rent-reminder:a1-seeded',
      'rent-reminder:a2',
      'rent-reminder:b',
    ]);
  });

  test("rows of tenant A are never read in tenant B's context, nor across legal entities", async () => {
    const ids = ['a1', 'a2', 'b'];
    // Even when B's context asks for A's ids with A's own predicates, RLS returns nothing of A.
    expect(await asRuntime(inDeliveryScope(scopeB, readRentReminders(scopeA1, ids)))).toEqual([]);
    expect(await asRuntime(inDeliveryScope(scopeA2, readRentReminders(scopeA1, ids)))).toEqual([]);
    const inB = await asRuntime(inDeliveryScope(scopeB, readRentReminders(scopeB, ids)));
    expect(inB.map((row) => [row.tenantId, row.reminder.id])).toEqual([[tenantB, 'b']]);
  });

  test('each scope sends its own content, seeded addresses are SKIPPED, and nothing is sent twice', async () => {
    const result = await asRuntime(dispatchEmailBatchWith(transport, {}));
    expect(result).toEqual({ configured: true, processed: 4, skipped: 1 });
    expect(sent.map((email) => email.recipient).sort()).toEqual([
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
      expect(['A1-only', 'A2-only', 'B-only'].filter((marker) => email?.text.includes(marker))).toHaveLength(1);
    }
    const ledger = await asAdmin<{ dedupe_key: string; legal_entity_id: string; status: string; tenant_id: string }>(
      'select dedupe_key, tenant_id::text, legal_entity_id::text, status from demo_email.deliveries order by dedupe_key',
    );
    expect(ledger).toEqual([
      { dedupe_key: 'rent-reminder:a1', legal_entity_id: entityA1, status: 'SENT', tenant_id: tenantA },
      { dedupe_key: 'rent-reminder:a1-seeded', legal_entity_id: entityA1, status: 'SKIPPED', tenant_id: tenantA },
      { dedupe_key: 'rent-reminder:a2', legal_entity_id: entityA2, status: 'SENT', tenant_id: tenantA },
      { dedupe_key: 'rent-reminder:b', legal_entity_id: entityB, status: 'SENT', tenant_id: tenantB },
    ]);
    expect(await asRuntime(dispatchEmailBatchWith(transport, {}))).toEqual({
      configured: true,
      processed: 0,
      skipped: 0,
    });
    expect(sent).toHaveLength(3);
  });

  test("company receipts show only the company's own ledger rows", async () => {
    const receipts = await asRuntime(
      listDeliveries({
        scope: { kind: 'company', principalId: randomUUID(), ...scopeB },
        source: 'rent-reminder',
        subjectIds: ['a1', 'a2', 'b'],
        subjectNumbers: [],
      }),
    );
    expect(receipts.map((receipt) => [receipt.subjectId, receipt.status])).toEqual([['b', 'SENT']]);
  });
});
