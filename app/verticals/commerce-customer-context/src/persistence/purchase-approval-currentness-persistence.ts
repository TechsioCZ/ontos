import type {
  BusinessPermissionAccessTarget,
  ContextAccessService,
  OperationalScope,
  ScopedTransactionExecutor,
} from '@app/core-runtime';
import { Effect, DateTime, Layer, Schema } from 'effect';

import { PurchaseApprovalCurrentnessFactory } from '../../shared/domain/purchase-approval-currentness-port.ts';
import type {
  PurchaseApprovalCurrentnessFactoryContract,
  PurchaseApprovalCurrentnessService,
  PurchaseApprovalCurrentnessTrustedScope,
} from '../../shared/domain/purchase-approval-currentness-port.ts';
import {
  PurchaseApprovalRequestSchema,
  PurchaseProposalRevisionSchema,
  ApprovalRouteSchema,
  ApprovalDecisionSchema,
  PurchasingApprovalRejected,
} from '../../shared/domain/purchasing-approval.ts';
import type {
  RevalidatePurchaseApprovalInput,
  SubmitPurchaseApprovalRequestInput,
} from '../../shared/domain/purchasing-approval.ts';
import { PurchaseLimitEvaluationCurrentFactsSchema } from '../../shared/domain/purchase-limit-evaluation-currentness-port.ts';
import type { PurchaseLimitEvaluationCurrentnessPortService } from '../../shared/domain/purchase-limit-evaluation-currentness-port.ts';
import {
  PurchaseLimitSourceRevisionVectorSchema,
  evaluatePurchaseLimit,
  PurchaseLimitStorefrontIdSchema,
} from '../../shared/domain/purchase-limit-evaluation.ts';
import type { PurchaseLimitSourceRevisionVector } from '../../shared/domain/purchase-limit-evaluation.ts';
import type { PurchaseLimitEvaluationSourceService } from '../../shared/domain/purchase-limit-evaluation.ts';
import { PurchaseLimitCounterpartyRefSchema } from '../../shared/domain/purchase-limit-policy.ts';
import { CommerceCustomerProfileRefSchema } from '../../shared/domain/profile-decisions.ts';
import { profilePersistenceServicesForTransaction } from './profile-persistence.ts';
import { lockingCurrentOwnerAccessForTransaction } from './access-persistence.ts';
import {
  readCurrentPurchaseLimitPolicyState,
  readCurrentPurchaseProposalRoutine,
} from './purchase-limit-persistence.ts';
import type { PurchasingApprovalScopedRoutineInvoker } from './purchasing-approval-persistence.ts';
import { readCurrentPurchaseApprovalRevalidationRoutine } from './purchasing-approval-persistence.ts';

const PROFILE_SOURCE = 'purchasing-profile';
const PROPOSAL_SOURCE = 'purchase-proposal';
const OWNER_SOURCE_NAMES = new Set(['counterparty-policy', 'principal-override']);

const SnapshotSchema = Schema.Struct({
  request: PurchaseApprovalRequestSchema,
  proposal: PurchaseProposalRevisionSchema,
  route: ApprovalRouteSchema,
  decision: ApprovalDecisionSchema,
  sourceRevisions: PurchaseLimitSourceRevisionVectorSchema,
});
type Snapshot = typeof SnapshotSchema.Type;
type CurrentApprovalFacts = Pick<Snapshot, 'proposal' | 'sourceRevisions'>;
const ProposalFactsSchema = Schema.Struct({
  proposal: PurchaseProposalRevisionSchema,
  sourceRevisions: PurchaseLimitSourceRevisionVectorSchema,
});

const CurrentnessResultSchema = Schema.Struct({ result: Schema.Json });

const currentnessRejected = (reason: string): PurchasingApprovalRejected =>
  new PurchasingApprovalRejected({
    code: 'CURRENT_STATE_INDETERMINATE',
    reason,
    retryable: true,
  });

const denied = (reason: string): PurchasingApprovalRejected =>
  new PurchasingApprovalRejected({ code: 'PERMISSION_DENIED', reason, retryable: false });

const sameRef = (
  left: {
    readonly moduleId: string;
    readonly resourceId: string;
    readonly resourceType: string;
    readonly tenantId: string;
  },
  right: {
    readonly moduleId: string;
    readonly resourceId: string;
    readonly resourceType: string;
    readonly tenantId: string;
  },
): boolean =>
  left.moduleId === right.moduleId &&
  left.resourceId === right.resourceId &&
  left.resourceType === right.resourceType &&
  left.tenantId === right.tenantId;

