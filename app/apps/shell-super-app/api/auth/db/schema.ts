import { defineRelations, sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgSchema,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

export const AUTH_SCHEMA_NAME = 'auth';
export const AUTH_TABLE_INVENTORY = [
  'user',
  'session',
  'account',
  'verification',
  'apikey',
  'support_impersonation_recovery',
  'jwks',
  'oauth_client',
  'oauth_resource',
  'oauth_client_resource',
  'oauth_refresh_token',
  'oauth_access_token',
  'oauth_consent',
  'oauth_client_assertion',
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
    activeContextKind: text('active_context_kind', { enum: ['company', 'tenant'] })
      .default('company')
      .notNull(),
    impersonatedBy: text('impersonated_by'),
    impersonationReason: text('impersonation_reason'),
    impersonationActionId: text('impersonation_action_id'),
    impersonationOriginalAuthBindingId: uuid('impersonation_original_auth_binding_id'),
    impersonationOriginalPrincipalId: uuid('impersonation_original_principal_id'),
    impersonationOriginalSessionId: text('impersonation_original_session_id'),
    impersonationTargetPrincipalId: uuid('impersonation_target_principal_id'),
  },
  (table) => [
    index('auth_session_user_id_idx').on(table.userId),
    check('auth_session_context_kind_check', sql`${table.activeContextKind} in ('company', 'tenant')`),
    check(
      'auth_session_tenant_context_check',
      sql`${table.activeContextKind} <> 'tenant' or (${table.activeTenantId} is not null and ${table.activeLegalEntityId} is null)`,
    ),
  ],
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
  (table) => [index('auth_support_impersonation_recovery_original_session_idx').on(table.originalSessionId)],
);

export const account = authSchema.table(
  'account',
  {
    id: text('id').primaryKey(),
    // Better Auth 1.7.3+ keys accounts on (providerId, accountId) and no longer writes `issuer`;
    // the column stays nullable, still filled by the `account_issuer_compat` trigger, until no
    // 1.7.2 writer remains. Drop it, its index and the trigger in that later contraction release.
    issuer: text('issuer'),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: timestamp('access_token_expires_at', {
      withTimezone: true,
    }),
    refreshTokenExpiresAt: timestamp('refresh_token_expires_at', {
      withTimezone: true,
    }),
    scope: text('scope'),
    password: text('password'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex('auth_account_issuer_account_id_uk').on(table.issuer, table.accountId),
    uniqueIndex('auth_account_provider_id_account_id_uk').on(table.providerId, table.accountId),
    index('auth_account_user_id_idx').on(table.userId),
  ],
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
    index('auth_apikey_metadata_jsonb_idx').using('gin', sql`(${table.metadata}::jsonb)`),
  ],
);

export const jwks = authSchema.table('jwks', {
  id: text('id').primaryKey(),
  publicKey: text('public_key').notNull(),
  privateKey: text('private_key').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  alg: text('alg'),
  crv: text('crv'),
});

export const oauthClient = authSchema.table(
  'oauth_client',
  {
    id: text('id').primaryKey(),
    clientId: text('client_id').notNull().unique(),
    clientSecret: text('client_secret'),
    clientDiscoveryId: text('client_discovery_id'),
    disabled: boolean('disabled').default(false),
    skipConsent: boolean('skip_consent'),
    enableEndSession: boolean('enable_end_session'),
    subjectType: text('subject_type'),
    scopes: text('scopes').array(),
    clientCredentialsScopes: text('client_credentials_scopes').array(),
    userId: text('user_id').references(() => user.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }),
    name: text('name'),
    uri: text('uri'),
    icon: text('icon'),
    contacts: text('contacts').array(),
    tos: text('tos'),
    policy: text('policy'),
    softwareId: text('software_id'),
    softwareVersion: text('software_version'),
    softwareStatement: text('software_statement'),
    redirectUris: text('redirect_uris').array().notNull(),
    postLogoutRedirectUris: text('post_logout_redirect_uris').array(),
    backchannelLogoutUri: text('backchannel_logout_uri'),
    backchannelLogoutSessionRequired: boolean('backchannel_logout_session_required'),
    tokenEndpointAuthMethod: text('token_endpoint_auth_method'),
    applicationType: text('application_type'),
    jwks: text('jwks'),
    jwksUri: text('jwks_uri'),
    grantTypes: text('grant_types').array(),
    responseTypes: text('response_types').array(),
    requirePKCE: boolean('require_pkce'),
    dpopBoundAccessTokens: boolean('dpop_bound_access_tokens').default(false),
    referenceId: text('reference_id'),
    metadata: jsonb('metadata'),
  },
  (table) => [index('auth_oauth_client_user_id_idx').on(table.userId)],
);

export const oauthResource = authSchema.table('oauth_resource', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull().unique(),
  name: text('name').notNull(),
  accessTokenTtl: integer('access_token_ttl'),
  refreshTokenTtl: integer('refresh_token_ttl'),
  signingAlgorithm: text('signing_algorithm'),
  signingKeyId: text('signing_key_id'),
  allowedScopes: text('allowed_scopes').array(),
  customClaims: jsonb('custom_claims'),
  dpopBoundAccessTokensRequired: boolean('dpop_bound_access_tokens_required').default(false),
  disabled: boolean('disabled').default(false),
  createdAt: timestamp('created_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }),
  policyVersion: integer('policy_version').default(1),
  metadata: jsonb('metadata'),
});

