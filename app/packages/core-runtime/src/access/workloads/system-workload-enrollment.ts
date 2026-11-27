import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { DateTime, Effect, Match, Option, Result } from 'effect';

import {
  IdentityLifecycleConflictError,
  IdentityPersistenceUnavailableError,
  IdentityTargetInvalidError,
} from '../../auth/principal-management-errors.ts';
import { accessWorkloadBindings, principals, tenantModuleStates, tenants } from '../../db/schema.ts';
import type { ScopedTransactionExecutor } from '../../db/scoped-transaction.ts';
import type { OntosRegisteredWorkloadCall } from '../../modules/registered-workload-calls.ts';
import type { OperationalScope } from '../../operations/context.ts';
import { TenantIdSchema } from '../ids.ts';
import type { PrincipalId } from '../ids.ts';
import type { WorkloadKey } from '../../authorization/access-declaration.ts';
import type { AccessIntentError } from '../intent/errors.ts';
import { registerWorkloadBindingsIn } from './binding-store.ts';
import type { AccessWorkloadBindingId } from './store.ts';

/*
 * A Tenant's system Principal for one system workload a module declares (`systemWorkloads` in its manifest): the
 * identity Core resolves for that module's own work in that Tenant (`readScopedWorkloadEnrollment`,
 * `SystemPrincipalContextResolver.resolveEnrolled`). Only `core.identity.change-system-workload-enrollment`
 * (and the release installer, `release-system-workloads.ts`) creates such a Principal, always together with its one
 * binding of the workload key, and records that key on it (`core.principals.system_workload_key`, one live Principal
 * per Tenant and key); the enrollment ends it. The writer of kind `system` lives here and nowhere else:
 * `core.identity.create-non-human-principal` never creates one.
 */

/** One active system Principal holding an active binding of the workload. */
export interface SystemWorkloadEnrollmentHolder {
  readonly bindingId: string;
  readonly bindingIncarnation: string;
  readonly principalId: string;
}

/**
 * The Tenant's one active holder of the workload, or none. The reader fails closed on two, so a change never chooses
 * between two holders: an enrollment creates one only when none is active and otherwise keeps the active one
 * unchanged, and an end ends the active one.
 */
export const soleSystemWorkloadHolder = (
  holders: readonly SystemWorkloadEnrollmentHolder[],
): Result.Result<Option.Option<SystemWorkloadEnrollmentHolder>, IdentityLifecycleConflictError> => {
  const [holder, second] = holders;
  return second === undefined
    ? Result.succeed(Option.fromUndefinedOr(holder))
    : Result.fail(
        new IdentityLifecycleConflictError({
          code: 'identity_lifecycle_conflict',
          reason: 'More than one system principal holds this workload; it is not chosen between',
        }),
      );
};

/** Whether the installed module's contract declares the workload as one of its system workloads. */
export const declaresSystemWorkload = (
  contract: { readonly manifest: { readonly systemWorkloads?: readonly string[] | undefined } },
  workloadKey: string,
): boolean => (contract.manifest.systemWorkloads ?? []).some((declared) => declared === workloadKey);

export type EnrolledWorkloadCall = Pick<OntosRegisteredWorkloadCall, 'audience' | 'entrypointKey' | 'schemaVersion'>;

/**
 * The owner operations the module's published registered-workload calls perform as this enrollment, once each: the
 * calls its job of this key makes and the calls received under this workload. Ending the enrollment stops them for
 * the Tenant. Work the module has queued or started is the module's own state, which Core does not see.
 */
export const enrolledWorkloadCalls = (
  contract: {
    readonly manifest: {
      readonly registeredWorkloadCalls?:
        | readonly Pick<
            OntosRegisteredWorkloadCall,
            'audience' | 'entrypointKey' | 'jobKey' | 'schemaVersion' | 'workloadKey'
          >[]
        | undefined;
    };
  },
  workloadKey: string,
): readonly EnrolledWorkloadCall[] => {
  const calls = new Map<string, EnrolledWorkloadCall>();
  for (const { audience, entrypointKey, jobKey, schemaVersion, workloadKey: callWorkload } of contract.manifest
    .registeredWorkloadCalls ?? []) {
    if (jobKey === workloadKey || callWorkload === workloadKey) {
      calls.set(`${audience} ${entrypointKey}@${schemaVersion}`, { audience, entrypointKey, schemaVersion });
    }
  }
  return [...calls.entries()].toSorted(([left], [right]) => left.localeCompare(right)).map(([, call]) => call);
};

