/**
 * Read-only column view of Core principals (owned by packages/core-runtime, schema `core`), so Historie změn and
 * comments name the acting account (an AI agent, a service account) instead of a generic label. Not part of this
 * vertical's drizzle schema: no migration is ever generated from this file. Column names mirror
 * packages/core-runtime/src/db/schema.ts.
 */
import { pgSchema, text, uuid } from 'drizzle-orm/pg-core';

const core = pgSchema('core');

export const corePrincipals = core.table('principals', {
  displayName: text('display_name').notNull(),
  principalId: uuid('principal_id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
});
