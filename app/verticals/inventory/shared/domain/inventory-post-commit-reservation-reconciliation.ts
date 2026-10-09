import type { Effect as EffectType, Option } from 'effect';
import { Schema } from 'effect';

import { PurchaseDemandOccurrenceIdSchema } from './catalog-to-stock-binding.ts';
import type { CatalogToStockBinding } from './catalog-to-stock-binding.ts';
import {
  ImportedCommittedObligationSchema,
  RuntimeCommittedInventoryObligationSchema,
  StockAllocationIdSchema,
} from './inventory-obligation.ts';
import type {
  ImportedCommittedObligation,
  InventoryObligationRequirement,
  InventoryStockAllocation,
  ProvisionalInventoryReservation,
  RuntimeCommittedInventoryObligation,
  RuntimeOrderCommitProofObservation,
} from './inventory-obligation.ts';
import { InventoryCommittedObligationStateEvidenceSchema } from './inventory-source-obligation-reconciliation.ts';
import type { InventoryPostCommitReconciliationUnavailable } from './inventory-post-commit-reconciliation-unavailable.ts';
import { PhysicalStockEffectIdSchema } from './physical-stock-effect.ts';
import type { AppliedPhysicalStockEffectSchema, PhysicalStockEffectRecord } from './physical-stock-effect.ts';
import { ImportedCommittedObligationRefSchema } from '../resources/imported-committed-obligation.ts';
import { InventoryReservationRefSchema } from '../resources/inventory-reservation.ts';

export const PostCommitInventoryObligationSchema = Schema.Union([
  RuntimeCommittedInventoryObligationSchema,
  ImportedCommittedObligationSchema,
]);
export type PostCommitInventoryObligation = typeof PostCommitInventoryObligationSchema.Type;

export const PostCommitObligationRefSchema = Schema.Union([
  InventoryReservationRefSchema,
  ImportedCommittedObligationRefSchema,
]);

export const InventoryPostCommitReductionRequestSchema = Schema.Struct({
  allocationId: StockAllocationIdSchema,
  issueEffectId: PhysicalStockEffectIdSchema,
  obligationRef: PostCommitObligationRefSchema,
  purchaseDemandOccurrenceId: PurchaseDemandOccurrenceIdSchema,
});
export type InventoryPostCommitReductionRequest = typeof InventoryPostCommitReductionRequestSchema.Type;

export const InventoryPostCommitReductionResultSchema = Schema.Struct({
  evidence: InventoryCommittedObligationStateEvidenceSchema,
  outcome: Schema.Literals(['REDUCED', 'EXACT_REPLAY']),
});
export type InventoryPostCommitReductionResult = typeof InventoryPostCommitReductionResultSchema.Type;

export interface InventoryPostCommitAppliedIssueReduction {
  readonly allocation: InventoryStockAllocation;
  readonly issue: typeof AppliedPhysicalStockEffectSchema.Type;
  readonly obligation: PostCommitInventoryObligation;
  readonly requirement: InventoryObligationRequirement;
}

export interface InventoryPostCommitTransition {
  readonly transition: (
    reservation: ProvisionalInventoryReservation,
    observation: RuntimeOrderCommitProofObservation,
  ) => EffectType.Effect<
    RuntimeCommittedInventoryObligation,
    InventoryPostCommitReconciliationRejected | InventoryPostCommitReconciliationUnavailable
  >;
}

export class InventoryPostCommitReconciliationRejected extends Schema.TaggedError<InventoryPostCommitReconciliationRejected>()(
  'InventoryPostCommitReconciliationRejected',
  {
    code: Schema.Literal('inventory_post_commit_reconciliation_rejected'),
    reason: Schema.Literals([
      'TENANT_SCOPE_MISMATCH',
      'OBLIGATION_NOT_FOUND',
      'OBLIGATION_NOT_COMMITTED',
      'ORDER_COMMIT_PROOF_MISMATCH',
      'PHYSICAL_EFFECT_NOT_FOUND',
      'PHYSICAL_ISSUE_NOT_APPLIED',
      'PHYSICAL_ISSUE_SCOPE_MISMATCH',
      'OBLIGATION_REQUIREMENT_NOT_FOUND',
      'ALLOCATION_NOT_FOUND',
      'REDUCTION_EVIDENCE_SCOPE_MISMATCH',
      'BINDING_SCOPE_MISMATCH',
    ]),
  },
) {}

export interface InventoryPostCommitPhysicalEffectReader {
  readonly read: (
    effectId: typeof PhysicalStockEffectIdSchema.Type,
  ) => EffectType.Effect<Option.Option<PhysicalStockEffectRecord>, InventoryPostCommitReconciliationUnavailable>;
}

export interface InventoryPostCommitReductionWriter {
  readonly reduceAfterAppliedIssue: (
    request: InventoryPostCommitAppliedIssueReduction,
  ) => EffectType.Effect<
    InventoryPostCommitReductionResult,
    InventoryPostCommitReconciliationRejected | InventoryPostCommitReconciliationUnavailable
  >;
}

export interface InventoryPostCommitBindingAssessmentInput {
  readonly currentBinding: CatalogToStockBinding;
  readonly obligation: ImportedCommittedObligation | RuntimeCommittedInventoryObligation;
  readonly purchaseDemandOccurrenceId: typeof PurchaseDemandOccurrenceIdSchema.Type;
}
