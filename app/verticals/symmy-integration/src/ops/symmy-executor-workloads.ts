import type { OperationalScope, ScopedTransactionExecutor } from '@app/core-runtime';
import {
  AccessWorkloadBindingIdSchema,
  AccessWorkloadCompanyBindingIdSchema,
  readActiveWorkloadBindingHolders,
  readSystemPrincipalWorkloadHolders,
  registerWorkloadBindingsIn,
  registerWorkloadCompanyBindingsIn,
  revokeWorkloadBindingIn,
  revokeWorkloadCompanyBindingIn,
  WorkloadKeySchema,
} from '@app/core-runtime/access/enforcement';
import { LegalEntityIdSchema, PrincipalIdSchema, TenantIdSchema } from '@app/core-runtime/access/ids';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { Crypto, DateTime, Effect, Option, Schema } from 'effect';

import { SymmyExecutorWorkloadKeySchema } from '../../shared/actions/manage-symmy-routes.ts';
import type { SymmyExecutorWorkloadChange } from '../../shared/actions/manage-symmy-routes.ts';
import { symmyExecutorWorkloadGrants, symmyJobRoutes } from '../db/schema.ts';
import { deriveSymmyRouteBindings, SYMMY_JOB_KEY } from './symmy-route-bindings.ts';
import type { SymmyRequiredBinding } from './symmy-route-bindings.ts';
import { SymmyRouteEnrollmentUnavailable } from './symmy-route-enrollment-unavailable.ts';
import { symmyEnrolledInventory, symmyRouteInventoryOf } from './symmy-route-enrollment.ts';

/*
 * The owner workloads the Symmy executor calls under. The executor is the Tenant's one system Principal enrolled for
 * `integration.symmy.execute-symmy-job` (`core.identity.change-system-workload-enrollment`). Enabling a route binds the
 * executor each owner workload the route calls under that no system Principal holds yet, and registers the executor's
 * binding for the route's company where a call runs there, through Core's own in-transaction binding writers. What an
 * installer wrote (as on the stage demo) is used as it is. Disabling withdraws only what an enable wrote, once no active
 * route of the Tenant calls under the workload (in that company). Every write is recorded in
 * `symmy_integration.executor_workload_grants` with who made it and why.
 */

export type SymmyExecutorContracts = Parameters<typeof deriveSymmyRouteBindings>[0]['contracts'];

/** Who changed the executor's workloads and why: the route change that needed it. */
export interface SymmyExecutorAttribution {
  readonly operatorRef: string;
  readonly reason: string;
}

const unavailable = (reason: string) => (cause?: unknown) => new SymmyRouteEnrollmentUnavailable({ cause, reason });

/** One executor workload of a route as Core holds it: its system holders and whether each binding serves the company. */
export interface SymmyExecutorWorkloadState {
  readonly companyScoped: boolean;
  readonly holders: readonly {
    readonly bindingId: string;
    readonly principalId: string;
    /** Whether this very binding is registered for the route's company (read only for a company-scoped workload). */
    readonly registered: boolean;
  }[];
  readonly workloadKey: string;
}

/** A Core write the executor needs: a binding of a workload no system Principal holds, or a company registration. */
export type SymmyExecutorGrant =
  | { readonly kind: 'binding'; readonly legalEntityId?: string; readonly workloadKey: string }
  | {
      readonly kind: 'company_registration';
      readonly legalEntityId: string;
      readonly workloadBindingId: string;
      readonly workloadKey: string;
    };

/**
 * What the executor still needs for a route's workloads. A workload no system Principal holds is bound to the executor
 * (registered for the company where a call runs there); the executor's own binding not registered for the company is
 * registered. A workload held by two system Principals, or by another one, is left to the route checks, which refuse it.
 */
