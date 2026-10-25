import { randomUUID } from 'node:crypto';

import { and, asc, desc, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { Effect, Layer, Option, Schema } from 'effect';

import { CoreDatabase } from '../db/client.ts';
import { oauthConnectionGrants as grants, principalAuthBindings as bindings, principals } from '../db/schema.ts';
import { STAFF_AUTHENTICATION_NAMESPACE_ID } from './staff-authentication-namespace.ts';
import { OAuthGrantRecordFactsSchema } from './oauth-grant-registry-contract.ts';
import { OAuthGrantRegistryUnavailable } from './oauth-grant-registry-unavailable.ts';
import type { CoreDatabaseExecutor } from '../db/types.ts';
import type {
  OAuthGrantRecord,
  OAuthGrantActivation,
  OAuthGrantDraft,
  OAuthGrantListFilter,
  OAuthGrantKey,
  OAuthGrantModules,
} from './oauth-grant-registry-contract.ts';
import { OAuthGrantRegistry } from './oauth-grant-registry-service.ts';

const GRANT_ID_PATTERN = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/iu;
const DRAFT_TTL = sql`interval '30 minutes'`;

const isRegistryUnavailable = Schema.is(OAuthGrantRegistryUnavailable);
const unavailable = (cause: unknown) =>
  isRegistryUnavailable(cause) ? cause : new OAuthGrantRegistryUnavailable({ cause });

type DbGrant = typeof grants.$inferSelect;

/** Invalid retained facts are storage failures, never invented authority or historical evidence. */
const toOAuthGrantRecord = (row: DbGrant): Effect.Effect<OAuthGrantRecord, OAuthGrantRegistryUnavailable> =>
  Schema.decodeUnknownEffect(OAuthGrantRecordFactsSchema)({
    actingKind: row.actingKind,
    clientKind: row.clientKind,
    modules: row.modulesJson,
    revokeReason: row.revokeReason,
    status: row.status,
    writePolicy: row.writePolicy,
  }).pipe(
    Effect.map((facts) => ({
      actingKind: facts.actingKind,
      actingPrincipalId: row.actingPrincipalId,
      authBindingId: row.authBindingId,
      clientHost: row.clientHost,
      clientId: row.clientId,
      clientKind: facts.clientKind,
      clientLogoUri: row.clientLogoUri,
      clientName: row.clientName,
      consentedAt: row.consentedAt,
      consentId: row.consentId,
      createdAt: row.createdAt,
      grantId: row.grantId,
      lastUsedAt: row.lastUsedAt,
      legalEntityId: row.legalEntityId,
      modules: facts.modules,
      profileId: row.profileId,
      revokedAt: row.revokedAt,
      revokedByPrincipalId: row.revokedByPrincipalId,
      // Only a successfully decoded SQL null becomes null again; invalid reasons fail above.
      revokeReason: Option.getOrNull(facts.revokeReason),
      sessionId: row.sessionId,
      status: facts.status,
      tenantId: row.tenantId,
      userId: row.userId,
      userPrincipalId: row.userPrincipalId,
      writePolicy: facts.writePolicy,
    })),
    Effect.mapError(unavailable),
  );

const firstGrant = (
  rows: readonly DbGrant[],
): Effect.Effect<Option.Option<OAuthGrantRecord>, OAuthGrantRegistryUnavailable> =>
  rows[0] === undefined ? Effect.succeedNone : toOAuthGrantRecord(rows[0]).pipe(Effect.asSome);

/** Same-key lookup of the "one profile per (user, company, acting principal, client)" rule. */

const sameKey = (key: OAuthGrantKey): SQL[] => [
  eq(grants.actingPrincipalId, key.actingPrincipalId),
  eq(grants.clientId, key.clientId),
  eq(grants.legalEntityId, key.legalEntityId),
  eq(grants.userId, key.userId),
];

const makeRegistry = (executor: CoreDatabaseExecutor): (typeof OAuthGrantRegistry)['Service'] => {
  /** Drops expired drafts, then inserts the new draft. */
  const insertDraftGrant = Effect.fn('OAuthGrantRegistry.insertDraftGrant')(function* insertDraftGrant(
    input: OAuthGrantDraft,
  ) {
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
    const inserted = yield* firstGrant(rows);
    if (Option.isNone(inserted)) {
      return yield* unavailable('Draft insert returned no retained grant');
    }
    return inserted.value;
  });

  const findGrant = Effect.fn('OAuthGrantRegistry.findGrant')(function* findGrant(grantId: string) {
    if (!GRANT_ID_PATTERN.test(grantId)) {
      return Option.none<OAuthGrantRecord>();
    }
    const rows = yield* executor
      .select()
      .from(grants)
      .where(eq(grants.grantId, grantId))
      .limit(1)
      .pipe(Effect.mapError(unavailable));
    return yield* firstGrant(rows);
  });

  /** Newest draft or active grant of this Better Auth session and user (the consent reference of the flow). */
  const findSessionGrant = Effect.fn('OAuthGrantRegistry.findSessionGrant')(function* findSessionGrant(input: {
    readonly sessionId: string;
    readonly userId: string;
  }) {
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
    return yield* firstGrant(rows);
  });

  const findPreviousProfileId = Effect.fn('OAuthGrantRegistry.findPreviousProfileId')(function* findPreviousProfileId(
    input: OAuthGrantKey,
  ) {
    const rows = yield* executor
      .select()
      .from(grants)
      .where(and(...sameKey(input), inArray(grants.status, ['active', 'superseded', 'revoked'])))
      .orderBy(desc(grants.createdAt))
      .limit(1)
      .pipe(Effect.mapError(unavailable));
    return (yield* firstGrant(rows)).pipe(Option.map((record) => record.profileId));
  });

  /**
   * Activates a draft in one transaction under a per-key advisory lock, so at most one grant per (user, company,
   * acting principal, client) is active: moves the draft to active, supersedes the other active grants of the same
   * key, disables their bindings and creates the draft's `oauth_grant` binding. Returns None when the row is no
   * longer a draft (another approval of the same draft won); the caller finishes the superseded grants' side effects.
   */
  const approveDraftGrant = Effect.fn('OAuthGrantRegistry.approveDraftGrant')(function* approveDraftGrant(input: {
    readonly actorPrincipalId: string;
    readonly grant: OAuthGrantRecord;
  }) {
    const { grant } = input;
    if (!GRANT_ID_PATTERN.test(grant.grantId)) {
      return Option.none<OAuthGrantActivation>();
    }
    const lockKey = `oauth-connection-grant:${grant.tenantId}:${grant.userId}:${grant.legalEntityId}:${grant.actingPrincipalId}:${grant.clientId}`;
    return yield* executor
      .transaction(
        Effect.fn('OAuthGrantRegistry.approveTransaction')(function* approveInTransaction(transaction) {
          yield* transaction.execute(sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);
          const [draftRow] = yield* transaction
            .select()
            .from(grants)
            .where(
              and(
                eq(grants.grantId, grant.grantId),
                eq(grants.tenantId, grant.tenantId),
                ...sameKey(grant),
                eq(grants.userPrincipalId, grant.userPrincipalId),
                eq(grants.profileId, grant.profileId),
                grant.sessionId === null ? isNull(grants.sessionId) : eq(grants.sessionId, grant.sessionId),
                eq(grants.status, 'draft'),
                sql`${grants.createdAt} > now() - ${DRAFT_TTL}`,
              ),
            )
            .for('update');
          if (draftRow === undefined) {
            return Option.none<OAuthGrantActivation>();
          }
          const draft = yield* toOAuthGrantRecord(draftRow);
          // A callback can race principal disablement. Lock the real retained principals, never a forged context.
          const principalRows = yield* transaction
            .select()
            .from(principals)
            .where(
              and(
                eq(principals.tenantId, draft.tenantId),
                inArray(principals.principalId, [draft.actingPrincipalId, draft.userPrincipalId]),
              ),
            )
            .for('share');
          const acting = principalRows.find((row) => row.principalId === draft.actingPrincipalId);
          const human = principalRows.find((row) => row.principalId === draft.userPrincipalId);
          if (
            acting?.status !== 'active' ||
            acting.kind !== draft.actingKind ||
            human?.status !== 'active' ||
            human.kind !== 'human'
          ) {
            return Option.none<OAuthGrantActivation>();
          }
          const authBindingId = randomUUID();
          const active = yield* firstGrant(
            yield* transaction
              .update(grants)
              .set({ authBindingId, consentedAt: sql`now()`, status: 'active' })
              .where(and(eq(grants.grantId, grant.grantId), eq(grants.status, 'draft')))
              .returning(),
          );
          if (Option.isNone(active)) {
            return Option.none<OAuthGrantActivation>();
          }
          const supersededRows = yield* transaction
            .update(grants)
            .set({
              revokedAt: sql`now()`,
              revokedByPrincipalId: input.actorPrincipalId,
              revokeReason: 'superseded',
              status: 'superseded',
            })
            .where(
              and(
                eq(grants.tenantId, draft.tenantId),
                ...sameKey(draft),
                eq(grants.status, 'active'),
                ne(grants.grantId, draft.grantId),
              ),
            )
            .returning();
          const superseded = yield* Effect.forEach(supersededRows, toOAuthGrantRecord, { concurrency: 1 });
          const supersededBindingIds = superseded.flatMap((old) =>
            old.authBindingId === null ? [] : [old.authBindingId],
          );
          if (supersededBindingIds.length > 0) {
            yield* transaction
              .update(bindings)
              .set({
                bindingRevision: sql`${bindings.bindingRevision} + 1`,
                status: 'disabled',
                updatedAt: sql`now()`,
              })
              .where(
                and(
                  inArray(bindings.principalAuthBindingId, supersededBindingIds),
                  eq(bindings.tenantId, draft.tenantId),
                  eq(bindings.authenticationNamespaceId, STAFF_AUTHENTICATION_NAMESPACE_ID),
                  eq(bindings.provider, 'better_auth'),
                  eq(bindings.subjectType, 'oauth_grant'),
                  eq(bindings.status, 'active'),
                  isNull(bindings.revokedAt),
                ),
              );
          }
          yield* transaction.insert(bindings).values({
            authenticationNamespaceId: STAFF_AUTHENTICATION_NAMESPACE_ID,
            bindingRevision: 1,
            principalAuthBindingId: authBindingId,
            principalId: grant.actingPrincipalId,
            provider: 'better_auth',
            providerSubjectId: grant.grantId,
            status: 'active',
            subjectType: 'oauth_grant',
            tenantId: grant.tenantId,
            updatedAt: sql`now()`,
          });
          return Option.some({ active: active.value, superseded });
        }),
      )
      .pipe(Effect.mapError(unavailable));
  });

  const setGrantStatus = Effect.fn('OAuthGrantRegistry.setGrantStatus')(function* setGrantStatus(input: {
    readonly grantId: string;
    readonly revokedByPrincipalId: string | null;
    readonly revokeReason: NonNullable<OAuthGrantRecord['revokeReason']> | null;
    readonly status: 'denied' | 'revoked' | 'superseded';
  }) {
    if (!GRANT_ID_PATTERN.test(input.grantId)) {
      return Option.none<OAuthGrantRecord>();
    }
    return yield* executor
      .transaction(
        Effect.fn('OAuthGrantRegistry.transitionTransaction')(function* transitionGrant(transaction) {
          const [retainedRow] = yield* transaction
            .select()
            .from(grants)
            .where(eq(grants.grantId, input.grantId))
            .for('update');
          if (retainedRow === undefined) {
            return Option.none<OAuthGrantRecord>();
          }
          const retained = yield* toOAuthGrantRecord(retainedRow);
          if (input.status === 'denied' && retained.status === 'active') {
            return Option.none<OAuthGrantRecord>();
          }
          if (retained.authBindingId !== null) {
            yield* transaction
              .update(bindings)
              .set({
                bindingRevision: sql`${bindings.bindingRevision} + 1`,
                revokedAt: null,
                status: 'disabled',
                updatedAt: sql`now()`,
              })
              .where(
                and(
                  eq(bindings.tenantId, retained.tenantId),
                  eq(bindings.principalAuthBindingId, retained.authBindingId),
                  eq(bindings.authenticationNamespaceId, STAFF_AUTHENTICATION_NAMESPACE_ID),
                  eq(bindings.provider, 'better_auth'),
                  eq(bindings.subjectType, 'oauth_grant'),
                  eq(bindings.providerSubjectId, retained.grantId),
                  eq(bindings.principalId, retained.actingPrincipalId),
                  eq(bindings.status, 'active'),
                  isNull(bindings.revokedAt),
                ),
              );
          }
          // Terminal grants never reactivate or change historical attribution on repeated cleanup.
          if (retained.status !== 'draft' && retained.status !== 'active') {
            return Option.some(retained);
          }
          return yield* firstGrant(
            yield* transaction
              .update(grants)
              .set({
                revokedAt: input.status === 'denied' ? null : sql`now()`,
                revokedByPrincipalId: input.revokedByPrincipalId,
                revokeReason: input.revokeReason,
                status: input.status,
              })
              .where(eq(grants.grantId, input.grantId))
              .returning(),
          );
        }),
      )
      .pipe(Effect.mapError(unavailable));
  });

  /** Changes the requested ceiling and write policy of an active grant. */
  const updateGrantAccess = Effect.fn('OAuthGrantRegistry.updateGrantAccess')(function* updateGrantAccess(input: {
    readonly grantId: string;
    readonly modules: OAuthGrantModules;
    readonly writePolicy: OAuthGrantRecord['writePolicy'];
  }) {
    if (!GRANT_ID_PATTERN.test(input.grantId)) {
      return Option.none<OAuthGrantRecord>();
    }
    const rows = yield* executor
      .update(grants)
      .set({ modulesJson: input.modules, writePolicy: input.writePolicy })
      .where(and(eq(grants.grantId, input.grantId), eq(grants.status, 'active')))
      .returning()
      .pipe(Effect.mapError(unavailable));
    return yield* firstGrant(rows);
  });

  /** Writes `last_used_at` at most once per minute. Returns true when the row was written. */
  const touchGrantLastUsed = Effect.fn('OAuthGrantRegistry.touchGrantLastUsed')(function* touchGrantLastUsed(
    grantId: string,
  ) {
    if (!GRANT_ID_PATTERN.test(grantId)) {
      return false;
    }
    const rows = yield* executor
      .update(grants)
      .set({ lastUsedAt: sql`now()` })
      .where(
        and(
          eq(grants.grantId, grantId),
          or(isNull(grants.lastUsedAt), sql`${grants.lastUsedAt} < now() - interval '1 minute'`),
        ),
      )
      .returning()
      .pipe(Effect.mapError(unavailable));
    return Option.isSome(yield* firstGrant(rows));
  });

  const listGrants = Effect.fn('OAuthGrantRegistry.listGrants')(function* listGrants(filter: OAuthGrantListFilter) {
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
    const rows = yield* executor
      .select()
      .from(grants)
      .where(and(...conditions))
      .orderBy(desc(grants.createdAt))
      .limit(500)
      .pipe(Effect.mapError(unavailable));
    return yield* Effect.forEach(rows, toOAuthGrantRecord, { concurrency: 1 });
  });

  const setGrantBindingStatus = Effect.fn('OAuthGrantRegistry.setGrantBindingStatus')(
    function* setGrantBindingStatus(input: {
      readonly authBindingId: string;
      readonly status: 'active' | 'disabled';
      readonly tenantId: string;
    }) {
      yield* executor
        .transaction(
          Effect.fn('OAuthGrantRegistry.bindingTransaction')(function* changeDerivedBinding(transaction) {
            const [grantRow] = yield* transaction
              .select()
              .from(grants)
              .where(and(eq(grants.tenantId, input.tenantId), eq(grants.authBindingId, input.authBindingId)))
              .for('update');
            if (grantRow === undefined) {
              return yield* Effect.void;
            }
            const grant = yield* toOAuthGrantRecord(grantRow);
            if (input.status === 'active') {
              if (grant.status !== 'active') {
                return yield* unavailable('Cannot activate a terminal grant binding');
              }
              const activePrincipals = yield* transaction
                .select()
                .from(principals)
                .where(
                  and(
                    eq(principals.tenantId, grant.tenantId),
                    inArray(principals.principalId, [grant.actingPrincipalId, grant.userPrincipalId]),
                  ),
                )
                .for('share');
              if (
                activePrincipals.length === 0 ||
                activePrincipals.some((row) => row.status !== 'active') ||
                !activePrincipals.some(
                  (row) => row.principalId === grant.actingPrincipalId && row.kind === grant.actingKind,
                ) ||
                !activePrincipals.some((row) => row.principalId === grant.userPrincipalId && row.kind === 'human')
              ) {
                return yield* unavailable('Cannot activate an inactive principal binding');
              }
            }
            return yield* transaction
              .update(bindings)
              .set({
                bindingRevision: sql`${bindings.bindingRevision} + 1`,
                revokedAt: null,
                status: input.status,
                updatedAt: sql`now()`,
              })
              .where(
                and(
                  eq(bindings.principalAuthBindingId, input.authBindingId),
                  eq(bindings.tenantId, input.tenantId),
                  eq(bindings.authenticationNamespaceId, STAFF_AUTHENTICATION_NAMESPACE_ID),
                  eq(bindings.provider, 'better_auth'),
                  eq(bindings.subjectType, 'oauth_grant'),
                  eq(bindings.providerSubjectId, grant.grantId),
                  eq(bindings.principalId, grant.actingPrincipalId),
                  ne(bindings.status, input.status),
                  ne(bindings.status, 'revoked'),
                  isNull(bindings.revokedAt),
                ),
              )
              .pipe(Effect.asVoid);
          }),
        )
        .pipe(Effect.mapError(unavailable));
    },
  );

  const loadBindingStatus = Effect.fn('OAuthGrantRegistry.loadBindingStatus')(function* loadBindingStatus(input: {
    readonly authBindingId: string;
    readonly tenantId: string;
  }) {
    const rows = yield* executor
      .select({ status: bindings.status })
      .from(bindings)
      .where(
        and(
          eq(bindings.principalAuthBindingId, input.authBindingId),
          eq(bindings.tenantId, input.tenantId),
          eq(bindings.authenticationNamespaceId, STAFF_AUTHENTICATION_NAMESPACE_ID),
          eq(bindings.provider, 'better_auth'),
          eq(bindings.subjectType, 'oauth_grant'),
          isNull(bindings.revokedAt),
        ),
      )
      .limit(1)
      .pipe(Effect.mapError(unavailable));
    return Option.fromNullishOr(rows[0]?.status);
  });

  const loadPrincipals = Effect.fn('OAuthGrantRegistry.loadPrincipals')(function* loadPrincipals(
    tenantId: string,
    principalIds: readonly string[],
  ) {
    if (principalIds.length === 0) {
      return new Map<string, { displayName: string; kind: string; status: string }>();
    }
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

  const listAgentPrincipals = Effect.fn('OAuthGrantRegistry.listAgentPrincipals')(function* listAgentPrincipals(
    tenantId: string,
  ) {
    return yield* executor
      .select({ displayName: principals.displayName, principalId: principals.principalId })
      .from(principals)
      .where(and(eq(principals.tenantId, tenantId), eq(principals.kind, 'agent'), eq(principals.status, 'active')))
      .orderBy(asc(principals.displayName))
      .pipe(Effect.mapError(unavailable));
  });

  const owners = Effect.fn('OAuthGrantRegistry.owners')(function* owners(input: {
    readonly grantIds: readonly string[];
    readonly legalEntityId: string;
    readonly tenantId: string;
  }) {
    if (input.grantIds.length === 0) {
      return [];
    }
    const rows = yield* executor
      .select()
      .from(grants)
      .where(
        and(
          eq(grants.tenantId, input.tenantId),
          eq(grants.legalEntityId, input.legalEntityId),
          eq(grants.status, 'revoked'),
          inArray(grants.grantId, [...input.grantIds]),
        ),
      )
      .pipe(Effect.mapError(unavailable));
    const retained = yield* Effect.forEach(rows, toOAuthGrantRecord, { concurrency: 1 });
    return retained.map(({ grantId, legalEntityId, tenantId, userPrincipalId }) => ({
      grantId,
      legalEntityId,
      tenantId,
      userPrincipalId,
    }));
  });

  return {
    approveDraftGrant,
    findGrant,
    findPreviousProfileId,
    findSessionGrant,
    insertDraftGrant,
    listAgentPrincipals,
    listGrants,
    loadBindingStatus,
    loadPrincipals,
    owners,
    setGrantBindingStatus,
    setGrantStatus,
    touchGrantLastUsed,
    updateGrantAccess,
  };
};

/** Native Core issuer; no synthetic action principal and no Auth/admin database. */
export const OAuthGrantRegistryLive = Layer.effect(
  OAuthGrantRegistry,
  Effect.gen(function* oauthGrantRegistryService() {
    const { executor } = yield* CoreDatabase;
    return makeRegistry(executor);
  }),
);
