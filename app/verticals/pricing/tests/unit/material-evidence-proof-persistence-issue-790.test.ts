import { scopedRoutineInvokerFromTransaction, TrustedPrincipalContextSchema } from '@app/core-runtime';
import type { OperationalScope } from '@app/core-runtime';
import { PricingSetBackedMaterialEvidenceFenceSourceSchema } from '@app/pricing-contracts/domain/material-evidence';
import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  materialEvidenceProofPersistenceForScope,
  resolvePricingMaterialProofRoutine,
} from '../../src/services/material-evidence-proof-persistence.service.ts';
import type { PricingMaterialEvidenceFenceExpectation } from '../../src/services/material-evidence-final-validation.service.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const legalEntityId = '22222222-2222-4222-8222-222222222222';
const observedAt = '2026-09-28T10:00:00.500Z';
const effectiveAt = '2026-09-28T10:00:00.000Z';
const verificationRef = 'commerce.pricing.exact-price-candidate-set-proof:root:revision:7';
const ownerScope = {
  ownerModuleId: 'commerce.pricing',
  ownerRootRef: 'root',
  predicateRef: 'commerce.pricing.exact-price-candidates:root',
  tenantId,
} as const;
const temporal = {
  effectiveAt,
  evaluatedAt: effectiveAt,
  evaluationMode: 'HISTORICAL_AS_OF',
  observedAt,
  requestedAt: '2026-09-28T09:59:59.000Z',
} as const;
const verification = { kind: 'OWNER_VERIFIABLE_OPAQUE_REFERENCE', verificationRef } as const;
const exactKey = {
  catalogSelection: {
    productRef: {
      moduleId: 'commerce.catalog',
      resourceId: '33333333-3333-4333-8333-333333333333',
      resourceType: 'commerce.catalog.product',
      tenantId,
    },
    variantRef: {
      moduleId: 'commerce.catalog',
      resourceId: '44444444-4444-4444-8444-444444444444',
      resourceType: 'commerce.catalog.variant',
      tenantId,
    },
  },
  commercialScope: { channelId: 'B2C', marketId: 'CZ', sellingLegalEntityId: legalEntityId },
  currencyCode: 'CZK',
  priceGroupSelector: { kind: 'NO_GROUP' },
  unitBasis: {
    quantity: '1',
    unitRef: {
      moduleId: 'commerce.catalog',
      resourceId: '55555555-5555-4555-8555-555555555555',
      resourceType: 'commerce.catalog.product-unit',
      tenantId,
    },
  },
} as const;
const source = Schema.decodeSync(PricingSetBackedMaterialEvidenceFenceSourceSchema)({
  sourceEvidence: {
    _tag: 'VERIFIED_PRESENT',
    completeness: {
      completenessEvidence: {
        observedAt,
        ownerRevision: 'revision',
        scope: { kind: 'EXACT_PREDICATE', predicateRef: ownerScope.predicateRef },
      },
      currencyCode: 'CZK',
      family: 'PRICE',
      ownerScope,
      ownerSetRevisionRef: 'revision',
      temporal,
      verification,
    },
    currentFacts: [
      {
        currencyCode: 'CZK',
        effectivePeriod: { effectiveFrom: '2026-09-01T00:00:00.000Z', effectiveTo: null },
        factRef: 'price-a',
        factRevisionRef: 'revision-a',
        family: 'PRICE',
        ownerScope,
        temporal,
        verification,
      },
    ],
    request: {
      currencyCode: 'CZK',
      effectiveAt,
      family: 'PRICE',
      ownerScope,
      requestedAt: temporal.requestedAt,
    },
  },
  verificationMaterial: {
    kind: 'PRICING_PRICE_AUTHORITY',
    lookupRequest: { effectiveAt, exactKey },
    ownerReadReceipt: {
      authority: {
        generation: 7,
        kind: 'PERSISTENT',
        observedAt,
        ownerRevision: 'revision',
        ownerRootRef: ownerScope.ownerRootRef,
        predicateRef: ownerScope.predicateRef,
        verificationRef,
      },
      factProofs: [{ factRef: 'price-a', factRevisionRef: 'revision-a', verificationRef }],
    },
  },
});
const expected: PricingMaterialEvidenceFenceExpectation = {
  currencyCode: 'CZK',
  currentFacts: [{ factRef: 'price-a', factRevisionRef: 'revision-a', verificationRef }],
  evidenceObservedAt: observedAt,
  evidenceVerificationRef: verificationRef,
  family: 'PRICE',
  ownerModuleId: 'commerce.pricing',
  ownerRootRef: 'root',
  ownerSetRevisionRef: 'revision',
  predicateRef: ownerScope.predicateRef,
  tenantId,
};
const scope: OperationalScope = {
  ...Schema.decodeSync(TrustedPrincipalContextSchema)({
    authBindingId: '66666666-6666-4666-8666-666666666666',
    authContextRef: 'session:material-proof',
    authMethod: 'session',
    legalEntityId,
    principalId: '77777777-7777-4777-8777-777777777777',
    tenantId,
  }),
  correlationId: 'material-proof',
};

