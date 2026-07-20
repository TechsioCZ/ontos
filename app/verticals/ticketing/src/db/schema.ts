import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { principals, tenants } from '@app/core-runtime/db/schema';

export const ticketingSchema = pgSchema('ticketing');

const tenantId = () =>
  uuid('tenant_id')
    .notNull()
    .references(() => tenants.tenantId, { onDelete: 'restrict' });

const createdAt = () =>
  timestamp('created_at', { precision: 3, withTimezone: true }).defaultNow().notNull();

export const taskCollections = ticketingSchema.table(
  'task_collections',
  {
    collectionId: uuid('collection_id').defaultRandom().primaryKey(),
    createdAt: createdAt(),
    tenantId: tenantId(),
  },
  (table) => [
    uniqueIndex('ticketing_task_collections_tenant_collection_uk').on(
      table.tenantId,
      table.collectionId,
    ),
    index('ticketing_task_collections_tenant_idx').on(table.tenantId),
  ],
);

export const taskSchemas = ticketingSchema.table(
  'task_schemas',
  {
    collectionId: uuid('collection_id')
      .notNull()
      .references(() => taskCollections.collectionId, { onDelete: 'restrict' }),
    createdAt: createdAt(),
    schemaId: uuid('schema_id').defaultRandom().primaryKey(),
    tenantId: tenantId(),
  },
  (table) => [
    uniqueIndex('ticketing_task_schemas_collection_uk').on(table.collectionId),
    uniqueIndex('ticketing_task_schemas_tenant_schema_uk').on(table.tenantId, table.schemaId),
  ],
);

export const taskPropertyDefinitions = ticketingSchema.table(
  'task_property_definitions',
  {
    createdAt: createdAt(),
    datatype: text('datatype').notNull(),
    hidden: boolean('hidden').default(false).notNull(),
    mandatory: boolean('mandatory').default(false).notNull(),
    name: text('name').notNull(),
    propertyDefinitionId: uuid('property_definition_id').defaultRandom().primaryKey(),
    revision: integer('revision').default(1).notNull(),
    schemaId: uuid('schema_id')
      .notNull()
      .references(() => taskSchemas.schemaId, { onDelete: 'restrict' }),
    tenantId: tenantId(),
  },
  (table) => [
    uniqueIndex('ticketing_task_property_definitions_schema_name_uk').on(
      table.schemaId,
      sql`lower(${table.name})`,
    ),
    check('ticketing_task_property_definitions_name_ck', sql`btrim(${table.name}) <> ''`),
    check(
      'ticketing_task_property_definitions_datatype_ck',
      sql`${table.datatype} in ('title', 'checkbox')`,
    ),
    check('ticketing_task_property_definitions_revision_ck', sql`${table.revision} >= 1`),
  ],
);

export const tasks = ticketingSchema.table(
  'tasks',
  {
    collectionId: uuid('collection_id')
      .notNull()
      .references(() => taskCollections.collectionId, { onDelete: 'restrict' }),
    createdAt: createdAt(),
    createdByPrincipalId: uuid('created_by_principal_id')
      .notNull()
      .references(() => principals.principalId, { onDelete: 'restrict' }),
    lastEditedAt: timestamp('last_edited_at', { precision: 3, withTimezone: true })
      .defaultNow()
      .notNull(),
    lastEditedByPrincipalId: uuid('last_edited_by_principal_id')
      .notNull()
      .references(() => principals.principalId, { onDelete: 'restrict' }),
    revision: integer('revision').default(1).notNull(),
    taskId: uuid('task_id').defaultRandom().primaryKey(),
    tenantId: tenantId(),
    title: text('title').default('').notNull(),
  },
  (table) => [
    index('ticketing_tasks_collection_idx').on(table.tenantId, table.collectionId),
    index('ticketing_tasks_created_by_idx').on(table.tenantId, table.createdByPrincipalId),
    check('ticketing_tasks_revision_ck', sql`${table.revision} >= 1`),
  ],
);

export const taskRevisions = ticketingSchema.table(
  'task_revisions',
  {
    changedAt: timestamp('changed_at', { precision: 3, withTimezone: true }).notNull(),
    changedByPrincipalId: uuid('changed_by_principal_id')
      .notNull()
      .references(() => principals.principalId, { onDelete: 'restrict' }),
    reason: text('reason').notNull(),
    revision: integer('revision').notNull(),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.taskId, { onDelete: 'restrict' }),
    tenantId: tenantId(),
  },
  (table) => [
    primaryKey({ columns: [table.taskId, table.revision], name: 'ticketing_task_revisions_pk' }),
    index('ticketing_task_revisions_tenant_idx').on(table.tenantId, table.taskId),
    check(
      'ticketing_task_revisions_reason_ck',
      sql`${table.reason} in ('created', 'checkbox_value_changed')`,
    ),
    check('ticketing_task_revisions_revision_ck', sql`${table.revision} >= 1`),
  ],
);

export const taskCheckboxValues = ticketingSchema.table(
  'task_checkbox_values',
  {
    propertyDefinitionId: uuid('property_definition_id')
      .notNull()
      .references(() => taskPropertyDefinitions.propertyDefinitionId, { onDelete: 'restrict' }),
    revision: integer('revision').default(1).notNull(),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.taskId, { onDelete: 'restrict' }),
    tenantId: tenantId(),
    value: boolean('value').default(false).notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.taskId, table.propertyDefinitionId],
      name: 'ticketing_task_checkbox_values_pk',
    }),
    index('ticketing_task_checkbox_values_filter_idx').on(
      table.tenantId,
      table.propertyDefinitionId,
      table.value,
    ),
    check('ticketing_task_checkbox_values_revision_ck', sql`${table.revision} >= 1`),
  ],
);
