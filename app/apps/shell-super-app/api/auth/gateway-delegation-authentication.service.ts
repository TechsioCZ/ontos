import { PrincipalResolver, recoverSqlTransactionError } from '@app/core-runtime';
import type { GatewayTrustedPrincipalContext } from '@app/shared-contracts';
import { eq } from 'drizzle-orm';
import { Effect, Predicate } from 'effect';

import { AuthDatabase } from './db/client.ts';
import { apikey, session, user } from './db/schema.ts';
import { delegationForbidden as forbidden, delegationUnavailable as unavailable } from './gateway-delegation-errors.ts';

/** A Better Auth user ban holds while it is unexpired; an open-ended ban holds until lifted. */
export const userBanHoldsAt = (
  ban: { readonly banExpires: Date | null; readonly banned: boolean | null },
  now: number,
): boolean => ban.banned === true && (ban.banExpires === null || ban.banExpires.getTime() > now * 1000);

const validateApiKey = Effect.fn('GatewayDelegation.validateApiKey')(function* validateApiKey(
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

const loadSession = Effect.fn('GatewayDelegation.loadSession')(function* loadSession(
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
    userBanHoldsAt(current, now)
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
const validateImpersonation = Effect.fn('GatewayDelegation.validateImpersonation')(function* validateImpersonation(
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
    userBanHoldsAt(originalSession, now)
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

/** Rechecks the signed authentication reference of the subject; the calling module credential is never the subject. */
export const validateDelegationAuthentication = Effect.fn('GatewayDelegation.validateAuthentication')(
  function* validateDelegationAuthentication(original: GatewayTrustedPrincipalContext, now: number) {
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
