import type { OperationalScope } from '@app/core-runtime';
import { Context } from 'effect';
import type { Effect } from 'effect';
import type { TriggerPurchaseApprovalPayload } from '../../shared/actions/trigger-purchase-approval.ts';
import type { PurchaseApprovalCandidateCurrentEvidence } from '../../shared/domain/purchase-approval-currentness-port.ts';
import type {
  PurchaseApprovalProfileEvidence,
  PurchaseApprovalProposalEvidence,
  PurchaseApprovalTriggerError,
} from '../../shared/domain/purchase-limit-approval-trigger.ts';
import type { PurchaseLimitEvaluationContext } from '../../shared/domain/purchase-limit-evaluation.ts';
import type { PurchaseProposalRevision } from '../../shared/domain/purchasing-approval.ts';

export interface PurchaseApprovalTriggerCurrentEvidence {
  readonly currentSourceRevisions: TriggerPurchaseApprovalPayload['expectedSourceRevisions'];
  readonly profileEvidence: PurchaseApprovalProfileEvidence;
  readonly proposalEvidence: PurchaseApprovalProposalEvidence;
}

export interface PurchaseApprovalTriggerEvidenceSource {
  /** Candidate evidence must never use the proposal row that creation is about to insert. */
  readonly loadCandidateCurrent?: (input: {
    readonly candidateProposal?: PurchaseProposalRevision;
    readonly payload: TriggerPurchaseApprovalPayload;
    readonly trustedContext: PurchaseLimitEvaluationContext;
  }) => Effect.Effect<PurchaseApprovalCandidateCurrentEvidence, PurchaseApprovalTriggerError>;
  readonly loadCurrent: (input: {
    readonly payload: TriggerPurchaseApprovalPayload;
    readonly trustedContext: PurchaseLimitEvaluationContext;
  }) => Effect.Effect<PurchaseApprovalTriggerCurrentEvidence, PurchaseApprovalTriggerError>;
}

export interface PurchaseApprovalTriggerEvidenceSourceFactoryContract {
  readonly make: <Transaction>(
    transaction: Transaction,
    scope: OperationalScope,
  ) => Effect.Effect<PurchaseApprovalTriggerEvidenceSource, PurchaseApprovalTriggerError>;
}

/** Persistence and Actions share the owner port without importing each other's implementation. */
export class PurchaseApprovalTriggerEvidenceSourceFactory extends Context.Service<
  PurchaseApprovalTriggerEvidenceSourceFactory,
  PurchaseApprovalTriggerEvidenceSourceFactoryContract
>()(
  '@app/commerce-customer-context/services/purchase-approval-trigger-evidence-source/PurchaseApprovalTriggerEvidenceSourceFactory',
) {}
