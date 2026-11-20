import { and, asc, eq, inArray } from 'drizzle-orm';
import { DateTime, Effect, Option, Result } from 'effect';

import {
  IdentityLifecycleConflictError,
  IdentityPersistenceUnavailableError,
  IdentityTargetInvalidError,
} from '../../auth/principal-management-errors.ts';
import { accessWorkloadBindings, principals, tenantModuleStates, tenants } from '../../db/schema.ts';
import type { ScopedTransactionExecutor } from '../../db/scoped-transaction.ts';
import { registeredWorkloadCallReceiverIssue } from '../../modules/registered-workload-calls.ts';
import type {
  OntosRegisteredWorkloadCallInput,
  RegisteredWorkloadCallReceiver,
} from '../../modules/registered-workload-calls.ts';

/*
 * A Tenant's system Principal for one system workload a module declares (`systemWorkloads` in its manifest): the
 * identity Core resolves for that module's own work in that Tenant (`readScopedSystemWorkloadEnrollment`,
 * `SystemPrincipalContextResolver.resolveEnrolled`). Only `core.identity.change-system-workload-enrollment` creates
 * such a Principal, binds its workloads and ends it, through the writers below: the generic binding store refuses a
 * Principal of kind `system` (`binding-store.ts`), `core.identity.change-principal-status` refuses one, and
 * `core.identity.create-non-human-principal` never creates one.
 */

/** A system Principal holding an active binding of the workload: active or disabled, never archived. */
export interface SystemWorkloadEnrollmentHolder {
  readonly bindingId: string;
  readonly bindingIncarnation: string;
  readonly principalId: string;
  readonly status: 'active' | 'disabled';
}

/**
 * The Tenant's one holder of the workload, or none. The reader fails closed on two, so a change never chooses between
 * two holders: an enrollment creates one only when none holds the workload and otherwise keeps the holder, and an end
 * ends the holder.
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

type IdentityCall = Pick<
  OntosRegisteredWorkloadCallInput,
  | 'audience'
  | 'declarationKey'
  | 'entrypointKey'
  | 'jobKey'
  | 'legalEntityScope'
  | 'schemaVersion'
  | 'sourceWorkloadKey'
  | 'workloadKey'
>;

export type EnrolledWorkloadCall = Pick<IdentityCall, 'audience' | 'entrypointKey' | 'schemaVersion'>;

/**
 * The calls the module's published registered-workload calls declare for this workload, once each: the calls its job
 * of this key makes and the calls received under this workload. A list for the operator of what this identity served,
 * never a confirmation that any of them ran as it or has stopped.
 */
