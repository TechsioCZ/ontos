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

export interface AvailableTenant {
  readonly name: string;
  readonly tenantId: string;
}

export interface ResolvedPrincipalIdentity {
  readonly displayName: string;
  readonly principalId: string;
  readonly tenantId: string;
}

export interface PrincipalResolutionRecord {
  readonly bindingCreatedAt: Date;
  readonly bindingRevokedAt: Date | null;
  readonly bindingStatus: string;
  readonly displayName: string;
  readonly principalId: string;
  readonly principalStatus: string;
  readonly tenantId: string;
  readonly tenantName: string;
  readonly tenantStatus: string;
}

const compareText = (left: string, right: string): number => {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
};

const eligibleRecords = (
  records: readonly PrincipalResolutionRecord[],
): Effect.Effect<readonly PrincipalResolutionRecord[], PrincipalResolutionError> => {
  if (records.length === 0) {
    return Effect.fail(new PrincipalBindingMissingError());
  }

  const activeBindings = records.filter(
    (record) => record.bindingStatus === 'active' && record.bindingRevokedAt === null,
  );
  if (activeBindings.length === 0) {
    return Effect.fail(new PrincipalBindingInactiveError());
  }

  const activePrincipals = activeBindings.filter((record) => record.principalStatus === 'active');
  if (activePrincipals.length === 0) {
    return Effect.fail(new PrincipalInactiveError());
  }

  const activeTenants = activePrincipals.filter((record) => record.tenantStatus === 'active');
  if (activeTenants.length === 0) {
    return Effect.fail(new TenantInactiveError());
  }

  const tenantIds = new Set(activeTenants.map((record) => record.tenantId));
  if (tenantIds.size !== activeTenants.length) {
    return Effect.fail(new PrincipalBindingAmbiguousError());
  }

  return Effect.succeed(activeTenants);
};

const toResolvedIdentity = (record: PrincipalResolutionRecord): ResolvedPrincipalIdentity => ({
  displayName: record.displayName,
  principalId: record.principalId,
  tenantId: record.tenantId,
});

export const classifyAvailableTenants = (
  records: readonly PrincipalResolutionRecord[],
): Effect.Effect<readonly AvailableTenant[], PrincipalResolutionError> =>
  eligibleRecords(records).pipe(
    Effect.map((eligible) =>
      eligible
        .map((record) => ({ name: record.tenantName, tenantId: record.tenantId }))
        .toSorted(
          (left, right) =>
            compareText(left.name, right.name) || compareText(left.tenantId, right.tenantId),
        ),
    ),
  );

export const classifyDefaultPrincipal = (
  records: readonly PrincipalResolutionRecord[],
): Effect.Effect<ResolvedPrincipalIdentity, PrincipalResolutionError> =>
  eligibleRecords(records).pipe(
    Effect.map((eligible) =>
      eligible.toSorted(
        (left, right) =>
          left.bindingCreatedAt.getTime() - right.bindingCreatedAt.getTime() ||
          compareText(left.tenantId, right.tenantId),
      ),
    ),
    Effect.flatMap(([first]) =>
      first === undefined
        ? Effect.fail(new PrincipalBindingMissingError())
        : Effect.succeed(toResolvedIdentity(first)),
    ),
  );

export const classifySelectedPrincipal = (
  records: readonly PrincipalResolutionRecord[],
  selectedTenantId: string,
): Effect.Effect<ResolvedPrincipalIdentity, PrincipalResolutionError> =>
  eligibleRecords(records).pipe(
    Effect.flatMap((eligible) => {
      const selected = eligible.find((record) => record.tenantId === selectedTenantId);
      return selected === undefined
        ? Effect.fail(new PrincipalBindingMissingError())
        : Effect.succeed(toResolvedIdentity(selected));
    }),
  );

export interface PrincipalResolverShape {
  readonly listAvailableTenants: (
    betterAuthUserId: string,
  ) => Effect.Effect<readonly AvailableTenant[], PrincipalResolutionError>;
  readonly resolveDefaultBetterAuthUser: (
    betterAuthUserId: string,
  ) => Effect.Effect<ResolvedPrincipalIdentity, PrincipalResolutionError>;
  readonly resolveBetterAuthUserForTenant: (
    betterAuthUserId: string,
    tenantId: string,
  ) => Effect.Effect<ResolvedPrincipalIdentity, PrincipalResolutionError>;
}

export class PrincipalResolver extends Context.Service<PrincipalResolver, PrincipalResolverShape>()(
  '@app/core-runtime/auth/principal-resolver/PrincipalResolver',
) {}

export const makePrincipalResolver = (
  database: Context.Service.Shape<typeof CoreDatabase>,
): PrincipalResolverShape => {
  const loadRecords = (
    betterAuthUserId: string,
    tenantId?: string,
  ): Effect.Effect<readonly PrincipalResolutionRecord[], PrincipalResolverUnavailableError> =>
    Effect.tryPromise({
      catch: () =>
        new PrincipalResolverUnavailableError({
          reason: 'Unable to resolve the authenticated principal',
        }),
      try: () =>
        database.executor
          .select({
            bindingCreatedAt: principalAuthBindings.createdAt,
            bindingRevokedAt: principalAuthBindings.revokedAt,
            bindingStatus: principalAuthBindings.status,
            displayName: principals.displayName,
            principalId: principals.principalId,
            principalStatus: principals.status,
            tenantId: tenants.tenantId,
            tenantName: tenants.name,
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
              ...(tenantId === undefined ? [] : [eq(principalAuthBindings.tenantId, tenantId)]),
            ),
          ),
    });

  return {
    listAvailableTenants: (betterAuthUserId) =>
      loadRecords(betterAuthUserId).pipe(Effect.flatMap(classifyAvailableTenants)),
    resolveBetterAuthUserForTenant: (betterAuthUserId, tenantId) =>
      loadRecords(betterAuthUserId, tenantId).pipe(
        Effect.flatMap((records) => classifySelectedPrincipal(records, tenantId)),
      ),
    resolveDefaultBetterAuthUser: (betterAuthUserId) =>
      loadRecords(betterAuthUserId).pipe(Effect.flatMap(classifyDefaultPrincipal)),
  };
};

export const PrincipalResolverLive = Layer.effect(
  PrincipalResolver,
  CoreDatabase.pipe(Effect.map(makePrincipalResolver)),
);
