// @effect-diagnostics *:off
// Committed-state readers. Which e-mails are due is decided once, by demo_email.pending_deliveries() (ids only, the
// dispatcher's sole cross-tenant read). Content is read here, only inside inDeliveryScope (RLS) and only for those ids.
import { PgClient } from '@effect/sql-pg';
import { Effect } from 'effect';
import type {
  AgendaNotificationInput,
  AgendaPreferenceInput,
  AgendaRecipientInput,
  AkrosOrderInput,
  EmailDeliverySource,
  RentReminderInput,
} from './contract.ts';
import { AKROS_LEGAL_ENTITY_ID, DEMO_TENANT_ID } from './contract.ts';
import type { DeliveryScope } from './scope.ts';

const json = <T>(value: unknown): T => (typeof value === 'string' ? JSON.parse(value) : value) as T;
/** Per source and tick; the function caps it at 100. */
export const PENDING_PAGE_SIZE = 10;

export interface PendingDelivery extends DeliveryScope {
  /** The ledger dedupe key, e.g. `rent-reminder:<reminder id>`. */
  readonly deliveryId: string;
}

export const readPendingDeliveries = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient;
  return yield* sql<PendingDelivery>`
    select tenant_id::text as "tenantId", legal_entity_id::text as "legalEntityId", delivery_id as "deliveryId"
    from demo_email.pending_deliveries(${PENDING_PAGE_SIZE}, ${DEMO_TENANT_ID}::uuid, ${AKROS_LEGAL_ENTITY_ID}::uuid)`;
});

export interface ParsedDeliveryId {
  readonly source: EmailDeliverySource;
  /** Order id, reminder id or the agenda recipient's principal id. */
  readonly subjectId: string;
}

/** `akros-order:<order id>:<event>`, `rent-reminder:<id>`, `facility-agenda:<principal id>:<batch instant>`. */
export const parseDeliveryId = (deliveryId: string): ParsedDeliveryId | null => {
  const separator = deliveryId.indexOf(':');
  const source = deliveryId.slice(0, separator);
  const rest = deliveryId.slice(separator + 1);
  if (separator < 0 || rest === '') return null;
  switch (source) {
    case 'rent-reminder':
      return { source, subjectId: rest };
    case 'akros-order': {
      const end = rest.lastIndexOf(':');
      return end <= 0 ? null : { source, subjectId: rest.slice(0, end) };
    }
    case 'facility-agenda': {
      const end = rest.indexOf(':');
      return end <= 0 ? null : { source, subjectId: rest.slice(0, end) };
    }
    default:
      return null;
  }
};

/** Call inside inDeliveryScope(scope). The explicit predicates restate what RLS already enforces. */
export const readAkrosOrders = (scope: DeliveryScope, orderIds: readonly string[]) =>
  Effect.gen(function* () {
    if (orderIds.length === 0) return [] as readonly AkrosOrderInput[];
    const sql = yield* PgClient.PgClient;
    const rows = yield* sql<{ readonly order: unknown }>`
      select r.document as "order" from demo_merchandise.orders r
      where r.tenant_id = ${scope.tenantId}::uuid and r.legal_entity_id = ${scope.legalEntityId}::uuid
        and r.id in ${sql.in(orderIds)}
      order by r.created_at, r.id`;
    return rows.map((row) => json<AkrosOrderInput>(row.order));
  });

/** Call inside inDeliveryScope(scope). */
export const readRentReminders = (scope: DeliveryScope, reminderIds: readonly string[]) =>
  Effect.gen(function* () {
    if (reminderIds.length === 0) return [] as readonly RentReminderInput[];
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
      where s.tenant_id = ${scope.tenantId}::uuid and s.legal_entity_id = ${scope.legalEntityId}::uuid
        and r->>'id' in ${sql.in(reminderIds)}
      order by r->>'createdAt', r->>'id'`;
    return rows.map((row): RentReminderInput => ({
      invoiceNumber: row.invoiceNumber,
      legalEntityId: row.legalEntityId,
      legalName: row.legalName,
      reminder: json<RentReminderInput['reminder']>(row.reminder),
      tenantId: row.tenantId,
    }));
  });

/** Call inside inDeliveryScope(scope). All notifications of each person; the planner groups them into batches. */
export const readAgendaRecipients = (scope: DeliveryScope, principalIds: readonly string[]) =>
  Effect.gen(function* () {
    if (principalIds.length === 0) return [] as readonly AgendaRecipientInput[];
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
        (select u.email from core.principal_auth_bindings b join auth."user" u on u.id = b.provider_subject_id
          where b.principal_id::text = p->'principal'->>'principalId' and b.tenant_id = s.tenant_id
            and b.status = 'active' order by b.created_at limit 1) as email,
        (select le.legal_name from core.legal_entities le
          where le.legal_entity_id = s.legal_entity_id and le.tenant_id = s.tenant_id) as "legalName",
        (select coalesce(jsonb_agg(n), '[]'::jsonb) from jsonb_array_elements(coalesce(s.state->'notifications', '[]'::jsonb)) n
          where n->'recipient'->>'principalId' = p->'principal'->>'principalId') as "notifications"
      from facility_operations.agenda_states s
      cross join lateral jsonb_array_elements(coalesce(s.state->'preferences', '[]'::jsonb)) p
      where s.tenant_id = ${scope.tenantId}::uuid and s.legal_entity_id = ${scope.legalEntityId}::uuid
        and s.agenda = 'agenda' and p->'principal'->>'principalId' in ${sql.in(principalIds)}`;
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
