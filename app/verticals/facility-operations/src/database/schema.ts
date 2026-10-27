import { tenantLegalEntityRlsPolicies } from '@app/core-runtime';
import { defineRelations, sql } from 'drizzle-orm';
import { bytea, check, index, integer, jsonb, pgSchema, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';

export const facilityOperationsSchema = pgSchema('facility_operations');

/** One JSONB state document per (tenant, legal entity, agenda); each agenda has an independent revision. */
export const agendaStates = facilityOperationsSchema.table.withRLS(
  'agenda_states',
  {
    agenda: text('agenda').notNull(),
    legalEntityId: uuid('legal_entity_id').notNull(),
    revision: integer('revision').default(0).notNull(),
    state: jsonb('state').notNull(),
    tenantId: uuid('tenant_id').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.legalEntityId, table.agenda] }),
    check('facility_operations_revision_nonnegative', sql`${table.revision} >= 0`),
    check('facility_operations_state_object', sql`jsonb_typeof(${table.state}) = 'object'`),
    ...tenantLegalEntityRlsPolicies('facility_operations_state_scope', table.tenantId, table.legalEntityId),
  ],
);

/** Binary files (documents lane). Content is written/read as base64 through SQL encode/decode. */
export const files = facilityOperationsSchema.table.withRLS(
  'files',
  {
    bytes: bytea('bytes').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    createdBy: uuid('created_by').notNull(),
    id: text('id').notNull(),
    legalEntityId: uuid('legal_entity_id').notNull(),
    mime: text('mime').notNull(),
    name: text('name').notNull(),
    size: integer('size').notNull(),
    tenantId: uuid('tenant_id').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.legalEntityId, table.id] }),
    check('facility_operations_file_size', sql`${table.size} >= 0 and ${table.size} <= 5242880`),
    ...tenantLegalEntityRlsPolicies('facility_operations_file_scope', table.tenantId, table.legalEntityId),
  ],
);

export const gatewayAssertionRedemptions = facilityOperationsSchema.table(
  'gateway_assertion_redemptions',
  {
    audience: text('audience').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    issuer: text('issuer').notNull(),
    jti: text('jti').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.issuer, table.audience, table.jti] }),
    index('facility_operations_redemption_expiry').on(table.expiresAt),
  ],
);

export const facilityOperationsRelations = defineRelations({ agendaStates, files, gatewayAssertionRedemptions });