export const enrollmentUnavailable = (cause?: unknown) => {
  const failure = new IdentityPersistenceUnavailableError({
    code: 'identity_persistence_unavailable',
    reason: 'The system workload enrollment could not be read or persisted',
  });
  if (cause !== undefined) {
    Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
  }
  return failure;
};

const invalid = (reason: string) => new IdentityTargetInvalidError({ code: 'identity_target_invalid', reason });

/** A binding store refusal is a lost race or an unavailable store, never a silent success. */
export const enrollmentStoreFailure = (failure: AccessIntentError) =>
  Match.value(failure).pipe(
    Match.tagsExhaustive({
      AccessIntentConflictError: () =>
        new IdentityLifecycleConflictError({
          code: 'identity_lifecycle_conflict',
          reason: 'The system workload enrollment changed concurrently',
        }),
      AccessIntentUnavailableError: enrollmentUnavailable,
    }),
  );

/**
 * Serializes every enrollment change of one Tenant, and each with that Tenant's module state changes, which lock the
 * same row for update. It does not block a write that only references the Tenant. Requires the Tenant to be active.
 */
export const lockActiveTenantForEnrollment = (
  transaction: ScopedTransactionExecutor,
): Effect.Effect<void, IdentityPersistenceUnavailableError | IdentityTargetInvalidError> =>
  transaction
    .select({ status: tenants.status })
    .from(tenants)
    .where(eq(tenants.tenantId, transaction.scope.tenantId))
    .for('no key update')
    .pipe(
      Effect.mapError(enrollmentUnavailable),
      Effect.filterOrFail(
        ([tenant]) => tenant?.status === 'active',
        () => invalid('The tenant is not active'),
      ),
      Effect.asVoid,
    );

/** A module is active for a Tenant only while its stored state is `active`; no stored state is not active. */
export const requireActiveTenantModule = (
  transaction: ScopedTransactionExecutor,
  moduleKey: string,
): Effect.Effect<void, IdentityPersistenceUnavailableError | IdentityTargetInvalidError> =>
  transaction
    .select({ state: tenantModuleStates.state })
    .from(tenantModuleStates)
    .where(
      and(eq(tenantModuleStates.tenantId, transaction.scope.tenantId), eq(tenantModuleStates.moduleKey, moduleKey)),
    )
    .pipe(
      Effect.mapError(enrollmentUnavailable),
      Effect.filterOrFail(
        ([module]) => module?.state === 'active',
        () => invalid('The module is not active for this tenant'),
      ),
      Effect.asVoid,
    );

/**
 * The Tenant's active system Principals enrolled for the workload (their recorded `system_workload_key` is it) that
 * hold an active binding of it; two are enough to refuse. A Principal with no recorded workload, or enrolled for
 * another one, is no enrollment of this workload: it is never adopted or ended.
 */
export const readSystemWorkloadEnrollmentHolders = (
  transaction: ScopedTransactionExecutor,
  workloadKey: string,
): Effect.Effect<readonly SystemWorkloadEnrollmentHolder[], IdentityPersistenceUnavailableError> =>
  transaction
    .select({
      bindingId: accessWorkloadBindings.bindingId,
      bindingIncarnation: accessWorkloadBindings.incarnation,
      principalId: principals.principalId,
    })
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
        eq(accessWorkloadBindings.workloadKey, workloadKey),
        eq(accessWorkloadBindings.status, 'active'),
        eq(principals.systemWorkloadKey, workloadKey),
        eq(principals.kind, 'system'),
        eq(principals.status, 'active'),
      ),
    )
    .orderBy(asc(principals.principalId))
    .limit(2)
    .pipe(Effect.mapError(enrollmentUnavailable));

/**
 * The Tenant's active system Principals holding an active binding of the workload, whatever workload each was
 * enrolled for; two are enough to refuse. Symmy's route enabling binds its executor owner workloads it calls under
 * (`symmy-executor-workloads.ts`), so the holder of such a workload is any system Principal, not only one enrolled
 * for it.
 */
