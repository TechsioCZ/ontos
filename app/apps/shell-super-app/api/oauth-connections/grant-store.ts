/**
 * Shell database store of MCP connection grants (core.oauth_connection_grants), their auth binding
 * (core.principal_auth_bindings, subject type `oauth_grant`) and the connection audit trail. Pure row mapping stays in
 * this file; the wire shapes live in @app/shared-contracts/oauth-connections.
 */
import { randomUUID } from 'node:crypto';

import { STAFF_AUTHENTICATION_NAMESPACE_ID } from '@app/core-runtime/auth/staff-authentication-namespace';
import {
  ConnectionModulesRequestSchema,
  type ConnectionActingKind,
  type ConnectionClientKind,
  type ConnectionGrantStatus,
  type ConnectionModulesRequest,
  type ConnectionRevokeReason,
  type ConnectionWritePolicy,
} from '@app/shared-contracts/oauth-connections';
import { and, asc, desc, eq, inArray, isNull, ne, or, type SQL, sql } from 'drizzle-orm';
import { integer, jsonb, pgSchema, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { Effect, Option, Schema } from 'effect';

import { AuthDatabase } from '../auth/db/client.ts';
import { user } from '../auth/db/schema.ts';
import { ConnectionUnavailable } from './errors.ts';
import type { GrantListFilter, GrantRow, NewDraftGrant } from './types.ts';

const core = pgSchema('core');

const grants = core.table('oauth_connection_grants', {
  actingKind: text('acting_kind').notNull(),
  actingPrincipalId: uuid('acting_principal_id').notNull(),
  authBindingId: uuid('auth_binding_id'),
  clientHost: text('client_host').notNull(),
  clientId: text('client_id').notNull(),
  clientKind: text('client_kind').notNull(),
  clientLogoUri: text('client_logo_uri'),
  clientName: text('client_name').notNull(),
  consentId: text('consent_id'),
  consentedAt: timestamp('consented_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  grantId: uuid('grant_id').notNull().defaultRandom(),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  legalEntityId: uuid('legal_entity_id').notNull(),
  modulesJson: jsonb('modules_json').$type<unknown>().notNull(),
  profileId: uuid('profile_id').notNull(),
  revokeReason: text('revoke_reason'),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  revokedByPrincipalId: uuid('revoked_by_principal_id'),
  sessionId: text('session_id'),
  status: text('status').notNull(),
  tenantId: uuid('tenant_id').notNull(),
  userId: text('user_id').notNull(),
  userPrincipalId: uuid('user_principal_id').notNull(),
  writePolicy: text('write_policy').notNull(),
});

const bindings = core.table('principal_auth_bindings', {
  authenticationNamespaceId: text('authentication_namespace_id').notNull(),
  bindingRevision: integer('binding_revision').notNull(),
  principalAuthBindingId: uuid('principal_auth_binding_id').notNull(),
  principalId: uuid('principal_id').notNull(),
  provider: text('provider').notNull(),
  providerSubjectId: text('provider_subject_id').notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  status: text('status').notNull(),
  subjectType: text('subject_type').notNull(),
  tenantId: uuid('tenant_id').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
});

const principals = core.table('principals', {
  displayName: text('display_name').notNull(),
  kind: text('kind').notNull(),
  principalId: uuid('principal_id').notNull(),
  status: text('status').notNull(),
  tenantId: uuid('tenant_id').notNull(),
});

const legalEntities = core.table('legal_entities', {
  legalEntityId: uuid('legal_entity_id').notNull(),
  legalName: text('legal_name').notNull(),
  tenantId: uuid('tenant_id').notNull(),
});

const coreAuditEventsWrite = core.table('audit_events', {
  auditProfile: text('audit_profile').notNull(),
  authBindingId: uuid('auth_binding_id'),
  authMethod: text('auth_method').notNull(),
  eventType: text('event_type').notNull(),
  evidenceJson: jsonb('evidence_json').$type<Readonly<Record<string, unknown>>>().notNull(),
  legalEntityId: uuid('legal_entity_id'),
  outcome: text('outcome').notNull(),
  outcomeCode: text('outcome_code').notNull(),
  outcomeStage: text('outcome_stage').notNull(),
  principalId: uuid('principal_id'),
  targetModuleKey: text('target_module_key'),
  tenantId: uuid('tenant_id').notNull(),
});

const ACTING_KINDS: readonly ConnectionActingKind[] = ['human', 'agent'];
const CLIENT_KINDS: readonly ConnectionClientKind[] = ['cimd', 'loopback'];
const GRANT_STATUSES: readonly ConnectionGrantStatus[] = ['draft', 'active', 'denied', 'revoked', 'superseded'];
const WRITE_POLICIES: readonly ConnectionWritePolicy[] = ['read_only', 'approval', 'direct'];
const REVOKE_REASONS: readonly ConnectionRevokeReason[] = [
  'user',
  'admin',
  'superseded',
  'operator_removed',
  'agent_disabled',
  'user_disabled',
  'password_changed',
];

const GRANT_ID_PATTERN = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/iu;
const DRAFT_TTL = sql`interval '30 minutes'`;

const isOneOf = <T extends string>(values: readonly T[], value: string): value is T =>
  (values as readonly string[]).includes(value);

const unavailable = (cause: unknown) => new ConnectionUnavailable({ cause });

type DbGrant = typeof grants.$inferSelect;

/** Maps a database row to the grant row; unknown literals fall back to the safest value. */
const toGrantRow = (row: DbGrant): GrantRow => ({
  actingKind: isOneOf(ACTING_KINDS, row.actingKind) ? row.actingKind : 'human',
  actingPrincipalId: row.actingPrincipalId,
  authBindingId: row.authBindingId,
  clientHost: row.clientHost,
  clientId: row.clientId,
  clientKind: isOneOf(CLIENT_KINDS, row.clientKind) ? row.clientKind : 'cimd',
  clientLogoUri: row.clientLogoUri,
  clientName: row.clientName,
  consentId: row.consentId,
  consentedAt: row.consentedAt,
  createdAt: row.createdAt,
  grantId: row.grantId,
  lastUsedAt: row.lastUsedAt,
  legalEntityId: row.legalEntityId,
  modules: Option.getOrElse(Schema.decodeUnknownOption(ConnectionModulesRequestSchema)(row.modulesJson), () => []),
  profileId: row.profileId,
  revokeReason:
    row.revokeReason !== null && isOneOf(REVOKE_REASONS, row.revokeReason) ? row.revokeReason : null,
  revokedAt: row.revokedAt,
  revokedByPrincipalId: row.revokedByPrincipalId,
  sessionId: row.sessionId,
  status: isOneOf(GRANT_STATUSES, row.status) ? row.status : 'revoked',
  tenantId: row.tenantId,
  userId: row.userId,
  userPrincipalId: row.userPrincipalId,
  writePolicy: isOneOf(WRITE_POLICIES, row.writePolicy) ? row.writePolicy : 'read_only',
});

const firstGrant = (rows: readonly DbGrant[]): GrantRow | undefined => {
  const row = rows[0];
  return row === undefined ? undefined : toGrantRow(row);
};

/** Same-key lookup of the "one profile per (user, company, acting principal, client)" rule. */
export interface GrantKey {
  readonly actingPrincipalId: string;
  readonly clientId: string;
  readonly legalEntityId: string;
  readonly userId: string;
}

const sameKey = (key: GrantKey): SQL[] => [
  eq(grants.actingPrincipalId, key.actingPrincipalId),
  eq(grants.clientId, key.clientId),
  eq(grants.legalEntityId, key.legalEntityId),
  eq(grants.userId, key.userId),
];

/** Drops expired drafts, then inserts the new draft. */
export const insertDraftGrant = Effect.fn('OAuthGrantStore.insertDraftGrant')(function* (input: NewDraftGrant) {
  const { executor } = yield* AuthDatabase;
  yield* executor
    .delete(grants)
    .where(and(eq(grants.status, 'draft'), sql`${grants.createdAt} < now() - ${DRAFT_TTL}`))
    .pipe(Effect.mapError(unavailable));
  const rows = yield* executor
    .insert(grants)
    .values({
      actingKind: input.actingKind,
      actingPrincipalId: input.actingPrincipalId,
      clientHost: input.clientHost,
      clientId: input.clientId,
      clientKind: input.clientKind,
      clientLogoUri: input.clientLogoUri,
      clientName: input.clientName,
      legalEntityId: input.legalEntityId,
      modulesJson: input.modules,
      profileId: input.profileId,
      sessionId: input.sessionId,
      status: 'draft',
      tenantId: input.tenantId,
      userId: input.userId,
      userPrincipalId: input.userPrincipalId,
      writePolicy: input.writePolicy,
    })
    .returning()
    .pipe(Effect.mapError(unavailable));
  return firstGrant(rows) as GrantRow;
});

export const findGrant = Effect.fn('OAuthGrantStore.findGrant')(function* (grantId: string) {
  if (!GRANT_ID_PATTERN.test(grantId)) {
    return undefined;
  }
  const { executor } = yield* AuthDatabase;
  const rows = yield* executor
    .select()
    .from(grants)
    .where(eq(grants.grantId, grantId))
    .limit(1)
    .pipe(Effect.mapError(unavailable));
  return firstGrant(rows);
});

/** Newest draft or active grant of this Better Auth session and user (the consent reference of the flow). */
export const findSessionGrant = Effect.fn('OAuthGrantStore.findSessionGrant')(function* (input: {
  readonly sessionId: string;
  readonly userId: string;
}) {
  const { executor } = yield* AuthDatabase;
  const rows = yield* executor
    .select()
    .from(grants)
    .where(
      and(
        eq(grants.sessionId, input.sessionId),
        eq(grants.userId, input.userId),
        inArray(grants.status, ['draft', 'active']),
        sql`${grants.createdAt} > now() - ${DRAFT_TTL}`,
      ),
    )
    .orderBy(desc(grants.createdAt))
    .limit(1)
    .pipe(Effect.mapError(unavailable));
  return firstGrant(rows);
});

export const findPreviousProfileId = Effect.fn('OAuthGrantStore.findPreviousProfileId')(function* (
  input: GrantKey,
) {
  const { executor } = yield* AuthDatabase;
  const rows = yield* executor
    .select({ profileId: grants.profileId })
    .from(grants)
    .where(and(...sameKey(input), inArray(grants.status, ['active', 'superseded', 'revoked'])))
    .orderBy(desc(grants.createdAt))
    .limit(1)
    .pipe(Effect.mapError(unavailable));
  return rows[0]?.profileId;
});

export const listActiveGrantsForKey = Effect.fn('OAuthGrantStore.listActiveGrantsForKey')(function* (
  input: GrantKey,
) {
  const { executor } = yield* AuthDatabase;
  const rows = yield* executor
    .select()
    .from(grants)
    .where(and(...sameKey(input), eq(grants.status, 'active')))
    .orderBy(desc(grants.createdAt))
    .pipe(Effect.mapError(unavailable));
  return rows.map(toGrantRow);
});

/** Moves a draft to active and binds it to its auth binding. Only drafts can be activated. */
export const activateGrant = Effect.fn('OAuthGrantStore.activateGrant')(function* (input: {
  readonly authBindingId: string;
  readonly grantId: string;
}) {
  if (!GRANT_ID_PATTERN.test(input.grantId)) {
    return undefined;
  }
  const { executor } = yield* AuthDatabase;
  const rows = yield* executor
    .update(grants)
    .set({ authBindingId: input.authBindingId, consentedAt: sql`now()`, status: 'active' })
    .where(and(eq(grants.grantId, input.grantId), eq(grants.status, 'draft')))
    .returning()
    .pipe(Effect.mapError(unavailable));
  return firstGrant(rows);
});

export const setGrantStatus = Effect.fn('OAuthGrantStore.setGrantStatus')(function* (input: {
  readonly grantId: string;
  readonly revokeReason: ConnectionRevokeReason | null;
  readonly revokedByPrincipalId: string | null;
  readonly status: 'denied' | 'revoked' | 'superseded';
}) {
  if (!GRANT_ID_PATTERN.test(input.grantId)) {
    return undefined;
  }
  const { executor } = yield* AuthDatabase;
  const rows = yield* executor
    .update(grants)
    .set({
      revokeReason: input.revokeReason,
      revokedAt: input.status === 'denied' ? null : sql`now()`,
      revokedByPrincipalId: input.revokedByPrincipalId,
      status: input.status,
    })
    .where(eq(grants.grantId, input.grantId))
    .returning()
    .pipe(Effect.mapError(unavailable));
  return firstGrant(rows);
});

/** Changes the requested ceiling and write policy of an active grant. */
export const updateGrantAccess = Effect.fn('OAuthGrantStore.updateGrantAccess')(function* (input: {
  readonly grantId: string;
  readonly modules: ConnectionModulesRequest;
  readonly writePolicy: ConnectionWritePolicy;
}) {
  if (!GRANT_ID_PATTERN.test(input.grantId)) {
    return undefined;
  }
  const { executor } = yield* AuthDatabase;
  const rows = yield* executor
    .update(grants)
    .set({ modulesJson: input.modules, writePolicy: input.writePolicy })
    .where(and(eq(grants.grantId, input.grantId), eq(grants.status, 'active')))
    .returning()
    .pipe(Effect.mapError(unavailable));
  return firstGrant(rows);
});

/** Writes `last_used_at` at most once per minute. Returns true when the row was written. */
export const touchGrantLastUsed = Effect.fn('OAuthGrantStore.touchGrantLastUsed')(function* (grantId: string) {
  if (!GRANT_ID_PATTERN.test(grantId)) {
    return false;
  }
  const { executor } = yield* AuthDatabase;
  const rows = yield* executor
    .update(grants)
    .set({ lastUsedAt: sql`now()` })
    .where(
      and(
        eq(grants.grantId, grantId),
        or(isNull(grants.lastUsedAt), sql`${grants.lastUsedAt} < now() - interval '1 minute'`),
      ),
    )
    .returning({ grantId: grants.grantId })
    .pipe(Effect.mapError(unavailable));
  return rows.length > 0;
});

export const listGrants = Effect.fn('OAuthGrantStore.listGrants')(function* (filter: GrantListFilter) {
  const conditions: SQL[] = [eq(grants.tenantId, filter.tenantId)];
  if (filter.actingPrincipalId !== undefined) {
    conditions.push(eq(grants.actingPrincipalId, filter.actingPrincipalId));
  }
  if (filter.clientId !== undefined) {
    conditions.push(eq(grants.clientId, filter.clientId));
  }
  if (filter.legalEntityId !== undefined) {
    conditions.push(eq(grants.legalEntityId, filter.legalEntityId));
  }
  if (filter.userId !== undefined) {
    conditions.push(eq(grants.userId, filter.userId));
  }
  if (filter.userPrincipalId !== undefined) {
    conditions.push(eq(grants.userPrincipalId, filter.userPrincipalId));
  }
  conditions.push(
    filter.statuses !== undefined && filter.statuses.length > 0
      ? inArray(grants.status, filter.statuses)
      : ne(grants.status, 'draft'),
  );
  const { executor } = yield* AuthDatabase;
  const rows = yield* executor
    .select()
    .from(grants)
    .where(and(...conditions))
    .orderBy(desc(grants.createdAt))
    .limit(500)
    .pipe(Effect.mapError(unavailable));
  return rows.map(toGrantRow);
});

/** Creates the `oauth_grant` auth binding of a grant and returns its id. */
export const insertGrantBinding = Effect.fn('OAuthGrantStore.insertGrantBinding')(function* (input: {
  readonly grantId: string;
  readonly principalId: string;
  readonly tenantId: string;
}) {
  const { executor } = yield* AuthDatabase;
  const principalAuthBindingId = randomUUID();
  yield* executor
    .insert(bindings)
    .values({
      authenticationNamespaceId: STAFF_AUTHENTICATION_NAMESPACE_ID,
      bindingRevision: 1,
      principalAuthBindingId,
      principalId: input.principalId,
      provider: 'better_auth',
      providerSubjectId: input.grantId,
      status: 'active',
      subjectType: 'oauth_grant',
      tenantId: input.tenantId,
      updatedAt: sql`now()`,
    })
    .pipe(Effect.mapError(unavailable));
  return principalAuthBindingId;
});

export const setGrantBindingStatus = Effect.fn('OAuthGrantStore.setGrantBindingStatus')(function* (input: {
  readonly authBindingId: string;
  readonly status: 'active' | 'disabled';
  readonly tenantId: string;
}) {
  const { executor } = yield* AuthDatabase;
  yield* executor
    .update(bindings)
    .set({
      bindingRevision: sql`${bindings.bindingRevision} + 1`,
      revokedAt: null,
      status: input.status,
      updatedAt: sql`now()`,
    })
    .where(
      and(eq(bindings.principalAuthBindingId, input.authBindingId), eq(bindings.tenantId, input.tenantId)),
    )
    .pipe(Effect.mapError(unavailable));
});

export const loadBindingStatus = Effect.fn('OAuthGrantStore.loadBindingStatus')(function* (input: {
  readonly authBindingId: string;
  readonly tenantId: string;
}) {
  const { executor } = yield* AuthDatabase;
  const rows = yield* executor
    .select({ status: bindings.status })
    .from(bindings)
    .where(
      and(eq(bindings.principalAuthBindingId, input.authBindingId), eq(bindings.tenantId, input.tenantId)),
    )
    .limit(1)
    .pipe(Effect.mapError(unavailable));
  return rows[0]?.status;
});

export const loadUserAccount = Effect.fn('OAuthGrantStore.loadUserAccount')(function* (userId: string) {
  const { executor } = yield* AuthDatabase;
  const rows = yield* executor
    .select({ banned: user.banned, emailVerified: user.emailVerified, name: user.name })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1)
    .pipe(Effect.mapError(unavailable));
  const row = rows[0];
  return row === undefined
    ? undefined
    : { banned: row.banned === true, emailVerified: row.emailVerified, name: row.name };
});

export const loadPrincipals = Effect.fn('OAuthGrantStore.loadPrincipals')(function* (
  tenantId: string,
  principalIds: readonly string[],
) {
  if (principalIds.length === 0) {
    return new Map<string, { displayName: string; kind: string; status: string }>();
  }
  const { executor } = yield* AuthDatabase;
  const rows = yield* executor
    .select({
      displayName: principals.displayName,
      kind: principals.kind,
      principalId: principals.principalId,
      status: principals.status,
    })
    .from(principals)
    .where(and(eq(principals.tenantId, tenantId), inArray(principals.principalId, principalIds)))
    .pipe(Effect.mapError(unavailable));
  return new Map(
    rows.map((row) => [row.principalId, { displayName: row.displayName, kind: row.kind, status: row.status }]),
  );
});

export const listAgentPrincipals = Effect.fn('OAuthGrantStore.listAgentPrincipals')(function* (tenantId: string) {
  const { executor } = yield* AuthDatabase;
  return yield* executor
    .select({ displayName: principals.displayName, principalId: principals.principalId })
    .from(principals)
    .where(and(eq(principals.tenantId, tenantId), eq(principals.kind, 'agent'), eq(principals.status, 'active')))
    .orderBy(asc(principals.displayName))
    .pipe(Effect.mapError(unavailable));
});

export const loadLegalNames = Effect.fn('OAuthGrantStore.loadLegalNames')(function* (
  tenantId: string,
  legalEntityIds: readonly string[],
) {
  if (legalEntityIds.length === 0) {
    return new Map<string, string>();
  }
  const { executor } = yield* AuthDatabase;
  const rows = yield* executor
    .select({ legalEntityId: legalEntities.legalEntityId, legalName: legalEntities.legalName })
    .from(legalEntities)
    .where(and(eq(legalEntities.tenantId, tenantId), inArray(legalEntities.legalEntityId, legalEntityIds)))
    .pipe(Effect.mapError(unavailable));
  return new Map(rows.map((row) => [row.legalEntityId, row.legalName]));
});

/** Writes a Core audit row for a connection event. Auditing never fails the request. */
export const recordConnectionAudit = Effect.fn('OAuthGrantStore.recordConnectionAudit')(function* (input: {
  readonly authBindingId: string | null;
  readonly authMethod: string;
  readonly eventType:
    | 'oauth.connection.created'
    | 'oauth.connection.updated'
    | 'oauth.connection.revoked'
    | 'oauth.connection.denied'
    | 'authn.connector_exchange';
  readonly evidence: Readonly<Record<string, string | null>>;
  readonly grant: GrantRow;
  readonly outcome: 'succeeded' | 'denied';
  readonly outcomeCode: string;
  readonly principalId: string | null;
}) {
  const { executor } = yield* AuthDatabase;
  yield* executor
    .insert(coreAuditEventsWrite)
    .values({
      auditProfile: 'sensitive',
      authBindingId: input.authBindingId,
      authMethod: input.authMethod,
      eventType: input.eventType,
      evidenceJson: {
        grantId: input.grant.grantId,
        clientId: input.grant.clientId,
        clientName: input.grant.clientName,
        ...input.evidence,
      },
      legalEntityId: input.grant.legalEntityId,
      outcome: input.outcome,
      outcomeCode: input.outcomeCode,
      outcomeStage: input.eventType === 'authn.connector_exchange' ? 'authn' : 'execution',
      principalId: input.principalId,
      targetModuleKey: 'core.identity',
      tenantId: input.grant.tenantId,
    })
    .pipe(Effect.ignore);
});
