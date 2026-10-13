import { tenantRlsPolicies } from '@app/core-runtime';
import { defineRelations, sql } from 'drizzle-orm';
import { check, foreignKey, index, pgSchema, text, timestamp, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

export const PROJECTS_SCHEMA_NAME = 'projects';
export const PROJECTS_TABLE_INVENTORY = ['projects'] as const;

export const projectsSchema = pgSchema(PROJECTS_SCHEMA_NAME);
export const projects = projectsSchema.table.withRLS(
  'projects',
  {
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    createdByPrincipalId: uuid('created_by_principal_id').notNull(),
    lifecycleState: text('lifecycle_state', { enum: ['active', 'archived'] })
      .default('active')
      .notNull(),
    name: text('name').notNull(),
    ownerPrincipalId: uuid('owner_principal_id').notNull(),
    parentProjectId: uuid('parent_project_id'),
    prefix: text('prefix').notNull(),
    projectId: uuid('project_id').defaultRandom().primaryKey(),
    shortText: text('short_text'),
    tenantId: uuid('tenant_id').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique('projects_projects_tenant_id_uk').on(table.tenantId, table.projectId),
    uniqueIndex('projects_projects_tenant_prefix_uk').on(table.tenantId, table.prefix),
    index('projects_projects_tenant_parent_idx').on(table.tenantId, table.parentProjectId),
    foreignKey({
      columns: [table.tenantId, table.parentProjectId],
      foreignColumns: [table.tenantId, table.projectId],
      name: 'projects_projects_tenant_parent_fk',
    }).onDelete('restrict'),
    check('projects_projects_prefix_ck', sql`${table.prefix} ~ '^[A-Z]{2,5}$'`),
    check('projects_projects_name_ck', sql`length(btrim(${table.name})) > 0`),
    check('projects_projects_short_text_ck', sql`${table.shortText} is null or char_length(${table.shortText}) <= 255`),
    check(
      'projects_projects_not_own_parent_ck',
      sql`${table.parentProjectId} is null or ${table.parentProjectId} <> ${table.projectId}`,
    ),
    check('projects_projects_lifecycle_state_ck', sql`${table.lifecycleState} in ('active', 'archived')`),
    ...tenantRlsPolicies('projects_projects_tenant', table.tenantId),
  ],
);

export const projectsDatabaseSchema = { projects } as const;

export type ProjectRecord = typeof projects.$inferSelect;

export const projectsRelations = defineRelations(projectsDatabaseSchema);
