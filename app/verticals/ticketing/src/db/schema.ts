import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
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
    locale: text('locale').notNull(),
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
    numberFormat: text('number_format'),
    propertyDefinitionId: uuid('property_definition_id').defaultRandom().primaryKey(),
    revision: integer('revision').default(1).notNull(),
    schemaId: uuid('schema_id')
      .notNull()
      .references(() => taskSchemas.schemaId, { onDelete: 'restrict' }),
    selectOptionOrderMode: text('select_option_order_mode'),
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
      sql`${table.datatype} in ('title', 'checkbox', 'email', 'number', 'phone', 'select', 'text', 'url')`,
    ),
    check(
      'ticketing_task_property_definitions_select_order_ck',
      sql`(${table.datatype} = 'select' and ${table.selectOptionOrderMode} in ('manual', 'alphabetical', 'reverse_alphabetical')) or (${table.datatype} <> 'select' and ${table.selectOptionOrderMode} is null)`,
    ),
    check(
      'ticketing_task_property_definitions_number_format_ck',
      sql`(${table.datatype} = 'number' and ${table.numberFormat} in ('number', 'number_with_separators', 'percent')) or (${table.datatype} <> 'number' and ${table.numberFormat} is null)`,
    ),
    check('ticketing_task_property_definitions_revision_ck', sql`${table.revision} >= 1`),
  ],
);

export const selectOptions = ticketingSchema.table(
  'select_options',
  {
    color: text('color').notNull(),
    manualPosition: integer('manual_position').notNull(),
    name: text('name').notNull(),
    normalizedName: text('normalized_name').notNull(),
    optionId: uuid('option_id').defaultRandom().primaryKey(),
    propertyDefinitionId: uuid('property_definition_id')
      .notNull()
      .references(() => taskPropertyDefinitions.propertyDefinitionId, { onDelete: 'restrict' }),
    revision: integer('revision').default(1).notNull(),
    tenantId: tenantId(),
  },
  (table) => [
    uniqueIndex('ticketing_select_options_definition_name_uk').on(
      table.propertyDefinitionId,
      table.normalizedName,
    ),
    uniqueIndex('ticketing_select_options_ownership_uk').on(
      table.tenantId,
      table.propertyDefinitionId,
      table.optionId,
    ),
    uniqueIndex('ticketing_select_options_manual_position_uk').on(
      table.propertyDefinitionId,
      table.manualPosition,
    ),
    check('ticketing_select_options_name_ck', sql`btrim(${table.name}) <> ''`),
    check('ticketing_select_options_manual_position_ck', sql`${table.manualPosition} >= 0`),
    check('ticketing_select_options_revision_ck', sql`${table.revision} >= 1`),
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
    retentionState: text('retention_state').default('active').notNull(),
    revision: integer('revision').default(1).notNull(),
    taskId: uuid('task_id').defaultRandom().primaryKey(),
    tenantId: tenantId(),
    title: text('title').default('').notNull(),
  },
  (table) => [
    index('ticketing_tasks_collection_idx').on(table.tenantId, table.collectionId),
    index('ticketing_tasks_created_by_idx').on(table.tenantId, table.createdByPrincipalId),
    check('ticketing_tasks_revision_ck', sql`${table.revision} >= 1`),
    check(
      'ticketing_tasks_retention_state_ck',
      sql`${table.retentionState} in ('active', 'archived', 'soft_deleted')`,
    ),
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
      sql`${table.reason} in ('created', 'checkbox_value_changed', 'email_value_changed', 'number_value_changed', 'phone_value_changed', 'select_value_changed', 'text_value_changed', 'url_value_changed', 'archived', 'restored', 'soft_deleted')`,
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

export const taskEmailValues = ticketingSchema.table(
  'task_email_values',
  {
    normalizedValue: text('normalized_value'),
    propertyDefinitionId: uuid('property_definition_id')
      .notNull()
      .references(() => taskPropertyDefinitions.propertyDefinitionId, { onDelete: 'restrict' }),
    revision: integer('revision').default(1).notNull(),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.taskId, { onDelete: 'restrict' }),
    tenantId: tenantId(),
    value: text('value'),
  },
  (table) => [
    primaryKey({
      columns: [table.taskId, table.propertyDefinitionId],
      name: 'ticketing_task_email_values_pk',
    }),
    index('ticketing_task_email_values_query_idx').on(
      table.tenantId,
      table.propertyDefinitionId,
      table.normalizedValue,
      table.taskId,
    ),
    check('ticketing_task_email_values_revision_ck', sql`${table.revision} >= 1`),
    check('ticketing_task_email_values_trimmed_ck', sql`btrim(${table.value}) = ${table.value}`),
    check(
      'ticketing_task_email_values_normalized_ck',
      sql`(${table.normalizedValue} is null and ${table.value} is null) or ${table.normalizedValue} = lower(${table.value})`,
    ),
    check(
      'ticketing_task_email_values_length_ck',
      sql`char_length(${table.value}) between 1 and 254`,
    ),
  ],
);

export const taskSelectValues = ticketingSchema.table(
  'task_select_values',
  {
    optionId: uuid('option_id'),
    propertyDefinitionId: uuid('property_definition_id')
      .notNull()
      .references(() => taskPropertyDefinitions.propertyDefinitionId, { onDelete: 'restrict' }),
    revision: integer('revision').default(1).notNull(),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.taskId, { onDelete: 'restrict' }),
    tenantId: tenantId(),
  },
  (table) => [
    primaryKey({
      columns: [table.taskId, table.propertyDefinitionId],
      name: 'ticketing_task_select_values_pk',
    }),
    foreignKey({
      columns: [table.tenantId, table.propertyDefinitionId, table.optionId],
      foreignColumns: [
        selectOptions.tenantId,
        selectOptions.propertyDefinitionId,
        selectOptions.optionId,
      ],
      name: 'ticketing_task_select_values_option_fk',
    }).onDelete('restrict'),
    index('ticketing_task_select_values_filter_idx').on(
      table.tenantId,
      table.propertyDefinitionId,
      table.optionId,
    ),
    check('ticketing_task_select_values_revision_ck', sql`${table.revision} >= 1`),
  ],
);