const sourceMap = (sources: readonly { readonly source: string; readonly revision: string }[]) =>
  new Map(sources.map(({ source, revision }) => [source, revision] as const));

const sameSourceVector = (
  left: readonly { readonly source: string; readonly revision: string }[],
  right: readonly { readonly source: string; readonly revision: string }[],
): boolean => {
  const leftMap = sourceMap(left);
  const rightMap = sourceMap(right);
  return (
    leftMap.size === rightMap.size &&
    [...leftMap].every(([source, revision]) => rightMap.get(source) === revision)
  );
};

const invokeCurrentnessSnapshot = (
  transaction: PurchasingApprovalScopedRoutineInvoker,
  requestRef: string,
): Effect.Effect<Snapshot, PurchasingApprovalRejected> =>
  transaction.invoke(readCurrentPurchaseApprovalRevalidationRoutine, [{ requestRef }]).pipe(
    Effect.mapError(() =>
      currentnessRejected('The current Purchasing Approval snapshots are unavailable'),
    ),
    Effect.flatMap(([row]) =>
      row === undefined
        ? Effect.fail(
            currentnessRejected('The current Purchasing Approval snapshots are unavailable'),
          )
        : Schema.decodeUnknownEffect(CurrentnessResultSchema)(row).pipe(
            Effect.mapError(() =>
              currentnessRejected('The currentness owner returned an invalid result'),
            ),
            Effect.flatMap(({ result }) =>
              Schema.decodeUnknownEffect(SnapshotSchema)(result).pipe(
                Effect.mapError(() =>
                  currentnessRejected('The current Purchasing Approval snapshot is malformed'),
                ),
              ),
            ),
          ),
    ),
  );

const invokeCurrentProposal = (
  transaction: PurchasingApprovalScopedRoutineInvoker,
  proposalRevisionRef: string,
): Effect.Effect<CurrentApprovalFacts, PurchasingApprovalRejected> =>
  transaction
    .invoke(readCurrentPurchaseProposalRoutine, [
      { proposalRevisionResourceId: proposalRevisionRef },
    ])
    .pipe(
      Effect.mapError(() => currentnessRejected('The current Purchase Proposal is unavailable')),
      Effect.flatMap(([row]) =>
        row === undefined
          ? Effect.fail(currentnessRejected('The current Purchase Proposal is unavailable'))
          : Schema.decodeUnknownEffect(Schema.Struct({ result: Schema.Json }))(row).pipe(
              Effect.mapError(() =>
                currentnessRejected('The Purchase Proposal owner returned an invalid result'),
              ),
              Effect.flatMap(({ result }) =>
                Schema.decodeUnknownEffect(ProposalFactsSchema)(result).pipe(
                  Effect.mapError(() =>
                    currentnessRejected('The current Purchase Proposal snapshot is malformed'),
                  ),
                ),
              ),
            ),
      ),
    );

const assertClaimedTarget = (
  claimed: RevalidatePurchaseApprovalInput,
  snapshot: Snapshot,
  scope: PurchaseApprovalCurrentnessTrustedScope,
): Effect.Effect<void, PurchasingApprovalRejected> => {
  const { request, proposal, route, decision } = snapshot;
  const counterparty = proposal.identity.counterpartyRef;
  if (
    claimed.counterpartyRef.tenantId !== scope.tenantId ||
    claimed.storefrontId !== scope.storefrontId ||
    !sameRef(claimed.requestRef, request.requestRef) ||
    !sameRef(claimed.proposalRevisionRef, proposal.proposalRevisionRef) ||
    claimed.expectedProposalHash !== proposal.canonicalHash ||
    !sameRef(claimed.decisionRef, decision.decisionRef) ||
    !sameRef(claimed.hierarchyRef, route.hierarchyRef) ||
    !sameRef(claimed.routeRef, route.routeRef) ||
    !sameRef(claimed.counterpartyRef, counterparty) ||
    proposal.context.tenantId !== scope.tenantId ||
    proposal.context.sellingLegalEntityId !== scope.legalEntityId ||
    proposal.context.storefrontId !== scope.storefrontId ||
    !sameRef(route.requestRef, request.requestRef) ||
    !sameRef(route.proposalRevisionRef, proposal.proposalRevisionRef) ||
    !sameRef(decision.requestRef, request.requestRef) ||
    !sameRef(decision.proposalRevisionRef, proposal.proposalRevisionRef) ||
    !sameRef(decision.routeRef, route.routeRef) ||
    !sameRef(decision.hierarchyRef, route.hierarchyRef)
  ) {
    return Effect.fail(
      denied('The claimed approval identity does not match the owner-current snapshots'),
    );
  }
  return Effect.void;
};

