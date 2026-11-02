import { randomUUID } from 'node:crypto';

import { ContextAccess, ScopedRoutineInvocationError } from '@app/core-runtime';
import { makeIsolatedNativeDatabaseFixture } from '@app/core-runtime/testing/isolated-native-database';
import { NodeChildProcessSpawner, NodeCrypto, NodeServices } from '@effect/platform-node';
import { eq } from 'drizzle-orm';
import { Context, DateTime, Effect, Layer, Option, Result, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { PurchaseApprovalCurrentnessFactory } from '../../shared/domain/purchase-approval-currentness-port.ts';
import {
  PurchasingApprovalRejected,
  RevalidatePurchaseApprovalInputSchema,
  computePurchaseProposalCanonicalHash,
} from '../../shared/domain/purchasing-approval.ts';
import type { RevalidatePurchaseApprovalInput } from '../../shared/domain/purchasing-approval.ts';
import { PurchaseLimitDependencyUnavailableSchema } from '../../shared/domain/purchase-limit-policy.ts';
import { approvalRevalidations } from '../../src/database/schema.ts';
import { readCurrentPurchaseApprovalRevalidationRoutine } from '../../src/persistence/purchasing-approval-persistence.ts';
import { enrollmentApplicationCompositionSnapshot } from '../support/enrollment-application-composition.ts';
import { makePurchasingApprovalNativeFixture } from '../support/purchasing-approval-native.ts';

const services = NodeChildProcessSpawner.layer.pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(NodeCrypto.layer),
);

const scenario = Effect.fn('ApprovalCurrentness.nativeScenario')(function* nativeScenario() {
  const snapshot = yield* enrollmentApplicationCompositionSnapshot;
  const isolated = yield* makeIsolatedNativeDatabaseFixture({
    compositionSnapshot: snapshot,
    mode: 'schema-only',
    purpose: 'stabilization-1256-approval-currentness',
  });
  yield* isolated.assertClonedSchema();
  const owner = yield* makePurchasingApprovalNativeFixture({ connections: isolated.connections, snapshot });
  // The shared owner fixture uses all six actual runAction registrations and actual invocation IDs.
  // Only its exact-target external Current/role and cryptographic issuer dependencies are TEST configured.
  const chain = yield* owner.createRequest({
    deliveryAddress: Object.fromEntries([
      ['street', 'Main'],
      ['city', 'Prague'],
      ['country', 'CZ'],
    ]),
    invoiceAddress: Object.fromEntries([
      ['street', 'Billing'],
      ['city', 'Brno'],
      ['country', 'CZ'],
    ]),
    ttlMilliseconds: 60_000,
  });
  // Submission reloads the genuine proposal snapshot from PostgreSQL JSONB. Each address
  // changes property order, but neither the immutable approved meaning nor its hash changes.
  for (const destination of ['deliveryDestination', 'invoiceRecipient'] as const) {
    const stored = chain.request.request.proposal[destination];
    expect(stored.address).toEqual(chain.proposal[destination].address);
    expect(JSON.stringify(stored.address)).not.toBe(JSON.stringify(chain.proposal[destination].address));
    expect(computePurchaseProposalCanonicalHash({ ...chain.proposal, [destination]: stored })).toBe(
      chain.proposal.canonicalHash,
    );
  }
  expect(computePurchaseProposalCanonicalHash(chain.request.request.proposal)).toBe(chain.proposal.canonicalHash);
  const pending = yield* Effect.result(
    owner.fixture
      .prepareOwner(
        (transaction) =>
          transaction.invoke(readCurrentPurchaseApprovalRevalidationRoutine, [
            { requestRef: chain.request.request.requestRef },
          ]),
        'required',
      )
      .pipe(Effect.provideContext(owner.runtimeContext)),
  );
  expect(Result.isFailure(pending)).toBe(true);
  if (Result.isFailure(pending)) {
    const failure = yield* Schema.decodeUnknownEffect(Schema.toType(ScopedRoutineInvocationError))(pending.failure);
    expect(Option.getOrUndefined(failure.constraint)).toBe('pa_currentness_not_found');
  }
  const approved = yield* chain.decide();
  expect(approved.request.status).toBe('APPROVED');
  const factory = Context.get(owner.runtimeContext, PurchaseApprovalCurrentnessFactory);
  const access = Context.get(owner.runtimeContext, ContextAccess);
  let externalCurrentCalls = 0;
  const externalCurrentness = {
    resolveCurrent: () =>
      Effect.sync(() => {
        externalCurrentCalls += 1;
      }).pipe(
        Effect.andThen(
          Effect.fail(
            Schema.decodeUnknownSync(PurchaseLimitDependencyUnavailableSchema)({
              _tag: 'PurchaseLimitDependencyUnavailable',
              code: 'purchase_limit_dependency_unavailable',
              dependency: 'TEST_EXACT_APPROVAL_CURRENT_UNAVAILABLE',
              reason: 'The bounded external Current owner is deliberately unavailable',
            }),
          ),
        ),
      ),
  };
  const evaluationSource = {
    loadCurrent: () => Effect.die('Unavailable Current facts must not reach final evaluation'),
  };
  const resolve = (patch: Partial<RevalidatePurchaseApprovalInput> = {}, wrongLegalEntity = false) =>
    owner.fixture
      .prepareOwner(
        (transaction, scope) =>
          Effect.gen(function* resolveProductionCurrentness() {
            const now = (yield* owner.nativeNow()).at;
            const claimed = yield* Schema.decodeUnknownEffect(RevalidatePurchaseApprovalInputSchema)({
              buyerPermission: 'ALLOWED',
              checkedAt: DateTime.formatIso(now),
              // This actual scoped operation's correlation is not an invented Order Commitment Attempt.
              commitmentCorrelationId: scope.correlationId,
              counterpartyRef: chain.counterpartyRef,
              decisionBundleHash: approved.decision.decisionBundleHash,
              decisionBundleVersion: approved.decision.decisionBundleVersion,
              decisionRef: approved.decision.decisionRef,
              expectedProposalHash: chain.proposal.canonicalHash,
              hierarchyRef: chain.hierarchy.hierarchyRef,
              idempotencyKey: randomUUID(),
              profileState: 'ACTIVE',
              proposalRevisionRef: chain.proposal.proposalRevisionRef,
              requestRef: approved.request.requestRef,
              routeCurrent: true,
              routeRef: approved.request.route.routeRef,
              sourceRevisions: chain.sourceRevisions,
              storefrontId: owner.storefrontId,
              validUntil: chain.expiresAtText,
            });
            const trusted = {
              ...scope,
              legalEntityId: wrongLegalEntity ? randomUUID() : owner.legalEntityId,
              trustedStorefrontId: owner.storefrontId,
            };
            const service = factory.make(transaction, trusted, access, externalCurrentness, evaluationSource);
            return yield* service.resolveRevalidation({
              claimed: { ...claimed, ...patch },
              scope: {
                legalEntityId: trusted.legalEntityId,
                principalId: scope.principalId,
                storefrontId: owner.storefrontId,
                tenantId: owner.tenantId,
              },
            });
          }),
        'required',
      )
      .pipe(Effect.provideContext(owner.runtimeContext));
  const readProofs = () =>
    owner.admin.select().from(approvalRevalidations).where(eq(approvalRevalidations.tenantId, owner.tenantId));
  return { approved, externalCalls: () => externalCurrentCalls, readProofs, resolve };
});