export const readSystemPrincipalWorkloadHolders = (
  transaction: ScopedTransactionExecutor,
  workloadKey: string,
): Effect.Effect<readonly SystemWorkloadEnrollmentHolder[], IdentityPersistenceUnavailableError> =>
  transaction
    .select({
      bindingId: accessWorkloadBindings.bindingId,
      bindingIncarnation: accessWorkloadBindings.incarnation,
      principalId: principals.principalId,
    })
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
        eq(accessWorkloadBindings.workloadKey, workloadKey),
        eq(accessWorkloadBindings.status, 'active'),
        eq(principals.kind, 'system'),
        eq(principals.status, 'active'),
      ),
    )
    .orderBy(asc(principals.principalId))
    .limit(2)
    .pipe(Effect.mapError(enrollmentUnavailable));

/**
 * Core's only writer of a Principal of kind `system`: one per enrollment, named after its workload and recording it.
 * A second live one for the same Tenant and key is refused by `core_principals_system_workload_uk`.
 */
export const insertSystemWorkloadPrincipal = Effect.fn('SystemWorkloadEnrollment.insertSystemWorkloadPrincipal')(
  function* insertSystemWorkloadPrincipal(transaction: ScopedTransactionExecutor, workloadKey: string) {
    const [created] = yield* transaction
      .insert(principals)
      .values({
        displayName: `System workload ${workloadKey}`,
        kind: 'system',
        status: 'active',
        systemWorkloadKey: workloadKey,
        tenantId: transaction.scope.tenantId,
      })
      .returning({ principalId: principals.principalId })
      .pipe(Effect.mapError(enrollmentUnavailable));
    if (created === undefined) {
      return yield* enrollmentUnavailable();
    }
    return created.principalId;
  },
);

/**
 * Archives the ended enrollment's system Principal. Archived is final in Core's Principal lifecycle, so a later
 * enrollment creates a new Principal and this one never holds a workload again. Only a system Principal without a
 * platform role is an enrollment's, so the Tenant's access release actor is never archived here.
 */
export const archiveSystemWorkloadPrincipal = Effect.fn('SystemWorkloadEnrollment.archiveSystemWorkloadPrincipal')(
  function* archiveSystemWorkloadPrincipal(transaction: ScopedTransactionExecutor, principalId: string) {
    const [archived] = yield* transaction
      .update(principals)
      .set({ status: 'archived' })
      .where(
        and(
          eq(principals.tenantId, transaction.scope.tenantId),
          eq(principals.principalId, principalId),
          eq(principals.kind, 'system'),
          eq(principals.status, 'active'),
          isNull(principals.platformRole),
        ),
      )
      .returning({ principalId: principals.principalId })
      .pipe(Effect.mapError(enrollmentUnavailable));
    if (archived === undefined) {
      return yield* new IdentityLifecycleConflictError({
        code: 'identity_lifecycle_conflict',
        reason: 'The system principal of the enrollment changed concurrently',
      });
    }
    return yield* Effect.void;
  },
);

/** One active binding an enrollment holds. */
export interface SystemWorkloadBinding {
  readonly incarnation: string;
  readonly workloadKey: string;
}

const byKey = (left: string, right: string) => left.localeCompare(right);

/** The enrollment's one binding of its own workload key, written through the generic binding store. */
const bindSystemWorkloadKey = Effect.fn('SystemWorkloadEnrollment.bindSystemWorkloadKey')(function* bindWorkloadKey(
  transaction: ScopedTransactionExecutor,
  scope: OperationalScope,
  binding: {
    readonly bindingId: AccessWorkloadBindingId;
    readonly incarnation: AccessWorkloadBindingId;
    readonly principalId: PrincipalId;
    readonly workloadKey: WorkloadKey;
  },
) {
  return yield* registerWorkloadBindingsIn(transaction, scope, {
    bindings: [
      {
        ...binding,
        createdAt: DateTime.toDateUtc(yield* DateTime.now),
        tenantId: TenantIdSchema.make(scope.tenantId),
      },
    ],
  }).pipe(Effect.mapError(enrollmentStoreFailure));
});

/**
 * Revokes every active binding the ended enrollment's system Principal holds, the workload key's own and every owner
 * workload another writer bound to it (Symmy's route enabling), and names each one.
 */
