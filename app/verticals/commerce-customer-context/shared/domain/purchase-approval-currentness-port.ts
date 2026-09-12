import type { ContextAccessService, OperationalScope, ScopedTransactionExecutor } from '@app/core-runtime'; // eslint-disable-line eslint/max-classes-per-file -- This owner-local port intentionally colocates its implementation and composition service tags; expires: 2027-09-10.
import type { Effect } from 'effect';
import { Context } from 'effect';

import type {
  RevalidatePurchaseApprovalInput,
  SubmitPurchaseApprovalRequestInput,
  PurchasingApprovalRejected,
} from './purchasing-approval.ts';
import type {
  PurchaseApprovalProfileEvidence,
  PurchaseApprovalProposalEvidence,
} from './purchase-limit-approval-trigger.ts';
import type {
  PurchaseLimitEvaluationCurrentFacts,
  PurchaseLimitEvaluationCurrentnessPortService,
} from './purchase-limit-evaluation-currentness-port.ts';
import type {
  PurchaseLimitEvaluationSourceService,
  PurchaseLimitSourceRevisionVector,
  PurchaseLimitUtcTimestampSchema,
} from './purchase-limit-evaluation.ts';

export interface PurchaseApprovalCandidateCurrentEvidence {
  readonly currentSourceRevisions: PurchaseLimitSourceRevisionVector;
  readonly profileEvidence: PurchaseApprovalProfileEvidence;
  readonly proposalEvidence: PurchaseApprovalProposalEvidence;
}

interface PurchaseApprovalCandidateCurrentnessInput {
  readonly claimedPurchaseValue: PurchaseApprovalCandidateCurrentEvidence['proposalEvidence']['purchaseValue'];
  readonly counterpartyRef: PurchaseApprovalCandidateCurrentEvidence['profileEvidence']['counterpartyRef'];
  readonly expectedSourceRevisions: PurchaseLimitSourceRevisionVector;
  readonly observedAt: typeof PurchaseLimitUtcTimestampSchema.Type;
  readonly profileRef: PurchaseApprovalCandidateCurrentEvidence['profileEvidence']['profileRef'];
  readonly scope: PurchaseApprovalCurrentnessTrustedScope;
}

/**
 * The only scope a Purchasing Approval currentness adapter may close over.  In particular, the
 * actor and Storefront are installed by Core; they are never recovered from a request body.
 */
export interface PurchaseApprovalCurrentnessTrustedScope {
  readonly legalEntityId: string;
  readonly principalId: string;
  readonly storefrontId: string;
  readonly tenantId: string;
}

export interface PurchaseApprovalCurrentnessService {
  /** Bind all reads to the same scoped transaction as the Action mutation. */
  readonly forTransaction?: (
    transaction: ScopedTransactionExecutor,
    scope: PurchaseApprovalCurrentnessTrustedScope,
  ) => PurchaseApprovalCurrentnessService;
  /**
   * Candidate currentness for first proposal creation.  A production adapter may fail closed
   * when an external Cart/policy owner is not configured, but it must never read the proposal row
   * being created and call that row current.
   */
  readonly resolveCandidate?: (input: {
    readonly input: PurchaseApprovalCandidateCurrentnessInput;
  }) => Effect.Effect<PurchaseLimitEvaluationCurrentFacts, PurchasingApprovalRejected>;
  /**
   * Revalidate from owner-held request/proposal/route/decision snapshots and current external
   * owner facts.  The returned payload is a trusted replacement; caller currentness fields are
   * never merged into it.
   */
  readonly resolveRevalidation: (input: {
    readonly claimed: RevalidatePurchaseApprovalInput;
    readonly scope: PurchaseApprovalCurrentnessTrustedScope;
  }) => Effect.Effect<RevalidatePurchaseApprovalInput, PurchasingApprovalRejected>;
  /**
   * Validate a direct submission against the current proposal/profile/buyer/policy owners.  This
   * method is intentionally separate from revalidation: the first submission must not require an
   * already-CURRENT approval request, and it must not use revalidation evidence as a shortcut.
   */
  readonly resolveSubmission?: (input: {
    readonly claimed: SubmitPurchaseApprovalRequestInput;
    readonly scope: PurchaseApprovalCurrentnessTrustedScope;
  }) => Effect.Effect<SubmitPurchaseApprovalRequestInput, PurchasingApprovalRejected>;
}

// eslint-disable-next-line no-unused-vars -- Retain the Context tag that connects this effectful currentness contract to its Layer boundary.
class PurchaseApprovalCurrentnessPort extends Context.Service<
  PurchaseApprovalCurrentnessPort,
  PurchaseApprovalCurrentnessService
>()(
  '@app/commerce-customer-context/shared/domain/purchase-approval-currentness-port/PurchaseApprovalCurrentnessPort',
) {}

/**
 * Owner-local composition seam for Actions.  The implementation is supplied by the Commerce
 * Customer Context runtime, while generated handlers depend only on this narrow service tag and
 * the already-approved currentness ports.  Keeping the transaction opaque here prevents a
 * governed Action from importing the persistence implementation or exposing a database handle.
 */
export interface PurchaseApprovalCurrentnessFactoryContract {
  readonly make: (
    transaction: ScopedTransactionExecutor,
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
  ) => PurchaseApprovalCurrentnessService;
}

export class PurchaseApprovalCurrentnessFactory extends Context.Service<
  PurchaseApprovalCurrentnessFactory,
  PurchaseApprovalCurrentnessFactoryContract
>()(
  '@app/commerce-customer-context/shared/domain/purchase-approval-currentness-port/PurchaseApprovalCurrentnessFactory',
) {}
