import type {
  BusinessPermissionAccessTarget,
  ContextAccessService,
  OperationalScope,
  ScopedRoutineInvoker,
  ScopedTransactionExecutor,
} from '@app/core-runtime';
import { Effect, DateTime, Layer, Predicate, Schema } from 'effect';

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
import type {
  PurchaseLimitSourceRevisionVector,
  PurchaseLimitEvaluationSourceService,
} from '../../shared/domain/purchase-limit-evaluation.ts';
import { PurchaseLimitCounterpartyRefSchema } from '../../shared/domain/purchase-limit-policy.ts';
import { CommerceCustomerProfileRefSchema } from '../../shared/domain/profile-decisions.ts';
import { profilePersistenceServicesForTransaction } from './profile-persistence.ts';
import { lockingCurrentOwnerAccessForTransaction } from './access-persistence.ts';
import {
  readCurrentPurchaseLimitPolicyState,
  readCurrentPurchaseProposalRoutine,
} from './purchase-limit-persistence.ts';
import { readCurrentPurchaseApprovalRevalidationRoutine } from './purchasing-approval-persistence.ts';

const PROFILE_SOURCE = 'purchasing-profile';
const PROPOSAL_SOURCE = 'purchase-proposal';
const INVALID_COUNTERPARTY_REFERENCE = 'The owner-current Counterparty reference is invalid';
const OWNER_SOURCE_NAMES = new Set(['counterparty-policy', 'principal-override']);

const SnapshotSchema = Schema.Struct({
  decision: ApprovalDecisionSchema,
  proposal: PurchaseProposalRevisionSchema,
  request: PurchaseApprovalRequestSchema,
  route: ApprovalRouteSchema,
  sourceRevisions: PurchaseLimitSourceRevisionVectorSchema,
});
type Snapshot = typeof SnapshotSchema.Type;
type CurrentApprovalFacts = Pick<Snapshot, 'proposal' | 'sourceRevisions'>;
const ProposalFactsSchema = Schema.Struct({
  proposal: PurchaseProposalRevisionSchema,
  sourceRevisions: PurchaseLimitSourceRevisionVectorSchema,
});

const CurrentnessResultSchema = Schema.Struct({ result: Schema.Json });

const currentnessRejected = (reason: string, cause?: unknown): PurchasingApprovalRejected => {
  const rejection = new PurchasingApprovalRejected({
    code: 'CURRENT_STATE_INDETERMINATE',
    reason,
    retryable: true,
  });
  if (cause !== undefined) {
    Object.defineProperty(rejection, 'cause', { configurable: true, value: cause });
  }
  return rejection;
};

const mapCurrentnessError =
  (reason: string) =>
  (cause: unknown): PurchasingApprovalRejected =>
    currentnessRejected(reason, cause);

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

const sourceMap = (sources: readonly { readonly revision: string; readonly source: string }[]) =>
  new Map(sources.map(({ revision, source }) => [source, revision] as const));

const sameSourceVector = (
  left: readonly { readonly revision: string; readonly source: string }[],
  right: readonly { readonly revision: string; readonly source: string }[],
): boolean => {
  const leftMap = sourceMap(left);
  const rightMap = sourceMap(right);
  return (
    leftMap.size === rightMap.size && [...leftMap].every(([source, revision]) => rightMap.get(source) === revision)
  );
};

const invokeCurrentnessSnapshot = (
  transaction: ScopedTransactionExecutor,
  requestRef: string,
): Effect.Effect<Snapshot, PurchasingApprovalRejected> =>
  transaction.invoke(readCurrentPurchaseApprovalRevalidationRoutine, [{ requestRef }]).pipe(
    Effect.mapError(mapCurrentnessError('The current Purchasing Approval snapshots are unavailable')),
    Effect.flatMap(([row]) =>
      row === undefined
        ? Effect.fail(currentnessRejected('The current Purchasing Approval snapshots are unavailable'))
        : Schema.decodeEffect(CurrentnessResultSchema)(row).pipe(
            Effect.mapError(mapCurrentnessError('The currentness owner returned an invalid result')),
            Effect.flatMap(({ result }) =>
              Schema.decodeUnknownEffect(SnapshotSchema)(result).pipe(
                Effect.mapError(mapCurrentnessError('The current Purchasing Approval snapshot is malformed')),
              ),
            ),
          ),
    ),
  );

