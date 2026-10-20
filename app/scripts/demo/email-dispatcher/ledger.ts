// @effect-diagnostics *:off
// Delivery ledger for the demo e-mail dispatcher: one row per e-mail (primary key = dedupe_key).
import { PgClient } from '@effect/sql-pg';
import { Effect } from 'effect';
import type { DeliveryOutcome, EmailDeliverySource, EmailDeliveryView, PlannedEmail } from './contract.ts';

const ISO = (column: string) => `to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

const DDL: readonly string[] = [
  `create schema if not exists demo_email`,
  `create table if not exists demo_email.deliveries (
      dedupe_key text primary key,
      source text not null check (source in ('akros-order', 'siampark-reminder')),
      event text not null,
      tenant_id uuid not null,
      legal_entity_id uuid not null,
      subject_id text not null,
      subject_number text not null default '',
      recipient text not null,
      email_subject text not null,
      status text not null check (status in ('SENDING', 'SENT', 'RETRY', 'FAILED', 'UNKNOWN')),
      attempts integer not null default 1,
      message_id text,
      error_tag text,
      event_at timestamptz not null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      sent_at timestamptz
    )`,
  `create index if not exists deliveries_subject_idx on demo_email.deliveries (source, subject_id)`,
  `create index if not exists deliveries_number_idx on demo_email.deliveries (source, subject_number)`,
  `create table if not exists demo_email.settings (key text primary key, value text not null)`,
  `insert into demo_email.settings (key, value) values ('enabled_since', ${ISO('now()')}) on conflict (key) do nothing`,
];

export const ensureLedger = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient;
  for (const statement of DDL) {
    yield* sql.unsafe(statement);
  }
});

export const readEnabledSince = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient;
  const rows = yield* sql<{ readonly value: string }>`select value from demo_email.settings where key = 'enabled_since'`;
  const value = rows[0]?.value;
  if (value === undefined) {
    return yield* Effect.die(new Error('demo_email.settings enabled_since is missing'));
  }
  return value;
});

/** A row left in SENDING by a crashed process may already have been sent: mark UNKNOWN, never resend. */
export const recoverInterrupted = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient;
  const rows = yield* sql<{ readonly dedupe_key: string }>`
    update demo_email.deliveries set status = 'UNKNOWN', error_tag = 'interrupted', updated_at = now()
    where status = 'SENDING' returning dedupe_key`;
  return rows.length;
});

export const listSettledKeys = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient;
  const rows = yield* sql<{ readonly dedupe_key: string }>`
    select dedupe_key from demo_email.deliveries where status in ('SENT', 'FAILED', 'UNKNOWN')`;
  return rows.map((row) => row.dedupe_key);
});

/** Returns true only when THIS call owns the send (fresh claim, or a due RETRY re-claimed). */
export const claim = (planned: PlannedEmail) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const inserted = yield* sql<{ readonly dedupe_key: string }>`
      insert into demo_email.deliveries (dedupe_key, source, event, tenant_id, legal_entity_id, subject_id, subject_number, recipient, email_subject, status, attempts, event_at)
      values (${planned.dedupeKey}, ${planned.source}, ${planned.event}, ${planned.tenantId}::uuid, ${planned.legalEntityId}::uuid, ${planned.subjectId}, ${planned.subjectNumber}, ${planned.recipient}, ${planned.subject}, 'SENDING', 1, ${planned.eventAt}::timestamptz)
      on conflict (dedupe_key) do nothing
      returning dedupe_key`;
    if (inserted.length === 1) {
      return true;
    }
    const retried = yield* sql<{ readonly dedupe_key: string }>`
      update demo_email.deliveries set status = 'SENDING', attempts = attempts + 1, updated_at = now()
      where dedupe_key = ${planned.dedupeKey} and status = 'RETRY' and attempts < 20 and updated_at < now() - interval '10 seconds'
      returning dedupe_key`;
    return retried.length === 1;
  });

export const finish = (dedupeKey: string, outcome: DeliveryOutcome) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const messageId = outcome.status === 'SENT' ? outcome.messageId : null;
    const errorTag = outcome.status === 'SENT' ? null : outcome.errorTag;
    yield* sql`
      update demo_email.deliveries set status = ${outcome.status}, message_id = ${messageId}, error_tag = ${errorTag},
        sent_at = case when ${outcome.status}::text = 'SENT' then now() else sent_at end, updated_at = now()
      where dedupe_key = ${dedupeKey} and status = 'SENDING'`;
  });

/** Public receipts only: never selects the e-mail address or the message body. */
export const listDeliveries = (query: {
  readonly source: EmailDeliverySource;
  readonly subjectIds: readonly string[];
  readonly subjectNumbers: readonly string[];
}) =>
  Effect.gen(function* () {
    if (query.subjectIds.length === 0 && query.subjectNumbers.length === 0) {
      return [] as readonly EmailDeliveryView[];
    }
    const sql = yield* PgClient.PgClient;
    let byId: readonly EmailDeliveryView[] = [];
    let byNumber: readonly EmailDeliveryView[] = [];
    if (query.subjectIds.length > 0) {
      byId = yield* sql<EmailDeliveryView>`
        select source, event, status, subject_id as "subjectId", subject_number as "subjectNumber",
          to_char(event_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "eventAt",
          to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "createdAt",
          case when sent_at is null then null else to_char(sent_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') end as "sentAt"
        from demo_email.deliveries
        where source = ${query.source} and subject_id in ${sql.in(query.subjectIds)}`;
    }
    if (query.subjectNumbers.length > 0) {
      byNumber = yield* sql<EmailDeliveryView>`
        select source, event, status, subject_id as "subjectId", subject_number as "subjectNumber",
          to_char(event_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "eventAt",
          to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "createdAt",
          case when sent_at is null then null else to_char(sent_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') end as "sentAt"
        from demo_email.deliveries
        where source = ${query.source} and subject_number in ${sql.in(query.subjectNumbers)}`;
    }
    const merged = new Map<string, EmailDeliveryView>();
    for (const row of [...byId, ...byNumber]) {
      merged.set(`${row.subjectId}:${row.event}`, row);
    }
    return [...merged.values()].sort((a, b) => Date.parse(a.eventAt) - Date.parse(b.eventAt)) as readonly EmailDeliveryView[];
  });