const assertClaimedSubmissionTarget = (
  claimed: SubmitPurchaseApprovalRequestInput,
  snapshot: CurrentApprovalFacts,
  scope: PurchaseApprovalCurrentnessTrustedScope,
): Effect.Effect<void, PurchasingApprovalRejected> => {
  const { proposal } = snapshot;
  if (
    claimed.counterpartyRef.tenantId !== scope.tenantId ||
    claimed.storefrontId !== scope.storefrontId ||
    !sameRef(claimed.proposalRevisionRef, proposal.proposalRevisionRef) ||
    !sameRef(claimed.counterpartyRef, proposal.identity.counterpartyRef) ||
    proposal.context.tenantId !== scope.tenantId ||
    proposal.context.sellingLegalEntityId !== scope.legalEntityId ||
    proposal.context.storefrontId !== scope.storefrontId ||
    proposal.revision !== claimed.proposalRevision
  ) {
    return Effect.fail(
      denied('The claimed submission target does not match the owner-current proposal'),
    );
  }
  return Effect.void;
};

const currentProfile = (
  transaction: ScopedTransactionExecutor,
  snapshot: CurrentApprovalFacts,
  scope: PurchaseApprovalCurrentnessTrustedScope,
) => {
  const counterpartyRef = Schema.decodeUnknownEffect(PurchaseLimitCounterpartyRefSchema)(
    snapshot.proposal.identity.counterpartyRef,
  ).pipe(
    Effect.mapError(() =>
      currentnessRejected('The owner-current Counterparty reference is invalid'),
    ),
  );
  const profileRef = Schema.decodeUnknownEffect(CommerceCustomerProfileRefSchema)({
    kind: 'COUNTERPARTY',
    ...snapshot.proposal.identity.profileRef,
  }).pipe(
    Effect.mapError(() =>
      currentnessRejected('The owner-current Purchasing Profile reference is invalid'),
    ),
  );
  return Effect.gen(function* readProfileCurrentness() {
    const profile = yield* profileRef;
    const counterparty = yield* counterpartyRef;
    const services = profilePersistenceServicesForTransaction(transaction, {
      legalEntityId: scope.legalEntityId,
      principalId: scope.principalId,
      tenantId: scope.tenantId,
    });
    const current = yield* services.customerProfileTradingGate
      .evaluateGate(
        {
          authorizationSubject: {
            counterpartyRef: counterparty,
            kind: 'COUNTERPARTY',
          },
          profileRef: profile,
        },
        scope.tenantId,
      )
      .pipe(
        Effect.mapError(() =>
          currentnessRejected('The current Customer Profile trading gate is unavailable'),
        ),
      );
    if (
      current.profileRef.kind !== 'COUNTERPARTY' ||
      current.profileRef.resourceId !== snapshot.proposal.identity.profileRef.resourceId ||
      current.profileRef.resourceType !== snapshot.proposal.identity.profileRef.resourceType ||
      current.profileRef.tenantId !== snapshot.proposal.identity.profileRef.tenantId ||
      current.subject.kind !== 'COUNTERPARTY' ||
      !sameRef(current.subject.counterpartyRef, counterparty)
    ) {
      return yield* currentnessRejected(
        'The current Customer Profile owner returned a different profile or Counterparty',
      );
    }
    return current;
  });
};