export const planSymmyExecutorGrants = (input: {
  readonly executorPrincipalId: string;
  readonly legalEntityId?: string | undefined;
  readonly workloads: readonly SymmyExecutorWorkloadState[];
}): readonly SymmyExecutorGrant[] =>
  input.workloads.flatMap(({ companyScoped, holders, workloadKey }): SymmyExecutorGrant[] => {
    const company = companyScoped ? input.legalEntityId : undefined;
    const [holder, second] = holders;
    if (holder === undefined) {
      return company === undefined
        ? [{ kind: 'binding', workloadKey }]
        : [{ kind: 'binding', legalEntityId: company, workloadKey }];
    }
    if (second !== undefined || holder.principalId !== input.executorPrincipalId || company === undefined) {
      return [];
    }
    return holder.registered
      ? []
      : [{ kind: 'company_registration', legalEntityId: company, workloadBindingId: holder.bindingId, workloadKey }];
  });

/** The executor workloads of a binding plan besides its own job enrollment, each company-scoped if any call is. */
export const symmyExecutorWorkloadsOf = (bindings: readonly SymmyRequiredBinding[]) => {
  const scoped = new Map<string, boolean>();
  for (const { companyScoped, identity, workloads } of bindings) {
    if (identity !== 'executor') {
      continue;
    }
    for (const workloadKey of workloads) {
      if (workloadKey !== SYMMY_JOB_KEY) {
        scoped.set(workloadKey, (scoped.get(workloadKey) ?? false) || companyScoped);
      }
    }
  }
  return [...scoped].map(([workloadKey, companyScoped]) => ({ companyScoped, workloadKey }));
};

const registrationKey = (workloadKey: string, legalEntityId: string) => `${workloadKey}\u0000${legalEntityId}`;

/** The executor workloads the Tenant's active routes call under, and the companies each runs in. */
export const symmyExecutorWorkloadsInUse = (
  routes: readonly {
    readonly fixturePlan: Parameters<typeof symmyEnrolledInventory>[1] | null;
    readonly legalEntityId: string | null;
    readonly routeKey: Parameters<typeof symmyRouteInventoryOf>[0];
  }[],
  contracts: SymmyExecutorContracts,
) => {
  const workloads = new Set<string>();
  const registrations = new Set<string>();
  for (const { fixturePlan, legalEntityId, routeKey } of routes) {
    const inventory = symmyRouteInventoryOf(routeKey);
    if (Option.isNone(inventory) || fixturePlan === null) {
      continue;
    }
    const { bindings } = deriveSymmyRouteBindings({
      companyScoped: legalEntityId !== null,
      contracts,
      enrolled: symmyEnrolledInventory(inventory.value, fixturePlan),
      inventory: inventory.value,
    });
    for (const { companyScoped, workloadKey } of symmyExecutorWorkloadsOf(bindings)) {
      workloads.add(workloadKey);
      if (companyScoped && legalEntityId !== null) {
        registrations.add(registrationKey(workloadKey, legalEntityId));
      }
    }
  }
  return {
    hasRegistration: (workloadKey: string, legalEntityId: string) =>
      registrations.has(registrationKey(workloadKey, legalEntityId)),
    uses: (workloadKey: string) => workloads.has(workloadKey),
  };
};

/**
 * Serializes every change of the Tenant's executor workloads, held until the transaction ends. The Action takes it
 * before any route enrollment lock, so the order is always this lock, then the enrollment locks.
 */
export const lockSymmyExecutorWorkloads = (transaction: ScopedTransactionExecutor, tenantId: string) => {
  const lockKey = `integration.symmy.executor-workloads:${tenantId}`;
  return transaction
    .select({ locked: sql`pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))` })
    .from(sql`(values (1)) as symmy_executor_workloads_lock(anchor)`)
    .pipe(Effect.asVoid, Effect.mapError(unavailable('The executor workload lock could not be taken')));
};

const newId = Effect.fn('SymmyExecutorWorkloads.newId')(function* newId() {
  const crypto = yield* Crypto.Crypto;
  return yield* crypto.randomUUIDv4().pipe(Effect.mapError(unavailable('A binding id could not be drawn')));
});

