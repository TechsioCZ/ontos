import { defineScopedRoutine } from '@app/core-runtime';
import type { OperationalScope, ReadServiceFactory, ScopedRoutineInvocationError } from '@app/core-runtime';
import { PricingInstantSchema } from '@app/pricing-contracts/domain/currency-support';
import type { PricingMaterialEvidenceFenceSource } from '@app/pricing-contracts/domain/material-evidence';
import { Effect, Match, Option, Schema } from 'effect';

import { PricingOwnerMaterialEvidenceFenceGatewayUnavailable } from '../integrations/material-evidence-owner-final-fence.ts';
import type { PricingCurrentDecisionResolvedOriginalProof } from '../integrations/current-pricing-decision-owner-final-fence.ts';
import type { PricingMaterialEvidenceFenceExpectation } from './material-evidence-final-validation.service.ts';

type PricingSetBackedFenceSource = Extract<PricingMaterialEvidenceFenceSource, { readonly sourceEvidence: unknown }>;

const PricingMaterialProofRowSchema = Schema.Struct({ payload: Schema.Unknown });
const PricingMaterialProofOutcomeSchema = Schema.Struct({
  currentFacts: Schema.Array(
    Schema.Struct({
      factRef: Schema.String,
      factRevisionRef: Schema.String,
      verificationRef: Schema.String,
    }),
  ),
  evidenceInvalidationGeneration: Schema.Int.check(Schema.isBetween({ maximum: Number.MAX_SAFE_INTEGER, minimum: 0 })),
  evidenceVerificationRef: Schema.String,
  observedAt: PricingInstantSchema,
  outcome: Schema.Literal('PRICING_MATERIAL_PROOF_RESOLVED'),
  ownerRootRef: Schema.String,
  ownerSetRevisionRef: Schema.String,
  predicateRef: Schema.String,
});

export const resolvePricingMaterialProofRoutine = defineScopedRoutine({
  name: 'resolve_material_proof_v1',
  ownerModuleKey: 'commerce.pricing',
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    { source: 'legalEntityId', type: 'uuid' },
    { source: 'input', type: 'jsonb' },
  ],
  resultSchema: PricingMaterialProofRowSchema,
  routineKey: 'pricing.resolve-material-proof-v1',
  schema: 'pricing',
});

export interface MaterialEvidenceProofPersistence {
  readonly resolveOriginalProof: (request: {
    readonly expected: PricingMaterialEvidenceFenceExpectation;
    readonly source: PricingSetBackedFenceSource;
  }) => Effect.Effect<PricingCurrentDecisionResolvedOriginalProof, PricingOwnerMaterialEvidenceFenceGatewayUnavailable>;
}

const PRICING_OWNER = 'commerce.pricing' as const;

const unavailable = (reason: string, cause?: unknown): PricingOwnerMaterialEvidenceFenceGatewayUnavailable => {
  const failure = new PricingOwnerMaterialEvidenceFenceGatewayUnavailable({
    ownerModuleId: PRICING_OWNER,
    reason,
    retryable: true,
  });
  if (cause !== undefined) {
    Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
  }
  return failure;
};

type ScopedTransaction = Pick<Parameters<ReadServiceFactory<Readonly<Record<string, never>>>>[0], 'invoke'>;

interface MaterialProofFact {
  readonly factRef: string;
  readonly factRevisionRef: string;
  readonly verificationRef: string;
}

const stableFacts = (facts: readonly MaterialProofFact[]): readonly MaterialProofFact[] =>
  facts.toSorted((left, right) =>
    `${left.factRef}\u0000${left.factRevisionRef}\u0000${left.verificationRef}`.localeCompare(
      `${right.factRef}\u0000${right.factRevisionRef}\u0000${right.verificationRef}`,
    ),
  );

const sameFacts = (left: readonly MaterialProofFact[], right: readonly MaterialProofFact[]): boolean => {
  const stableLeft = stableFacts(left);
  const stableRight = stableFacts(right);
  return (
    stableLeft.length === stableRight.length &&
    stableLeft.every((fact, index) => {
      const candidate = stableRight[index];
      return (
        candidate !== undefined &&
        fact.factRef === candidate.factRef &&
        fact.factRevisionRef === candidate.factRevisionRef &&
        fact.verificationRef === candidate.verificationRef
      );
    })
  );
};

const proofResolutionInput = (source: PricingSetBackedFenceSource) =>
  Match.value(source.verificationMaterial).pipe(
    Match.when({ kind: 'PRICING_PRICE_AUTHORITY' }, (material) => ({
      family: 'PRICE' as const,
      legalEntityId: material.lookupRequest.exactKey.commercialScope.sellingLegalEntityId,
      ownerReadReceipt: material.ownerReadReceipt,
      query: material.lookupRequest,
    })),
    Match.when({ kind: 'PRICING_COMMERCIAL_FEE_AUTHORITY' }, (material) => ({
      family: 'COMMERCIAL_FEE' as const,
      legalEntityId: material.currentSet.commercialScope.sellingLegalEntityId,
      ownerReadReceipt: material.ownerReadReceipt,
      query: {
        commercialScope: material.currentSet.commercialScope,
        currencyCode: material.currentSet.currencyCode,
        effectiveAt: source.sourceEvidence.completeness.temporal.effectiveAt,
        target: material.currentSet.target,
      },
    })),
    Match.when({ kind: 'PRICING_ZERO_FLOOR_AUTHORITY' }, (material) => ({
      family: 'ZERO_FLOOR' as const,
      legalEntityId: material.query.commercialScope.sellingLegalEntityId,
      ownerReadReceipt: material.ownerReadReceipt,
      query: material.query,
    })),
    Match.orElse(() => null),
  );