const buyerPermission = (
  transaction: ScopedTransactionExecutor,
  snapshot: CurrentApprovalFacts,
  scope: PurchaseApprovalCurrentnessTrustedScope,
  contextAccess: ContextAccessService,
) =>
  Effect.gen(function* readBuyerPermission() {
    const check = contextAccess.businessPermissions;
    if (check === undefined) {
      return yield* currentnessRejected('Core buyer authorization is unavailable');
    }
    const counterparty = yield* Schema.decodeUnknownEffect(PurchaseLimitCounterpartyRefSchema)(
      snapshot.proposal.identity.counterpartyRef,
    ).pipe(
      Effect.mapError(() =>
        currentnessRejected('The owner-current Counterparty reference is invalid'),
      ),
    );
    const target: BusinessPermissionAccessTarget = {
      permission: 'counterparty.purchase.submit',
      target: {
        counterpartyId: counterparty.resourceId,
        kind: 'counterparty_storefront',
        legalEntityId: scope.legalEntityId,
        storefrontId: scope.storefrontId,
        tenantId: scope.tenantId,
      },
    };
    const [core] = yield* check({
      principal: snapshot.proposal.identity.buyer,
      targets: [target],
      trustedStorefrontId: scope.storefrontId,
    });
    const owner = yield* lockingCurrentOwnerAccessForTransaction(transaction, {
      legalEntityId: scope.legalEntityId,
      tenantId: scope.tenantId,
    })({
      counterpartyRef: counterparty,
      legalEntityId: scope.legalEntityId,
      permission: 'counterparty.purchase.submit',
      principal: snapshot.proposal.identity.buyer,
      scope: { kind: 'storefront', storefrontKey: scope.storefrontId },
    });
    if (core?.decision === 'unavailable' || owner === 'UNAVAILABLE' || core === undefined) {
      return yield* currentnessRejected('Current buyer authorization is unavailable');
    }
    return core.decision === 'allowed' && owner === 'ALLOWED'
      ? ('ALLOWED' as const)
      : ('DENIED' as const);
  });

const currentExternalFacts = (
  currentness: PurchaseLimitEvaluationCurrentnessPortService,
  snapshot: CurrentApprovalFacts,
  scope: PurchaseApprovalCurrentnessTrustedScope,
  transaction: ScopedTransactionExecutor,
  observedAt: DateTime.Utc,
) => {
  const currentnessForTransaction = currentness.forTransaction?.(transaction, scope) ?? currentness;
  return Schema.decodeUnknownEffect(PurchaseLimitCounterpartyRefSchema)(
    snapshot.proposal.identity.counterpartyRef,
  ).pipe(
    Effect.mapError(() =>
      currentnessRejected('The owner-current Counterparty reference is invalid'),
    ),
    Effect.flatMap((counterpartyRef) =>
      currentnessForTransaction.resolveCurrent({
        claimedPurchaseValue: snapshot.proposal.purchaseValue,
        counterpartyRef,
        expectedSourceRevisions: snapshot.sourceRevisions,
        observedAt,
        scope,
      }),
    ),
    Effect.mapError(() =>
      currentnessRejected('Current Cart, Storefront, and Commerce Policy facts are unavailable'),
    ),
    Effect.flatMap((facts) =>
      Schema.decodeUnknownEffect(PurchaseLimitEvaluationCurrentFactsSchema)(facts).pipe(
        Effect.mapError(() =>
          currentnessRejected('The external currentness owner returned malformed facts'),
        ),
        Effect.filterOrFail(
          ({ channelId, marketId }) =>
            channelId === snapshot.proposal.context.channelId &&
            marketId === snapshot.proposal.context.marketId,
          () =>
            currentnessRejected(
              'The current purchase context does not match the captured proposal',
            ),
        ),
        Effect.filterOrFail(
          ({ purchaseValue }) =>
            purchaseValue.sourceRef === snapshot.proposal.purchaseValue.sourceRef &&
            purchaseValue.sourceRevision === snapshot.proposal.purchaseValue.sourceRevision &&
            purchaseValue.monetaryAmount.amount ===
              snapshot.proposal.purchaseValue.monetaryAmount.amount &&
            purchaseValue.monetaryAmount.currency ===
              snapshot.proposal.purchaseValue.monetaryAmount.currency,
          () =>
            currentnessRejected('The current purchase value does not match the captured proposal'),
        ),
      ),
    ),
  );
};