it.live(
  'reads genuine registered Approval snapshots through the actual factory and keeps later Current failure and wrong targets proof-free',
  () =>
    Effect.scoped(
      Effect.gen(function* nativeCurrentnessBoundary() {
        const current = yield* scenario();
        expect(yield* current.readProofs()).toEqual([]);
        expect(current.approved.decision.decisionBundleHash).toBe(current.approved.request.decisionBundleHash);
        const laterFailure = yield* Schema.decodeUnknownEffect(PurchasingApprovalRejected)(
          yield* Effect.flip(current.resolve()),
        );
        expect(laterFailure.code).toBe('CURRENT_STATE_INDETERMINATE');
        expect(laterFailure.reason).not.toBe('The current Purchasing Approval snapshots are unavailable');
        expect(laterFailure.reason).not.toBe('The current Purchasing Approval snapshot is malformed');
        expect(current.externalCalls()).toBe(1);
        const beforeDenials = current.externalCalls();
        const foreignTenant = yield* Schema.decodeUnknownEffect(PurchasingApprovalRejected)(
          yield* Effect.flip(
            current.resolve({ requestRef: { ...current.approved.request.requestRef, tenantId: randomUUID() } }),
          ),
        );
        expect(foreignTenant.code).toBe('PERMISSION_DENIED');
        const foreignLegalEntity = yield* Schema.decodeUnknownEffect(PurchasingApprovalRejected)(
          yield* Effect.flip(current.resolve({}, true)),
        );
        expect(foreignLegalEntity.code).toBe('PERMISSION_DENIED');
        expect(current.externalCalls()).toBe(beforeDenials);
        const missing = yield* Schema.decodeUnknownEffect(PurchasingApprovalRejected)(
          yield* Effect.flip(
            current.resolve({ requestRef: { ...current.approved.request.requestRef, resourceId: randomUUID() } }),
          ),
        );
        expect(missing.code).toBe('CURRENT_STATE_INDETERMINATE');
        expect(missing.reason).toBe('The current Purchasing Approval snapshots are unavailable');
        // Each failed operation has settled before these fresh native reads. No write is attempted in an aborted transaction.
        expect(yield* current.readProofs()).toEqual([]);
        const afterAbort = yield* Schema.decodeUnknownEffect(PurchasingApprovalRejected)(
          yield* Effect.flip(current.resolve()),
        );
        expect(afterAbort.reason).not.toBe('The current Purchasing Approval snapshots are unavailable');
        expect(current.externalCalls()).toBe(beforeDenials + 1);
        expect(yield* current.readProofs()).toEqual([]);
      }),
    ).pipe(Effect.provide(services)),
);
