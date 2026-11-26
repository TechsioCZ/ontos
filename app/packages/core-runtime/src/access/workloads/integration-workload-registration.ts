import { and, eq, inArray } from 'drizzle-orm';
import { Effect, Match } from 'effect';

import {
  IdentityLifecycleConflictError,
  IdentityPersistenceUnavailableError,
  IdentityTargetInvalidError,
} from '../../auth/principal-management-errors.ts';
import { workloadKeyBelongsToModule } from '../../authorization/access-declaration.ts';
import { accessWorkloadBindings, accessWorkloadCompanyBindings, principals } from '../../db/schema.ts';
import type { ScopedTransactionExecutor } from '../../db/scoped-transaction.ts';
import type { AccessIntentError } from '../intent/errors.ts';

/*
 * The workloads a Tenant administrator binds to one of the Tenant's integration Principals (a connector partner such as
 * Symmy) and registers for the selected company: `core.identity.register-integration-workloads`. A workload is
 * bindable when an installed, active module publishes it as a receiver workload of one of its Actions or operations.
 * A module's system workload (`systemWorkloads`, the Tenant's enrolled system Principal) and a workload the platform
 * holds through its own internal-workload Principal are never bound to an integration.
 */

const invalid = (reason: string) => new IdentityTargetInvalidError({ code: 'identity_target_invalid', reason });

export const integrationWorkloadUnavailable = (cause?: unknown) => {
  const failure = new IdentityPersistenceUnavailableError({
    code: 'identity_persistence_unavailable',
    reason: 'The integration workload registration could not be read or persisted',
  });
  if (cause !== undefined) {
    Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
  }
  return failure;
};

/** A binding store refusal is a lost race (a concurrent registration) or an unavailable store, never a success. */
export const integrationWorkloadStoreFailure = (failure: AccessIntentError) =>
  Match.value(failure).pipe(
    Match.tagsExhaustive({
      AccessIntentConflictError: () =>
        new IdentityLifecycleConflictError({
          code: 'identity_lifecycle_conflict',
          reason: 'The integration workload registration changed concurrently',
        }),
      AccessIntentUnavailableError: integrationWorkloadUnavailable,
    }),
  );

/** Which installed module publishes the workload as a receiver, unless it is that module's system workload. */
export interface WorkloadPublishingManifest {
  readonly module: { readonly id: string };
  readonly publicSurface: {
    readonly actions: readonly { readonly accessWorkload?: { readonly workloads: readonly string[] } | undefined }[];
    readonly operationContracts?:
      | readonly { readonly workloadCarrier?: { readonly workloads: readonly string[] } | undefined }[]
      | undefined;
  };
  readonly systemWorkloads?: readonly string[] | undefined;
}

export const bindableWorkloadOwner = (
  contracts: readonly { readonly manifest: WorkloadPublishingManifest }[],
  workloadKey: string,
): string | undefined =>
  contracts.find(({ manifest }) => {
    if (!workloadKeyBelongsToModule(workloadKey, manifest.module.id)) {
      return false;
    }
    const isKey = (declared: string) => declared === workloadKey;
    if ((manifest.systemWorkloads ?? []).some(isKey)) {
      return false;
    }
    return (
      manifest.publicSurface.actions.some((action) => (action.accessWorkload?.workloads ?? []).some(isKey)) ||
      (manifest.publicSurface.operationContracts ?? []).some((operation) =>
        (operation.workloadCarrier?.workloads ?? []).some(isKey),
      )
    );
  })?.manifest.module.id;

/** The target must be an active integration Principal of the Tenant that the platform did not make. */
export const requireTenantIntegration = Effect.fn('IntegrationWorkloadRegistration.requireTenantIntegration')(
  function* requireTenantIntegration(transaction: ScopedTransactionExecutor, principalId: string) {
    const [target] = yield* transaction
      .select({ kind: principals.kind, platformRole: principals.platformRole, status: principals.status })
      .from(principals)
      .where(and(eq(principals.tenantId, transaction.scope.tenantId), eq(principals.principalId, principalId)))
      .limit(1)
      .pipe(Effect.mapError(integrationWorkloadUnavailable));
    if (target?.kind !== 'integration' || target.status !== 'active' || target.platformRole !== null) {
      return yield* invalid('Workloads are registered only for an active integration principal of this tenant');
    }
    return yield* Effect.void;
  },
);

/** A workload the platform holds through its own internal-workload Principal in this Tenant is the platform's. */
export const refusePlatformHeldWorkloads = Effect.fn('IntegrationWorkloadRegistration.refusePlatformHeldWorkloads')(
  function* refusePlatformHeldWorkloads(transaction: ScopedTransactionExecutor, workloadKeys: readonly string[]) {
    const [held] = yield* transaction
      .select({ workloadKey: accessWorkloadBindings.workloadKey })
      .from(accessWorkloadBindings)
      .innerJoin(
        principals,
        and(
          eq(principals.tenantId, accessWorkloadBindings.tenantId),
          eq(principals.principalId, accessWorkloadBindings.principalId),
        ),
      )
      .where(
        and(
          eq(accessWorkloadBindings.tenantId, transaction.scope.tenantId),
          inArray(accessWorkloadBindings.workloadKey, [...workloadKeys]),
          eq(principals.platformRole, 'internal_workload'),
        ),
      )
      .limit(1)
      .pipe(Effect.mapError(integrationWorkloadUnavailable));
    if (held !== undefined) {
      return yield* invalid(`The workload ${held.workloadKey} is a module internal workload the platform holds`);
    }
    return yield* Effect.void;
  },
);

/** The integration's active binding of each workload and the company its active registration names, if any. */
export interface IntegrationWorkloadHolding {
  readonly bindingId: string;
  readonly companyBindingId: string | null;
  readonly legalEntityId: string | null;
  readonly workloadKey: string;
}

export const readIntegrationWorkloadHoldings = (
  transaction: ScopedTransactionExecutor,
  principalId: string,
  workloadKeys: readonly string[],
): Effect.Effect<readonly IntegrationWorkloadHolding[], IdentityPersistenceUnavailableError> =>
  transaction
    .select({
      bindingId: accessWorkloadBindings.bindingId,
      companyBindingId: accessWorkloadCompanyBindings.companyBindingId,
      legalEntityId: accessWorkloadCompanyBindings.legalEntityId,
      workloadKey: accessWorkloadBindings.workloadKey,
    })
    .from(accessWorkloadBindings)
    .leftJoin(
      accessWorkloadCompanyBindings,
      and(
        eq(accessWorkloadCompanyBindings.tenantId, accessWorkloadBindings.tenantId),
        eq(accessWorkloadCompanyBindings.workloadBindingId, accessWorkloadBindings.bindingId),
        eq(accessWorkloadCompanyBindings.status, 'active'),
      ),
    )
    .where(
      and(
        eq(accessWorkloadBindings.tenantId, transaction.scope.tenantId),
        eq(accessWorkloadBindings.principalId, principalId),
        inArray(accessWorkloadBindings.workloadKey, [...workloadKeys]),
        eq(accessWorkloadBindings.status, 'active'),
      ),
    )
    .pipe(Effect.mapError(integrationWorkloadUnavailable));
