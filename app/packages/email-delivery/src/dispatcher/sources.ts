// @effect-diagnostics *:off
// Bounded committed-state readers. Settled/in-flight keys are excluded in PostgreSQL, so old
// receipts cannot fill a page forever. RETRY is eligible only when its backoff has elapsed.
import { PgClient } from '@effect/sql-pg';
import { Effect } from 'effect';
import type {
  AgendaNotificationInput,
  AgendaPreferenceInput,
  AgendaRecipientInput,
  AkrosOrderInput,
  RentReminderInput,
} from './contract.ts';
import {
  AGENDA_MANDATORY_EMAIL_CATEGORIES,
  AGENDA_OPTIONAL_EMAIL_CATEGORIES,
  AKROS_LEGAL_ENTITY_ID,
  DEMO_TENANT_ID,
} from './contract.ts';

const json = <T>(value: unknown): T => (typeof value === 'string' ? JSON.parse(value) : value) as T;
const SOURCE_PAGE_SIZE = 10;

export const readAkrosOrders = (enabledSince: string) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const rows = yield* sql<{ readonly order: unknown }>`
      select o as "order" from demo_merchandise.merchandise_states s, jsonb_array_elements(coalesce(s.state->'orders', '[]'::jsonb)) o
      where s.tenant_id = ${DEMO_TENANT_ID}::uuid and s.legal_entity_id = ${AKROS_LEGAL_ENTITY_ID}::uuid
        and o->>'channel' = 'STOREFRONT' and (o->>'createdAt')::timestamptz >= ${enabledSince}::timestamptz
        and coalesce(trim(o->'contact'->>'email'), '') <> ''
        and exists (
          select 1 from (
            select event, at from (values ('ORDER_CREATED', o->>'createdAt'),
              (case when o->>'status' in ('CONFIRMED', 'SHIPPED', 'DELIVERED', 'CANCELLED') then o->>'status' end, o->>'updatedAt')) current_event(event, at)
            union all
            select case
              when h->>'after' like 'Zpracovává se%' or h->>'after' like 'Potvrzen%' then 'CONFIRMED'
              when h->>'after' like 'Předáno dopravci%' then 'SHIPPED'
              when h->>'after' like 'Dokončen%' then 'DELIVERED'
              when h->>'after' like 'Stornovan%' or h->>'after' like 'Zrušen%' then 'CANCELLED'
            end, h->>'at' from jsonb_array_elements(coalesce(o->'history', '[]'::jsonb)) h where h->>'kind' = 'STATUS'
          ) e where e.event is not null
            and (o->'demoCleanup'->>'at' is null or e.at::timestamptz < (o->'demoCleanup'->>'at')::timestamptz)
            and not exists (select 1 from demo_email.deliveries d
              where d.dedupe_key = 'akros-order:' || (o->>'id') || ':' || e.event
                and (d.status <> 'RETRY' or d.updated_at >= now() - make_interval(secs => least(60, 10 * power(2, least(d.attempts - 1, 3))))))
        )
      order by o->>'createdAt', o->>'id' limit ${SOURCE_PAGE_SIZE}`;
    return rows.map((row) => json<AkrosOrderInput>(row.order));
  });

export const readRentReminders = (enabledSince: string) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const rows = yield* sql<{
      readonly invoiceNumber: string | null;
      readonly legalEntityId: string;
      readonly legalName: string | null;
      readonly reminder: unknown;
      readonly tenantId: string;
    }>`
      select s.tenant_id::text as "tenantId", s.legal_entity_id::text as "legalEntityId", r as "reminder",
        (select le.legal_name from core.legal_entities le
          where le.legal_entity_id = s.legal_entity_id and le.tenant_id = s.tenant_id) as "legalName",
        (select i->>'number' from jsonb_array_elements(coalesce(s.state->'invoices', '[]'::jsonb)) i
          where i->'ref'->>'resourceId' = r->>'invoiceResourceId' limit 1) as "invoiceNumber"
      from finance_billing.finance_states s, jsonb_array_elements(coalesce(s.state->'reminders', '[]'::jsonb)) r
      where r->>'deliveryMode' = 'EMAIL' and (r->>'createdAt')::timestamptz >= ${enabledSince}::timestamptz
        and coalesce(trim(r->>'recipient'), '') <> ''
        and not exists (select 1 from demo_email.deliveries d where d.dedupe_key = 'rent-reminder:' || (r->>'id')
          and (d.status <> 'RETRY' or d.updated_at >= now() - make_interval(secs => least(60, 10 * power(2, least(d.attempts - 1, 3))))))
      order by r->>'createdAt', r->>'id' limit ${SOURCE_PAGE_SIZE}`;
    return rows.map((row): RentReminderInput => ({
      invoiceNumber: row.invoiceNumber,
      legalEntityId: row.legalEntityId,
      legalName: row.legalName,
      reminder: json<RentReminderInput['reminder']>(row.reminder),
      tenantId: row.tenantId,
    }));
  });

