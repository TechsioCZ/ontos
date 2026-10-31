import type { OperationalScope, ScopedTransactionExecutor } from '@app/core-runtime';
import type { PricingMaterialEvidenceReady } from '@app/pricing-contracts/domain/material-evidence';
import type { PricingInstantSchema } from '@app/pricing-contracts/domain/currency-support';
import { Effect } from 'effect';
import type { PricingOwnerMaterialEvidenceFenceGatewayUnavailable } from './material-evidence-owner-final-fence.ts';
import type { PricingMaterialEvidenceOwnerFenceFailure } from '../services/material-evidence-final-validation.service.ts';
import { preparedPricingOwnerEvidenceChecks } from '../services/material-evidence-final-validation.service.ts';
import { pricingCurrentDecisionPricingOwnerFinalFenceGatewayForScope } from './current-pricing-decision-owner-final-fence.ts';

type PricingInstant = typeof PricingInstantSchema.Type;

/** Final Action fence for owner facts already read during released-connection preparation. */
export const revalidatePreparedPricingOwnerEvidence = Effect.fn('PricingMaterialEvidence.revalidatePreparedOwner')(
  function* revalidatePreparedOwner(
    transaction: ScopedTransactionExecutor,
    admission: {
      readonly compositionRevision: string;
      readonly material: PricingMaterialEvidenceReady;
      readonly now: PricingInstant;
      readonly scope: OperationalScope;
    },
  ): Effect.fn.Return<
    void,
    | PricingMaterialEvidenceOwnerFenceFailure
    | PricingOwnerMaterialEvidenceFenceGatewayUnavailable
    | Effect.Error<ReturnType<typeof pricingCurrentDecisionPricingOwnerFinalFenceGatewayForScope>>
  > {
    const { compositionRevision, material, now, scope } = admission;
    const gateway = yield* pricingCurrentDecisionPricingOwnerFinalFenceGatewayForScope(
      transaction,
      scope,
      compositionRevision,
    );
    const {
      collectSourceEvidence,
      observationMatchesExpectation,
      sameFacts,
      unverifiable,
      verifiedExpectations,
      verifiedTypedAuthority,
    } = preparedPricingOwnerEvidenceChecks;
    const typed = yield* verifiedTypedAuthority(material.candidateRef, material.sourceEvidence);
    const equivalences = typed.sources.flatMap((source) =>
      'sourceEvidence' in source && source.verificationMaterial.kind === 'CATALOG_EQUIVALENCE_AUTHORITY'
        ? [source.sourceEvidence]
        : [],
    );
    const expectations = yield* verifiedExpectations(
      material.candidateRef,
      [...collectSourceEvidence(material.sourceEvidence), ...equivalences],
      typed,
    );
    // A known future boundary from any owner must not be crossed while waiting for SQL admission.
    if (
      now < material.validatedAt ||
      expectations.some((source) => source.nextMaterialBoundary !== undefined && now >= source.nextMaterialBoundary)
    ) {
      return yield* unverifiable(
        material.candidateRef,
        'Prepared material evidence crossed its validity boundary',
        true,
      );
    }
    const local = expectations.filter((source) => source.ownerModuleId === 'commerce.pricing');
    const typedSources = typed.sources.filter(
      (source) =>
        'sourceEvidence' in source && source.sourceEvidence.request.ownerScope.ownerModuleId === 'commerce.pricing',
    );
    const { sources: _allSources, ...verificationContext } = typed;
    const observed = yield* gateway.verifyOpaqueProofsAgainstCurrentState({
      candidateRef: material.candidateRef,
      compositionRevision,
      sources: local,
      typedSources,
      verificationContext,
    });
    if (
      observed.observations.length !== local.length ||
      local.some((expected) => {
        const current = observed.observations.find(
          (item) => item.evidenceVerificationRef === expected.evidenceVerificationRef,
        );
        return current === undefined || !observationMatchesExpectation(expected, current, observed.completedAt);
      })
    ) {
      return yield* unverifiable(material.candidateRef, 'Pricing owner facts changed during remote preparation', true);
    }
    const confirmed = yield* gateway.confirmObservedGenerationsThrough({
      candidateRef: material.candidateRef,
      compositionRevision,
      observations: observed.observations,
      through: observed.completedAt,
      typedSources,
      verificationContext,
    });
    if (
      confirmed.verifiedThrough !== observed.completedAt ||
      confirmed.confirmations.length !== local.length ||
      new Set(confirmed.confirmations.map((item) => item.evidenceVerificationRef)).size !== local.length ||
      confirmed.confirmations.some(
        (item) =>
          item.currentInvalidationGenerationRef !== item.evidenceInvalidationGenerationRef ||
          !observed.observations.some(
            (observation) =>
              observation.evidenceVerificationRef === item.evidenceVerificationRef &&
              observation.currentOwnerSetRevisionRef === item.currentOwnerSetRevisionRef &&
              sameFacts(observation.currentFacts, item.currentFacts),
          ),
      )
    ) {
      return yield* unverifiable(
        material.candidateRef,
        'Pricing owner generation changed during final admission',
        true,
      );
    }
    return yield* Effect.void;
  },
);