const decodeBindingId = (value: string) =>
  Schema.decodeUnknownEffect(AccessWorkloadBindingIdSchema)(value).pipe(
    Effect.mapError(unavailable('A workload binding id is invalid')),
  );
const decodeCompanyBindingId = (value: string) =>
  Schema.decodeUnknownEffect(AccessWorkloadCompanyBindingIdSchema)(value).pipe(
    Effect.mapError(unavailable('A company registration id is invalid')),
  );
const decodeLegalEntityId = (value: string) =>
  Schema.decodeUnknownEffect(LegalEntityIdSchema)(value).pipe(Effect.mapError(unavailable('A company is invalid')));

/** The executor workloads' state in Core: each one's system holders and whether each binding serves the company. */
const readWorkloadStates = (
  transaction: ScopedTransactionExecutor,
  workloads: readonly { readonly companyScoped: boolean; readonly workloadKey: string }[],
  legalEntityId: string | undefined,
) =>
  Effect.forEach(
    workloads,
    Effect.fnUntraced(function* readState({ companyScoped, workloadKey }) {
      const systems = yield* readSystemPrincipalWorkloadHolders(transaction, workloadKey).pipe(
        Effect.mapError(unavailable('The executor workload bindings could not be read')),
      );
      const company = companyScoped ? legalEntityId : undefined;
      const registered =
        company === undefined || systems.length === 0
          ? []
          : yield* readActiveWorkloadBindingHolders(transaction, transaction.scope.tenantId, workloadKey, company).pipe(
              Effect.mapError(unavailable('The executor company registrations could not be read')),
            );
      const state: SymmyExecutorWorkloadState = {
        companyScoped,
        holders: systems.map(({ bindingId, principalId }) => ({
          bindingId,
          principalId,
          registered: registered.some(
            (holder) => holder.principalId === principalId && holder.companyRegistration === 'binding',
          ),
        })),
        workloadKey,
      };
      return state;
    }),
    // One transaction serves one statement at a time.
    { concurrency: 1 },
  );

/**
 * Grants the executor what a route's bindings need of it that Core does not hold yet, each Core write recorded as granted
 * by this change. Grants nothing while the Tenant has no single enrolled Symmy executor: the route checks then refuse
 * the route with `executor_binding_missing` on `integration.symmy.execute-symmy-job`, which
 * `core.identity.change-system-workload-enrollment` enrolls. Idempotent: a repeated change finds everything held.
 */