describe('Pricing durable material proof persistence #790', () => {
  it.effect('passes the exact owner predicate and original references to the governed routine', () =>
    Effect.gen(function* resolvesOriginalProof() {
      const proof = {
        currentFacts: expected.currentFacts,
        evidenceInvalidationGeneration: 7,
        evidenceVerificationRef: verificationRef,
        observedAt,
        outcome: 'PRICING_MATERIAL_PROOF_RESOLVED',
        ownerRootRef: expected.ownerRootRef,
        ownerSetRevisionRef: expected.ownerSetRevisionRef,
        predicateRef: expected.predicateRef,
      };
      let invoked = false;
      const transaction = scopedRoutineInvokerFromTransaction(
        (_sql) => {
          invoked = true;
          return Effect.succeed([{ payload: proof }]);
        },
        { legalEntityId, tenantId },
      );
      const persistence = yield* materialEvidenceProofPersistenceForScope(transaction, scope);
      expect(resolvePricingMaterialProofRoutine.routineKey).toBe('pricing.resolve-material-proof-v1');
      expect(yield* persistence.resolveOriginalProof({ expected, source })).toEqual({
        currentFacts: expected.currentFacts,
        evidenceInvalidationGeneration: 7,
        evidenceVerificationRef: verificationRef,
        observedAt,
        ownerRootRef: expected.ownerRootRef,
        ownerSetRevisionRef: expected.ownerSetRevisionRef,
        predicateRef: expected.predicateRef,
      });
      expect(invoked).toBe(true);
    }),
  );

  it.effect('rejects a fact proof that is not the exact owner set proof before touching persistence', () =>
    Effect.gen(function* rejectsUnboundFact() {
      let invoked = false;
      const transaction = scopedRoutineInvokerFromTransaction(
        () => {
          invoked = true;
          return Effect.succeed([]);
        },
        { legalEntityId, tenantId },
      );
      const persistence = yield* materialEvidenceProofPersistenceForScope(transaction, scope);
      const failure = yield* persistence
        .resolveOriginalProof({
          expected: {
            ...expected,
            currentFacts: expected.currentFacts.map((fact) => ({
              ...fact,
              verificationRef: 'unrelated-fact-proof',
            })),
          },
          source,
        })
        .pipe(Effect.flip);
      expect(failure.reason).toContain('not owner bound');
      expect(invoked).toBe(false);
    }),
  );

  it.effect('rejects retained evidence outside the trusted governed scope before touching persistence', () =>
    Effect.gen(function* rejectsScopeMismatch() {
      let invoked = false;
      const transaction = scopedRoutineInvokerFromTransaction(
        () => {
          invoked = true;
          return Effect.succeed([]);
        },
        { legalEntityId, tenantId },
      );
      const persistence = yield* materialEvidenceProofPersistenceForScope(transaction, {
        ...scope,
        tenantId: '88888888-8888-4888-8888-888888888888',
      });
      const failure = yield* persistence.resolveOriginalProof({ expected, source }).pipe(Effect.flip);
      expect(failure.reason).toContain('not owner bound');
      expect(invoked).toBe(false);
    }),
  );

  it.effect('rejects a decoded routine payload that does not match the retained owner receipt', () =>
    Effect.gen(function* rejectsMismatchedRoutineProof() {
      const transaction = scopedRoutineInvokerFromTransaction(
        () =>
          Effect.succeed([
            {
              payload: {
                currentFacts: expected.currentFacts,
                evidenceInvalidationGeneration: 8,
                evidenceVerificationRef: verificationRef,
                observedAt,
                outcome: 'PRICING_MATERIAL_PROOF_RESOLVED',
                ownerRootRef: expected.ownerRootRef,
                ownerSetRevisionRef: expected.ownerSetRevisionRef,
                predicateRef: expected.predicateRef,
              },
            },
          ]),
        { legalEntityId, tenantId },
      );
      const persistence = yield* materialEvidenceProofPersistenceForScope(transaction, scope);
      const failure = yield* persistence.resolveOriginalProof({ expected, source }).pipe(Effect.flip);
      expect(failure.reason).toContain('does not match the retained owner receipt');
    }),
  );

  it.effect('accepts a stored virtual-empty Price receipt with generation zero and no fabricated facts', () =>
    Effect.gen(function* resolvesVirtualEmptyReceipt() {
      if (source.verificationMaterial.kind !== 'PRICING_PRICE_AUTHORITY') {
        return yield* Effect.die(new Error('Material proof fixture requires exact Price authority'));
      }
      const absentSource = yield* Schema.decodeEffect(PricingSetBackedMaterialEvidenceFenceSourceSchema)({
        sourceEvidence: {
          _tag: 'VERIFIED_ABSENT',
          completeness: source.sourceEvidence.completeness,
          request: source.sourceEvidence.request,
        },
        verificationMaterial: {
          kind: 'PRICING_PRICE_AUTHORITY',
          lookupRequest: source.verificationMaterial.lookupRequest,
          ownerReadReceipt: {
            authority: {
              generation: 0,
              kind: 'VIRTUAL_EMPTY',
              observedAt,
              ownerRevision: expected.ownerSetRevisionRef,
              ownerRootRef: expected.ownerRootRef,
              predicateRef: expected.predicateRef,
              verificationRef,
            },
            factProofs: [],
          },
        },
      });
      const absentExpected: PricingMaterialEvidenceFenceExpectation = {
        ...expected,
        currentFacts: [],
      };
      const transaction = scopedRoutineInvokerFromTransaction(
        () =>
          Effect.succeed([
            {
              payload: {
                currentFacts: [],
                evidenceInvalidationGeneration: 0,
                evidenceVerificationRef: verificationRef,
                observedAt,
                outcome: 'PRICING_MATERIAL_PROOF_RESOLVED',
                ownerRootRef: expected.ownerRootRef,
                ownerSetRevisionRef: expected.ownerSetRevisionRef,
                predicateRef: expected.predicateRef,
              },
            },
          ]),
        { legalEntityId, tenantId },
      );
      const persistence = yield* materialEvidenceProofPersistenceForScope(transaction, scope);
      const resolved = yield* persistence.resolveOriginalProof({ expected: absentExpected, source: absentSource });
      expect(resolved.currentFacts).toEqual([]);
      expect(resolved.evidenceInvalidationGeneration).toBe(0);
      expect(resolved.observedAt).toBe(observedAt);
      return yield* Effect.void;
    }),
  );
});
