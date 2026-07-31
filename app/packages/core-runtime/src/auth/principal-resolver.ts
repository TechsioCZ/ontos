import { and, eq } from 'drizzle-orm';
import { Context, Effect, Layer } from 'effect';
import { CoreDatabase } from '../db/client.ts';
import { principalAuthBindings, principals, tenants } from '../db/schema.ts';
import {
  PrincipalBindingAmbiguousError,
  PrincipalBindingInactiveError,
  PrincipalBindingMissingError,
  PrincipalInactiveError,
  PrincipalResolverUnavailableError,
  TenantInactiveError,
} from './principal-resolver-errors.ts';
import type { PrincipalResolutionError } from './principal-resolver-errors.ts';

export interface ResolvedPrincipalIdentity {
  readonly displayName: string;
  readonly principalId: string;
  readonly tenantId: string;
}

export interface PrincipalResolutionRecord {
  readonly bindingRevokedAt: Date | null;
  readonly bindingStatus: string;
  readonly displayName: string;
  readonly principalId: string;
  readonly principalStatus: string;
  readonly tenantId: string;
  readonly tenantStatus: string;
}

export const classifyPrincipalResolution = (
  records: readonly PrincipalResolutionRecord[],
): Effect.Effect<ResolvedPrincipalIdentity, PrincipalResolutionError> => {
  if (records.length === 0) {
    return Effect.fail(new PrincipalBindingMissingError());
  }

  const activeBindings = records.filter(
    (record) => record.bindingStatus === 'active' && record.bindingRevokedAt === null,
  );

  if (activeBindings.length === 0) {
    return Effect.fail(new PrincipalBindingInactiveError());
  }

  if (activeBindings.length > 1) {
    return Effect.fail(new PrincipalBindingAmbiguousError());
  }

  const [identity] = activeBindings;

  if (identity === undefined) {
    return Effect.fail(new PrincipalBindingMissingError());
  }

  if (identity.principalStatus !== 'active') {
    return Effect.fail(new PrincipalInactiveError());
  }

  if (identity.tenantStatus !== 'active') {
    return Effect.fail(new TenantInactiveError());
  }

  return Effect.succeed({
    displayName: identity.displayName,
    principalId: identity.principalId,
    tenantId: identity.tenantId,
  });
};

export interface PrincipalResolverShape {
  readonly resolveBetterAuthUser: (
    betterAuthUserId: string,
  ) => Effect.Effect<ResolvedPrincipalIdentity, PrincipalResolutionError>;
}

export class PrincipalResolver extends Context.Service<PrincipalResolver, PrincipalResolverShape>()(
  '@app/core-runtime/auth/principal-resolver/PrincipalResolver',
) {}

export const makePrincipalResolver = (
  database: Context.Service.Shape<typeof CoreDatabase>,
): PrincipalResolverShape => ({
  resolveBetterAuthUser: (betterAuthUserId) =>
    Effect.tryPromise({
      catch: () =>
        new PrincipalResolverUnavailableError({
          reason: 'Unable to resolve the authenticated principal',
        }),
      try: () =>
        database.executor
          .select({
            bindingRevokedAt: principalAuthBindings.revokedAt,
            bindingStatus: principalAuthBindings.status,
            displayName: principals.displayName,
            principalId: principals.principalId,
            principalStatus: principals.status,
            tenantId: tenants.tenantId,
            tenantStatus: tenants.status,
          })
          .from(principalAuthBindings)
          .innerJoin(
            principals,
            and(
              eq(principals.principalId, principalAuthBindings.principalId),
              eq(principals.tenantId, principalAuthBindings.tenantId),
            ),
          )
          .innerJoin(tenants, eq(tenants.tenantId, principalAuthBindings.tenantId))
          .where(
            and(
              eq(principalAuthBindings.provider, 'better_auth'),
              eq(principalAuthBindings.subjectType, 'user'),
              eq(principalAuthBindings.providerSubjectId, betterAuthUserId),
            ),
          ),
    }).pipe(Effect.flatMap(classifyPrincipalResolution)),
});

export const PrincipalResolverLive = Layer.effect(
  PrincipalResolver,
  CoreDatabase.pipe(Effect.map(makePrincipalResolver)),
);
