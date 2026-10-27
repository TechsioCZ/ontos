// Committed-state readers. Which e-mails are due is decided once, by demo_email.pending_deliveries() (ids only, the
// dispatcher's sole cross-tenant read). Content is read here, only inside inDeliveryScope (RLS) and only for those ids.
import { PgClient } from '@effect/sql-pg';
import { Effect, Match, Schema } from 'effect';
import type { AgendaRecipientInput, EmailDeliverySource, RentReminderInput } from './contract.ts';
import {
  AKROS_LEGAL_ENTITY_ID,
  DEMO_TENANT_ID,
  StorefrontInquiryTaskSchema,
  AkrosOrderInputSchema,
  RentReminderInputSchema,
  AgendaNotificationInputSchema,
  AgendaPreferenceInputSchema,
  EmailDeliverySourceSchema,
} from './contract.ts';
import type { DeliveryScope } from './scope.ts';

const StoredOrderSchema = Schema.Union([
  Schema.toEncoded(AkrosOrderInputSchema),
  Schema.fromJsonString(Schema.toEncoded(AkrosOrderInputSchema)),
]);
const StoredReminderSchema = Schema.Union([
  Schema.toEncoded(RentReminderInputSchema.fields.reminder),
  Schema.fromJsonString(Schema.toEncoded(RentReminderInputSchema.fields.reminder)),
]);
const StoredNotificationsSchema = Schema.Union([
  Schema.Array(Schema.toEncoded(AgendaNotificationInputSchema)),
  Schema.fromJsonString(Schema.Array(Schema.toEncoded(AgendaNotificationInputSchema))),
]);
const StoredPreferenceSchema = Schema.Union([
  Schema.toEncoded(AgendaPreferenceInputSchema),
  Schema.fromJsonString(Schema.toEncoded(AgendaPreferenceInputSchema)),
]);
/** Per source and tick; the function caps it at 100. */
export const PENDING_PAGE_SIZE = 10;

export interface PendingDelivery extends DeliveryScope {
  /** The ledger dedupe key, e.g. `rent-reminder:<reminder id>`. */
  readonly deliveryId: string;
}

export const readPendingDeliveries = Effect.gen(function* readPendingDeliveries() {
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
  if (separator === -1 || rest === '') {
    return null;
  }
  if (!Schema.is(EmailDeliverySourceSchema)(source)) {
    return null;
  }
  return Match.value(source).pipe(
    Match.whenOr('storefront-inquiry', 'person-invitation', 'rent-reminder', (kind) => ({
      source: kind,
      subjectId: rest,
    })),
    Match.when('akros-order', (kind) => {
      const end = rest.lastIndexOf(':');
      return end <= 0 ? null : { source: kind, subjectId: rest.slice(0, end) };
    }),
    Match.when('facility-agenda', (kind) => {
      const end = rest.indexOf(':');
      return end <= 0 ? null : { source: kind, subjectId: rest.slice(0, end) };
    }),
    Match.exhaustive,
  );
};

/** Call inside inDeliveryScope(scope). The explicit predicates restate what RLS already enforces. */
export const readAkrosOrders = Effect.fn('EmailSources.readAkrosOrders')(function* readOrders(
  scope: DeliveryScope,
  orderIds: readonly string[],
) {
  if (orderIds.length === 0) {
    return [];
  }
  const sql = yield* PgClient.PgClient;
  const rows = yield* sql<{ readonly order: unknown }>`
      select r.document as "order" from demo_merchandise.orders r
      where r.tenant_id = ${scope.tenantId}::uuid and r.legal_entity_id = ${scope.legalEntityId}::uuid
        and r.id in ${sql.in(orderIds)}
      order by r.created_at, r.id`;
  return yield* Effect.forEach(rows, (row) => Schema.decodeUnknownEffect(StoredOrderSchema)(row.order), {
    concurrency: 1,
  });
});

/** Call inside inDeliveryScope(scope). */
export const readRentReminders = Effect.fn('EmailSources.readRentReminders')(function* readReminders(
  scope: DeliveryScope,
  reminderIds: readonly string[],
) {
  if (reminderIds.length === 0) {
    return [];
  }
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
  return yield* Effect.forEach(
    rows,
    (row) =>
      Schema.decodeUnknownEffect(StoredReminderSchema)(row.reminder).pipe(
        Effect.map((reminder): RentReminderInput => ({
          invoiceNumber: row.invoiceNumber,
          legalEntityId: row.legalEntityId,
          legalName: row.legalName,
          reminder,
          tenantId: row.tenantId,
        })),
      ),
    { concurrency: 1 },
  );
});

/** Call inside inDeliveryScope(scope). All notifications of each person; the planner groups them into batches. */
export const readAgendaRecipients = Effect.fn('EmailSources.readAgendaRecipients')(function* readRecipients(
  scope: DeliveryScope,
  principalIds: readonly string[],
) {
  if (principalIds.length === 0) {
    return [];
  }
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
  return yield* Effect.forEach(
    rows,
    (row) =>
      Effect.all(
        {
          notifications: Schema.decodeUnknownEffect(StoredNotificationsSchema)(row.notifications),
          preference: Schema.decodeUnknownEffect(StoredPreferenceSchema)(row.preference),
        },
        { concurrency: 1 },
      ).pipe(
        Effect.map(({ notifications, preference }): AgendaRecipientInput => ({
          email: row.email,
          legalEntityId: row.legalEntityId,
          legalName: row.legalName,
          notifications,
          preference,
          principalId: row.principalId,
          tenantId: row.tenantId,
        })),
      ),
    { concurrency: 1 },
  );
});

/** Scoped committed task state, only pending ids discovered by the migration-owned scheduler. */
export const readStorefrontInquiryTasks = Effect.fn('Sources.readStorefrontInquiryTasks')(
  function* readStorefrontInquiryTasks(scope: DeliveryScope, taskIds: readonly string[]) {
    if (taskIds.length === 0) {
      return [];
    }
    const sql = yield* PgClient.PgClient;
    const rows = yield* sql<{ readonly task: unknown }>`
      select t as task from work_tasks.work_states s,
        jsonb_array_elements(coalesce(s.state->'tasks', '[]'::jsonb)) t
      where s.tenant_id = ${scope.tenantId}::uuid and s.legal_entity_id = ${scope.legalEntityId}::uuid
        and t->'ref'->>'resourceId' in ${sql.in(taskIds)} and t->'storefrontInquiry' is not null
      order by t->>'createdAt', t->'ref'->>'resourceId'`;
    return yield* Effect.forEach(
      rows,
      (row) => Schema.decodeUnknownEffect(Schema.toEncoded(StorefrontInquiryTaskSchema))(row.task),
      { concurrency: 1 },
    );
  },
);
