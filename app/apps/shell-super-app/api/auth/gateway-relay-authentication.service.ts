import { PrincipalResolver, recoverSqlTransactionError } from '@app/core-runtime';
import type { GatewayTrustedPrincipalContext } from '@app/shared-contracts';
import { eq } from 'drizzle-orm';
import { Effect, Predicate } from 'effect';

import { AuthDatabase } from './db/client.ts';
import { apikey, session, user } from './db/schema.ts';
import { relayForbidden as forbidden, relayUnavailable as unavailable } from './gateway-relay-errors.ts';

const validateApiKey = Effect.fn('GatewayRelay.validateApiKey')(function* validateApiKey(
  original: GatewayTrustedPrincipalContext,
  providerKeyId: string,
  now: number,
) {
  const database = yield* AuthDatabase;
  const resolver = yield* PrincipalResolver;
  const [key] = yield* database.executor
    .select({ enabled: apikey.enabled, expiresAt: apikey.expiresAt })
    .from(apikey)
    .where(eq(apikey.id, providerKeyId))
    .limit(1)
    .pipe(recoverSqlTransactionError, Effect.mapError(unavailable));
  if (key === undefined || key.enabled !== true || (key.expiresAt !== null && key.expiresAt.getTime() <= now * 1000)) {
    return yield* forbidden();
  }
  const identity = yield* resolver.resolveBetterAuthApiKey(providerKeyId).pipe(Effect.mapError(forbidden));
  if (
    identity.principalId !== original.principalId ||
    identity.tenantId !== original.tenantId ||
    identity.authBindingId !== original.authBindingId
  ) {
    return yield* forbidden();
  }
  return yield* Effect.void;
});

const loadSession = Effect.fn('GatewayRelay.loadSession')(function* loadSession(
  original: GatewayTrustedPrincipalContext,
  sessionId: string,
  now: number,
) {
  const database = yield* AuthDatabase;
  const resolver = yield* PrincipalResolver;
  const [current] = yield* database.executor
    .select({
      actionId: session.impersonationActionId,
      activeLegalEntityId: session.activeLegalEntityId,
      activeTenantId: session.activeTenantId,
      banExpires: user.banExpires,
      banned: user.banned,
      expiresAt: session.expiresAt,
      impersonatedBy: session.impersonatedBy,
      originalAuthBindingId: session.impersonationOriginalAuthBindingId,
      originalPrincipalId: session.impersonationOriginalPrincipalId,
      originalSessionId: session.impersonationOriginalSessionId,
      reason: session.impersonationReason,
      targetPrincipalId: session.impersonationTargetPrincipalId,
      userId: session.userId,
    })
    .from(session)
    .innerJoin(user, eq(user.id, session.userId))
    .where(eq(session.id, sessionId))
    .limit(1)
    .pipe(recoverSqlTransactionError, Effect.mapError(unavailable));
  if (
    current === undefined ||
    current.expiresAt.getTime() <= now * 1000 ||
    current.activeTenantId !== original.tenantId ||
    current.activeLegalEntityId !== (original.legalEntityId ?? null) ||
    (current.banned === true && (current.banExpires === null || current.banExpires.getTime() > now * 1000))
  ) {
    return yield* forbidden();
  }
  const identity = yield* resolver
    .resolveBetterAuthUserForTenant(current.userId, original.tenantId)
    .pipe(Effect.mapError(forbidden));
  if (identity.principalId !== original.principalId || identity.authBindingId !== original.authBindingId) {
    return yield* forbidden();
  }
  return current;
});

type SourceSession = Effect.Success<ReturnType<typeof loadSession>>;
const validateImpersonation = Effect.fn('GatewayRelay.validateImpersonation')(function* validateImpersonation(
  original: GatewayTrustedPrincipalContext,
  current: SourceSession,
  sessionId: string,
  now: number,
) {
  if (
    current.impersonatedBy === null ||
    current.originalPrincipalId !== original.impersonatedByPrincipalId ||
    current.targetPrincipalId !== original.principalId ||
    current.actionId === null ||
    current.reason === null ||
    current.originalSessionId === null ||
    current.originalAuthBindingId === null ||
    current.originalPrincipalId === null
  ) {
    return yield* forbidden();
  }
  const database = yield* AuthDatabase;
  const resolver = yield* PrincipalResolver;
  const [originalSession] = yield* database.executor
    .select({
      banExpires: user.banExpires,
      banned: user.banned,
      expiresAt: session.expiresAt,
      userId: session.userId,
    })
    .from(session)
    .innerJoin(user, eq(user.id, session.userId))
    .where(eq(session.id, current.originalSessionId))
    .limit(1)
    .pipe(recoverSqlTransactionError, Effect.mapError(unavailable));
  if (
    originalSession === undefined ||
    originalSession.userId !== current.impersonatedBy ||
    originalSession.expiresAt.getTime() <= now * 1000 ||
    (originalSession.banned === true &&
      (originalSession.banExpires === null || originalSession.banExpires.getTime() > now * 1000))
  ) {
    return yield* forbidden();
  }
  const impersonator = yield* resolver
    .resolveBetterAuthUserForTenant(originalSession.userId, original.tenantId)
    .pipe(Effect.mapError(forbidden));
  if (
    impersonator.principalId !== original.impersonatedByPrincipalId ||
    impersonator.authBindingId !== current.originalAuthBindingId
  ) {
    return yield* forbidden();
  }
  const verifyStarted = resolver.verifySupportImpersonationStarted;
  if (!Predicate.isFunction(verifyStarted)) {
    return yield* unavailable();
  }
  const started = yield* verifyStarted({
    actionId: current.actionId,
    originalPrincipalId: current.originalPrincipalId,
    reason: current.reason,
    sessionId,
    targetPrincipalId: original.principalId,
    tenantId: original.tenantId,
  }).pipe(Effect.mapError(unavailable));
  if (!started) {
    return yield* forbidden();
  }
  return yield* Effect.void;
});

/** Rechecks the signed authentication reference, not the calling deployment's unrelated credential. */
export const validateRelayAuthentication = Effect.fn('GatewayRelay.validateAuthentication')(
  function* validateRelayAuthentication(original: GatewayTrustedPrincipalContext, now: number) {
    const reference = original.authContextRef;
    if (reference === undefined) {
      return yield* forbidden();
    }
    if (original.authMethod === 'api_key' && reference.startsWith('better-auth-api-key:')) {
      return yield* validateApiKey(original, reference.slice('better-auth-api-key:'.length), now);
    }
    if (
      (original.authMethod !== 'session' && original.authMethod !== 'support_impersonation') ||
      !reference.startsWith('better-auth-session:')
    ) {
      return yield* forbidden();
    }
    const sessionId = reference.slice('better-auth-session:'.length);
    const current = yield* loadSession(original, sessionId, now);
    if (original.authMethod === 'support_impersonation') {
      return yield* validateImpersonation(original, current, sessionId, now);
    }
    if (current.impersonatedBy !== null || original.impersonatedByPrincipalId !== undefined) {
      return yield* forbidden();
    }
    return yield* Effect.void;
  },
);