const revokeSystemWorkloadPrincipalBindings = Effect.fn(
  'SystemWorkloadEnrollment.revokeSystemWorkloadPrincipalBindings',
)(function* revokeSystemWorkloadPrincipalBindings(transaction: ScopedTransactionExecutor, principalId: string) {
  const revoked: readonly SystemWorkloadBinding[] = yield* transaction
    .update(accessWorkloadBindings)
    .set({ revokedAt: DateTime.toDateUtc(yield* DateTime.now), status: 'revoked' })
    .where(
      and(
        eq(accessWorkloadBindings.tenantId, transaction.scope.tenantId),
        eq(accessWorkloadBindings.principalId, principalId),
        eq(accessWorkloadBindings.status, 'active'),
      ),
    )
    .returning({ incarnation: accessWorkloadBindings.incarnation, workloadKey: accessWorkloadBindings.workloadKey })
    .pipe(Effect.mapError(enrollmentUnavailable));
  return revoked.toSorted((left, right) => byKey(left.workloadKey, right.workloadKey));
});

/**
 * Revokes the bindings of a system workload's key that system Principals with no recorded workload hold, and names
 * those Principals: the key's own enrollment takes it back from a holder nothing accounts for.
 *
 * Demo line: a Principal enrolled for another workload keeps the key. An executor holds the owner workloads its routes
 * need (the Symmy executor calls Inventory under `commerce.inventory.source-provision`, bound by route enabling), so
 * main's revocation from every Principal not enrolled for the key would stop those calls on an administrator's ENROLL
 * of the owner's workload, and route enabling could not bind it again. See MERGING.md V51 and V52.
 */
const reclaimSystemWorkloadKey = Effect.fn('SystemWorkloadEnrollment.reclaimSystemWorkloadKey')(
  function* reclaimSystemWorkloadKey(transaction: ScopedTransactionExecutor, workloadKey: string) {
    const notEnrolledForIt = transaction
      .select({ principalId: principals.principalId })
      .from(principals)
      .where(
        and(
          eq(principals.tenantId, transaction.scope.tenantId),
          eq(principals.kind, 'system'),
          isNull(principals.systemWorkloadKey),
        ),
      );
    const reclaimed = yield* transaction
      .update(accessWorkloadBindings)
      .set({ revokedAt: DateTime.toDateUtc(yield* DateTime.now), status: 'revoked' })
      .where(
        and(
          eq(accessWorkloadBindings.tenantId, transaction.scope.tenantId),
          eq(accessWorkloadBindings.workloadKey, workloadKey),
          eq(accessWorkloadBindings.status, 'active'),
          inArray(accessWorkloadBindings.principalId, notEnrolledForIt),
        ),
      )
      .returning({ principalId: accessWorkloadBindings.principalId })
      .pipe(Effect.mapError(enrollmentUnavailable));
    return reclaimed.map(({ principalId }) => principalId).toSorted(byKey);
  },
);

/**
 * What an enrollment change reads and writes, each operation closed over the one transaction (and its scope) it is
 * made for: the Action's handler is given these and never the executor.
 */
export const systemWorkloadEnrollmentRepositoryFromTransaction = (
  transaction: ScopedTransactionExecutor,
  scope: OperationalScope,
) =>
  Object.freeze({
    archivePrincipal: (principalId: string) => archiveSystemWorkloadPrincipal(transaction, principalId),
    bindWorkloadKey: (binding: Parameters<typeof bindSystemWorkloadKey>[2]) =>
      bindSystemWorkloadKey(transaction, scope, binding),
    insertPrincipal: (workloadKey: string) => insertSystemWorkloadPrincipal(transaction, workloadKey),
    lockActiveTenant: () => lockActiveTenantForEnrollment(transaction),
    readHolders: (workloadKey: string) => readSystemWorkloadEnrollmentHolders(transaction, workloadKey),
    reclaimWorkloadKey: (workloadKey: string) => reclaimSystemWorkloadKey(transaction, workloadKey),
    requireActiveModule: (moduleKey: string) => requireActiveTenantModule(transaction, moduleKey),
    revokePrincipalBindings: (principalId: string) => revokeSystemWorkloadPrincipalBindings(transaction, principalId),
  });
