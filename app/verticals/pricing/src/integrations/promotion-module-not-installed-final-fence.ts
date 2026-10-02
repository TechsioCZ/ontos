import type {
  ActiveApplicationCompositionServiceContract,
  ActiveApplicationCompositionSnapshot,
} from '@app/core-runtime';
import { ActiveApplicationCompositionService } from '@app/core-runtime';
import { DateTime, Effect, Layer } from 'effect';

import {
  PricingOwnerMaterialEvidenceFenceGatewayUnavailable,
  PricingPromotionMaterialEvidenceFenceGateway,
} from './material-evidence-owner-final-fence.ts';
import type { PricingOwnerMaterialEvidenceFenceGateway } from './material-evidence-owner-final-fence.ts';

const PROMOTION_MODULE_ID = 'commerce.promotion';

const unavailable = (reason: string, cause?: unknown) => {
  const failure = new PricingOwnerMaterialEvidenceFenceGatewayUnavailable({
    ownerModuleId: PROMOTION_MODULE_ID,
    reason,
    retryable: true,
  });
  return cause === undefined
    ? failure
    : Object.defineProperty(failure, 'cause', { configurable: true, enumerable: false, value: cause });
};

const assertModuleAbsentAt = (
  snapshot: ActiveApplicationCompositionSnapshot,
  instant: string,
): Effect.Effect<ActiveApplicationCompositionSnapshot, PricingOwnerMaterialEvidenceFenceGatewayUnavailable> => {
  const checkedAt = DateTime.makeUnsafe(instant);
  if (
    DateTime.toEpochMillis(snapshot.observedAt) > DateTime.toEpochMillis(checkedAt) ||
    DateTime.toEpochMillis(checkedAt) >= DateTime.toEpochMillis(snapshot.validUntil)
  ) {
    return Effect.fail(
      unavailable('Active Application Composition evidence is not Current through the Promotion final-fence instant'),
    );
  }
  if (snapshot.composition.modules.some(({ moduleId }) => moduleId === PROMOTION_MODULE_ID)) {
    return Effect.fail(
      unavailable(
        'Promotion is installed, but no published Promotion owner endpoint can replay contribution proofs and confirm its generation',
      ),
    );
  }
  return Effect.succeed(snapshot);
};

const loadAbsentModuleProof = (load: ActiveApplicationCompositionServiceContract['load'], instant: string) =>
  load.pipe(
    Effect.mapError((cause) =>
      unavailable('Authoritative active Application Composition evidence for Promotion is unavailable', cause),
    ),
    Effect.flatMap((snapshot) => assertModuleAbsentAt(snapshot, instant)),
  );

/**
 * Authorizes only the source-free Promotion path, and only while the governed active composition
 * proves that Promotion is not installed. It never interprets a missing client or missing source as
 * owner-proven campaign absence. Once Promotion is installed, PARK #894 must supply its published
 * proof-replay and generation-confirmation client before Pricing can publish a selected result.
 */
export const makePromotionModuleNotInstalledFinalFenceGateway = (
  load: ActiveApplicationCompositionServiceContract['load'],
): PricingOwnerMaterialEvidenceFenceGateway => ({
  confirmObservedGenerationsThrough: Effect.fn(
    'PromotionModuleNotInstalledFinalFence.confirmObservedGenerationsThrough',
  )(function* confirmPromotionModuleAbsence({ observations, through, typedSources }) {
    if (observations.length !== 0 || (typedSources !== undefined && typedSources.length !== 0)) {
      return yield* unavailable(
        'Application Composition cannot confirm selected Promotion owner evidence or its generation',
      );
    }
    const snapshot = yield* loadAbsentModuleProof(load, through);
    return {
      confirmations: [],
      verifiedThrough: DateTime.formatIso(DateTime.subtract(snapshot.validUntil, { milliseconds: 1 })),
    };
  }),
  verifyOpaqueProofsAgainstCurrentState: Effect.fn(
    'PromotionModuleNotInstalledFinalFence.verifyOpaqueProofsAgainstCurrentState',
  )(function* verifyPromotionModuleAbsence({ sources, typedSources, verificationContext }) {
    if (sources.length !== 0 || (typedSources !== undefined && typedSources.length !== 0)) {
      return yield* unavailable('Application Composition cannot verify selected Promotion contribution proof material');
    }
    if (verificationContext === undefined) {
      return yield* unavailable(
        'Exact candidate evaluation context is required for Promotion module-absence verification',
      );
    }
    const snapshot = yield* loadAbsentModuleProof(load, verificationContext.evaluatedAt);
    return {
      completedAt: DateTime.formatIso(snapshot.observedAt),
      observations: [],
    };
  }),
});

export const promotionModuleNotInstalledFinalFenceLive = Layer.effect(
  PricingPromotionMaterialEvidenceFenceGateway,
  ActiveApplicationCompositionService.pipe(
    Effect.map(({ load }) => makePromotionModuleNotInstalledFinalFenceGateway(load)),
  ),
);
