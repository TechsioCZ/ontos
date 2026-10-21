// @effect-diagnostics *:off
// Committed-state readers: the dispatcher reads only persisted domain JSON, never in-flight transactions.
import { PgClient } from '@effect/sql-pg';
import { Effect } from 'effect';
import type { AkrosOrderInput, SiamparkReminderInput } from './contract.ts';
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

export const readSiamparkReminders = (enabledSince: string) =>
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
      from siampark_billing_finance.finance_states s, jsonb_array_elements(coalesce(s.state->'reminders', '[]'::jsonb)) r
      where r->>'deliveryMode' = 'EMAIL' and (r->>'createdAt')::timestamptz >= ${enabledSince}::timestamptz`;
    return rows.map(
      (row): SiamparkReminderInput => ({
        invoiceNumber: row.invoiceNumber,
        legalEntityId: row.legalEntityId,
        legalName: row.legalName,
        reminder: json<SiamparkReminderInput['reminder']>(row.reminder),
        tenantId: row.tenantId,
      }),
    );
  });
