// @effect-diagnostics *:off
// Committed-state readers: the dispatcher reads only persisted domain JSON, never in-flight transactions.
import { PgClient } from '@effect/sql-pg';
import { Effect } from 'effect';
import type { AgendaNotificationInput, AgendaPreferenceInput, AgendaRecipientInput, AkrosOrderInput, RentReminderInput } from './contract.ts';
import { AKROS_LEGAL_ENTITY_ID, DEMO_TENANT_ID } from './contract.ts';

const json = <T>(value: unknown): T => (typeof value === 'string' ? JSON.parse(value) : value) as T;

export const readAkrosOrders = (enabledSince: string) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const rows = yield* sql<{ readonly order: unknown }>`
      select o as "order" from demo_merchandise.merchandise_states s, jsonb_array_elements(coalesce(s.state->'orders', '[]'::jsonb)) o
      where s.tenant_id = ${DEMO_TENANT_ID}::uuid and s.legal_entity_id = ${AKROS_LEGAL_ENTITY_ID}::uuid
        and o->>'channel' = 'STOREFRONT' and (o->>'createdAt')::timestamptz >= ${enabledSince}::timestamptz`;
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
      where r->>'deliveryMode' = 'EMAIL' and (r->>'createdAt')::timestamptz >= ${enabledSince}::timestamptz`;
    return rows.map(
      (row): RentReminderInput => ({
        invoiceNumber: row.invoiceNumber,
        legalEntityId: row.legalEntityId,
        legalName: row.legalName,
        reminder: json<RentReminderInput['reminder']>(row.reminder),
        tenantId: row.tenantId,
      }),
    );
  });

/**
 * Agenda notifications (facility-operations `agenda` state) of every person whose preference has e-mail switched on, with the
 * person's sign-in e-mail (core principal binding → auth user). Only notifications created after e-mail was switched on.
 */
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
        p->'principal'->>'principalId' as "principalId",
        (select le.legal_name from core.legal_entities le
          where le.legal_entity_id = s.legal_entity_id and le.tenant_id = s.tenant_id) as "legalName",
        (select u.email from core.principal_auth_bindings b join auth."user" u on u.id = b.provider_subject_id
          where b.principal_id::text = p->'principal'->>'principalId' and b.tenant_id = s.tenant_id
            and b.status = 'active' order by b.created_at limit 1) as "email",
        coalesce((select jsonb_agg(n) from jsonb_array_elements(coalesce(s.state->'notifications', '[]'::jsonb)) n
          where n->'recipient'->>'principalId' = p->'principal'->>'principalId'
            and (n->>'createdAt')::timestamptz >= greatest(${enabledSince}::timestamptz,
              coalesce(p->>'emailSince', p->>'updatedAt')::timestamptz)), '[]'::jsonb) as "notifications"
      from facility_operations.agenda_states s, jsonb_array_elements(coalesce(s.state->'preferences', '[]'::jsonb)) p
      where s.agenda = 'agenda' and (p->>'emailOptIn')::boolean is true`;
    return rows.map(
      (row): AgendaRecipientInput => ({
        email: row.email,
        legalEntityId: row.legalEntityId,
        legalName: row.legalName,
        notifications: json<readonly AgendaNotificationInput[]>(row.notifications),
        preference: json<AgendaPreferenceInput>(row.preference),
        principalId: row.principalId,
        tenantId: row.tenantId,
      }),
    );
  });
