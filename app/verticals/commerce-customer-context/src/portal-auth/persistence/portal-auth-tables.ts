import { defineRelations, sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  index,
  integer,
  pgSchema,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { portalAuthAuditEvent } from '../audit/audit-tables.ts';

/** The Commerce portal owns this schema and migration history independently of Core and Staff. */
export const COMMERCE_PORTAL_AUTH_SCHEMA_NAME = 'commerce_auth';
export const COMMERCE_PORTAL_AUTH_TABLE_INVENTORY = [
  'user',
  'session',
  'account',
  'verification',
  'rateLimit',
  'twoFactor',
  'stepUpChallenge',
  'stepUpChallengeAttempt',
  'recoveryReconciliation',
  'recoveryResetLedger',
  'accountCreationCorrelation',
  'portalAuthAuditEvent',
] as const;

/**
 * `drizzle.portal-auth.config.ts` names this module as its schema input, and Drizzle Kit reads a
 * schema through the module's own exports. The schema handle and every table below therefore stay
 * exported even where nothing else imports them: unexporting one hides it from migration
 * generation, and the next generated migration drops the live table.
 */
export const commercePortalAuthSchema = pgSchema(COMMERCE_PORTAL_AUTH_SCHEMA_NAME);

export const user = commercePortalAuthSchema.table('user', {
  // Provider controls own status; browser assertions never establish these values.
  banExpires: timestamp('ban_expires', { withTimezone: true }),
  banned: boolean('banned').default(false),
  banReason: text('ban_reason'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified').default(false).notNull(),
  id: text('id').primaryKey(),
  image: text('image'),
  name: text('name').notNull(),
  twoFactorEnabled: boolean('two_factor_enabled').default(false),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export const session = commercePortalAuthSchema.table(
  'session',
  {
    /**
     * The last primary or step-up authentication on this session. Better Auth owns the insert at
     * sign-in and knows nothing of this column, so a row it wrote answers NULL and every reader
     * falls back to `created_at` — which for such a row *is* the authentication time. The owner's
     * identifier rotation deliberately carries `created_at` forward so the absolute session
     * lifetime survives a rotation, so a completed step-up stamps this column instead: without it
     * a session older than the freshness window could never become fresh again.
     */
    authenticatedAt: timestamp('authenticated_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    id: text('id').primaryKey(),
    ipAddress: text('ip_address'),
    // This private token is never returned in a session reference.
    token: text('token').notNull().unique(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
    userAgent: text('user_agent'),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
  },
  (table) => [index('commerce_auth_session_user_id_idx').on(table.userId)],
);

export const account = commercePortalAuthSchema.table(
  'account',
  {
    accessToken: text('access_token'),
    accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }),
    accountId: text('account_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    id: text('id').primaryKey(),
    idToken: text('id_token'),
    issuer: text('issuer').notNull(),
    password: text('password'),
    providerId: text('provider_id').notNull(),
    refreshToken: text('refresh_token'),
    refreshTokenExpiresAt: timestamp('refresh_token_expires_at', { withTimezone: true }),
    scope: text('scope'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
  },
  (table) => [
    uniqueIndex('commerce_auth_account_issuer_account_id_uk').on(table.issuer, table.accountId),
    index('commerce_auth_account_user_id_idx').on(table.userId),
  ],
);

export const verification = commercePortalAuthSchema.table(
  'verification',
  {
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    id: text('id').primaryKey(),
    identifier: text('identifier').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
    value: text('value').notNull(),
  },
  (table) => [index('commerce_auth_verification_identifier_idx').on(table.identifier)],
);

/** Better Auth stores rate-limit timestamps as epoch milliseconds. bigint avoids 2038 overflow. */
export const rateLimit = commercePortalAuthSchema.table('rate_limit', {
  count: bigint('count', { mode: 'number' }).notNull(),
  // Better Auth supplies an identifier for every adapter model, including rate-limit rows.
  id: text('id')
    .notNull()
    .unique()
    .default(sql`gen_random_uuid()::text`),
  key: text('key').primaryKey(),
  lastRequest: bigint('last_request', { mode: 'number' }).notNull(),
});

/** Better Auth's two-factor plugin owns these fields and their optional/default semantics. */
export const twoFactor = commercePortalAuthSchema.table(
  'two_factor',
  {
    backupCodes: text('backup_codes').notNull(),
    failedVerificationCount: integer('failed_verification_count').default(0),
    id: text('id').primaryKey(),
    lockedUntil: timestamp('locked_until', { withTimezone: true }),
    secret: text('secret').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    verified: boolean('verified').default(true),
  },
  (table) => [
    index('commerce_auth_two_factor_secret_idx').on(table.secret),
    index('commerce_auth_two_factor_user_id_idx').on(table.userId),
  ],
);

/** Step-up challenges store only a digest of the public challenge identifier. */
export const stepUpChallenge = commercePortalAuthSchema.table(
  'step_up_challenge',
  {
    attemptsRemaining: smallint('attempts_remaining').notNull(),
    challengeIdHash: text('challenge_id_hash').primaryKey(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    providerSubjectId: text('provider_subject_id').notNull(),
    sessionId: text('session_id').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index('commerce_auth_step_up_challenge_expires_at_idx').on(table.expiresAt)],
);

/** A reservation makes each attempt one-use and lets outages refund exactly one budget slot. */
export const stepUpChallengeAttempt = commercePortalAuthSchema.table(
  'step_up_challenge_attempt',
  {
    challengeIdHash: text('challenge_id_hash')
      .notNull()
      .references(() => stepUpChallenge.challengeIdHash, { onDelete: 'cascade' }),
    providerSubjectId: text('provider_subject_id').notNull(),
    reservationId: text('reservation_id').primaryKey(),
    reservedAt: timestamp('reserved_at', { withTimezone: true }).defaultNow().notNull(),
    sessionId: text('session_id').notNull(),
  },
  (table) => [index('commerce_auth_step_up_attempt_challenge_id_hash_idx').on(table.challengeIdHash)],
);

/**
 * A support-visible, append-mostly audit of detected recovery evidence conflicts. Recording a row
 * here is the only effect detection ever has: it never updates `user`, `session` or `account`, and
 * it never grants access. `providerSubjectId` is unconstrained text (no FK to `user.id`), matching
 * `stepUpChallenge.providerSubjectId` — the whole point of this table is that the subject may no
 * longer name any account row at all (`TOKEN_SUBJECT_STALE`).
 */
export const recoveryReconciliation = commercePortalAuthSchema.table(
  'recovery_reconciliation',
  {
    conflictClass: text('conflict_class').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    // The account that currently owns the identifier, when one does; null names no current owner.
    currentProviderSubjectId: text('current_provider_subject_id'),
    email: text('email').notNull(),
    id: text('id').primaryKey(),
    operation: text('operation').notNull(),
    providerSubjectId: text('provider_subject_id').notNull(),
  },
  (table) => [
    index('commerce_auth_recovery_reconciliation_email_idx').on(table.email),
    uniqueIndex('commerce_auth_recovery_reconciliation_dedupe_uk').on(
      table.operation,
      table.providerSubjectId,
      table.email,
      table.conflictClass,
    ),
  ],
);

/**
 * Commerce-owned issuance-time evidence for password-reset requests, kept out of Better Auth's
 * shared `verification` table so this vertical can own its own keys.
 *
 * `tokenDigest` is the primary key: one row per live token. Better Auth keeps every unexpired reset
 * token it issued valid, so keying by identifier would let a second request overwrite the first
 * token's binding and leave that still-acceptable token with no ledger row to reconcile against.
 * `identifierDigest` is indexed rather than unique for the same reason. Re-registering the *same*
 * token upserts its own row, which keeps a retried issuance idempotent. A terminal row — `expired`
 * by the sweep, `consumed` by a successful reset — clears `providerSubjectId` and `email`,
 * retaining only that it existed.
 */
export const recoveryResetLedger = commercePortalAuthSchema.table(
  'recovery_reset_ledger',
  {
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    email: text('email'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    identifierDigest: text('identifier_digest').notNull(),
    providerSubjectId: text('provider_subject_id'),
    state: text('state').notNull().default('pending'),
    tokenDigest: text('token_digest').primaryKey(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('commerce_auth_recovery_reset_ledger_identifier_digest_idx').on(table.identifierDigest),
    index('commerce_auth_recovery_reset_ledger_state_expires_at_idx').on(table.state, table.expiresAt),
  ],
);

/**
 * Which governed owner invocation created which provider account, written by the realm inside the
 * very sign-up call that commits the `user` row. Better Auth can commit that row and still lose its
 * answer — a timed-out call, an unusable payload, or a process exit before the Attempt journals the
 * outcome — and an Attempt with no recorded subject has nothing to key the exact provider lookup
 * on, so its reconciliation stays permanently indeterminate and a retried start is refused by the
 * duplicate-email guard. This row is the provider-side key that survives that lost answer.
 *
 * `owner_invocation_id` is the primary key because one governed invocation may create at most one
 * account, and `provider_subject_id` is unique because one account answers to at most one
 * invocation: either constraint alone would let a second creation quietly claim the same identity.
 * Deliberately outside `commercePortalAuthDatabaseSchema`: Better Auth owns no model here.
 */
export const accountCreationCorrelation = commercePortalAuthSchema.table('account_creation_correlation', {
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  ownerInvocationId: text('owner_invocation_id').primaryKey(),
  portalEnrollmentAttemptId: uuid('portal_enrollment_attempt_id').notNull(),
  providerSubjectId: text('provider_subject_id').notNull().unique(),
  tenantId: uuid('tenant_id').notNull(),
});

export const commercePortalAuthDatabaseSchema = {
  account,
  rateLimit,
  recoveryReconciliation,
  recoveryResetLedger,
  session,
  stepUpChallenge,
  stepUpChallengeAttempt,
  twoFactor,
  user,
  verification,
} as const;

export const commercePortalAuthRelations = defineRelations(commercePortalAuthDatabaseSchema, (r) => ({
  account: {
    user: r.one.user({
      from: r.account.userId,
      optional: false,
      to: r.user.id,
    }),
  },
  session: {
    user: r.one.user({
      from: r.session.userId,
      optional: false,
      to: r.user.id,
    }),
  },
  stepUpChallenge: {
    attempts: r.many.stepUpChallengeAttempt(),
  },
  stepUpChallengeAttempt: {
    challenge: r.one.stepUpChallenge({
      from: r.stepUpChallengeAttempt.challengeIdHash,
      optional: false,
      to: r.stepUpChallenge.challengeIdHash,
    }),
  },
  twoFactor: {
    user: r.one.user({
      from: r.twoFactor.userId,
      optional: false,
      to: r.user.id,
    }),
  },
  user: {
    accounts: r.many.account(),
    sessions: r.many.session(),
  },
}));

/** Drizzle tables used by the Better Auth adapter; no Core or customer tables belong here. */
export const COMMERCE_PORTAL_AUTH_TABLES = [
  user,
  session,
  account,
  verification,
  rateLimit,
  twoFactor,
  stepUpChallenge,
  stepUpChallengeAttempt,
  recoveryReconciliation,
  recoveryResetLedger,
  accountCreationCorrelation,
  portalAuthAuditEvent,
] as const;
