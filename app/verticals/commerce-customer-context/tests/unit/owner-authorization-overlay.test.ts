/* eslint-disable anti-slop/no-chained-type-assertions, typescript/no-unsafe-type-assertion -- The test harness decodes fixture rows through each owner routine schema before exposing Core's private branded transaction capability; expires: 2027-03-31. */
import type {
  OwnerAuthorizationInput,
  ScopedRoutineDefinition,
  ScopedTransactionExecutor,
} from '@app/core-runtime';
import { Deferred, Effect, Fiber, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import type { ProfileRetailPermissionReaderFactoryService } from '../../src/integrations/retail-permission-reader.ts';
import { makeCommerceCustomerContextOwnerAuthorizationOverlay } from '../../src/persistence/owner-authorization-overlay.ts';

const tenantId = '20000000-0000-4000-8000-000000000001';
const legalEntityId = '30000000-0000-4000-8000-000000000001';
const principalId = '50000000-0000-4000-8000-000000000001';
const counterpartyId = 'counterparty-one';

const scope = Object.freeze({
  authBindingId: '40000000-0000-4000-8000-000000000001',
  authContextRef: 'better-auth-session:owner-overlay-test',
  authMethod: 'session' as const,
  correlationId: 'owner-overlay-correlation',
  legalEntityId,
  principalId,
  tenantId,
  trustedStorefrontId: 'storefront-one',
});

const ownerRow = (
  state: 'ACTIVE' | 'PENDING_REVOKE' | 'RECONCILIATION_REQUIRED',
  storefrontResourceId: string | null = null,
) => {
  const row = {
    action_invocation_id: null,
    counterparty_resource_id: counterpartyId,
    grant_id: '70000000-0000-4000-8000-000000000001',
    granted_at: '2026-09-09T09:00:00.000Z',
    granted_by: principalId,
    mutation_id: state === 'PENDING_REVOKE' ? '80000000-0000-4000-8000-000000000001' : null,
    mutation_operation: state === 'PENDING_REVOKE' ? 'revoke' : null,
    mutation_staged: state === 'PENDING_REVOKE' ? true : null,
    permission_code: 'counterparty.access.manage',
    principal_id: principalId,
    reason: 'Owner overlay test',
    revision: 2,
    revoked_at: null,
    revoked_by: null,
    state,
    storefront_resource_id: storefrontResourceId,
  };
  return state === 'PENDING_REVOKE'
    ? { ...row, operation_outcome: 'PENDING_REVOKE' as const }
    : row;
};

type RoutineHandler = (routineKey: string) => readonly object[];

const transactionWith = (handler: RoutineHandler): ScopedTransactionExecutor =>
  // SAFETY: Every fixture row is decoded by the invoked owner routine schema; this harness only
  // exercises the adapter's scoped `invoke` capability.
  ({
    invoke: (routine: ScopedRoutineDefinition) =>
      Effect.sync(() => handler(routine.routineKey)).pipe(
        Effect.flatMap((rows) =>
          // oxlint-disable-next-line unicorn/no-array-method-this-argument -- Effect.forEach's second argument is the element effect, not Array thisArg.
          Effect.forEach(rows, (row) => Schema.decodeUnknownEffect(routine.resultSchema)(row)),
        ),
      ),
  }) as unknown as ScopedTransactionExecutor;

const transactionWithEffect = (
  handler: (routineKey: string) => Effect.Effect<readonly object[]>,
): ScopedTransactionExecutor =>
  // SAFETY: Every fixture row is decoded by the invoked owner routine schema; this harness only
  // exercises the adapter's scoped `invoke` capability.
  ({
    invoke: (routine: ScopedRoutineDefinition) =>
      handler(routine.routineKey).pipe(
        Effect.flatMap((rows) =>
          // oxlint-disable-next-line unicorn/no-array-method-this-argument -- Effect.forEach's second argument is the element effect, not Array thisArg.
          Effect.forEach(rows, (row) => Schema.decodeUnknownEffect(routine.resultSchema)(row)),
        ),
      ),
  }) as unknown as ScopedTransactionExecutor;

const readerFactory: ProfileRetailPermissionReaderFactoryService = {
  make: () => () =>
    Effect.succeed({
      observedAt: '2026-09-09T09:00:00.000Z',
      permissions: [],
    }),
};

const input = (
  target: Extract<
    OwnerAuthorizationInput['targets'][number],
    { readonly kind: 'business_permission' }
  >,
): OwnerAuthorizationInput => ({
  operation: 'action',
  operationKey: 'commerce.customer-context.grant-counterparty-commerce-access',
  owningModuleKey: 'commerce.customer-context',
  scope,
  targets: [target],
});

const counterpartyTarget = (
  storefrontId?: string,
): Extract<OwnerAuthorizationInput['targets'][number], { readonly kind: 'business_permission' }> =>
  storefrontId === undefined
    ? {
        kind: 'business_permission',
        permission: 'counterparty.access.manage',
        target: {
          counterpartyId,
          kind: 'counterparty',
          legalEntityId,
          tenantId,
        },
      }
    : {
        kind: 'business_permission',
        permission: 'counterparty.access.manage',
        target: {
          counterpartyId,
          kind: 'counterparty_storefront',
          legalEntityId,
          storefrontId,
          tenantId,
        },
        trustedStorefrontId: storefrontId,
      };

it.effect('denies a stale Core tuple when the owner row is pending revoke', () =>
  Effect.gen(function* ownerPendingRevoke() {
    const calls: string[] = [];
    const transaction = transactionWith((routineKey) => {
      calls.push(routineKey);
      return routineKey === 'counterparty-access.lock-grant-authority'
        ? [ownerRow('PENDING_REVOKE')]
        : [];
    });
    const overlay = makeCommerceCustomerContextOwnerAuthorizationOverlay(readerFactory);
    const decision = yield* overlay.authorize(transaction, input(counterpartyTarget()));

    expect(decision).toBe('denied');
    expect(calls).toEqual(['counterparty-access.lock-grant-authority']);
  }),
);

it.effect('uses a broad active owner row for a narrower storefront target', () =>
  Effect.gen(function* broadActiveOwnerGrant() {
    const transaction = transactionWith((routineKey) =>
      routineKey === 'counterparty-access.lock-grant-authority'
        ? [ownerRow('ACTIVE'), ownerRow('PENDING_REVOKE', 'storefront-one')]
        : [],
    );
    const overlay = makeCommerceCustomerContextOwnerAuthorizationOverlay(readerFactory);
    const decision = yield* overlay.authorize(
      transaction,
      input(counterpartyTarget('storefront-one')),
    );

    expect(decision).toBe('allowed');
  }),
);

it.effect('returns unavailable when owner reconciliation is required', () =>
  Effect.gen(function* ownerReconciliationRequired() {
    const transaction = transactionWith((routineKey) =>
      routineKey === 'counterparty-access.lock-grant-authority'
        ? [ownerRow('RECONCILIATION_REQUIRED')]
        : [],
    );
    const overlay = makeCommerceCustomerContextOwnerAuthorizationOverlay(readerFactory);
    const decision = yield* overlay.authorize(transaction, input(counterpartyTarget()));

    expect(decision).toBe('unavailable');
  }),
);

it.effect('fences a grant reauthorization against a concurrent revoke', () =>
  Effect.gen(function* revokeBeforeGrantReauthorization() {
    const lockStarted = yield* Deferred.make<null>();
    const releaseFence = yield* Deferred.make<null>();
    let revokeCommitted = false;
    const transaction = transactionWithEffect((routineKey) => {
      if (routineKey !== 'counterparty-access.lock-grant-authority') {
        return Effect.succeed([]);
      }
      return Effect.gen(function* ownerFence() {
        yield* Deferred.succeed(lockStarted, null);
        yield* Deferred.await(releaseFence);
        return [ownerRow(revokeCommitted ? 'PENDING_REVOKE' : 'ACTIVE')];
      });
    });
    const overlay = makeCommerceCustomerContextOwnerAuthorizationOverlay(readerFactory);
    const decisionFiber = yield* Effect.forkScoped(
      overlay.authorize(transaction, input(counterpartyTarget())),
    );
    yield* Deferred.await(lockStarted);
    revokeCommitted = true;
    yield* Deferred.succeed(releaseFence, null);

    expect(yield* Fiber.join(decisionFiber)).toBe('denied');
  }),
);