const invokeCurrentProposal = (
  transaction: ScopedRoutineInvoker,
  proposalRevisionRef: string,
): Effect.Effect<CurrentApprovalFacts, PurchasingApprovalRejected> =>
  transaction.invoke(readCurrentPurchaseProposalRoutine, [{ proposalRevisionResourceId: proposalRevisionRef }]).pipe(
    Effect.mapError(mapCurrentnessError('The current Purchase Proposal is unavailable')),
    Effect.flatMap(([row]) =>
      row === undefined
        ? Effect.fail(currentnessRejected('The current Purchase Proposal is unavailable'))
        : Schema.decodeEffect(Schema.Struct({ result: Schema.Json }))(row).pipe(
            Effect.mapError(mapCurrentnessError('The Purchase Proposal owner returned an invalid result')),
            Effect.flatMap(({ result }) =>
              Schema.decodeUnknownEffect(ProposalFactsSchema)(result).pipe(
                Effect.mapError(mapCurrentnessError('The current Purchase Proposal snapshot is malformed')),
              ),
            ),
          ),
    ),
  );

const claimedApprovalRefsMatch = (claimed: RevalidatePurchaseApprovalInput, snapshot: Snapshot): boolean =>
  sameRef(claimed.requestRef, snapshot.request.requestRef) &&
  sameRef(claimed.proposalRevisionRef, snapshot.proposal.proposalRevisionRef) &&
  claimed.expectedProposalHash === snapshot.proposal.canonicalHash &&
  sameRef(claimed.decisionRef, snapshot.decision.decisionRef) &&
  sameRef(claimed.hierarchyRef, snapshot.route.hierarchyRef) &&
  sameRef(claimed.routeRef, snapshot.route.routeRef) &&
  sameRef(claimed.counterpartyRef, snapshot.proposal.identity.counterpartyRef);

const claimedApprovalScopeMatches = (
  claimed: RevalidatePurchaseApprovalInput,
  snapshot: Snapshot,
  scope: PurchaseApprovalCurrentnessTrustedScope,
): boolean =>
  claimed.counterpartyRef.tenantId === scope.tenantId &&
  claimed.storefrontId === scope.storefrontId &&
  snapshot.proposal.context.tenantId === scope.tenantId &&
  snapshot.proposal.context.sellingLegalEntityId === scope.legalEntityId &&
  snapshot.proposal.context.storefrontId === scope.storefrontId;

const approvalSnapshotRefsAreConsistent = ({ decision, proposal, request, route }: Snapshot): boolean =>
  sameRef(route.requestRef, request.requestRef) &&
  sameRef(route.proposalRevisionRef, proposal.proposalRevisionRef) &&
  sameRef(decision.requestRef, request.requestRef) &&
  sameRef(decision.proposalRevisionRef, proposal.proposalRevisionRef) &&
  sameRef(decision.routeRef, route.routeRef) &&
  sameRef(decision.hierarchyRef, route.hierarchyRef);

const assertClaimedTarget = (
  claimed: RevalidatePurchaseApprovalInput,
  snapshot: Snapshot,
  scope: PurchaseApprovalCurrentnessTrustedScope,
): Effect.Effect<void, PurchasingApprovalRejected> => {
  if (
    !claimedApprovalRefsMatch(claimed, snapshot) ||
    !claimedApprovalScopeMatches(claimed, snapshot, scope) ||
    !approvalSnapshotRefsAreConsistent(snapshot)
  ) {
    return Effect.fail(denied('The claimed approval identity does not match the owner-current snapshots'));
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
    return Effect.fail(denied('The claimed submission target does not match the owner-current proposal'));
  }
  return Effect.void;
};