export const enrolledWorkloadCalls = (
  contract: {
    readonly manifest: {
      readonly registeredWorkloadCalls?: readonly IdentityCall[] | undefined;
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

/** The published parts of an installed contract the worker identity is derived from. */
export interface SystemWorkloadContract extends RegisteredWorkloadCallReceiver {
  readonly manifest: RegisteredWorkloadCallReceiver['manifest'] & {
    readonly module: { readonly id: string };
    readonly registeredWorkloadCalls?: readonly IdentityCall[] | undefined;
  };
}

/** One declared call that no installed receiver active for the Tenant serves yet, and why. */
export interface PendingSystemWorkloadCall extends EnrolledWorkloadCall {
  readonly reason: string;
}

/** An owner workload of the identity none of whose declared calls can be served yet: it stays unbound. */
export interface PendingSystemWorkload {
  readonly calls: readonly PendingSystemWorkloadCall[];
  readonly workloadKey: string;
}

/** The owner workloads one system workload's worker runs its calls under in a Tenant. */
export interface SystemWorkloadIdentity {
  /** Each served by at least one declared call to a receiver installed, publishing it and active for the Tenant. */
  readonly bindable: readonly string[];
  readonly pending: readonly PendingSystemWorkload[];
}

const byKey = (left: string, right: string) => left.localeCompare(right);

/**
 * The module's whole declared worker identity for one of its system workloads, beside the workload key itself: the
 * owner workload of every registered call the module's own published contract declares for that job (`jobKey`), and,
 * from each call a receiver serves, the owner workload of every call that receiver publishes for the same job from
 * that workload (`sourceWorkloadKey`), as the gateway admits a follow-up the worker's own identity makes. A call counts
 * only where its receiver is installed, publishes it (`registeredWorkloadCallReceiverIssue`, as the route enrollment
 * command checks) and is active for the Tenant; a workload none of whose calls counts is pending, by call and reason.
 * Nothing a caller names and no call declared for another job is part of it.
 */
export const systemWorkloadIdentity = (input: {
  readonly activeModuleKeys: ReadonlySet<string>;
  readonly contracts: readonly SystemWorkloadContract[];
  readonly moduleKey: string;
  readonly workloadKey: string;
}): SystemWorkloadIdentity => {
  const served = new Set<string>();
  const unserved = new Map<string, Map<string, PendingSystemWorkloadCall>>();
  const visited = new Set<string>();
  const follow = (call: IdentityCall): void => {
    const label = [call.audience, call.entrypointKey, call.schemaVersion, call.declarationKey, call.workloadKey].join(
      ' ',
    );
    if (call.workloadKey === input.workloadKey || visited.has(label)) {
      return;
    }
    visited.add(label);
    const receiver = input.contracts.find((contract) => contract.deployment.appId === call.audience);
    const unpublished = registeredWorkloadCallReceiverIssue(call, receiver);
    const reason =
      unpublished ??
      (receiver === undefined || input.activeModuleKeys.has(receiver.manifest.module.id)
        ? undefined
        : `${receiver.manifest.module.id} is not active for this tenant`);
    if (receiver === undefined || reason !== undefined) {
      const calls = unserved.get(call.workloadKey) ?? new Map<string, PendingSystemWorkloadCall>();
      calls.set(label, {
        audience: call.audience,
        entrypointKey: call.entrypointKey,
        reason: reason ?? `${call.audience} is not installed`,
        schemaVersion: call.schemaVersion,
      });
      unserved.set(call.workloadKey, calls);
      return;
    }
    served.add(call.workloadKey);
    for (const nested of receiver.manifest.registeredWorkloadCalls ?? []) {
      if (nested.jobKey === input.workloadKey && nested.sourceWorkloadKey === call.workloadKey) {
        follow(nested);
      }
    }
  };
  const owner = input.contracts.find((contract) => contract.manifest.module.id === input.moduleKey);
  for (const call of owner?.manifest.registeredWorkloadCalls ?? []) {
    if (call.jobKey === input.workloadKey && call.sourceWorkloadKey === undefined) {
      follow(call);
    }
  }
  return {
    bindable: [...served].toSorted(byKey),
    pending: [...unserved.entries()]
      .filter(([workloadKey]) => !served.has(workloadKey))
      .toSorted(([left], [right]) => byKey(left, right))
      .map(([workloadKey, calls]) => ({
        calls: [...calls.entries()].toSorted(([left], [right]) => byKey(left, right)).map(([, call]) => call),
        workloadKey,
      })),
  };
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

/** The modules active for the Tenant: a module is active only while its stored state is `active`. */
export const readActiveTenantModuleKeys = (
  transaction: ScopedTransactionExecutor,
): Effect.Effect<ReadonlySet<string>, IdentityPersistenceUnavailableError> =>
  transaction
    .select({ moduleKey: tenantModuleStates.moduleKey })
    .from(tenantModuleStates)
    .where(and(eq(tenantModuleStates.tenantId, transaction.scope.tenantId), eq(tenantModuleStates.state, 'active')))
    .pipe(
      Effect.mapError(enrollmentUnavailable),
      Effect.map((rows) => new Set(rows.map(({ moduleKey }) => moduleKey))),
    );

/**
 * The Tenant's system Principals that are not archived and hold an active binding of the workload; two are enough to
 * refuse. A disabled one still holds the enrollment, so an enrollment never creates a second beside it.
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
      status: principals.status,
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
        inArray(principals.status, ['active', 'disabled']),
      ),
    )
    .orderBy(asc(principals.principalId))
    .limit(2)
    .pipe(
      Effect.mapError(enrollmentUnavailable),
      Effect.map((rows) => rows.flatMap((row) => (row.status === 'archived' ? [] : [{ ...row, status: row.status }]))),
    );

/** One active binding an enrollment holds. */
export interface SystemWorkloadBinding {
  readonly incarnation: string;
  readonly workloadKey: string;
}

/** Every active binding the enrollment's system Principal holds, by workload key. */
export const readSystemWorkloadPrincipalBindings = (
  transaction: ScopedTransactionExecutor,
  principalId: string,
): Effect.Effect<readonly SystemWorkloadBinding[], IdentityPersistenceUnavailableError> =>
  transaction
    .select({ incarnation: accessWorkloadBindings.incarnation, workloadKey: accessWorkloadBindings.workloadKey })
    .from(accessWorkloadBindings)
    .where(
      and(
        eq(accessWorkloadBindings.tenantId, transaction.scope.tenantId),
        eq(accessWorkloadBindings.principalId, principalId),
        eq(accessWorkloadBindings.status, 'active'),
      ),
    )
    .orderBy(asc(accessWorkloadBindings.workloadKey))
    .pipe(Effect.mapError(enrollmentUnavailable));

/** Core's only writer of a Principal of kind `system`: one per enrollment, named after its workload. */
export const insertSystemWorkloadPrincipal = Effect.fn('SystemWorkloadEnrollment.insertSystemWorkloadPrincipal')(
  function* insertSystemWorkloadPrincipal(transaction: ScopedTransactionExecutor, workloadKey: string) {
    const [created] = yield* transaction
      .insert(principals)
      .values({
        displayName: `System workload ${workloadKey}`,
        kind: 'system',
        status: 'active',
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

/** One binding the enrollment writes: a fresh binding id and incarnation for one workload key. */
export interface NewSystemWorkloadBinding {
  readonly bindingId: string;
  readonly incarnation: string;
  readonly workloadKey: string;
}

/**
 * Core's only writer of a system Principal's bindings: binds each key, with its fresh binding id and incarnation, to
 * the enrollment's Principal in the enrollment's own transaction, which holds the Tenant row lock and has read what the
 * Principal already holds.
 */
export const bindSystemWorkloadPrincipal = Effect.fn('SystemWorkloadEnrollment.bindSystemWorkloadPrincipal')(
  function* bindSystemWorkloadPrincipal(
    transaction: ScopedTransactionExecutor,
    principalId: string,
    bindings: readonly NewSystemWorkloadBinding[],
  ) {
    if (bindings.length === 0) {
      return [];
    }
    const createdAt = DateTime.toDateUtc(yield* DateTime.now);
    const bound: readonly SystemWorkloadBinding[] = yield* transaction
      .insert(accessWorkloadBindings)
      .values(
        bindings.map(({ bindingId, incarnation, workloadKey }) => ({
          bindingId,
          createdAt,
          incarnation,
          principalId,
          revokedAt: null,
          status: 'active' as const,
          tenantId: transaction.scope.tenantId,
          workloadKey,
        })),
      )
      .returning({ incarnation: accessWorkloadBindings.incarnation, workloadKey: accessWorkloadBindings.workloadKey })
      .pipe(Effect.mapError(enrollmentUnavailable));
    return bound.toSorted((left, right) => byKey(left.workloadKey, right.workloadKey));
  },
);

/** Revokes every active binding the enrollment's system Principal holds and names each one. */
export const revokeSystemWorkloadPrincipalBindings = Effect.fn(
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
 * Archives the ended enrollment's system Principal, active or disabled. Archived is final in Core's Principal
 * lifecycle, so a later enrollment creates a new Principal and this one never holds a workload again.
 */
export const archiveSystemWorkloadPrincipal = Effect.fn('SystemWorkloadEnrollment.archiveSystemWorkloadPrincipal')(
  function* archiveSystemWorkloadPrincipal(transaction: ScopedTransactionExecutor, principalId: string) {
    const [archived] = yield* transaction
      .update(principals)
      .set({ disabledAt: null, status: 'archived' })
      .where(
        and(
          eq(principals.tenantId, transaction.scope.tenantId),
          eq(principals.principalId, principalId),
          eq(principals.kind, 'system'),
          inArray(principals.status, ['active', 'disabled']),
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