export const taskTextValues = ticketingSchema.table(
  'task_text_values',
  {
    document: jsonb('document'),
    propertyDefinitionId: uuid('property_definition_id')
      .notNull()
      .references(() => taskPropertyDefinitions.propertyDefinitionId, { onDelete: 'restrict' }),
    readableText: text('readable_text'),
    revision: integer('revision').default(1).notNull(),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.taskId, { onDelete: 'restrict' }),
    tenantId: tenantId(),
  },
  (table) => [
    primaryKey({
      columns: [table.taskId, table.propertyDefinitionId],
      name: 'ticketing_task_text_values_pk',
    }),
    index('ticketing_task_text_values_query_idx').on(
      table.tenantId,
      table.propertyDefinitionId,
      table.readableText,
    ),
    check('ticketing_task_text_values_revision_ck', sql`${table.revision} >= 1`),
    check(
      'ticketing_task_text_values_empty_ck',
      sql`(${table.document} is null) = (${table.readableText} is null)`,
    ),
  ],
);

export const taskNumberValues = ticketingSchema.table(
  'task_number_values',
  {
    propertyDefinitionId: uuid('property_definition_id')
      .notNull()
      .references(() => taskPropertyDefinitions.propertyDefinitionId, { onDelete: 'restrict' }),
    revision: integer('revision').default(1).notNull(),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.taskId, { onDelete: 'restrict' }),
    tenantId: tenantId(),
    value: numeric('value', { precision: 38, scale: 18 }),
  },
  (table) => [
    primaryKey({
      columns: [table.taskId, table.propertyDefinitionId],
      name: 'ticketing_task_number_values_pk',
    }),
    index('ticketing_task_number_values_query_idx').on(
      table.tenantId,
      table.propertyDefinitionId,
      table.value,
    ),
    check('ticketing_task_number_values_revision_ck', sql`${table.revision} >= 1`),
  ],
);

export const taskUrlValues = ticketingSchema.table(
  'task_url_values',
  {
    propertyDefinitionId: uuid('property_definition_id')
      .notNull()
      .references(() => taskPropertyDefinitions.propertyDefinitionId, { onDelete: 'restrict' }),
    revision: integer('revision').default(0).notNull(),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.taskId, { onDelete: 'restrict' }),
    tenantId: tenantId(),
    value: text('value'),
  },
  (table) => [
    primaryKey({
      columns: [table.taskId, table.propertyDefinitionId],
      name: 'ticketing_task_url_values_pk',
    }),
    index('ticketing_task_url_values_query_idx').on(table.tenantId, table.propertyDefinitionId),
    check('ticketing_task_url_values_revision_ck', sql`${table.revision} >= 0`),
    check(
      'ticketing_task_url_values_byte_length_ck',
      sql`${table.value} is null or octet_length(${table.value}) <= 8000`,
    ),
  ],
);

export const taskPhoneValues = ticketingSchema.table(
  'task_phone_values',
  {
    propertyDefinitionId: uuid('property_definition_id')
      .notNull()
      .references(() => taskPropertyDefinitions.propertyDefinitionId, { onDelete: 'restrict' }),
    revision: integer('revision').default(1).notNull(),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.taskId, { onDelete: 'restrict' }),
    tenantId: tenantId(),
    value: text('value').notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.taskId, table.propertyDefinitionId],
      name: 'ticketing_task_phone_values_pk',
    }),
    check('ticketing_task_phone_values_length_ck', sql`char_length(${table.value}) <= 256`),
    check('ticketing_task_phone_values_not_blank_ck', sql`btrim(${table.value}) <> ''`),
    check('ticketing_task_phone_values_revision_ck', sql`${table.revision} >= 1`),
  ],
);
