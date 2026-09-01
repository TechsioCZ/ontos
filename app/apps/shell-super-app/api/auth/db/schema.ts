/* eslint-disable sort-keys -- Columns preserve the Better Auth CLI model order. */
import { relations } from 'drizzle-orm';
import { boolean, index, integer, pgSchema, text, timestamp, uuid } from 'drizzle-orm/pg-core';

export const AUTH_SCHEMA_NAME = 'auth';
export const AUTH_TABLE_INVENTORY = [
  'user',
  'session',
  'account',
  'verification',
  'apikey',
  'support_impersonation_recovery',
] as const;

export const authSchema = pgSchema(AUTH_SCHEMA_NAME);

export const user = authSchema.table('user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified').default(false).notNull(),
  image: text('image'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  role: text('role'),
  banned: boolean('banned').default(false),
  banReason: text('ban_reason'),
  banExpires: timestamp('ban_expires', { withTimezone: true }),
});

export const session = authSchema.table(
  'session',
  {
    id: text('id').primaryKey(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    token: text('token').notNull().unique(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    activeTenantId: uuid('active_tenant_id'),
    activeLegalEntityId: uuid('active_legal_entity_id'),
    impersonatedBy: text('impersonated_by'),
    impersonationReason: text('impersonation_reason'),
    impersonationActionId: text('impersonation_action_id'),
    impersonationOriginalAuthBindingId: uuid('impersonation_original_auth_binding_id'),
    impersonationOriginalPrincipalId: uuid('impersonation_original_principal_id'),
    impersonationOriginalSessionId: text('impersonation_original_session_id'),
    impersonationTargetPrincipalId: uuid('impersonation_target_principal_id'),
  },
  (table) => [index('auth_session_user_id_idx').on(table.userId)],
);

export const supportImpersonationRecovery = authSchema.table(
  'support_impersonation_recovery',
  {
    impersonationSessionId: text('impersonation_session_id').primaryKey(),
    originalAuthBindingId: uuid('original_auth_binding_id').notNull(),
    originalPrincipalId: uuid('original_principal_id').notNull(),
    originalSessionId: text('original_session_id').notNull(),
    tenantId: uuid('tenant_id').notNull(),
    targetPrincipalId: uuid('target_principal_id').notNull(),
    actionId: text('action_id').notNull(),
    reason: text('reason').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('auth_support_impersonation_recovery_original_session_idx').on(table.originalSessionId),
  ],
);

export const account = authSchema.table(
  'account',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }),
    refreshTokenExpiresAt: timestamp('refresh_token_expires_at', { withTimezone: true }),
    scope: text('scope'),
    password: text('password'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (table) => [index('auth_account_user_id_idx').on(table.userId)],
);

export const verification = authSchema.table(
  'verification',
  {
    id: text('id').primaryKey(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index('auth_verification_identifier_idx').on(table.identifier)],
);

export const apikey = authSchema.table(
  'apikey',
  {
    id: text('id').primaryKey(),
    configId: text('config_id').default('default').notNull(),
    name: text('name'),
    start: text('start'),
    referenceId: text('reference_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    prefix: text('prefix'),
    key: text('key').notNull(),
    refillInterval: integer('refill_interval'),
    refillAmount: integer('refill_amount'),
    lastRefillAt: timestamp('last_refill_at', { withTimezone: true }),
    enabled: boolean('enabled').default(true),
    rateLimitEnabled: boolean('rate_limit_enabled').default(true),
    rateLimitTimeWindow: integer('rate_limit_time_window').default(86_400_000),
    rateLimitMax: integer('rate_limit_max').default(10),
    requestCount: integer('request_count').default(0),
    remaining: integer('remaining'),
    lastRequest: timestamp('last_request', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
    permissions: text('permissions'),
    metadata: text('metadata'),
  },
  (table) => [
    index('auth_apikey_config_id_idx').on(table.configId),
    index('auth_apikey_reference_id_idx').on(table.referenceId),
    index('auth_apikey_key_idx').on(table.key),
    index('auth_apikey_metadata_created_at_idx').on(table.metadata, table.createdAt),
  ],
);

export const userRelations = relations(user, ({ many }) => ({
  sessions: many(session),
  accounts: many(account),
  apiKeys: many(apikey),
}));

export const sessionRelations = relations(session, ({ one }) => ({
  user: one(user, {
    fields: [session.userId],
    references: [user.id],
  }),
}));

export const accountRelations = relations(account, ({ one }) => ({
  user: one(user, {
    fields: [account.userId],
    references: [user.id],
  }),
}));

export const apiKeyRelations = relations(apikey, ({ one }) => ({
  user: one(user, {
    fields: [apikey.referenceId],
    references: [user.id],
  }),
}));

export const authDatabaseSchema = {
  account,
  accountRelations,
  apikey,
  apiKeyRelations,
  session,
  sessionRelations,
  supportImpersonationRecovery,
  user,
  userRelations,
  verification,
} as const;

export const AUTH_TABLES = [
  user,
  session,
  account,
  verification,
  apikey,
  supportImpersonationRecovery,
] as const;