const currentSourceVector = (
  snapshot: CurrentApprovalFacts,
  externalFacts: typeof PurchaseLimitEvaluationCurrentFactsSchema.Type,
  policySources: PurchaseLimitSourceRevisionVector,
  profileRevision: number,
): Effect.Effect<PurchaseLimitSourceRevisionVector, PurchasingApprovalRejected> => {
  const expected = sourceMap(snapshot.sourceRevisions);
  const external = sourceMap(externalFacts.currentSourceRevisions);
  const policy = sourceMap(policySources);
  const profileSource = String(profileRevision);
  if (
    expected.get(PROFILE_SOURCE) !== profileSource ||
    external.get(PROFILE_SOURCE) !== profileSource ||
    expected.get(PROPOSAL_SOURCE) !== snapshot.proposal.purchaseValue.sourceRevision ||
    external.get(PROPOSAL_SOURCE) !== snapshot.proposal.purchaseValue.sourceRevision ||
    [...expected].some(([source, revision]) =>
      OWNER_SOURCE_NAMES.has(source)
        ? policy.get(source) !== revision
        : external.get(source) !== revision,
    )
  ) {
    return Effect.fail(
      currentnessRejected('Current owner source revisions no longer match the captured approval'),
    );
  }
  return Schema.decodeUnknownEffect(PurchaseLimitSourceRevisionVectorSchema)([
    ...externalFacts.currentSourceRevisions,
    ...policySources,
  ]).pipe(
    Effect.mapError(() => currentnessRejected('Current source revision evidence is malformed')),
  );
};

const makeTrustedRevalidation = (
  claimed: RevalidatePurchaseApprovalInput,
  snapshot: Snapshot,
  scope: PurchaseApprovalCurrentnessTrustedScope,
  sourceRevisions: PurchaseLimitSourceRevisionVector,
  buyer: 'ALLOWED' | 'DENIED',
  profileState: 'ACTIVE' | 'INACTIVE',
  now: DateTime.Utc,
): RevalidatePurchaseApprovalInput => {
  const routeCurrent =
    snapshot.request.status === 'APPROVED' &&
    snapshot.route.status === 'APPROVED' &&
    sameRef(snapshot.request.route.routeRef, snapshot.route.routeRef) &&
    snapshot.route.levels.every(
      ({ completedBy, completedAt }) => completedBy !== null && completedAt !== null,
    ) &&
    sameSourceVector(sourceRevisions, snapshot.sourceRevisions);
  const requestValidUntil = snapshot.request.expiresAt;
  const maximumValidUntil = DateTime.add(now, { minutes: 5 });
  const validUntil = DateTime.isLessThan(requestValidUntil, maximumValidUntil)
    ? requestValidUntil
    : maximumValidUntil;
  return {
    ...claimed,
    counterpartyRef: snapshot.proposal.identity.counterpartyRef,
    requestRef: snapshot.request.requestRef,
    proposalRevisionRef: snapshot.proposal.proposalRevisionRef,
    expectedProposalHash: snapshot.proposal.canonicalHash,
    decisionBundleHash: snapshot.request.decisionBundleHash ?? snapshot.decision.decisionBundleHash,
    decisionBundleVersion: snapshot.decision.decisionBundleVersion,
    decisionRef: snapshot.decision.decisionRef,
    hierarchyRef: snapshot.route.hierarchyRef,
    routeRef: snapshot.route.routeRef,
    sourceRevisions,
    checkedAt: now,
    validUntil,
    buyerPermission: buyer,
    profileState,
    routeCurrent,
    storefrontId: scope.storefrontId,
  };
};

const makeTrustedSubmission = (
  claimed: SubmitPurchaseApprovalRequestInput,
  snapshot: CurrentApprovalFacts,
  scope: PurchaseApprovalCurrentnessTrustedScope,
): SubmitPurchaseApprovalRequestInput => ({
  ...claimed,
  counterpartyRef: snapshot.proposal.identity.counterpartyRef,
  proposalRevisionRef: snapshot.proposal.proposalRevisionRef,
  proposalRevision: snapshot.proposal.revision,
  storefrontId: scope.storefrontId,
  requestExpiresAt: snapshot.proposal.expiresAt,
});

