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
      source text not null,
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
  `alter table demo_email.deliveries add column if not exists event_label text`,
  `alter table demo_email.deliveries drop constraint if exists deliveries_source_check`,
  `alter table demo_email.deliveries add constraint deliveries_source_check check (source in ('akros-order', 'facility-agenda', 'rent-reminder'))`,
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

/** A RETRY row older than this is given up: FAILED („Odeslání selhalo“), never left waiting forever. */
export const RETRY_WINDOW_HOURS = 24;

/**
 * Returns true only when THIS call owns the send (fresh claim, or a due RETRY re-claimed).
 * RETRY backs off 10 s, 20 s, 40 s, then every 60 s, so an SMTP outage of any length heals by itself once the
 * server is back; after RETRY_WINDOW_HOURS the row becomes FAILED instead.
 */
export const claim = (planned: PlannedEmail) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const inserted = yield* sql<{ readonly dedupe_key: string }>`
      insert into demo_email.deliveries (dedupe_key, source, event, event_label, tenant_id, legal_entity_id, subject_id, subject_number, recipient, email_subject, status, attempts, event_at)
      values (${planned.dedupeKey}, ${planned.source}, ${planned.event}, ${planned.eventLabel}, ${planned.tenantId}::uuid, ${planned.legalEntityId}::uuid, ${planned.subjectId}, ${planned.subjectNumber}, ${planned.recipient}, ${planned.subject}, 'SENDING', 1, ${planned.eventAt}::timestamptz)
      on conflict (dedupe_key) do nothing
      returning dedupe_key`;
    if (inserted.length === 1) {
      return true;
    }
    yield* sql`
      update demo_email.deliveries set status = 'FAILED', error_tag = 'retry_window_expired', updated_at = now()
      where dedupe_key = ${planned.dedupeKey} and status = 'RETRY'
        and created_at < now() - make_interval(hours => ${RETRY_WINDOW_HOURS})`;
    const retried = yield* sql<{ readonly dedupe_key: string }>`
      update demo_email.deliveries set status = 'SENDING', attempts = attempts + 1, updated_at = now()
      where dedupe_key = ${planned.dedupeKey} and status = 'RETRY'
        and updated_at < now() - make_interval(secs => least(60, 10 * power(2, least(attempts - 1, 3))))
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

/**
 * Who may read receipts: staff of one company (verified OntOS session → tenant + selected legal entity), or the
 * buyer of one order (order number + the e-mail address the order was placed with).
 */
export type DeliveryReadScope =
  | { readonly kind: 'company'; readonly legalEntityId: string; readonly principalId: string; readonly tenantId: string }
  | { readonly kind: 'buyer'; readonly recipient: string };

/** Public receipts only: never selects the e-mail address or the message body. */
export const listDeliveries = (query: {
  readonly scope: DeliveryReadScope;
  readonly source: EmailDeliverySource;
  readonly subjectIds: readonly string[];
  readonly subjectNumbers: readonly string[];
}) =>
  Effect.gen(function* () {
    if (query.subjectIds.length === 0 && query.subjectNumbers.length === 0) {
      return [] as readonly EmailDeliveryView[];
    }
    const sql = yield* PgClient.PgClient;
    const tenantId = query.scope.kind === 'company' ? query.scope.tenantId : null;
    const legalEntityId = query.scope.kind === 'company' ? query.scope.legalEntityId : null;
    const recipient = query.scope.kind === 'buyer' ? query.scope.recipient.trim().toLowerCase() : null;
    // Unused lists become a value no subject id/number can have, so each query keeps one static shape.
    const ids = query.subjectIds.length > 0 ? query.subjectIds : [''];
    const numbers = query.subjectNumbers.length > 0 ? query.subjectNumbers : [''];
    const rows = yield* sql<EmailDeliveryView>`
      select source, event, event_label as "eventLabel", status, subject_id as "subjectId", subject_number as "subjectNumber",
        to_char(event_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "eventAt",
        to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "createdAt",
        case when sent_at is null then null else to_char(sent_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') end as "sentAt"
      from demo_email.deliveries
      where source = ${query.source}
        and (subject_id in ${sql.in(ids)} or subject_number in ${sql.in(numbers)})
        and (${tenantId}::uuid is null or tenant_id = ${tenantId}::uuid)
        and (${legalEntityId}::uuid is null or legal_entity_id = ${legalEntityId}::uuid)
        and (${recipient}::text is null or lower(recipient) = ${recipient}::text)
        and (${tenantId}::uuid is not null or ${recipient}::text is not null)`;
    const merged = new Map<string, EmailDeliveryView>();
    for (const row of rows) {
      merged.set(`${row.subjectId}:${row.event}`, row);
    }
    return [...merged.values()].sort((a, b) => Date.parse(a.eventAt) - Date.parse(b.eventAt)) as readonly EmailDeliveryView[];
  });
