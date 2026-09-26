import type { Effect as EffectType, Option } from 'effect';
import { Schema } from 'effect';

import {
  InventorySourceAssertionIdSchema,
  InventorySourceAssertionProposalSchema,
} from './inventory-source-assertion.ts';
import type { InventorySourceAssertionProposal } from './inventory-source-assertion.ts';
import {
  compareInventorySourceOrdering,
  inventorySourceAssertionsClaimSameIdentityOrRevision,
  inventorySourceAssertionsHaveSameMaterialContent,
  inventorySourceAssertionsShareStream,
} from './inventory-source-ordering.ts';
import { StockQuantitySchema } from './stock-position.ts';
import { InventorySourceConflictRefSchema } from '../resources/inventory-source-conflict.ts';

const reason = Schema.String.check(Schema.isTrimmed(), Schema.isMinLength(1), Schema.isMaxLength(300));
export const InventorySourceImportActionInvocationIdSchema = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand('ActionInvocationId'),
);
export type InventorySourceImportActionInvocationId = typeof InventorySourceImportActionInvocationIdSchema.Type;

export const AcceptedInventorySourceImportOutcomeSchema = Schema.Struct({
  assertionId: InventorySourceAssertionIdSchema,
  postEffectOnHand: StockQuantitySchema,
  status: Schema.Literal('ACCEPTED'),
});
export const DuplicateInventorySourceImportOutcomeSchema = Schema.Struct({
  assertionId: InventorySourceAssertionIdSchema,
  duplicateOfAssertionId: InventorySourceAssertionIdSchema,
  reason,
  status: Schema.Literal('DUPLICATE'),
});
export const StaleInventorySourceImportOutcomeSchema = Schema.Struct({
  assertionId: InventorySourceAssertionIdSchema,
  currentAssertionId: Schema.optionalKey(InventorySourceAssertionIdSchema),
  reason,
  status: Schema.Literal('STALE'),
});
export const RejectedInventorySourceImportOutcomeSchema = Schema.Struct({
  assertionId: InventorySourceAssertionIdSchema,
  reason,
  status: Schema.Literal('REJECTED'),
});
export const ReconciliationIndeterminateInventorySourceImportOutcomeSchema = Schema.Struct({
  assertionId: InventorySourceAssertionIdSchema,
  reason: reason.check(
    Schema.makeFilter((value) =>
      value === 'INVENTORY_SOURCE_CONFLICT'
        ? 'Inventory Source Conflict outcomes require exact conflict refs'
        : undefined,
    ),
  ),
  reconciliationRequired: Schema.Literal(true),
  status: Schema.Literal('INDETERMINATE'),
});
export const ConflictIndeterminateInventorySourceImportOutcomeSchema = Schema.Struct({
  assertionId: InventorySourceAssertionIdSchema,
  conflictRefs: Schema.Array(InventorySourceConflictRefSchema).check(Schema.isMinLength(1)),
  reason: Schema.Literal('INVENTORY_SOURCE_CONFLICT'),
  reconciliationRequired: Schema.Literal(true),
  status: Schema.Literal('INDETERMINATE'),
});
export const IndeterminateInventorySourceImportOutcomeSchema = Schema.Union([
  ReconciliationIndeterminateInventorySourceImportOutcomeSchema,
  ConflictIndeterminateInventorySourceImportOutcomeSchema,
]);

export const InventorySourceImportOutcomeSchema = Schema.Union([
  AcceptedInventorySourceImportOutcomeSchema,
  DuplicateInventorySourceImportOutcomeSchema,
  StaleInventorySourceImportOutcomeSchema,
  RejectedInventorySourceImportOutcomeSchema,
  IndeterminateInventorySourceImportOutcomeSchema,
]);
export type InventorySourceImportOutcome = typeof InventorySourceImportOutcomeSchema.Type;