export const grantSymmyExecutorWorkloads = Effect.fn('SymmyExecutorWorkloads.grant')(function* grant(
  transaction: ScopedTransactionExecutor,
  input: {
    readonly attribution: SymmyExecutorAttribution;
    readonly bindings: readonly SymmyRequiredBinding[];
    readonly legalEntityId?: string | undefined;
    readonly scope: OperationalScope;
  },
) {
  const { attribution, bindings, legalEntityId, scope } = input;
  const workloads = symmyExecutorWorkloadsOf(bindings);
  if (workloads.length === 0) {
    return [];
  }
  const executors = yield* readSystemPrincipalWorkloadHolders(transaction, SYMMY_JOB_KEY).pipe(
    Effect.mapError(unavailable('The Symmy executor enrollment could not be read')),
  );
  const [executor, second] = executors;
  if (executor === undefined || second !== undefined) {
    return [];
  }
  const grants = planSymmyExecutorGrants({
    executorPrincipalId: executor.principalId,
    legalEntityId,
    workloads: yield* readWorkloadStates(transaction, workloads, legalEntityId),
  });
  if (grants.length === 0) {
    return [];
  }
  const tenantId = yield* Schema.decodeUnknownEffect(TenantIdSchema)(scope.tenantId).pipe(
    Effect.mapError(unavailable('The Tenant is invalid')),
  );
  const principalId = yield* Schema.decodeUnknownEffect(PrincipalIdSchema)(executor.principalId).pipe(
    Effect.mapError(unavailable('The Symmy executor is invalid')),
  );
  const createdAt = DateTime.toDateUtc(yield* DateTime.now);
  const recorded = {
    executorPrincipalId: principalId,
    grantedByRef: attribution.operatorRef,
    grantedReason: attribution.reason,
    tenantId,
  };
  const registerCompany = Effect.fnUntraced(function* registerCompany(
    workloadBindingId: string,
    company: string,
    workloadKey: string,
  ) {
    const [companyBindingId, legalEntity] = yield* Effect.all(
      [Effect.flatMap(newId(), decodeCompanyBindingId), decodeLegalEntityId(company)],
      { concurrency: 1 },
    );
    yield* registerWorkloadCompanyBindingsIn(transaction, scope, {
      bindings: [
        {
          companyBindingId,
          createdAt,
          incarnation: yield* decodeCompanyBindingId(yield* newId()),
          legalEntityId: legalEntity,
          tenantId,
          workloadBindingId: yield* decodeBindingId(workloadBindingId),
        },
      ],
    }).pipe(Effect.mapError(unavailable(`The company registration of ${workloadKey} could not be written`)));
    yield* transaction
      .insert(symmyExecutorWorkloadGrants)
      .values({
        ...recorded,
        grantedRowId: companyBindingId,
        kind: 'company_registration',
        legalEntityId: legalEntity,
        workloadBindingId,
        workloadKey,
      })
      .pipe(Effect.mapError(unavailable('The executor grant could not be recorded')));
    const change: SymmyExecutorWorkloadChange = {
      change: 'granted',
      legalEntityId: legalEntity,
      workloadKey: SymmyExecutorWorkloadKeySchema.make(workloadKey),
    };
    return change;
  });
  const grantOne = Effect.fnUntraced(function* grantOne(planned: SymmyExecutorGrant) {
    if (planned.kind === 'company_registration') {
      return [yield* registerCompany(planned.workloadBindingId, planned.legalEntityId, planned.workloadKey)];
    }
    const bindingId = yield* Effect.flatMap(newId(), decodeBindingId);
    const workloadKey = yield* Schema.decodeUnknownEffect(WorkloadKeySchema)(planned.workloadKey).pipe(
      Effect.mapError(unavailable('A workload key is invalid')),
    );
    yield* registerWorkloadBindingsIn(transaction, scope, {
      bindings: [
        {
          bindingId,
          createdAt,
          incarnation: yield* Effect.flatMap(newId(), decodeBindingId),
          principalId,
          tenantId,
          workloadKey,
        },
      ],
    }).pipe(Effect.mapError(unavailable(`The executor binding of ${planned.workloadKey} could not be written`)));
    yield* transaction
      .insert(symmyExecutorWorkloadGrants)
      .values({
        ...recorded,
        grantedRowId: bindingId,
        kind: 'binding',
        legalEntityId: null,
        workloadBindingId: bindingId,
        workloadKey: planned.workloadKey,
      })
      .pipe(Effect.mapError(unavailable('The executor grant could not be recorded')));
    const bound: SymmyExecutorWorkloadChange = {
      change: 'granted',
      workloadKey: SymmyExecutorWorkloadKeySchema.make(planned.workloadKey),
    };
    return planned.legalEntityId === undefined
      ? [bound]
      : [bound, yield* registerCompany(bindingId, planned.legalEntityId, planned.workloadKey)];
  });
  // In plan order, one Core write at a time in the one transaction.
  const changes = yield* Effect.forEach(grants, grantOne, { concurrency: 1 });
  return changes.flat();
});

/**
 * Withdraws what an enable granted the executor that no active route of the Tenant needs any more: a company
 * registration once no active route of that company calls under the workload, a binding once no active route does. Each
 * grant is marked withdrawn by this change; an installer's binding or registration is never touched.
 */