export const oauthClientResource = authSchema.table(
  'oauth_client_resource',
  {
    id: text('id').primaryKey(),
    clientId: text('client_id')
      .notNull()
      .references(() => oauthClient.clientId, { onDelete: 'cascade' }),
    resourceId: text('resource_id')
      .notNull()
      .references(() => oauthResource.identifier, { onDelete: 'cascade' }),
    metadata: jsonb('metadata'),
    createdAt: timestamp('created_at', { withTimezone: true }),
  },
  (table) => [
    index('auth_oauth_client_resource_client_id_idx').on(table.clientId),
    index('auth_oauth_client_resource_resource_id_idx').on(table.resourceId),
    uniqueIndex('auth_oauth_client_resource_client_id_resource_id_uk').on(table.clientId, table.resourceId),
  ],
);

export const oauthRefreshToken = authSchema.table(
  'oauth_refresh_token',
  {
    id: text('id').primaryKey(),
    token: text('token').notNull().unique(),
    clientId: text('client_id')
      .notNull()
      .references(() => oauthClient.clientId, { onDelete: 'cascade' }),
    sessionId: text('session_id').references(() => session.id, { onDelete: 'set null' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    referenceId: text('reference_id'),
    authorizationCodeId: text('authorization_code_id'),
    resources: text('resources').array(),
    requestedUserInfoClaims: text('requested_user_info_claims').array(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }),
    revoked: timestamp('revoked', { withTimezone: true }),
    rotatedAt: timestamp('rotated_at', { withTimezone: true }),
    rotationReplayResponse: text('rotation_replay_response'),
    rotationReplayExpiresAt: timestamp('rotation_replay_expires_at', { withTimezone: true }),
    authTime: timestamp('auth_time', { withTimezone: true }),
    confirmation: jsonb('confirmation'),
    scopes: text('scopes').array().notNull(),
  },
  (table) => [
    index('auth_oauth_refresh_token_client_id_idx').on(table.clientId),
    index('auth_oauth_refresh_token_session_id_idx').on(table.sessionId),
    index('auth_oauth_refresh_token_user_id_idx').on(table.userId),
    index('auth_oauth_refresh_token_authorization_code_id_idx').on(table.authorizationCodeId),
    index('auth_oauth_refresh_token_reference_id_idx').on(table.referenceId),
  ],
);

export const oauthAccessToken = authSchema.table(
  'oauth_access_token',
  {
    id: text('id').primaryKey(),
    token: text('token').unique(),
    clientId: text('client_id')
      .notNull()
      .references(() => oauthClient.clientId, { onDelete: 'cascade' }),
    sessionId: text('session_id').references(() => session.id, { onDelete: 'set null' }),
    userId: text('user_id').references(() => user.id, { onDelete: 'cascade' }),
    referenceId: text('reference_id'),
    authorizationCodeId: text('authorization_code_id'),
    resources: text('resources').array(),
    requestedUserInfoClaims: text('requested_user_info_claims').array(),
    refreshId: text('refresh_id').references(() => oauthRefreshToken.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }),
    revoked: timestamp('revoked', { withTimezone: true }),
    confirmation: jsonb('confirmation'),
    scopes: text('scopes').array().notNull(),
  },
  (table) => [
    index('auth_oauth_access_token_client_id_idx').on(table.clientId),
    index('auth_oauth_access_token_session_id_idx').on(table.sessionId),
    index('auth_oauth_access_token_user_id_idx').on(table.userId),
    index('auth_oauth_access_token_authorization_code_id_idx').on(table.authorizationCodeId),
    index('auth_oauth_access_token_refresh_id_idx').on(table.refreshId),
    index('auth_oauth_access_token_reference_id_idx').on(table.referenceId),
  ],
);

export const oauthConsent = authSchema.table(
  'oauth_consent',
  {
    id: text('id').primaryKey(),
    clientId: text('client_id')
      .notNull()
      .references(() => oauthClient.clientId, { onDelete: 'cascade' }),
    userId: text('user_id').references(() => user.id, { onDelete: 'cascade' }),
    referenceId: text('reference_id'),
    resources: text('resources').array(),
    requestedUserInfoClaims: text('requested_user_info_claims').array(),
    scopes: text('scopes').array().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }),
  },
  (table) => [
    index('auth_oauth_consent_client_id_idx').on(table.clientId),
    index('auth_oauth_consent_user_id_idx').on(table.userId),
    index('auth_oauth_consent_reference_id_idx').on(table.referenceId),
  ],
);

export const oauthClientAssertion = authSchema.table('oauth_client_assertion', {
  id: text('id').primaryKey(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
});

export const authDatabaseSchema = {
  account,
  apikey,
  jwks,
  oauthAccessToken,
  oauthClient,
  oauthClientAssertion,
  oauthClientResource,
  oauthConsent,
  oauthRefreshToken,
  oauthResource,
  session,
  supportImpersonationRecovery,
  user,
  verification,
} as const;

/**
 * Relational Queries v2 graph for the Auth owner. Better Auth resolves models through the table
 * map above; the relations only add typed `db.query` navigation and join support.
 */
export const authRelations = defineRelations(authDatabaseSchema, (r) => ({
  user: {
    sessions: r.many.session(),
    accounts: r.many.account(),
    apiKeys: r.many.apikey(),
  },
  session: {
    user: r.one.user({
      from: r.session.userId,
      to: r.user.id,
      optional: false,
    }),
  },
  account: {
    user: r.one.user({
      from: r.account.userId,
      to: r.user.id,
      optional: false,
    }),
  },
  apikey: {
    user: r.one.user({
      from: r.apikey.referenceId,
      to: r.user.id,
      optional: false,
    }),
  },
}));

export const AUTH_TABLES = [
  user,
  session,
  account,
  verification,
  apikey,
  supportImpersonationRecovery,
  jwks,
  oauthClient,
  oauthResource,
  oauthClientResource,
  oauthRefreshToken,
  oauthAccessToken,
  oauthConsent,
  oauthClientAssertion,
] as const;