export const InventorySourceImportLedgerEntrySchema = Schema.Struct({
  actionInvocationId: InventorySourceImportActionInvocationIdSchema,
  itemIndex: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  outcome: InventorySourceImportOutcomeSchema,
  proposal: InventorySourceAssertionProposalSchema,
});
export type InventorySourceImportLedgerEntry = typeof InventorySourceImportLedgerEntrySchema.Type;

export class InventorySourceImportUnavailable extends Schema.TaggedError<InventorySourceImportUnavailable>()(
  'InventorySourceImportUnavailable',
  {
    code: Schema.Literal('inventory_source_import_unavailable'),
    reason: Schema.Literal('Inventory Source Import persistence is temporarily unavailable'),
    retryable: Schema.Literal(true),
  },
) {}

export interface InventorySourceImportLedgerPersistence {
  readonly append: (
    entry: InventorySourceImportLedgerEntry,
  ) => EffectType.Effect<InventorySourceImportLedgerEntry, InventorySourceImportUnavailable>;
  readonly findByInvocationItem: (
    actionInvocationId: InventorySourceImportActionInvocationId,
    itemIndex: number,
  ) => EffectType.Effect<Option.Option<InventorySourceImportLedgerEntry>, InventorySourceImportUnavailable>;
  readonly lockAndReadAcceptedHistory: (
    proposal: InventorySourceAssertionProposal,
  ) => EffectType.Effect<readonly InventorySourceImportLedgerEntry[], InventorySourceImportUnavailable>;
}

export const InventorySourceImportPreflightDecisionSchema = Schema.Union([
  Schema.Struct({ status: Schema.Literal('CANDIDATE') }),
  DuplicateInventorySourceImportOutcomeSchema,
  StaleInventorySourceImportOutcomeSchema,
  IndeterminateInventorySourceImportOutcomeSchema,
]);
export type InventorySourceImportPreflightDecision = typeof InventorySourceImportPreflightDecisionSchema.Type;

/**
 * Classifies against durable accepted evidence. Non-accepted history is explanatory evidence only
 * and never becomes the ordering head.
 */
export const classifyInventorySourceImport = (input: {
  readonly acceptedHistory: readonly InventorySourceImportLedgerEntry[];
  readonly proposal: InventorySourceAssertionProposal;
}): InventorySourceImportPreflightDecision => {
  const accepted = input.acceptedHistory.filter(
    (entry) =>
      entry.outcome.status === 'ACCEPTED' && inventorySourceAssertionsShareStream(input.proposal, entry.proposal),
  );
  for (const entry of accepted) {
    if (!inventorySourceAssertionsClaimSameIdentityOrRevision(input.proposal, entry.proposal)) {
      continue;
    }
    return inventorySourceAssertionsHaveSameMaterialContent(input.proposal, entry.proposal)
      ? {
          assertionId: input.proposal.assertionId,
          duplicateOfAssertionId: entry.proposal.assertionId,
          reason: 'The same source identity or revision with identical material content was already accepted',
          status: 'DUPLICATE',
        }
      : {
          assertionId: input.proposal.assertionId,
          reason: 'The same source identity or revision carries different material business content',
          reconciliationRequired: true,
          status: 'INDETERMINATE',
        };
  }
  for (const entry of accepted) {
    const relation = compareInventorySourceOrdering(input.proposal.orderingEvidence, entry.proposal.orderingEvidence);
    if (relation === 'INCOMPARABLE') {
      return {
        assertionId: input.proposal.assertionId,
        reason: 'Owner evidence cannot establish an order relative to accepted source evidence',
        reconciliationRequired: true,
        status: 'INDETERMINATE',
      };
    }
    if (relation === 'OLDER') {
      return {
        assertionId: input.proposal.assertionId,
        currentAssertionId: entry.proposal.assertionId,
        reason: 'Owner ordering evidence proves that a newer source assertion is already accepted',
        status: 'STALE',
      };
    }
  }
  return { status: 'CANDIDATE' };
};
