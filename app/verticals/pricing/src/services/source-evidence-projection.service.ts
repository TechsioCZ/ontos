import type { PricingCommercialTotalSafeProjection } from '@app/pricing-contracts/domain/commercial-total';
import type { PricingMaterialEvidenceReady } from '@app/pricing-contracts/domain/material-evidence';
import { PricingMaterialEvidenceReadySchema } from '@app/pricing-contracts/domain/material-evidence';
import {
  PricingSourceEvidenceVerifiedAbsentSchema,
  PricingSourceEvidenceVerifiedPresentSchema,
} from '@app/pricing-contracts/domain/source-revision-evidence';
import { Effect, Schema } from 'effect';

import type { PricingCommercialTotalProjectionUnverifiable } from './commercial-total-projection.service.ts';
import {
  PricingCommercialTotalProjectionUnverifiable as CommercialTotalProjectionUnverifiable,
  projectPricingCommercialTotal,
} from './commercial-total-projection.service.ts';

export interface PricingAuthorizedInternalEvidenceHandoff {
  readonly materialEvidence: PricingMaterialEvidenceReady;
  readonly visibility: 'AUTHORIZED_INTERNAL';
}

export class PricingSourceEvidenceProjectionUnverifiable extends Schema.TaggedError<PricingSourceEvidenceProjectionUnverifiable>()(
  'PricingSourceEvidenceProjectionUnverifiable',
  {
    reason: Schema.String,
    retryable: Schema.Boolean,
  },
) {}

const unverifiable = (reason: string, cause?: unknown): PricingSourceEvidenceProjectionUnverifiable => {
  const failure = new PricingSourceEvidenceProjectionUnverifiable({ reason, retryable: true });
  return cause === undefined ? failure : Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
};

const customerProjectionUnverifiable = (cause: unknown): PricingCommercialTotalProjectionUnverifiable =>
  Object.defineProperty(
    new CommercialTotalProjectionUnverifiable({
      code: 'PROJECTION_UNVERIFIABLE',
      reason: 'The canonical Pricing material evidence cannot be published as a safe customer projection',
      retryable: true,
    }),
    'cause',
    { configurable: true, value: cause },
  );

const hasOnlyVerifiedSourceEvidence = (materialEvidence: PricingMaterialEvidenceReady): boolean => {
  const evidence = [
    materialEvidence.sourceEvidence.currencySupport,
    ...(materialEvidence.sourceEvidence.wholePurchase.contractualDiscounts.kind === 'DISCOUNT_SELECTED'
      ? [materialEvidence.sourceEvidence.wholePurchase.contractualDiscounts.sourceEvidence]
      : []),
    ...materialEvidence.sourceEvidence.lines.flatMap((line) => [
      line.commercialFees,
      ...(line.lineDiscounts.kind === 'DISCOUNT_SELECTED' ? [line.lineDiscounts.sourceEvidence] : []),
      line.pricePath.usedPrice,
      line.quantityTiers,
      ...(line.pricePath.assignedGroupAbsence === undefined ? [] : [line.pricePath.assignedGroupAbsence]),
      ...(line.zeroFloor === undefined ? [] : [line.zeroFloor]),
    ]),
  ];
  return evidence.every(
    (result) =>
      Schema.is(PricingSourceEvidenceVerifiedPresentSchema)(result) ||
      Schema.is(PricingSourceEvidenceVerifiedAbsentSchema)(result),
  );
};

/**
 * Owner-local handoff for a caller whose internal-evidence permission has already been established.
 * There is deliberately no caller-controlled visibility switch: customer callers use the separate
 * allowlist projection below, while this path retains the complete validated material aggregate.
 */
export const handoffPricingSourceEvidenceToAuthorizedInternalConsumer = Effect.fn(
  'PricingSourceEvidenceProjection.handoffAuthorizedInternal',
)(function* handoffPricingSourceEvidenceToAuthorizedInternalConsumerProgram(
  input: PricingMaterialEvidenceReady,
): Effect.fn.Return<PricingAuthorizedInternalEvidenceHandoff, PricingSourceEvidenceProjectionUnverifiable> {
  const materialEvidence = yield* Schema.decodeEffect(PricingMaterialEvidenceReadySchema, {
    onExcessProperty: 'error',
  })(input).pipe(
    Effect.mapError((cause) =>
      unverifiable('Internal evidence handoff requires one complete owner-validated material evidence result', cause),
    ),
  );

  if (!hasOnlyVerifiedSourceEvidence(materialEvidence)) {
    return yield* unverifiable(
      'A ready internal handoff cannot contain missing, conflicting, or unverifiable source evidence',
    );
  }

  return { materialEvidence, visibility: 'AUTHORIZED_INTERNAL' };
});

/** Customer output is a fixed allowlist over the canonical aggregate; every source proof is omitted. */
export const projectPricingMaterialEvidenceForCustomer = Effect.fn('PricingSourceEvidenceProjection.projectCustomer')(
  function* projectPricingMaterialEvidenceForCustomerProgram(
    result: PricingMaterialEvidenceReady,
  ): Effect.fn.Return<PricingCommercialTotalSafeProjection, PricingCommercialTotalProjectionUnverifiable> {
    const materialEvidence = yield* Schema.decodeEffect(PricingMaterialEvidenceReadySchema, {
      onExcessProperty: 'error',
    })(result).pipe(Effect.mapError(customerProjectionUnverifiable));
    if (!hasOnlyVerifiedSourceEvidence(materialEvidence)) {
      return yield* customerProjectionUnverifiable('Material source evidence is not verified');
    }
    return yield* projectPricingCommercialTotal(materialEvidence.sourceEvidence.commercialTotal);
  },
);