const verifyCurrentApprovalEvaluation = (
  evaluationSource: PurchaseLimitEvaluationSourceService | undefined,
  snapshot: CurrentApprovalFacts,
  scope: PurchaseApprovalCurrentnessTrustedScope,
): Effect.Effect<void, PurchasingApprovalRejected> => {
  if (evaluationSource === undefined) {
    return Effect.fail(
      currentnessRejected('Current policy and Commercial FX evidence is unavailable'),
    );
  }
  return Schema.decodeUnknownEffect(PurchaseLimitCounterpartyRefSchema)(
    snapshot.proposal.identity.counterpartyRef,
  ).pipe(
    Effect.mapError(() =>
      currentnessRejected('The owner-current Counterparty reference is invalid'),
    ),
    Effect.flatMap((counterpartyRef) =>
      Schema.decodeUnknownEffect(PurchaseLimitStorefrontIdSchema)(scope.storefrontId).pipe(
        Effect.mapError(() => currentnessRejected('The trusted Storefront reference is invalid')),
        Effect.flatMap((storefrontId) =>
          evaluationSource.loadCurrent({
            principalId: scope.principalId,
            query: {
              counterpartyRef,
              expectedSourceRevisions: snapshot.sourceRevisions,
              purchaseValue: snapshot.proposal.purchaseValue,
              storefrontId,
            },
          }),
        ),
      ),
    ),
    Effect.mapError(() =>
      currentnessRejected('Current policy and Commercial FX evidence is unavailable'),
    ),
    Effect.map(evaluatePurchaseLimit),
    Effect.filterOrFail(
      (evaluation) =>
        evaluation._tag === 'APPROVAL_REQUIRED' &&
        evaluation.purchaseValue.sourceRef === snapshot.proposal.purchaseValue.sourceRef &&
        evaluation.purchaseValue.sourceRevision ===
          snapshot.proposal.purchaseValue.sourceRevision &&
        evaluation.purchaseValue.monetaryAmount.amount ===
          snapshot.proposal.purchaseValue.monetaryAmount.amount &&
        evaluation.purchaseValue.monetaryAmount.currency ===
          snapshot.proposal.purchaseValue.monetaryAmount.currency &&
        sameSourceVector(evaluation.currentSourceRevisions, snapshot.sourceRevisions),
      () =>
        currentnessRejected(
          'The current Purchase Limit policy or Commercial FX evidence no longer matches the approval proposal',
        ),
    ),
    Effect.asVoid,
  );
};

