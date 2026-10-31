import { ContextAccess, OperationContextUnavailable, TrustedPrincipalContextSchema } from '@app/core-runtime';
import type {
  ActionServicePreparationContext,
  ContextAccessService,
  OperationalScope,
  ScopedRoutineInvoker,
  ScopedTransactionExecutor,
} from '@app/core-runtime';
import { TenantIdSchema } from '@app/core-runtime/auth/external-identity-contracts';
import { Effect, DateTime, Layer, Option, Predicate, Schema } from 'effect';

import type { PurchaseApprovalRequestRef } from '../../shared/resources/purchase-approval-request.ts';
import {
  PurchaseApprovalCurrentnessFactory,
  PurchaseApprovalFinalBindingAuthority,
} from '../../shared/domain/purchase-approval-currentness-port.ts';
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
  PurchaseApprovalFinalBindingEvidenceSchema,
} from '../../shared/domain/purchasing-approval.ts';
import type {
  RevalidatePurchaseApprovalInput,
  TrustedRevalidatePurchaseApprovalInput,
  PurchaseApprovalFinalBindingEvidence,
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
import {
  PurchaseLimitCounterpartyRefSchema,
  PurchaseLimitDependencyUnavailableSchema,
} from '../../shared/domain/purchase-limit-policy.ts';
import type { PurchaseValue } from '../../shared/domain/purchase-limit.ts';
import { CommerceCustomerProfileRefSchema } from '../../shared/domain/profile-decisions.ts';
import {
  ProfileCounterpartyRoleEligibilityResolverFactory,
  assertPreparedCounterpartyRoleCurrent,
} from '../profile-counterparty-role-eligibility.ts';
import type { ProfilePersistenceDependencies } from './profile-persistence.ts';
import {
  ProfilePersistenceDependencyFailure,
  profilePersistenceServicesForTransaction,
} from './profile-persistence.ts';
import { currentOwnerAccessForTransaction, lockingCurrentOwnerAccessForTransaction } from './access-persistence.ts';
import {
  purchaseLimitEvaluationSourceForVerifiedOrderSubject,
  purchaseLimitEvaluationSourceForTransaction,
  readCurrentPurchaseLimitPolicyState,
  readCurrentPurchaseProposalRoutine,
} from './purchase-limit-persistence.ts';
import { readCurrentPurchaseApprovalRevalidationRoutine } from './purchasing-approval-persistence.ts';

import type { RevalidatePurchaseApprovalPayload } from '../../shared/actions/revalidate-purchase-approval.ts';
import { preparePurchaseLimitCurrentness } from '../services/purchase-currentness-preparation.ts';
import { stableRevision } from '../integrations/order-finalization-pricing-context.ts';

const PROFILE_SOURCE = 'purchasing-profile';
const PROPOSAL_SOURCE = 'purchase-proposal';
const INVALID_COUNTERPARTY_REFERENCE = 'The owner-current Counterparty reference is invalid';
const OWNER_SOURCE_NAMES = new Set(['counterparty-policy', 'principal-override']);
const BUYER_SUBMISSION_PERMISSION = 'counterparty.purchase.submit' as const;
type BuyerPermission = RevalidatePurchaseApprovalInput['buyerPermission'];
const CORE_BUYER_UNAVAILABLE = 'Core buyer authorization is unavailable';
const PREPARED_SUBMISSION_ROLE_UNAVAILABLE = 'Prepared submission Counterparty role expired or is unavailable';
const PREPARED_APPROVAL_ROLE_UNAVAILABLE = 'Prepared approval Counterparty role expired or is unavailable';

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
  requestRef: PurchaseApprovalRequestRef,
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
  profileDependencies: Pick<ProfilePersistenceDependencies, 'resolveCounterpartyRole'>,
  actorPrincipalId: string = scope.principalId,
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
    const services = profilePersistenceServicesForTransaction(
      transaction,
      {
        legalEntityId: scope.legalEntityId,
        principalId: actorPrincipalId,
        tenantId: scope.tenantId,
      },
      profileDependencies,
    );
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

const buyerPermissionRequest = (
  snapshot: Pick<CurrentApprovalFacts, 'proposal'>,
  scope: PurchaseApprovalCurrentnessTrustedScope,
) => ({
  principal: snapshot.proposal.identity.buyer,
  targets: [
    {
      permission: BUYER_SUBMISSION_PERMISSION,
      target: {
        counterpartyId: snapshot.proposal.identity.counterpartyRef.resourceId,
        kind: 'counterparty_storefront' as const,
        legalEntityId: scope.legalEntityId,
        storefrontId: scope.storefrontId,
        tenantId: scope.tenantId,
      },
    },
  ],
  trustedStorefrontId: scope.storefrontId,
});

const coreBuyerPermissionDecision = (
  decisions: Effect.Success<ReturnType<NonNullable<ContextAccessService['businessPermissions']>>>,
): Effect.Effect<BuyerPermission, PurchasingApprovalRejected> => {
  const [core] = decisions;
  if (core === undefined || core.decision === 'unavailable') {
    return Effect.fail(currentnessRejected('Current buyer authorization is unavailable'));
  }
  return Effect.succeed(core.decision === 'allowed' ? 'ALLOWED' : 'DENIED');
};

const observeCoreBuyerPermission = Effect.fn('PurchaseApprovalCurrentnessPersistence.observeCoreBuyerPermission')(
  function* observeCoreBuyer(
    snapshot: Pick<CurrentApprovalFacts, 'proposal'>,
    scope: PurchaseApprovalCurrentnessTrustedScope,
  ) {
    const contextAccess = yield* ContextAccess;
    const check = contextAccess.businessPermissions;
    if (check === undefined) {
      return yield* currentnessRejected(CORE_BUYER_UNAVAILABLE);
    }
    return yield* check(buyerPermissionRequest(snapshot, scope)).pipe(Effect.flatMap(coreBuyerPermissionDecision));
  },
);

const ownerBuyerPermission = Effect.fn('PurchaseApprovalCurrentnessPersistence.ownerBuyerPermission')(
  (
    transaction: ScopedTransactionExecutor,
    snapshot: Pick<CurrentApprovalFacts, 'proposal'>,
    scope: PurchaseApprovalCurrentnessTrustedScope,
    core: BuyerPermission,
    // Decision paths keep the owner access row locked; read-only observation must not block nested owner reads.
    lock: boolean,
  ) =>
    Effect.gen(function* readBuyerPermission() {
      const counterparty = yield* Schema.decodeUnknownEffect(PurchaseLimitCounterpartyRefSchema)(
        snapshot.proposal.identity.counterpartyRef,
      ).pipe(Effect.mapError(mapCurrentnessError(INVALID_COUNTERPARTY_REFERENCE)));
      const ownerScope = {
        legalEntityId: scope.legalEntityId,
        tenantId: yield* Schema.decodeEffect(TenantIdSchema)(scope.tenantId).pipe(
          Effect.mapError(mapCurrentnessError('The trusted Tenant scope is malformed')),
        ),
      };
      const readOwnerAccess = lock
        ? lockingCurrentOwnerAccessForTransaction(transaction, ownerScope)
        : currentOwnerAccessForTransaction(transaction, ownerScope);
      const owner = yield* readOwnerAccess({
        counterpartyRef: counterparty,
        legalEntityId: scope.legalEntityId,
        permission: BUYER_SUBMISSION_PERMISSION,
        principal: snapshot.proposal.identity.buyer,
        scope: { kind: 'storefront', storefrontKey: scope.storefrontId },
      });
      if (owner === 'UNAVAILABLE') {
        return yield* currentnessRejected('Current buyer authorization is unavailable');
      }
      return core === 'ALLOWED' && owner === 'ALLOWED' ? ('ALLOWED' as const) : ('DENIED' as const);
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
  finalBindingEvidence: PurchaseApprovalFinalBindingEvidence;
  now: DateTime.Utc;
  profileState: 'ACTIVE' | 'INACTIVE';
  scope: PurchaseApprovalCurrentnessTrustedScope;
  snapshot: Snapshot;
  sourceRevisions: PurchaseLimitSourceRevisionVector;
}>;

const makeTrustedRevalidation = ({
  buyer,
  claimed,
  finalBindingEvidence,
  now,
  profileState,
  scope,
  snapshot,
  sourceRevisions,
}: TrustedRevalidationInput): TrustedRevalidatePurchaseApprovalInput => {
  const routeCurrent =
    snapshot.request.status === 'APPROVED' &&
    snapshot.route.status === 'APPROVED' &&
    sameRef(snapshot.request.route.routeRef, snapshot.route.routeRef) &&
    snapshot.route.levels.every(({ completedAt, completedBy }) => completedBy !== null && completedAt !== null) &&
    sameSourceVector(sourceRevisions, snapshot.sourceRevisions);
  const requestValidUntil = snapshot.request.expiresAt;
  const maximumValidUntil = DateTime.add(now, { minutes: 5 });
  const requestBound = DateTime.isLessThan(requestValidUntil, maximumValidUntil)
    ? requestValidUntil
    : maximumValidUntil;
  const validUntil = DateTime.isLessThan(finalBindingEvidence.validUntil, requestBound)
    ? finalBindingEvidence.validUntil
    : requestBound;
  return {
    ...claimed,
    buyerPermission: buyer,
    checkedAt: now,
    counterpartyRef: snapshot.proposal.identity.counterpartyRef,
    decisionBundleHash: snapshot.request.decisionBundleHash ?? snapshot.decision.decisionBundleHash,
    decisionBundleVersion: snapshot.decision.decisionBundleVersion,
    decisionRef: snapshot.decision.decisionRef,
    expectedProposalHash: snapshot.proposal.canonicalHash,
    finalBinding: finalBindingEvidence.binding,
    finalBindingEvidence,
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
    coreBuyerPermission: BuyerPermission,
    // eslint-disable-next-line effect-native/no-dependency-parameters -- This helper receives already-yielded services before resolving the shared owner-current evidence bundle; expires: 2027-09-10.
    purchaseLimitCurrentness: PurchaseLimitEvaluationCurrentnessPortService,
    profileDependencies: Pick<ProfilePersistenceDependencies, 'resolveCounterpartyRole'>,
    profileActorPrincipalId: string = scope.principalId,
  ) {
    const counterpartyRef = yield* Schema.decodeUnknownEffect(PurchaseLimitCounterpartyRefSchema)(
      snapshot.proposal.identity.counterpartyRef,
    ).pipe(Effect.mapError(mapCurrentnessError(INVALID_COUNTERPARTY_REFERENCE)));
    const now = yield* DateTime.now;
    const [profile, buyer, externalFacts, policyState] = yield* Effect.all(
      [
        currentProfile(transaction, snapshot, scope, profileDependencies, profileActorPrincipalId),
        ownerBuyerPermission(transaction, snapshot, scope, coreBuyerPermission, true),
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
  profileDependencies: Pick<ProfilePersistenceDependencies, 'resolveCounterpartyRole'>,
  // eslint-disable-next-line effect-native/no-dependency-parameters -- This owner-local constructor receives already-yielded Core and currentness services before closing the transaction-scoped adapter; expires: 2027-09-10.
  evaluationSource?: PurchaseLimitEvaluationSourceService,
  preparedBuyerPermission?: BuyerPermission,
  preparedFinalBindingEvidence?: PurchaseApprovalFinalBindingEvidence,
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
        const snapshot = yield* invokeCurrentnessSnapshot(transaction, claimed.requestRef);
        yield* assertClaimedTarget(claimed, snapshot, trustedScope);
        const coreBuyerPermission =
          preparedBuyerPermission ??
          (yield* (
            contextAccess
              .businessPermissions?.(buyerPermissionRequest(snapshot, trustedScope))
              .pipe(Effect.flatMap(coreBuyerPermissionDecision)) ??
              Effect.fail(currentnessRejected(CORE_BUYER_UNAVAILABLE))
          ));
        const { buyer, profile, sourceRevisions } = yield* loadCurrentApprovalFacts(
          scopedTransaction,
          snapshot,
          trustedScope,
          coreBuyerPermission,
          purchaseLimitCurrentness,
          profileDependencies,
        );
        yield* verifyCurrentApprovalEvaluation(evaluationSource, snapshot, trustedScope);
        const authority = yield* Effect.serviceOption(PurchaseApprovalFinalBindingAuthority);
        if (
          (preparedFinalBindingEvidence === undefined && Option.isNone(authority)) ||
          claimed.finalBinding === undefined
        ) {
          return yield* currentnessRejected('The final Bundle/Attempt authority is unavailable');
        }
        const finalBindingEvidence =
          preparedFinalBindingEvidence ??
          (yield* (
            Option.isSome(authority)
              ? authority.value.verifyRevalidation({
                  binding: claimed.finalBinding,
                  claimed,
                  request: snapshot.request,
                  scope: trustedScope,
                })
              : Effect.fail(currentnessRejected('The final Bundle/Attempt authority is unavailable'))
          ).pipe(
            Effect.flatMap((evidence) =>
              Schema.decodeUnknownEffect(Schema.toType(PurchaseApprovalFinalBindingEvidenceSchema))(evidence),
            ),
            Effect.mapError(mapCurrentnessError('The final Bundle/Attempt authority evidence is unavailable')),
          ));
        const verificationNow = yield* DateTime.now;
        const { binding } = finalBindingEvidence;
        if (
          !sameRef(binding.attemptRef, claimed.finalBinding.attemptRef) ||
          !sameRef(binding.bundleRef, claimed.finalBinding.bundleRef) ||
          binding.bundleHash !== claimed.finalBinding.bundleHash ||
          binding.bundleVersion !== claimed.finalBinding.bundleVersion ||
          binding.attemptRef.tenantId !== trustedScope.tenantId ||
          binding.bundleRef.tenantId !== trustedScope.tenantId ||
          DateTime.isGreaterThan(finalBindingEvidence.observedAt, verificationNow) ||
          !DateTime.isGreaterThan(finalBindingEvidence.validUntil, verificationNow) ||
          !DateTime.isGreaterThan(finalBindingEvidence.validUntil, finalBindingEvidence.observedAt)
        ) {
          return yield* currentnessRejected(
            'The final Bundle/Attempt authority did not verify the exact current binding',
          );
        }
        return makeTrustedRevalidation({
          buyer,
          claimed,
          finalBindingEvidence,
          now: verificationNow,
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
        const coreBuyerPermission =
          preparedBuyerPermission ??
          (yield* (
            contextAccess
              .businessPermissions?.(buyerPermissionRequest(snapshot, trustedScope))
              .pipe(Effect.flatMap(coreBuyerPermissionDecision)) ??
              Effect.fail(currentnessRejected(CORE_BUYER_UNAVAILABLE))
          ));
        const { buyer, profile, sourceRevisions } = yield* loadCurrentApprovalFacts(
          scopedTransaction,
          snapshot,
          trustedScope,
          coreBuyerPermission,
          purchaseLimitCurrentness,
          profileDependencies,
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

const submissionPreparationUnavailable = (cause: unknown) =>
  Object.defineProperty(
    new OperationContextUnavailable({
      code: 'operation_context_unavailable',
      reason: 'Prepared submission owner evidence could not be revalidated',
    }),
    'cause',
    { value: cause },
  );

/** Core permission is observed outside SQL; owner authorization remains locked and checked at commit. */
export const preparePurchaseApprovalSubmissionCurrentness = Effect.fn('PurchaseApprovalCurrentness.prepareSubmission')(
  function* prepareSubmission(claimed: SubmitPurchaseApprovalRequestInput, context: ActionServicePreparationContext) {
    const { scope } = context;
    const { legalEntityId, trustedStorefrontId } = scope;
    if (
      legalEntityId === undefined ||
      trustedStorefrontId === undefined ||
      claimed.counterpartyRef.tenantId !== scope.tenantId ||
      claimed.proposalRevisionRef.tenantId !== scope.tenantId ||
      claimed.storefrontId !== trustedStorefrontId
    ) {
      return yield* denied('Submission preparation requires the trusted Counterparty and Storefront');
    }
    const trustedScope = {
      legalEntityId,
      principalId: scope.principalId,
      storefrontId: trustedStorefrontId,
      tenantId: scope.tenantId,
    };
    const before = yield* context.transaction((transaction) =>
      invokeCurrentProposal(transaction, claimed.proposalRevisionRef.resourceId),
    );
    yield* assertClaimedSubmissionTarget(claimed, before, trustedScope);
    const contextAccess = yield* ContextAccess;
    const check = contextAccess.businessPermissions;
    if (check === undefined) {
      return yield* currentnessRejected(CORE_BUYER_UNAVAILABLE);
    }
    const roleFactory = yield* ProfileCounterpartyRoleEligibilityResolverFactory;
    const [prepareBasis, permission, role] = yield* Effect.all(
      [
        preparePurchaseLimitCurrentness(context, before.proposal.purchaseValue),
        check(buyerPermissionRequest(before, trustedScope)).pipe(Effect.flatMap(coreBuyerPermissionDecision)),
        roleFactory.make({ legalEntityId, requestCorrelation: scope.correlationId, tenantId: scope.tenantId })({
          counterpartyResourceId: before.proposal.identity.counterpartyRef.resourceId,
          tenantId: scope.tenantId,
        }),
      ],
      { concurrency: 3 },
    ).pipe(Effect.mapError(mapCurrentnessError('Current submission owner evidence is unavailable')));
    const sameProposal = Schema.toEquivalence(Schema.toType(ProposalFactsSchema));
    const intentRevision = stableRevision(claimed);
    return Effect.fn('PurchaseApprovalCurrentness.submissionCommitServices')(function* commitServices(
      transaction: ScopedTransactionExecutor,
      currentScope: OperationalScope,
      revision: string,
    ) {
      const [prepared, current] = yield* Effect.all(
        [
          prepareBasis(transaction, currentScope, revision),
          invokeCurrentProposal(transaction, claimed.proposalRevisionRef.resourceId).pipe(
            Effect.mapError(submissionPreparationUnavailable),
          ),
        ],
        { concurrency: 1 },
      );
      if (!sameProposal(before, current)) {
        return yield* submissionPreparationUnavailable(
          currentnessRejected('Submission proposal changed during preparation'),
        );
      }
      const ownerScope = { ...currentScope, legalEntityId, trustedStorefrontId };
      const currentness = purchaseApprovalCurrentnessForTransaction(
        transaction,
        ownerScope,
        contextAccess,
        prepared.currentness,
        {
          resolveCounterpartyRole: (request) =>
            request.tenantId === scope.tenantId &&
            request.counterpartyResourceId === before.proposal.identity.counterpartyRef.resourceId
              ? Effect.succeed(role)
              : Effect.fail(
                  new ProfilePersistenceDependencyFailure({ reason: 'Prepared submission Counterparty differs' }),
                ),
        },
        purchaseLimitEvaluationSourceForTransaction(transaction, ownerScope, prepared.currentness),
        permission,
      );
      const { resolveSubmission } = currentness;
      if (resolveSubmission === undefined) {
        return yield* submissionPreparationUnavailable(currentnessRejected('Submission resolver is unavailable'));
      }
      const bound: PurchaseApprovalCurrentnessService = {
        forTransaction: (candidate, candidateScope) =>
          Object.is(candidate, transaction) &&
          candidateScope.tenantId === scope.tenantId &&
          candidateScope.legalEntityId === legalEntityId &&
          candidateScope.principalId === scope.principalId &&
          candidateScope.storefrontId === trustedStorefrontId
            ? bound
            : {
                resolveRevalidation: () => Effect.fail(denied('Prepared submission transaction differs')),
                resolveSubmission: () => Effect.fail(denied('Prepared submission transaction differs')),
              },
        resolveRevalidation: () =>
          Effect.fail(currentnessRejected('Submission preparation cannot revalidate an approval')),
        resolveSubmission: (request) =>
          stableRevision(request.claimed) === intentRevision &&
          request.scope.tenantId === scope.tenantId &&
          request.scope.legalEntityId === legalEntityId &&
          request.scope.principalId === scope.principalId &&
          request.scope.storefrontId === trustedStorefrontId
            ? assertPreparedCounterpartyRoleCurrent(role).pipe(
                Effect.mapError(mapCurrentnessError(PREPARED_SUBMISSION_ROLE_UNAVAILABLE)),
                Effect.andThen(resolveSubmission(request)),
              )
            : Effect.fail(denied('Prepared submission intent or scope differs')),
      };
      return {
        currentness: bound,
        revalidate: () =>
          assertPreparedCounterpartyRoleCurrent(role).pipe(
            Effect.mapError(mapCurrentnessError(PREPARED_SUBMISSION_ROLE_UNAVAILABLE)),
            Effect.andThen(prepared.revalidate()),
            Effect.andThen(
              assertPreparedCounterpartyRoleCurrent(role).pipe(
                Effect.mapError(mapCurrentnessError(PREPARED_SUBMISSION_ROLE_UNAVAILABLE)),
              ),
            ),
          ),
      };
    });
  },
);

const sameCurrentPurchaseValue = (left: PurchaseValue, right: PurchaseValue): boolean =>
  left.sourceRef === right.sourceRef &&
  left.sourceRevision === right.sourceRevision &&
  left.roundingRuleRevision === right.roundingRuleRevision &&
  left.monetaryAmount.amount === right.monetaryAmount.amount &&
  left.monetaryAmount.currency === right.monetaryAmount.currency;

interface ApprovalBusinessSubject {
  readonly buyerPrincipalId: string;
  readonly storefrontId: string;
}
const samePreparationPrincipal = Schema.toEquivalence(TrustedPrincipalContextSchema);
const sameApprovalSnapshot = Schema.toEquivalence(Schema.toType(SnapshotSchema));

/** Only immutable observations leave preparation. SQL executors and scoped services do not. */
const prepareApprovalOwnerObservation = Effect.fn('PurchaseApprovalCurrentness.prepareOwnerObservation')(
  function* prepareOwnerObservation(
    claimed: RevalidatePurchaseApprovalInput,
    subject: ApprovalBusinessSubject | undefined,
    context: ActionServicePreparationContext,
  ) {
    const { scope } = context;
    if (scope.legalEntityId === undefined || (subject === undefined && scope.trustedStorefrontId === undefined)) {
      return yield* denied('Approval preparation requires a trusted Legal Entity and Storefront');
    }
    const snapshot = yield* context.transaction((transaction) =>
      invokeCurrentnessSnapshot(transaction, claimed.requestRef),
    );
    const { proposal } = snapshot;
    if (
      subject !== undefined &&
      (proposal.identity.buyer.tenantId !== scope.tenantId ||
        proposal.identity.buyer.principalId !== subject.buyerPrincipalId ||
        proposal.context.storefrontId !== subject.storefrontId)
    ) {
      return yield* denied('The Order subject does not match the retained approval proposal');
    }
    const businessScope: PurchaseApprovalCurrentnessTrustedScope = {
      legalEntityId: scope.legalEntityId,
      principalId: subject === undefined ? scope.principalId : proposal.identity.buyer.principalId,
      storefrontId: subject?.storefrontId ?? claimed.storefrontId,
      tenantId: scope.tenantId,
    };
    if (subject === undefined && businessScope.storefrontId !== scope.trustedStorefrontId) {
      return yield* denied('The claimed Storefront does not match the trusted operation');
    }
    yield* assertClaimedTarget(claimed, snapshot, businessScope);
    const observedAt = yield* DateTime.now;
    if (!DateTime.isLessThan(observedAt, snapshot.request.expiresAt)) {
      return yield* new PurchasingApprovalRejected({
        code: 'OWNER_CONFIRMATION_EXPIRED',
        reason: 'The owner revalidation evidence is outside the trusted validity window',
        retryable: true,
      });
    }
    const roleFactory = yield* ProfileCounterpartyRoleEligibilityResolverFactory;
    const [coreBuyerPermission, role] = yield* Effect.all(
      [
        observeCoreBuyerPermission(snapshot, businessScope),
        roleFactory.make({
          legalEntityId: scope.legalEntityId,
          requestCorrelation: scope.correlationId,
          tenantId: scope.tenantId,
        })({
          counterpartyResourceId: proposal.identity.counterpartyRef.resourceId,
          tenantId: scope.tenantId,
        }),
      ],
      { concurrency: 2 },
    ).pipe(Effect.mapError(mapCurrentnessError('Current approval buyer and Party observations are unavailable')));
    const validUntil = Math.min(
      DateTime.toEpochMillis(snapshot.request.expiresAt),
      DateTime.toEpochMillis(proposal.expiresAt),
      DateTime.toEpochMillis(observedAt) + 30_000,
    );
    return { businessScope, coreBuyerPermission, observedAt, role, snapshot, validUntil };
  },
);

const recheckApprovalOwnerObservation = Effect.fn('PurchaseApprovalCurrentness.recheckOwnerObservation')(
  function* recheckOwnerObservation(
    transaction: ScopedTransactionExecutor,
    scope: OperationalScope,
    revision: string,
    context: ActionServicePreparationContext,
    prepared: Effect.Success<ReturnType<typeof prepareApprovalOwnerObservation>>,
  ) {
    if (
      !samePreparationPrincipal(scope, context.scope) ||
      scope.tenantId !== context.scope.tenantId ||
      scope.legalEntityId !== context.scope.legalEntityId ||
      scope.trustedStorefrontId !== context.scope.trustedStorefrontId ||
      scope.correlationId !== context.scope.correlationId ||
      revision !== context.compositionRevision
    ) {
      return yield* denied('Prepared approval belongs to another operation scope or composition');
    }
    yield* assertPreparedCounterpartyRoleCurrent(prepared.role).pipe(
      Effect.mapError(mapCurrentnessError(PREPARED_APPROVAL_ROLE_UNAVAILABLE)),
    );
    const current = yield* invokeCurrentnessSnapshot(transaction, prepared.snapshot.request.requestRef);
    const now = yield* DateTime.now;
    if (
      !sameApprovalSnapshot(prepared.snapshot, current) ||
      DateTime.isLessThan(now, prepared.observedAt) ||
      DateTime.toEpochMillis(now) >= prepared.validUntil
    ) {
      return yield* currentnessRejected('Approval owner state changed or preparation expired before commit');
    }
    yield* assertPreparedCounterpartyRoleCurrent(prepared.role).pipe(
      Effect.mapError(mapCurrentnessError(PREPARED_APPROVAL_ROLE_UNAVAILABLE)),
    );
    return current;
  },
);

const preparedRoleEnd = (role: Effect.Success<ReturnType<typeof prepareApprovalOwnerObservation>>['role']): number =>
  role.outcome === 'ELIGIBLE' && role.validUntil !== null && role.validUntil !== undefined
    ? DateTime.toEpochMillis(DateTime.makeUnsafe(role.validUntil))
    : Infinity;

const preparedApprovalRole = (
  prepared: Effect.Success<ReturnType<typeof prepareApprovalOwnerObservation>>,
): Pick<ProfilePersistenceDependencies, 'resolveCounterpartyRole'> => ({
  resolveCounterpartyRole: (request) =>
    request.tenantId === prepared.businessScope.tenantId &&
    request.counterpartyResourceId === prepared.snapshot.proposal.identity.counterpartyRef.resourceId
      ? Effect.succeed(prepared.role)
      : Effect.fail(new ProfilePersistenceDependencyFailure({ reason: 'Prepared approval Counterparty differs' })),
});

/** The buyer Action observes Party, Core, Cart and final-owner authority only after SQL is released. */
export const preparePurchaseApprovalRevalidationCurrentness = Effect.fn(
  'PurchaseApprovalCurrentness.prepareRevalidation',
)(function* prepareRevalidation(claimed: RevalidatePurchaseApprovalInput, context: ActionServicePreparationContext) {
  const owner = yield* prepareApprovalOwnerObservation(claimed, undefined, context);
  const authority = yield* Effect.serviceOption(PurchaseApprovalFinalBindingAuthority);
  if (claimed.finalBinding === undefined || Option.isNone(authority)) {
    return yield* currentnessRejected('The final Bundle/Attempt binding is unavailable');
  }
  const prepareBasis = yield* preparePurchaseLimitCurrentness(context, owner.snapshot.proposal.purchaseValue).pipe(
    Effect.mapError(mapCurrentnessError('Current approval purchase source cannot be prepared')),
  );
  yield* context.transaction(
    Effect.fn('PurchaseApprovalCurrentness.checkBeforeFinalAuthority')(function* checkBeforeFinalAuthority(
      transaction: ScopedTransactionExecutor,
    ) {
      yield* recheckApprovalOwnerObservation(transaction, context.scope, context.compositionRevision, context, owner);
      const basis = yield* prepareBasis(transaction, context.scope, context.compositionRevision);
      const facts = yield* loadCurrentApprovalFacts(
        transaction,
        owner.snapshot,
        owner.businessScope,
        owner.coreBuyerPermission,
        basis.currentness,
        preparedApprovalRole(owner),
      );
      if (facts.buyer !== 'ALLOWED') {
        return yield* new PurchasingApprovalRejected({
          code: 'BUYER_PERMISSION_DENIED',
          reason: 'Current buyer authorization no longer permits this approval',
          retryable: false,
        });
      }
      if (facts.profile.gate.outcome !== 'ACTIVE' || !facts.profile.gate.canAcceptNewOrder) {
        return yield* new PurchasingApprovalRejected({
          code: 'PROFILE_INACTIVE',
          reason: 'The purchasing profile is no longer active',
          retryable: false,
        });
      }
      return yield* verifyCurrentApprovalEvaluation(
        purchaseLimitEvaluationSourceForTransaction(
          transaction,
          {
            ...context.scope,
            legalEntityId: owner.businessScope.legalEntityId,
            trustedStorefrontId: owner.businessScope.storefrontId,
          },
          basis.currentness,
        ),
        owner.snapshot,
        owner.businessScope,
      );
    }),
  );
  const finalBindingEvidence = yield* authority.value
    .verifyRevalidation({
      binding: claimed.finalBinding,
      claimed,
      request: owner.snapshot.request,
      scope: owner.businessScope,
    })
    .pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.toType(PurchaseApprovalFinalBindingEvidenceSchema))),
      Effect.mapError(mapCurrentnessError('The final Bundle/Attempt authority evidence is unavailable')),
    );
  const intentRevision = stableRevision(claimed);
  const contextAccess = yield* ContextAccess;
  return Effect.fn('PurchaseApprovalCurrentness.revalidationCommitServices')(function* revalidationCommitServices(
    transaction: ScopedTransactionExecutor,
    scope: OperationalScope,
    revision: string,
  ) {
    const revalidate = () =>
      recheckApprovalOwnerObservation(transaction, scope, revision, context, owner).pipe(
        Effect.andThen(DateTime.now),
        Effect.filterOrFail(
          (now) =>
            !DateTime.isGreaterThan(finalBindingEvidence.observedAt, now) &&
            DateTime.isGreaterThan(finalBindingEvidence.validUntil, now),
          () => currentnessRejected('The prepared final binding evidence expired before commit'),
        ),
        Effect.asVoid,
      );
    const basis = yield* prepareBasis(transaction, scope, revision);
    const ownerScope = {
      ...scope,
      legalEntityId: owner.businessScope.legalEntityId,
      trustedStorefrontId: owner.businessScope.storefrontId,
    };
    const delegate = purchaseApprovalCurrentnessForTransaction(
      transaction,
      ownerScope,
      contextAccess,
      basis.currentness,
      preparedApprovalRole(owner),
      purchaseLimitEvaluationSourceForTransaction(transaction, ownerScope, basis.currentness),
      owner.coreBuyerPermission,
      finalBindingEvidence,
    );
    const service: PurchaseApprovalCurrentnessService = {
      resolveRevalidation: (request) =>
        stableRevision(request.claimed) === intentRevision &&
        stableRevision(request.scope) === stableRevision(owner.businessScope)
          ? revalidate().pipe(
              Effect.andThen(delegate.resolveRevalidation(request)),
              Effect.map((trusted) => ({
                ...trusted,
                validUntil: DateTime.makeUnsafe(
                  Math.min(DateTime.toEpochMillis(trusted.validUntil), owner.validUntil, preparedRoleEnd(owner.role)),
                ),
              })),
            )
          : Effect.fail(denied('Prepared approval intent or business scope differs')),
    };
    return {
      currentness: service,
      revalidate: () =>
        revalidate().pipe(
          Effect.andThen(basis.revalidate()),
          Effect.andThen(
            assertPreparedCounterpartyRoleCurrent(owner.role).pipe(
              Effect.mapError(mapCurrentnessError(PREPARED_APPROVAL_ROLE_UNAVAILABLE)),
            ),
          ),
        ),
    };
  });
});

/** Service admission remains the authenticated actor. Buyer/Storefront are separately owner-proven facts. */
export const prepareOrderPurchaseApprovalRevalidation = Effect.fn(
  'PurchaseApprovalCurrentness.prepareOrderRevalidation',
)(function* prepareOrderRevalidation(
  subject: ApprovalBusinessSubject,
  claimed: RevalidatePurchaseApprovalPayload,
  providedFinalBindingEvidence: PurchaseApprovalFinalBindingEvidence,
  // eslint-disable-next-line effect-native/no-dependency-parameters -- The factory yields the Currentness Context service before closing it into this scoped revalidation input; expires: 2027-09-10.
  currentOrderEvidence: {
    readonly bundlePurchaseValue: PurchaseValue;
    readonly currentness: PurchaseLimitEvaluationCurrentnessPortService;
  },
  context: ActionServicePreparationContext,
) {
  const prepared = yield* prepareApprovalOwnerObservation(claimed, subject, context);
  const { businessScope, snapshot } = prepared;
  if (!sameCurrentPurchaseValue(currentOrderEvidence.bundlePurchaseValue, snapshot.proposal.purchaseValue)) {
    return yield* currentnessRejected('The genuine final Order purchase value no longer matches the approved proposal');
  }
  // The service closes this adapter over actual current owner observations. The global buyer
  // provider remains unchanged, and expected vectors never become returned current facts here.
  const purchaseLimitCurrentness: PurchaseLimitEvaluationCurrentnessPortService = {
    resolveCurrent: (input) =>
      currentOrderEvidence.currentness.resolveCurrent(input).pipe(
        Effect.filterOrFail(
          (observed) => sameCurrentPurchaseValue(observed.purchaseValue, currentOrderEvidence.bundlePurchaseValue),
          () =>
            PurchaseLimitDependencyUnavailableSchema.make({
              code: 'purchase_limit_dependency_unavailable',
              dependency: 'commerce.order.current-purchase-value',
              reason: 'Current owner purchase value does not match the genuine final Order value',
            }),
        ),
      ),
  };
  const finalBindingEvidence = yield* Schema.decodeUnknownEffect(
    Schema.toType(PurchaseApprovalFinalBindingEvidenceSchema),
  )(providedFinalBindingEvidence).pipe(
    Effect.mapError(mapCurrentnessError('The verified Order binding evidence is invalid')),
  );
  const now = yield* DateTime.now;
  const { binding } = finalBindingEvidence;
  if (
    claimed.finalBinding === undefined ||
    !sameRef(binding.attemptRef, claimed.finalBinding.attemptRef) ||
    !sameRef(binding.bundleRef, claimed.finalBinding.bundleRef) ||
    binding.bundleHash !== claimed.finalBinding.bundleHash ||
    binding.bundleVersion !== claimed.finalBinding.bundleVersion ||
    binding.attemptRef.tenantId !== businessScope.tenantId ||
    binding.bundleRef.tenantId !== businessScope.tenantId ||
    DateTime.isGreaterThan(finalBindingEvidence.observedAt, now) ||
    !DateTime.isGreaterThan(finalBindingEvidence.validUntil, now) ||
    !DateTime.isGreaterThan(finalBindingEvidence.validUntil, finalBindingEvidence.observedAt)
  ) {
    return yield* currentnessRejected('The Order authority did not verify the exact fresh prepared binding');
  }
  return Effect.fn('PurchaseApprovalCurrentness.orderCommitValidator')(function* orderCommitValidator(
    transaction: ScopedTransactionExecutor,
    actualScope: OperationalScope,
    revision: string,
  ) {
    const revalidate = () =>
      recheckApprovalOwnerObservation(transaction, actualScope, revision, context, prepared).pipe(
        Effect.andThen(DateTime.now),
        Effect.filterOrFail(
          (instant) => DateTime.isLessThan(instant, finalBindingEvidence.validUntil),
          () => currentnessRejected('The Order binding evidence expired before commit'),
        ),
        Effect.asVoid,
      );
    yield* revalidate();
    const { evaluationSource, facts } = yield* Effect.all(
      {
        evaluationSource: purchaseLimitEvaluationSourceForVerifiedOrderSubject(transaction, {
          actualScope,
          businessSubject: subject,
          currentness: purchaseLimitCurrentness,
        }).pipe(Effect.mapError(mapCurrentnessError('Current Order Purchase Limit evaluation is unavailable'))),
        facts: loadCurrentApprovalFacts(
          transaction,
          snapshot,
          businessScope,
          prepared.coreBuyerPermission,
          purchaseLimitCurrentness,
          preparedApprovalRole(prepared),
          actualScope.principalId,
        ),
      },
      { concurrency: 1 },
    );
    yield* verifyCurrentApprovalEvaluation(evaluationSource, snapshot, businessScope);
    const checkedAt = yield* DateTime.now;
    const trusted = makeTrustedRevalidation({
      buyer: facts.buyer,
      claimed,
      finalBindingEvidence,
      now: checkedAt,
      profileState:
        facts.profile.gate.outcome === 'ACTIVE' && facts.profile.gate.canAcceptNewOrder ? 'ACTIVE' : 'INACTIVE',
      scope: businessScope,
      snapshot,
      sourceRevisions: facts.sourceRevisions,
    });
    yield* revalidate();
    return {
      revalidate,
      trusted: {
        ...trusted,
        validUntil: DateTime.makeUnsafe(
          Math.min(DateTime.toEpochMillis(trusted.validUntil), prepared.validUntil, preparedRoleEnd(prepared.role)),
        ),
      },
    };
  });
});

/**
 * Runtime composition for the generated submit/revalidate Actions. The Actions receive only this
 * narrow owner-local factory; the transaction-bound implementation and its scoped routines stay
 * behind the persistence boundary.
 */
export const purchaseApprovalCurrentnessFactoryLive = Layer.effect(
  PurchaseApprovalCurrentnessFactory,
  Effect.gen(function* makeCurrentnessFactory() {
    const roleResolverFactory = yield* ProfileCounterpartyRoleEligibilityResolverFactory;
    return {
      make: <Transaction>(
        transaction: Transaction,
        scope: OperationalScope & {
          readonly legalEntityId: string;
          readonly trustedStorefrontId: string;
        },
        // eslint-disable-next-line effect-native/no-dependency-parameters -- The factory receives this already-yielded Core service before closing the owner-local Action adapter; expires: 2027-09-10.
        contextAccess: ContextAccessService,
        // eslint-disable-next-line effect-native/no-dependency-parameters -- The factory receives this already-yielded currentness port before closing the owner-local Action adapter; expires: 2027-09-10.
        purchaseLimitCurrentness: PurchaseLimitEvaluationCurrentnessPortService,
        // eslint-disable-next-line effect-native/no-dependency-parameters -- The factory receives this already-yielded evaluation source before closing the owner-local Action adapter; expires: 2027-09-10.
        evaluationSource: PurchaseLimitEvaluationSourceService,
      ) => {
        // eslint-disable-next-line typescript/no-unsafe-type-assertion -- SAFETY: Core invokes owner factories only with its branded, scope-installed transaction; expires: 2027-03-31.
        const scopedTransaction = transaction as ScopedTransactionExecutor;
        return purchaseApprovalCurrentnessForTransaction(
          scopedTransaction,
          scope,
          contextAccess,
          purchaseLimitCurrentness.forOperation?.(scopedTransaction, scope) ?? purchaseLimitCurrentness,
          {
            resolveCounterpartyRole: roleResolverFactory.make({
              legalEntityId: scope.legalEntityId,
              requestCorrelation: scope.correlationId,
              tenantId: scope.tenantId,
            }),
          },
          evaluationSource,
        );
      },
    } satisfies PurchaseApprovalCurrentnessFactoryContract;
  }),
);