const currentProfile = Effect.fn('PurchaseApprovalCurrentnessPersistence.currentProfile')((
  transaction: ScopedTransactionExecutor,
  snapshot: CurrentApprovalFacts,
  scope: PurchaseApprovalCurrentnessTrustedScope,
) => {
  const counterpartyRef = Schema.decodeUnknownEffect(PurchaseLimitCounterpartyRefSchema)(
    snapshot.proposal.identity.counterpartyRef,
  ).pipe(Effect.mapError(mapCurrentnessError(INVALID_COUNTERPARTY_REFERENCE)));
  const profileRef = Schema.decodeUnknownEffect(CommerceCustomerProfileRefSchema)({
    kind: 'COUNTERPARTY',
    ...snapshot.proposal.identity.profileRef,
  }).pipe(Effect.mapError(mapCurrentnessError('The owner-current Purchasing Profile reference is invalid')));
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
      .pipe(Effect.mapError(mapCurrentnessError('The current Customer Profile trading gate is unavailable')));
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
});

const buyerPermission = Effect.fn('PurchaseApprovalCurrentnessPersistence.buyerPermission')(
  (
    transaction: ScopedTransactionExecutor,
    snapshot: CurrentApprovalFacts,
    scope: PurchaseApprovalCurrentnessTrustedScope,
    // eslint-disable-next-line effect-native/no-dependency-parameters -- This owner-local helper receives the already-yielded Core access service while remaining directly testable; expires: 2027-09-10.
    contextAccess: ContextAccessService,
  ) =>
    Effect.gen(function* readBuyerPermission() {
      const check = contextAccess.businessPermissions;
      if (check === undefined) {
        return yield* currentnessRejected('Core buyer authorization is unavailable');
      }
      const counterparty = yield* Schema.decodeUnknownEffect(PurchaseLimitCounterpartyRefSchema)(
        snapshot.proposal.identity.counterpartyRef,
      ).pipe(Effect.mapError(mapCurrentnessError(INVALID_COUNTERPARTY_REFERENCE)));
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
      return core.decision === 'allowed' && owner === 'ALLOWED' ? ('ALLOWED' as const) : ('DENIED' as const);
    }),
);