export const purchaseApprovalCurrentnessForTransaction = (
  transaction: PurchasingApprovalScopedRoutineInvoker,
  scope: OperationalScope & {
    readonly legalEntityId: string;
    readonly trustedStorefrontId: string;
  },
  contextAccess: ContextAccessService,
  purchaseLimitCurrentness: PurchaseLimitEvaluationCurrentnessPortService,
  evaluationSource?: PurchaseLimitEvaluationSourceService,
): PurchaseApprovalCurrentnessService => {
  const trustedScope: PurchaseApprovalCurrentnessTrustedScope = {
    legalEntityId: scope.legalEntityId,
    principalId: scope.principalId,
    storefrontId: scope.trustedStorefrontId,
    tenantId: scope.tenantId,
  };
  const scopedTransaction = transaction as ScopedTransactionExecutor;
  const service: PurchaseApprovalCurrentnessService = {
    forTransaction: () => service,
    resolveRevalidation: ({ claimed }) =>
      Effect.gen(function* resolveRevalidation() {
        const snapshot = yield* invokeCurrentnessSnapshot(
          transaction,
          claimed.requestRef.resourceId,
        );
        yield* assertClaimedTarget(claimed, snapshot, trustedScope);
        const counterpartyRef = yield* Schema.decodeUnknownEffect(
          PurchaseLimitCounterpartyRefSchema,
        )(snapshot.proposal.identity.counterpartyRef).pipe(
          Effect.mapError(() =>
            currentnessRejected('The owner-current Counterparty reference is invalid'),
          ),
        );
        const now = yield* DateTime.now;
        const [profile, buyer, externalFacts, policyState] = yield* Effect.all(
          [
            currentProfile(scopedTransaction, snapshot, trustedScope),
            buyerPermission(scopedTransaction, snapshot, trustedScope, contextAccess),
            currentExternalFacts(
              purchaseLimitCurrentness,
              snapshot,
              trustedScope,
              scopedTransaction,
              now,
            ),
            readCurrentPurchaseLimitPolicyState(scopedTransaction, {
              counterpartyRef,
              principalRef: snapshot.proposal.identity.buyer,
              tenantId: trustedScope.tenantId,
            }).pipe(
              Effect.mapError(() =>
                currentnessRejected('Current Purchase Limit policy facts are unavailable'),
              ),
            ),
          ],
          { concurrency: 4 },
        );
        const sourceRevisions = yield* currentSourceVector(
          snapshot,
          externalFacts,
          policyState.sourceRevisions,
          profile.revision,
        );
        yield* verifyCurrentApprovalEvaluation(evaluationSource, snapshot, trustedScope);
        return makeTrustedRevalidation(
          claimed,
          snapshot,
          trustedScope,
          sourceRevisions,
          buyer,
          profile.gate.outcome === 'ACTIVE' && profile.gate.canAcceptNewOrder
            ? 'ACTIVE'
            : 'INACTIVE',
          now,
        );
      }),
    resolveSubmission: ({ claimed }) =>
      Effect.gen(function* resolveSubmission() {
        const snapshot = yield* invokeCurrentProposal(
          transaction,
          claimed.proposalRevisionRef.resourceId,
        );
        yield* assertClaimedSubmissionTarget(claimed, snapshot, trustedScope);
        const counterpartyRef = yield* Schema.decodeUnknownEffect(
          PurchaseLimitCounterpartyRefSchema,
        )(snapshot.proposal.identity.counterpartyRef).pipe(
          Effect.mapError(() =>
            currentnessRejected('The owner-current Counterparty reference is invalid'),
          ),
        );
        const now = yield* DateTime.now;
        const [profile, buyer, externalFacts, policyState] = yield* Effect.all(
          [
            currentProfile(scopedTransaction, snapshot, trustedScope),
            buyerPermission(scopedTransaction, snapshot, trustedScope, contextAccess),
            currentExternalFacts(
              purchaseLimitCurrentness,
              snapshot,
              trustedScope,
              scopedTransaction,
              now,
            ),
            readCurrentPurchaseLimitPolicyState(scopedTransaction, {
              counterpartyRef,
              principalRef: snapshot.proposal.identity.buyer,
              tenantId: trustedScope.tenantId,
            }).pipe(
              Effect.mapError(() =>
                currentnessRejected('Current Purchase Limit policy facts are unavailable'),
              ),
            ),
          ],
          { concurrency: 4 },
        );
        const sourceRevisions = yield* currentSourceVector(
          snapshot,
          externalFacts,
          policyState.sourceRevisions,
          profile.revision,
        );
        yield* verifyCurrentApprovalEvaluation(evaluationSource, snapshot, trustedScope);
        if (buyer !== 'ALLOWED') {
          return yield* new PurchasingApprovalRejected({
            code: 'BUYER_PERMISSION_DENIED',
            reason: 'Current buyer authorization does not permit this approval request',
            retryable: false,
          });
        }
        if (profile.gate.outcome !== 'ACTIVE' || !profile.gate.canAcceptNewOrder) {
          return yield* new PurchasingApprovalRejected({
            code: 'PROFILE_INACTIVE',
            reason: 'The purchasing profile is no longer active',
            retryable: false,
          });
        }
        if (!sameSourceVector(sourceRevisions, snapshot.sourceRevisions)) {
          return yield* new PurchasingApprovalRejected({
            code: 'POLICY_ROUTE_INVALID',
            reason: 'Current purchase policy evidence no longer matches the captured proposal',
            retryable: false,
          });
        }
        return makeTrustedSubmission(claimed, snapshot, trustedScope);
      }),
  };
  return service;
};

export const purchaseApprovalCurrentnessPortLayer = (
  transaction: PurchasingApprovalScopedRoutineInvoker,
  scope: OperationalScope & {
    readonly legalEntityId: string;
    readonly trustedStorefrontId: string;
  },
  contextAccess: ContextAccessService,
  purchaseLimitCurrentness: PurchaseLimitEvaluationCurrentnessPortService,
  evaluationSource?: PurchaseLimitEvaluationSourceService,
) =>
  purchaseApprovalCurrentnessForTransaction(
    transaction,
    scope,
    contextAccess,
    purchaseLimitCurrentness,
    evaluationSource,
  );

/**
 * Runtime composition for the generated submit/revalidate Actions. The Actions receive only this
 * narrow owner-local factory; the transaction-bound implementation and its scoped routines stay
 * behind the persistence boundary.
 */
export const purchaseApprovalCurrentnessFactoryLive = Layer.succeed(
  PurchaseApprovalCurrentnessFactory,
  {
    make: (transaction, scope, contextAccess, purchaseLimitCurrentness, evaluationSource) =>
      purchaseApprovalCurrentnessForTransaction(
        transaction as PurchasingApprovalScopedRoutineInvoker,
        scope,
        contextAccess,
        purchaseLimitCurrentness,
        evaluationSource,
      ),
  } satisfies PurchaseApprovalCurrentnessFactoryContract,
);
