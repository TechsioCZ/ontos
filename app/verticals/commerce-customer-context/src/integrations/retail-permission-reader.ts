import {
  BusinessPermissionCodeSchema,
  ContextAccess,
  PrincipalRefSchema,
  toBusinessPermissionAccessKey,
} from '@app/core-runtime';
import type { BusinessPermissionAccessTarget, BusinessPermissionCode, ContextAccessService } from '@app/core-runtime';
import { Context, DateTime, Effect, Exit, Layer, Result, Schema } from 'effect';

import { RETAIL_PORTAL_SELF_SERVICE_BASELINE } from '../../shared/domain/profile-contracts.ts';
import { ProfilePersistenceDependencyFailure } from '../persistence/profile-persistence.ts';
import type { ProfilePersistenceDependencies } from '../persistence/profile-persistence.ts';

export type RetailPermissionReader = NonNullable<ProfilePersistenceDependencies['readRetailPermissions']>;
type RetailPermission = (typeof RETAIL_PORTAL_SELF_SERVICE_BASELINE)[number];

export interface ProfileRetailPermissionReaderScope {
  readonly legalEntityId: string;
  readonly principalId: string;
  readonly tenantId: string;
}

const dependencyFailure = (reason: string, cause?: unknown): ProfilePersistenceDependencyFailure => {
  const failure = new ProfilePersistenceDependencyFailure({ reason });
  return cause === undefined ? failure : Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
};

const retailPermissionTarget = (
  permission: BusinessPermissionCode,
  scope: ProfileRetailPermissionReaderScope,
  profileId: string,
): BusinessPermissionAccessTarget => ({
  permission,
  target: {
    kind: 'retail_profile',
    legalEntityId: scope.legalEntityId,
    profileId,
    tenantId: scope.tenantId,
  },
});

const allowedRetailPermissions = (
  expectedKeys: readonly string[],
  resultsByKey: ReadonlyMap<string, { readonly decision: string }>,
): readonly RetailPermission[] => {
  const allowed: RetailPermission[] = [];
  for (const [index, key] of expectedKeys.entries()) {
    const result = resultsByKey.get(key);
    const permission = RETAIL_PORTAL_SELF_SERVICE_BASELINE[index];
    if (result?.decision === 'allowed' && permission !== undefined) {
      allowed.push(permission);
    }
  }
  return allowed;
};

/* oxlint-disable effect-native/no-dependency-parameters -- The Layer captures the Core service before creating this scoped adapter. */
const makeReader =
  (contextAccess: ContextAccessService, scope: ProfileRetailPermissionReaderScope): RetailPermissionReader =>
  (input) => {
    if (
      input.legalEntityId !== scope.legalEntityId ||
      input.principalId !== scope.principalId ||
      input.tenantId !== scope.tenantId
    ) {
      return Effect.fail(dependencyFailure('Retail Portal Permission lookup crossed the verified scope'));
    }
    const permissionResults = RETAIL_PORTAL_SELF_SERVICE_BASELINE.map((permission) =>
      Schema.decodeResult(BusinessPermissionCodeSchema)(permission),
    );
    const permissions: BusinessPermissionCode[] = [];
    for (const result of permissionResults) {
      if (Result.isFailure(result)) {
        return Effect.fail(
          dependencyFailure(
            'The Retail Portal Permission baseline contains an invalid business Permission code',
            result.failure,
          ),
        );
      }
      permissions.push(result.success);
    }
    const targets = permissions.map((permission) => retailPermissionTarget(permission, scope, input.profileId));
    const principalResult = Schema.decodeResult(PrincipalRefSchema)({
      principalId: scope.principalId,
      tenantId: scope.tenantId,
    });
    if (Result.isFailure(principalResult)) {
      return Effect.fail(dependencyFailure('The trusted principal identity is invalid', principalResult.failure));
    }
    if (contextAccess.businessPermissions === undefined) {
      return Effect.fail(dependencyFailure('Core business Permission checks are unavailable'));
    }
    const expectedKeys = targets.map(toBusinessPermissionAccessKey);
    return contextAccess
      .businessPermissions({
        principal: principalResult.success,
        targets,
      })
      .pipe(
        Effect.flatMap((results) => {
          const byKey = new Map(results.map((result) => [result.key, result]));
          if (results.length !== expectedKeys.length || expectedKeys.some((key) => !byKey.has(key))) {
            return Effect.fail(dependencyFailure('Core returned an incomplete Retail Portal Permission snapshot'));
          }
          const unavailable = expectedKeys
            .map((key) => byKey.get(key))
            .find((result) => result?.decision === 'unavailable');
          if (unavailable !== undefined) {
            return Effect.fail(dependencyFailure('Core returned an indeterminate Retail Portal Permission snapshot'));
          }
          return DateTime.now.pipe(
            Effect.map((observedAt) => ({
              observedAt: DateTime.formatIso(observedAt),
              permissions: allowedRetailPermissions(expectedKeys, byKey),
            })),
          );
        }),
      );
  };
/* oxlint-enable effect-native/no-dependency-parameters */

/** The reader of an operation that read no Retail Portal permissions: every lookup is unavailable. */
export const unreadRetailPermissions: RetailPermissionReader = () =>
  Effect.fail(dependencyFailure('No Retail Portal Permission snapshot was read before the transaction'));

/**
 * Reads the Retail Portal permission snapshots of the given profiles before a transaction opens. The
 * returned reader serves only those snapshots (or their failures), so owner code that consumes it inside
 * the transaction never calls SpiceDB.
 */
export const prefetchRetailPermissions = (
  reader: RetailPermissionReader,
  scope: ProfileRetailPermissionReaderScope,
  profileIds: readonly string[],
): Effect.Effect<RetailPermissionReader> =>
  Effect.forEach(
    [...new Set(profileIds)],
    (profileId) =>
      Effect.map(Effect.exit(reader({ ...scope, profileId })), (snapshot) => [profileId, snapshot] as const),
    // One target profile per Read; an owner overlay names a handful at most.
    { concurrency: 4 },
  ).pipe(
    Effect.map((entries): RetailPermissionReader => {
      const snapshots = new Map(entries);
      return (input) => {
        const snapshot = snapshots.get(input.profileId);
        if (
          snapshot === undefined ||
          input.legalEntityId !== scope.legalEntityId ||
          input.principalId !== scope.principalId ||
          input.tenantId !== scope.tenantId
        ) {
          return Effect.fail(
            dependencyFailure('The Retail Portal Permission snapshot was not read before the transaction'),
          );
        }
        return Exit.isSuccess(snapshot) ? Effect.succeed(snapshot.value) : Effect.failCause(snapshot.cause);
      };
    }),
  );

export interface ProfileRetailPermissionReaderFactoryService {
  readonly make: (scope: ProfileRetailPermissionReaderScope) => RetailPermissionReader;
}

export class ProfileRetailPermissionReaderFactory extends Context.Service<
  ProfileRetailPermissionReaderFactory,
  ProfileRetailPermissionReaderFactoryService
>()('@app/commerce-customer-context/integrations/retail-permission-reader/ProfileRetailPermissionReaderFactory') {}

export const profileRetailPermissionReaderFactoryLive = Layer.effect(
  ProfileRetailPermissionReaderFactory,
  Effect.gen(function* makeProfileRetailPermissionReaderFactory() {
    const contextAccess = yield* ContextAccess;
    return Object.freeze({
      make: (scope: ProfileRetailPermissionReaderScope) => makeReader(contextAccess, scope),
    });
  }),
);