const currentExternalFacts = (
  // eslint-disable-next-line effect-native/no-dependency-parameters -- This owner-local helper receives the already-yielded currentness port before binding it to the scoped transaction; expires: 2027-09-10.
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
    Effect.mapError(mapCurrentnessError(INVALID_COUNTERPARTY_REFERENCE)),
    Effect.flatMap((counterpartyRef) =>
      currentnessForTransaction.resolveCurrent({
        claimedPurchaseValue: snapshot.proposal.purchaseValue,
        counterpartyRef,
        expectedSourceRevisions: snapshot.sourceRevisions,
        observedAt,
        scope,
      }),
    ),
    Effect.mapError(mapCurrentnessError('Current Cart, Storefront, and Commerce Policy facts are unavailable')),
    Effect.flatMap((facts) =>
      Schema.decodeEffect(PurchaseLimitEvaluationCurrentFactsSchema)(facts).pipe(
        Effect.mapError(mapCurrentnessError('The external currentness owner returned malformed facts')),
        Effect.filterOrFail(
          ({ channelId, marketId }) =>
            channelId === snapshot.proposal.context.channelId && marketId === snapshot.proposal.context.marketId,
          () => currentnessRejected('The current purchase context does not match the captured proposal'),
        ),
        Effect.filterOrFail(
          ({ purchaseValue }) =>
            purchaseValue.sourceRef === snapshot.proposal.purchaseValue.sourceRef &&
            purchaseValue.sourceRevision === snapshot.proposal.purchaseValue.sourceRevision &&
            purchaseValue.monetaryAmount.amount === snapshot.proposal.purchaseValue.monetaryAmount.amount &&
            purchaseValue.monetaryAmount.currency === snapshot.proposal.purchaseValue.monetaryAmount.currency,
          () => currentnessRejected('The current purchase value does not match the captured proposal'),
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
      OWNER_SOURCE_NAMES.has(source) ? policy.get(source) !== revision : external.get(source) !== revision,
    )
  ) {
    return Effect.fail(currentnessRejected('Current owner source revisions no longer match the captured approval'));
  }
  return Schema.decodeEffect(PurchaseLimitSourceRevisionVectorSchema)([
    ...externalFacts.currentSourceRevisions,
    ...policySources,
  ]).pipe(Effect.mapError(mapCurrentnessError('Current source revision evidence is malformed')));
};

type TrustedRevalidationInput = Readonly<{
  buyer: 'ALLOWED' | 'DENIED';
  claimed: RevalidatePurchaseApprovalInput;
  now: DateTime.Utc;
  profileState: 'ACTIVE' | 'INACTIVE';
  scope: PurchaseApprovalCurrentnessTrustedScope;
  snapshot: Snapshot;
  sourceRevisions: PurchaseLimitSourceRevisionVector;
}>;

const makeTrustedRevalidation = ({
  buyer,
  claimed,
  now,
  profileState,
  scope,
  snapshot,
  sourceRevisions,
}: TrustedRevalidationInput): RevalidatePurchaseApprovalInput => {
  const routeCurrent =
    snapshot.request.status === 'APPROVED' &&
    snapshot.route.status === 'APPROVED' &&
    sameRef(snapshot.request.route.routeRef, snapshot.route.routeRef) &&
    snapshot.route.levels.every(({ completedAt, completedBy }) => completedBy !== null && completedAt !== null) &&
    sameSourceVector(sourceRevisions, snapshot.sourceRevisions);
  const requestValidUntil = snapshot.request.expiresAt;
  const maximumValidUntil = DateTime.add(now, { minutes: 5 });
  const validUntil = DateTime.isLessThan(requestValidUntil, maximumValidUntil) ? requestValidUntil : maximumValidUntil;
  return {
    ...claimed,
    buyerPermission: buyer,
    checkedAt: now,
    counterpartyRef: snapshot.proposal.identity.counterpartyRef,
    decisionBundleHash: snapshot.request.decisionBundleHash ?? snapshot.decision.decisionBundleHash,
    decisionBundleVersion: snapshot.decision.decisionBundleVersion,
    decisionRef: snapshot.decision.decisionRef,
    expectedProposalHash: snapshot.proposal.canonicalHash,
    hierarchyRef: snapshot.route.hierarchyRef,
    profileState,
    proposalRevisionRef: snapshot.proposal.proposalRevisionRef,
    requestRef: snapshot.request.requestRef,
    routeCurrent,
    routeRef: snapshot.route.routeRef,
    sourceRevisions,
    storefrontId: scope.storefrontId,
    validUntil,
  };
};

type TrustedSubmissionInput = Readonly<{
  claimed: SubmitPurchaseApprovalRequestInput;
  scope: PurchaseApprovalCurrentnessTrustedScope;
  snapshot: CurrentApprovalFacts;
}>;

const makeTrustedSubmission = ({
  claimed,
  scope,
  snapshot,
}: TrustedSubmissionInput): SubmitPurchaseApprovalRequestInput => ({
  ...claimed,
  counterpartyRef: snapshot.proposal.identity.counterpartyRef,
  proposalRevision: snapshot.proposal.revision,
  proposalRevisionRef: snapshot.proposal.proposalRevisionRef,
  requestExpiresAt: snapshot.proposal.expiresAt,
  storefrontId: scope.storefrontId,
});

const verifyCurrentApprovalEvaluation = (
  // eslint-disable-next-line effect-native/no-dependency-parameters -- This owner-local verifier receives the already-yielded evaluation source after the Action composition boundary; expires: 2027-09-10.
  evaluationSource: PurchaseLimitEvaluationSourceService | undefined,
  snapshot: CurrentApprovalFacts,
  scope: PurchaseApprovalCurrentnessTrustedScope,
): Effect.Effect<void, PurchasingApprovalRejected> => {
  if (evaluationSource === undefined) {
    return Effect.fail(currentnessRejected('Current policy and comparable purchase-value evidence is unavailable'));
  }
  return Schema.decodeUnknownEffect(PurchaseLimitCounterpartyRefSchema)(
    snapshot.proposal.identity.counterpartyRef,
  ).pipe(
    Effect.mapError(mapCurrentnessError(INVALID_COUNTERPARTY_REFERENCE)),
    Effect.flatMap((counterpartyRef) =>
      Schema.decodeEffect(PurchaseLimitStorefrontIdSchema)(scope.storefrontId).pipe(
        Effect.mapError(mapCurrentnessError('The trusted Storefront reference is invalid')),
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
    Effect.mapError(mapCurrentnessError('Current policy and comparable purchase-value evidence is unavailable')),
    Effect.map(evaluatePurchaseLimit),
    Effect.filterOrFail(
      (evaluation) =>
        Predicate.isTagged(evaluation, 'APPROVAL_REQUIRED') &&
        evaluation.purchaseValue.sourceRef === snapshot.proposal.purchaseValue.sourceRef &&
        evaluation.purchaseValue.sourceRevision === snapshot.proposal.purchaseValue.sourceRevision &&
        evaluation.purchaseValue.monetaryAmount.amount === snapshot.proposal.purchaseValue.monetaryAmount.amount &&
        evaluation.purchaseValue.monetaryAmount.currency === snapshot.proposal.purchaseValue.monetaryAmount.currency &&
        sameSourceVector(evaluation.currentSourceRevisions, snapshot.sourceRevisions),
      () =>
        currentnessRejected(
          'The current Purchase Limit policy or comparable purchase-value evidence no longer matches the approval proposal',
        ),
    ),
    Effect.asVoid,
  );
};

const loadCurrentApprovalFacts = Effect.fn('PurchaseApprovalCurrentnessPersistence.loadCurrentApprovalFacts')(
  function* loadFacts(
    transaction: ScopedTransactionExecutor,
    snapshot: CurrentApprovalFacts,
    scope: PurchaseApprovalCurrentnessTrustedScope,
    // eslint-disable-next-line effect-native/no-dependency-parameters -- This helper receives already-yielded services before resolving the shared owner-current evidence bundle; expires: 2027-09-10.
    contextAccess: ContextAccessService,
    // eslint-disable-next-line effect-native/no-dependency-parameters -- This helper receives already-yielded services before resolving the shared owner-current evidence bundle; expires: 2027-09-10.
    purchaseLimitCurrentness: PurchaseLimitEvaluationCurrentnessPortService,
  ) {
    const counterpartyRef = yield* Schema.decodeUnknownEffect(PurchaseLimitCounterpartyRefSchema)(
      snapshot.proposal.identity.counterpartyRef,
    ).pipe(Effect.mapError(mapCurrentnessError(INVALID_COUNTERPARTY_REFERENCE)));
    const now = yield* DateTime.now;
    const [profile, buyer, externalFacts, policyState] = yield* Effect.all(
      [
        currentProfile(transaction, snapshot, scope),
        buyerPermission(transaction, snapshot, scope, contextAccess),
        currentExternalFacts(purchaseLimitCurrentness, snapshot, scope, transaction, now),
        readCurrentPurchaseLimitPolicyState(transaction, {
          counterpartyRef,
          principalRef: snapshot.proposal.identity.buyer,
          tenantId: scope.tenantId,
        }).pipe(Effect.mapError(mapCurrentnessError('Current Purchase Limit policy facts are unavailable'))),
      ],
      { concurrency: 4 },
    );
    const sourceRevisions = yield* currentSourceVector(
      snapshot,
      externalFacts,
      policyState.sourceRevisions,
      profile.revision,
    );
    return { buyer, now, profile, sourceRevisions };
  },
);

const purchaseApprovalCurrentnessForTransaction = (
  transaction: ScopedTransactionExecutor,
  scope: OperationalScope & {
    readonly legalEntityId: string;
    readonly trustedStorefrontId: string;
  },
  // eslint-disable-next-line effect-native/no-dependency-parameters -- This owner-local constructor receives already-yielded Core and currentness services before closing the transaction-scoped adapter; expires: 2027-09-10.
  contextAccess: ContextAccessService,
  // eslint-disable-next-line effect-native/no-dependency-parameters -- This owner-local constructor receives already-yielded Core and currentness services before closing the transaction-scoped adapter; expires: 2027-09-10.
  purchaseLimitCurrentness: PurchaseLimitEvaluationCurrentnessPortService,
  // eslint-disable-next-line effect-native/no-dependency-parameters -- This owner-local constructor receives already-yielded Core and currentness services before closing the transaction-scoped adapter; expires: 2027-09-10.
  evaluationSource?: PurchaseLimitEvaluationSourceService,
): PurchaseApprovalCurrentnessService => {
  const trustedScope: PurchaseApprovalCurrentnessTrustedScope = {
    legalEntityId: scope.legalEntityId,
    principalId: scope.principalId,
    storefrontId: scope.trustedStorefrontId,
    tenantId: scope.tenantId,
  };
  const scopedTransaction = transaction;
  const service: PurchaseApprovalCurrentnessService = {
    forTransaction: () => service,
    resolveRevalidation: Effect.fn('service.resolveRevalidation')(({ claimed }) =>
      Effect.gen(function* resolveRevalidation() {
        const snapshot = yield* invokeCurrentnessSnapshot(transaction, claimed.requestRef.resourceId);
        yield* assertClaimedTarget(claimed, snapshot, trustedScope);
        const { buyer, now, profile, sourceRevisions } = yield* loadCurrentApprovalFacts(
          scopedTransaction,
          snapshot,
          trustedScope,
          contextAccess,
          purchaseLimitCurrentness,
        );
        yield* verifyCurrentApprovalEvaluation(evaluationSource, snapshot, trustedScope);
        return makeTrustedRevalidation({
          buyer,
          claimed,
          now,
          profileState: profile.gate.outcome === 'ACTIVE' && profile.gate.canAcceptNewOrder ? 'ACTIVE' : 'INACTIVE',
          scope: trustedScope,
          snapshot,
          sourceRevisions,
        });
      }),
    ),
    resolveSubmission: Effect.fn('service.resolveSubmission')(({ claimed }) =>
      Effect.gen(function* resolveSubmission() {
        const snapshot = yield* invokeCurrentProposal(transaction, claimed.proposalRevisionRef.resourceId);
        yield* assertClaimedSubmissionTarget(claimed, snapshot, trustedScope);
        const { buyer, profile, sourceRevisions } = yield* loadCurrentApprovalFacts(
          scopedTransaction,
          snapshot,
          trustedScope,
          contextAccess,
          purchaseLimitCurrentness,
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
        return makeTrustedSubmission({ claimed, scope: trustedScope, snapshot });
      }),
    ),
  };
  return service;
};

/**
 * Runtime composition for the generated submit/revalidate Actions. The Actions receive only this
 * narrow owner-local factory; the transaction-bound implementation and its scoped routines stay
 * behind the persistence boundary.
 */
export const purchaseApprovalCurrentnessFactoryLive = Layer.succeed(PurchaseApprovalCurrentnessFactory, {
  make: (transaction, scope, contextAccess, purchaseLimitCurrentness, evaluationSource) =>
    purchaseApprovalCurrentnessForTransaction(
      transaction,
      scope,
      contextAccess,
      purchaseLimitCurrentness,
      evaluationSource,
    ),
} satisfies PurchaseApprovalCurrentnessFactoryContract);
