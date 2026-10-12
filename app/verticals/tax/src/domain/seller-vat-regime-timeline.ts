import { DateTime, Order, Schema } from 'effect';

import { SellerVatRegimeDeclarationRevisionRefSchema } from '../../shared/domain/tax-kernel/seller-vat-regime.ts';
import type {
  SellerVatRegime,
  SellerVatRegimeDeclarationProvenance,
  SellerVatRegimeSelection,
} from '../../shared/domain/tax-kernel/seller-vat-regime.ts';
import { RevisionSchema } from '../../shared/domain/tax-kernel/tax-domain-primitives.ts';

export {
  SELLER_NOT_VAT_PAYER_LEGAL_BASIS,
  SellerVatRegimeDeclaredSchema,
} from '../../shared/domain/tax-kernel/seller-vat-regime.ts';
export type {
  SellerVatRegime,
  SellerVatRegimeDeclarationRevisionRef,
  SellerVatRegimeSelection,
} from '../../shared/domain/tax-kernel/seller-vat-regime.ts';

/** One append-only declaration revision, pure and storage-shape-free. */
export interface SellerVatRegimeDeclarationRevision {
  readonly effectiveFrom: DateTime.Utc;
  readonly provenance: SellerVatRegimeDeclarationProvenance;
  readonly regime: SellerVatRegime;
  readonly revision: number;
}

const byEffectiveFromThenRevision = Order.combine(
  Order.mapInput(DateTime.Order, (revision: SellerVatRegimeDeclarationRevision) => revision.effectiveFrom),
  Order.mapInput(Order.Number, (revision: SellerVatRegimeDeclarationRevision) => revision.revision),
);

const byRevisionDesc = Order.flip(
  Order.mapInput(Order.Number, (revision: SellerVatRegimeDeclarationRevision) => revision.revision),
);

/**
 * The regime live at an instant: the highest-numbered revision whose `effectiveFrom <= instant`; otherwise
 * NOT_DECLARED. Order-independent over the input array (Unit 10 A1).
 */
export const sellerVatRegimeAt = (
  revisions: readonly SellerVatRegimeDeclarationRevision[],
  instant: DateTime.Utc,
): SellerVatRegimeSelection => {
  const live = revisions.filter((revision) => !DateTime.isGreaterThan(revision.effectiveFrom, instant));
  const [head] = live.toSorted(byRevisionDesc);
  return head === undefined
    ? { _tag: 'NOT_DECLARED' }
    : {
        _tag: 'DECLARED',
        declarationRevisionRef: { revision: head.revision },
        regime: head.regime,
      };
};

/** The highest revision number recorded for the seller, or 0 when nothing is declared. */
export const sellerVatRegimeHead = (revisions: readonly SellerVatRegimeDeclarationRevision[]): number => {
  const [head] = revisions.toSorted(byRevisionDesc);
  return head?.revision ?? 0;
};

/**
 * Revisions whose `effectiveFrom` lies strictly after `effectiveFrom`, excluding any revision already superseded
 * by a later-numbered revision with an earlier-or-equal `effectiveFrom`. These are the revisions a new, earlier
 * declaration would still need to coexist with (Unit 10 A1, F5).
 */
export const liveLaterRevisions = (
  revisions: readonly SellerVatRegimeDeclarationRevision[],
  effectiveFrom: DateTime.Utc,
): readonly SellerVatRegimeDeclarationRevision[] => {
  const later = revisions.filter((revision) => DateTime.isGreaterThan(revision.effectiveFrom, effectiveFrom));
  return later.filter(
    (candidate) =>
      !revisions.some(
        (other) =>
          other.revision > candidate.revision && !DateTime.isGreaterThan(other.effectiveFrom, candidate.effectiveFrom),
      ),
  );
};

export interface SellerVatRegimeDeclarationRequest {
  readonly confirmReplacesScheduled: boolean;
  readonly effectiveFrom: DateTime.Utc;
  readonly expectedCurrentRevision: number;
  readonly reason?: string;
  readonly regime: SellerVatRegime;
}

/** Every outcome of evaluating one declaration request against the seller's revision set (Unit 10 A1, F6). */
export const SellerVatRegimeDeclarationEvaluationSchema = Schema.Union([
  Schema.TaggedStruct('STALE_BASIS', {}),
  Schema.TaggedStruct('REASON_REQUIRED_FOR_BACKDATED_EFFECT', {}),
  Schema.TaggedStruct('SCHEDULED_REVISION_CONFIRMATION_REQUIRED', {
    scheduled: Schema.Array(SellerVatRegimeDeclarationRevisionRefSchema),
  }),
  Schema.TaggedStruct('ACCEPTED', {
    replacesScheduled: Schema.Array(SellerVatRegimeDeclarationRevisionRefSchema),
    revision: RevisionSchema,
  }),
]);
export type SellerVatRegimeDeclarationEvaluation = typeof SellerVatRegimeDeclarationEvaluationSchema.Type;

/**
 * Evaluates one declaration request against the seller's complete revision set, in order: CAS (StaleBasis), the
 * backdating reason requirement, then scheduled-revision confirmation. Rejection detail carries only the opaque
 * revision references a caller needs to confirm, never the full revision record (Unit 10 A1, F6).
 */
export const evaluateSellerVatRegimeDeclaration = ({
  operationTime,
  request,
  revisions,
}: {
  readonly operationTime: DateTime.Utc;
  readonly request: SellerVatRegimeDeclarationRequest;
  readonly revisions: readonly SellerVatRegimeDeclarationRevision[];
}): SellerVatRegimeDeclarationEvaluation => {
  const head = sellerVatRegimeHead(revisions);
  if (request.expectedCurrentRevision !== head) {
    return { _tag: 'STALE_BASIS' };
  }
  const isBackdated = DateTime.isLessThan(request.effectiveFrom, operationTime);
  if (isBackdated && (request.reason === undefined || request.reason.length === 0)) {
    return { _tag: 'REASON_REQUIRED_FOR_BACKDATED_EFFECT' };
  }
  const scheduled = liveLaterRevisions(revisions, request.effectiveFrom)
    .toSorted(byEffectiveFromThenRevision)
    .map(({ revision }) => ({ revision }));
  if (scheduled.length > 0 && !request.confirmReplacesScheduled) {
    return { _tag: 'SCHEDULED_REVISION_CONFIRMATION_REQUIRED', scheduled };
  }
  return { _tag: 'ACCEPTED', replacesScheduled: scheduled, revision: head + 1 };
};