const retainedSourceFacts = (source: PricingSetBackedFenceSource): readonly MaterialProofFact[] =>
  Match.value(source.sourceEvidence).pipe(
    Match.tag('VERIFIED_PRESENT', ({ currentFacts }) =>
      currentFacts.map(({ factRef, factRevisionRef, verification }) => ({
        factRef,
        factRevisionRef,
        verificationRef: verification.verificationRef,
      })),
    ),
    Match.tag('VERIFIED_ABSENT', () => []),
    Match.exhaustive,
  );

type ProofResolutionInput = NonNullable<ReturnType<typeof proofResolutionInput>>;

const requestIsOwnerBound = (
  expected: PricingMaterialEvidenceFenceExpectation,
  source: PricingSetBackedFenceSource,
  input: ProofResolutionInput,
  scope: OperationalScope,
): boolean => {
  const sourceProof = source.sourceEvidence.completeness;
  const { authority } = input.ownerReadReceipt;
  return (
    scope.tenantId === expected.tenantId &&
    scope.legalEntityId === input.legalEntityId &&
    expected.ownerModuleId === PRICING_OWNER &&
    expected.tenantId === source.sourceEvidence.request.ownerScope.tenantId &&
    expected.family === input.family &&
    expected.ownerRootRef === source.sourceEvidence.request.ownerScope.ownerRootRef &&
    expected.predicateRef === source.sourceEvidence.request.ownerScope.predicateRef &&
    expected.ownerSetRevisionRef === sourceProof.ownerSetRevisionRef &&
    expected.evidenceObservedAt === sourceProof.temporal.observedAt &&
    expected.evidenceVerificationRef === sourceProof.verification.verificationRef &&
    expected.evidenceVerificationRef === authority.verificationRef &&
    expected.evidenceObservedAt === authority.observedAt &&
    expected.ownerRootRef === authority.ownerRootRef &&
    expected.ownerSetRevisionRef === authority.ownerRevision &&
    expected.predicateRef === authority.predicateRef &&
    expected.currentFacts.every((fact) => fact.verificationRef === expected.evidenceVerificationRef) &&
    sameFacts(expected.currentFacts, retainedSourceFacts(source)) &&
    sameFacts(expected.currentFacts, input.ownerReadReceipt.factProofs)
  );
};

const resolvedProofMatches = (
  proof: typeof PricingMaterialProofOutcomeSchema.Type,
  expected: PricingMaterialEvidenceFenceExpectation,
  input: ProofResolutionInput,
): boolean =>
  proof.evidenceVerificationRef === expected.evidenceVerificationRef &&
  proof.observedAt === expected.evidenceObservedAt &&
  proof.ownerRootRef === expected.ownerRootRef &&
  proof.ownerSetRevisionRef === expected.ownerSetRevisionRef &&
  proof.predicateRef === expected.predicateRef &&
  proof.evidenceInvalidationGeneration === input.ownerReadReceipt.authority.generation &&
  sameFacts(proof.currentFacts, expected.currentFacts);

/** The transaction is supplied by the governed Pricing read scope. */
export const materialEvidenceProofPersistenceForScope = (
  transaction: ScopedTransaction,
  scope: OperationalScope,
): Effect.Effect<MaterialEvidenceProofPersistence> =>
  Effect.succeed({
    resolveOriginalProof: ({ expected, source }) => {
      const input = proofResolutionInput(source);
      if (input === null || !requestIsOwnerBound(expected, source, input, scope)) {
        return Effect.fail(unavailable('Original Pricing material proof request is not owner bound'));
      }
      return transaction
        .invoke(resolvePricingMaterialProofRoutine, [
          {
            evidenceObservedAt: expected.evidenceObservedAt,
            evidenceVerificationRef: expected.evidenceVerificationRef,
            expectedFacts: expected.currentFacts,
            family: input.family,
            ownerRootRef: expected.ownerRootRef,
            ownerSetRevisionRef: expected.ownerSetRevisionRef,
            predicateRef: expected.predicateRef,
            query: input.query,
          },
        ])
        .pipe(
          Effect.mapError((cause: ScopedRoutineInvocationError) =>
            unavailable('Pricing original material proof could not be resolved', cause),
          ),
          Effect.flatMap((rows) => {
            const [row] = rows;
            const result =
              rows.length === 1 && row !== undefined
                ? Schema.decodeUnknownOption(PricingMaterialProofOutcomeSchema)(row.payload)
                : Option.none();
            if (Option.isNone(result)) {
              return Effect.fail(unavailable('Pricing original material proof is absent or ambiguous'));
            }
            const proof = result.value;
            return resolvedProofMatches(proof, expected, input)
              ? Effect.succeed(proof)
              : Effect.fail(unavailable('Pricing original material proof does not match the retained owner receipt'));
          }),
          Effect.map(({ outcome: _outcome, ...proof }) => proof),
        );
    },
  });
