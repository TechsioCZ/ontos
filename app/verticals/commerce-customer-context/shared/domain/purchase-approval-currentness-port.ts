import type { ContextAccessService, OperationalScope } from '@app/core-runtime';
import { Context, Effect } from 'effect';

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
import type { PurchaseLimitEvaluationSourceService } from './purchase-limit-evaluation.ts';
import type { PurchaseLimitSourceRevisionVector } from './purchase-limit-evaluation.ts';

export interface PurchaseApprovalCandidateCurrentEvidence {
  readonly currentSourceRevisions: PurchaseLimitSourceRevisionVector;
  readonly profileEvidence: PurchaseApprovalProfileEvidence;
  readonly proposalEvidence: PurchaseApprovalProposalEvidence;
}

export interface PurchaseApprovalCandidateCurrentnessInput {
  readonly claimedPurchaseValue: PurchaseApprovalCandidateCurrentEvidence['proposalEvidence']['purchaseValue'];
  readonly counterpartyRef: PurchaseApprovalCandidateCurrentEvidence['profileEvidence']['counterpartyRef'];
  readonly expectedSourceRevisions: PurchaseLimitSourceRevisionVector;
  readonly observedAt: string;
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
    transaction: unknown,
    scope: PurchaseApprovalCurrentnessTrustedScope,
  ) => PurchaseApprovalCurrentnessService;
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
  /**
   * Candidate currentness for first proposal creation.  A production adapter may fail closed
   * when an external Cart/policy owner is not configured, but it must never read the proposal row
   * being created and call that row current.
   */
  readonly resolveCandidate?: (input: {
    readonly input: PurchaseApprovalCandidateCurrentnessInput;
  }) => Effect.Effect<PurchaseLimitEvaluationCurrentFacts, PurchasingApprovalRejected>;
}

export class PurchaseApprovalCurrentnessPort extends Context.Service<
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
    transaction: unknown,
    scope: OperationalScope & {
      readonly legalEntityId: string;
      readonly trustedStorefrontId: string;
    },
    contextAccess: ContextAccessService,
    purchaseLimitCurrentness: PurchaseLimitEvaluationCurrentnessPortService,
    evaluationSource: PurchaseLimitEvaluationSourceService,
  ) => PurchaseApprovalCurrentnessService;
}

export class PurchaseApprovalCurrentnessFactory extends Context.Service<
  PurchaseApprovalCurrentnessFactory,
  PurchaseApprovalCurrentnessFactoryContract
>()(
  '@app/commerce-customer-context/shared/domain/purchase-approval-currentness-port/PurchaseApprovalCurrentnessFactory',
) {}