export const withdrawSymmyExecutorWorkloads = Effect.fn('SymmyExecutorWorkloads.withdraw')(function* withdraw(
  transaction: ScopedTransactionExecutor,
  input: {
    readonly attribution: SymmyExecutorAttribution;
    readonly contracts: SymmyExecutorContracts;
    readonly scope: OperationalScope;
  },
) {
  const { attribution, contracts, scope } = input;
  const [grants, routes] = yield* Effect.all(
    [
      transaction
        .select()
        .from(symmyExecutorWorkloadGrants)
        .where(
          and(
            eq(symmyExecutorWorkloadGrants.tenantId, scope.tenantId),
            isNull(symmyExecutorWorkloadGrants.withdrawnAt),
          ),
        )
        .for('update'),
      transaction
        .select({
          fixturePlan: symmyJobRoutes.fixturePlan,
          legalEntityId: symmyJobRoutes.legalEntityId,
          routeKey: symmyJobRoutes.routeKey,
        })
        .from(symmyJobRoutes)
        .where(and(eq(symmyJobRoutes.tenantId, scope.tenantId), eq(symmyJobRoutes.active, true))),
    ],
    // One transaction serves one statement at a time.
    { concurrency: 1 },
  ).pipe(Effect.mapError(unavailable('The executor grants could not be read')));
  const inUse = symmyExecutorWorkloadsInUse(routes, contracts);
  const unused = (grant: (typeof grants)[number]) =>
    grant.kind === 'binding'
      ? !inUse.uses(grant.workloadKey)
      : grant.legalEntityId === null || !inUse.hasRegistration(grant.workloadKey, grant.legalEntityId);
  // Registrations first: a binding is withdrawn only after the registrations granted on it.
  const withdrawn = grants
    .filter(unused)
    .toSorted((left, right) => Number(left.kind === 'binding') - Number(right.kind === 'binding'));
  const revokedAt = DateTime.toDateUtc(yield* DateTime.now);
  const withdrawOne = Effect.fnUntraced(function* withdrawOne(grant: (typeof grants)[number]) {
    yield* (
      grant.kind === 'binding'
        ? Effect.flatMap(decodeBindingId(grant.grantedRowId), (bindingId) =>
            revokeWorkloadBindingIn(transaction, scope, { bindingId, revokedAt }),
          )
        : Effect.flatMap(decodeCompanyBindingId(grant.grantedRowId), (companyBindingId) =>
            revokeWorkloadCompanyBindingIn(transaction, scope, { companyBindingId, revokedAt }),
          )
    ).pipe(Effect.mapError(unavailable(`The executor ${grant.kind} of ${grant.workloadKey} could not be withdrawn`)));
    yield* transaction
      .update(symmyExecutorWorkloadGrants)
      .set({ withdrawnAt: revokedAt, withdrawnByRef: attribution.operatorRef })
      .where(
        and(
          eq(symmyExecutorWorkloadGrants.tenantId, grant.tenantId),
          eq(symmyExecutorWorkloadGrants.grantedRowId, grant.grantedRowId),
        ),
      )
      .pipe(Effect.mapError(unavailable('The executor grant could not be marked withdrawn')));
    const change: SymmyExecutorWorkloadChange =
      grant.legalEntityId === null
        ? { change: 'withdrawn', workloadKey: SymmyExecutorWorkloadKeySchema.make(grant.workloadKey) }
        : {
            change: 'withdrawn',
            legalEntityId: yield* decodeLegalEntityId(grant.legalEntityId),
            workloadKey: SymmyExecutorWorkloadKeySchema.make(grant.workloadKey),
          };
    return change;
  });
  // Registrations before bindings, one Core write at a time in the one transaction.
  return yield* Effect.forEach(withdrawn, withdrawOne, { concurrency: 1 });
});