/** At most one eligible notification batch per person, only after opt-in and for chosen categories. */
export const readAgendaRecipients = (enabledSince: string) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const rows = yield* sql<{
      readonly email: string | null;
      readonly legalEntityId: string;
      readonly legalName: string | null;
      readonly notifications: unknown;
      readonly preference: unknown;
      readonly principalId: string;
      readonly tenantId: string;
    }>`
      select s.tenant_id::text as "tenantId", s.legal_entity_id::text as "legalEntityId", p as "preference",
        p->'principal'->>'principalId' as "principalId", recipient.email,
        (select le.legal_name from core.legal_entities le
          where le.legal_entity_id = s.legal_entity_id and le.tenant_id = s.tenant_id) as "legalName",
        (select jsonb_agg(n) from jsonb_array_elements(coalesce(s.state->'notifications', '[]'::jsonb)) n
          where n->'recipient'->>'principalId' = p->'principal'->>'principalId'
            and n->>'createdAt' = batch.at) as "notifications"
      from facility_operations.agenda_states s
      cross join lateral jsonb_array_elements(coalesce(s.state->'preferences', '[]'::jsonb)) p
      cross join lateral (
        select u.email from core.principal_auth_bindings b join auth."user" u on u.id = b.provider_subject_id
          where b.principal_id::text = p->'principal'->>'principalId' and b.tenant_id = s.tenant_id
            and b.status = 'active' order by b.created_at limit 1
      ) recipient
      cross join lateral (
        select n->>'createdAt' as at from jsonb_array_elements(coalesce(s.state->'notifications', '[]'::jsonb)) n
          where n->'recipient'->>'principalId' = p->'principal'->>'principalId'
            and (n->>'createdAt')::timestamptz >= greatest(${enabledSince}::timestamptz,
              coalesce(p->>'emailSince', p->>'updatedAt')::timestamptz)
            and (${JSON.stringify(AGENDA_MANDATORY_EMAIL_CATEGORIES)}::jsonb ? (n->>'category')
              or coalesce(p->'emailCategories', ${JSON.stringify(AGENDA_OPTIONAL_EMAIL_CATEGORIES)}::jsonb) ? (n->>'category'))
            and not exists (select 1 from demo_email.deliveries d
              where d.dedupe_key = 'facility-agenda:' || (p->'principal'->>'principalId') || ':' || (n->>'createdAt')
                and (d.status <> 'RETRY' or d.updated_at >= now() - make_interval(secs => least(60, 10 * power(2, least(d.attempts - 1, 3))))))
          group by n->>'createdAt' order by n->>'createdAt' limit 1
      ) batch
      where s.agenda = 'agenda' and (p->>'emailOptIn')::boolean is true and coalesce(trim(recipient.email), '') <> ''
      order by batch.at, p->'principal'->>'principalId' limit ${SOURCE_PAGE_SIZE}`;
    return rows.map((row): AgendaRecipientInput => ({
      email: row.email,
      legalEntityId: row.legalEntityId,
      legalName: row.legalName,
      notifications: json<readonly AgendaNotificationInput[]>(row.notifications),
      preference: json<AgendaPreferenceInput>(row.preference),
      principalId: row.principalId,
      tenantId: row.tenantId,
    }));
  });
