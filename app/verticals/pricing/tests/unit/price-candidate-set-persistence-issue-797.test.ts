import { scopedRoutineInvokerFromTransaction, TrustedPrincipalContextSchema } from '@app/core-runtime';
import type { OperationalScope } from '@app/core-runtime';
import { PgTypes } from '@effect/sql-pg';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  ExactPriceCandidateSetAuthoritySchema,
  PriceActionResultLookupOutcomeSchema,
  PricePersistenceUnavailable,
  ReadExactPriceCandidateSetPersistenceOutcomeSchema,
  VerifyExactPriceCandidateSetGenerationPersistenceOutcomeSchema,
  pricePersistenceForScope,
  lookupPriceActionResultRoutine,
  readExactPriceCandidateSetRoutine,
  verifyExactPriceCandidateSetGenerationRoutine,
} from '../../src/services/price-persistence.service.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const legalEntityId = '22222222-2222-4222-8222-222222222222';
const effectiveAt = '2026-09-28T10:00:00.000Z';
const observedAt = '2026-09-28T10:00:00.050Z';
const scope: OperationalScope = {
  ...Schema.decodeSync(TrustedPrincipalContextSchema)({
    authBindingId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    authContextRef: 'better-auth-session:price-candidate-set',
    authMethod: 'session',
    legalEntityId,
    principalId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    tenantId,
  }),
  correlationId: 'price-candidate-set-persistence',
};

const catalogRef = <const ResourceType extends string>(resourceId: string, resourceType: ResourceType) => ({
  moduleId: 'commerce.catalog' as const,
  resourceId,
  resourceType,
  tenantId,
});

const priceGroupRef = {
  moduleId: 'pricing.price-group-catalog' as const,
  resourceId: '33333333-3333-4333-8333-333333333333',
  resourceType: 'pricing.price-group-catalog.price-group' as const,
  tenantId,
};

const exactKey = {
  catalogSelection: {
    productRef: catalogRef('44444444-4444-4444-8444-444444444444', 'commerce.catalog.product'),
    variantRef: catalogRef('55555555-5555-4555-8555-555555555555', 'commerce.catalog.variant'),
  },
  commercialScope: { channelId: 'B2C', marketId: 'CZ', sellingLegalEntityId: legalEntityId },
  currencyCode: 'CZK',
  priceGroupSelector: { kind: 'PRICE_GROUP' as const, priceGroupRef },
  unitBasis: {
    quantity: '1',
    unitRef: catalogRef('66666666-6666-4666-8666-666666666666', 'commerce.catalog.product-unit'),
  },
} as const;

const authority = Schema.decodeSync(ExactPriceCandidateSetAuthoritySchema)({
  generation: 7,
  kind: 'PERSISTENT',
  nextApplicabilityBoundary: '2026-10-01T00:00:00.000Z',
  observedAt,
  ownerRevision: 'price-candidate-set:revision:7',
  ownerRootRef: 'price-candidate-set:root',
  predicateRef: 'price-candidate-set:exact-group-key',
  verificationRef: 'price-candidate-set:verification:7',
});
const virtualEmptyAuthority = Schema.decodeSync(ExactPriceCandidateSetAuthoritySchema)({
  generation: 0,
  kind: 'VIRTUAL_EMPTY',
  nextApplicabilityBoundary: '2026-10-01T00:00:00.000Z',
  observedAt,
  ownerRevision: 'price-candidate-set:virtual-empty:revision:v1',
  ownerRootRef: 'price-candidate-set:virtual-empty:root:v1',
  predicateRef: 'price-candidate-set:exact-group-key',
  verificationRef: 'price-candidate-set:virtual-empty:verification:v1',
});

const claimant = (resourceId: string, revisionId: string, scheduleRevision: number) => ({
  effectivePeriod: { effectiveFrom: '2026-09-01T00:00:00.000Z', effectiveTo: null },
  exactKey,
  priceRef: {
    moduleId: 'commerce.pricing' as const,
    resourceId,
    resourceType: 'commerce.pricing.price' as const,
    tenantId,
  },
  priceRevision: {
    effectiveFrom: '2026-09-01T00:00:00.000Z',
    monetaryAmount: { amount: '100', currencyCode: 'CZK' },
    monetaryBoundary: 'PRE_TAX' as const,
    revision: scheduleRevision,
    revisionId,
  },
  priceScheduleRevisionId: `${resourceId.slice(0, 8)}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`,
  provenanceRefs: [`${resourceId.slice(0, 8)}-bbbb-4bbb-8bbb-bbbbbbbbbbbb`],
  scheduleRevision,
});

const firstClaimant = claimant('77777777-7777-4777-8777-777777777777', '88888888-8888-4888-8888-888888888888', 1);
const secondClaimant = claimant('99999999-9999-4999-8999-999999999999', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 2);

describe('Price exact candidate-set persistence authority (#797)', () => {
  it('declares read-only scoped routines for the candidate set and its generation fence', () => {
    expect(readExactPriceCandidateSetRoutine).toMatchObject({
      name: 'read_exact_price_candidate_set_v1',
      ownerModuleKey: 'commerce.pricing',
      routineKey: 'pricing.read-exact-price-candidate-set-v1',
      schema: 'pricing',
    });
    expect(verifyExactPriceCandidateSetGenerationRoutine).toMatchObject({
      name: 'verify_exact_price_candidate_set_generation_v1',
      ownerModuleKey: 'commerce.pricing',
      routineKey: 'pricing.verify-exact-price-candidate-set-generation-v1',
      schema: 'pricing',
    });
  });

  it('distinguishes virtual-empty and persistent Current candidates, conflicts, and unverifiable state', () => {
    const current = {
      authority,
      candidateSet: { candidates: [firstClaimant], effectiveAt, exactKey },
      factProofs: [
        {
          factRef: firstClaimant.priceRef.resourceId,
          factRevisionRef: firstClaimant.priceRevision.revisionId,
          verificationRef: authority.verificationRef,
        },
      ],
      outcome: 'EXACT_PRICE_CANDIDATE_SET_CURRENT',
    };
    const absence = {
      authority: virtualEmptyAuthority,
      candidateSet: { candidates: [], effectiveAt, exactKey },
      factProofs: [],
      outcome: 'EXACT_PRICE_CANDIDATE_SET_CURRENT',
    };
    const conflict = {
      authority,
      candidateSet: { candidates: [firstClaimant, secondClaimant], effectiveAt, exactKey },
      outcome: 'EXACT_PRICE_CANDIDATE_SET_CONFLICT',
    };

    expect(Schema.is(ReadExactPriceCandidateSetPersistenceOutcomeSchema)(current)).toBe(true);
    expect(Schema.is(ReadExactPriceCandidateSetPersistenceOutcomeSchema)(absence)).toBe(true);
    expect(Schema.is(ReadExactPriceCandidateSetPersistenceOutcomeSchema)(conflict)).toBe(true);
    expect(
      Schema.is(ReadExactPriceCandidateSetPersistenceOutcomeSchema)({
        effectiveAt,
        exactKey,
        outcome: 'EXACT_PRICE_CANDIDATE_SET_UNVERIFIABLE',
        reason: 'owner state could not prove completeness',
      }),
    ).toBe(true);
    expect(
      Schema.is(ReadExactPriceCandidateSetPersistenceOutcomeSchema)({
        ...current,
        candidateSet: { ...current.candidateSet, candidates: [firstClaimant, secondClaimant] },
      }),
    ).toBe(false);
    expect(
      Schema.is(ReadExactPriceCandidateSetPersistenceOutcomeSchema)({
        ...conflict,
        candidateSet: { ...conflict.candidateSet, candidates: [firstClaimant] },
      }),
    ).toBe(false);
    expect(
      Schema.is(ReadExactPriceCandidateSetPersistenceOutcomeSchema)({
        ...absence,
        candidateSet: { ...absence.candidateSet, candidates: [firstClaimant] },
      }),
    ).toBe(false);
    expect(Schema.is(ExactPriceCandidateSetAuthoritySchema)({ ...authority, generation: 0 })).toBe(false);
    expect(Schema.is(ExactPriceCandidateSetAuthoritySchema)({ ...virtualEmptyAuthority, generation: 1 })).toBe(false);
    expect(
      Schema.is(ExactPriceCandidateSetAuthoritySchema)({
        ...authority,
        nextApplicabilityBoundary: authority.observedAt,
      }),
    ).toBe(false);
  });

  it('preserves the complete exact Group selector and rejects a claimant from the no-group key', () => {
    const wrongGroupClaimant = {
      ...firstClaimant,
      exactKey: { ...firstClaimant.exactKey, priceGroupSelector: { kind: 'NO_GROUP' as const } },
    };
    expect(
      Schema.is(ReadExactPriceCandidateSetPersistenceOutcomeSchema)({
        authority,
        candidateSet: { candidates: [wrongGroupClaimant], effectiveAt, exactKey },
        outcome: 'EXACT_PRICE_CANDIDATE_SET_CURRENT',
      }),
    ).toBe(false);
  });

  it.effect('invokes and decodes both owner read routines without introducing a create-on-read path', () =>
    Effect.gen(function* invokesReadRoutines() {
      const readOutcome = {
        authority,
        candidateSet: { candidates: [firstClaimant], effectiveAt, exactKey },
        factProofs: [
          {
            factRef: firstClaimant.priceRef.resourceId,
            factRevisionRef: firstClaimant.priceRevision.revisionId,
            verificationRef: authority.verificationRef,
          },
        ],
        outcome: 'EXACT_PRICE_CANDIDATE_SET_CURRENT' as const,
      };
      const verifyOutcome = {
        authority,
        outcome: 'EXACT_PRICE_CANDIDATE_SET_GENERATION_CURRENT' as const,
        verifiedThrough: '2026-09-28T10:00:01.000Z',
      };
      const payloads: object[] = [readOutcome, verifyOutcome];
      let invocationCount = 0;
      const transaction = scopedRoutineInvokerFromTransaction(
        () => {
          const payload = payloads[invocationCount];
          invocationCount += 1;
          return Effect.succeed(payload === undefined ? [] : [{ payload }]);
        },
        { legalEntityId, tenantId },
      );
      const persistence = yield* pricePersistenceForScope(transaction, scope);
      const readQuery = { effectiveAt, exactKey };
      const verifyQuery = {
        authority,
        effectiveAt,
        exactKey,
        through: verifyOutcome.verifiedThrough,
      };

      expect(yield* persistence.readExactCandidateSet(readQuery)).toEqual(readOutcome);
      expect(yield* persistence.verifyExactCandidateSetGeneration(verifyQuery)).toEqual(verifyOutcome);
      expect(invocationCount).toBe(2);
      expect(Schema.is(VerifyExactPriceCandidateSetGenerationPersistenceOutcomeSchema)(verifyOutcome)).toBe(true);
      expect(
        Schema.is(VerifyExactPriceCandidateSetGenerationPersistenceOutcomeSchema)({
          authority: virtualEmptyAuthority,
          outcome: 'EXACT_PRICE_CANDIDATE_SET_GENERATION_CURRENT',
          verifiedThrough: verifyOutcome.verifiedThrough,
        }),
      ).toBe(true);
      expect(
        Schema.is(VerifyExactPriceCandidateSetGenerationPersistenceOutcomeSchema)({
          outcome: 'EXACT_PRICE_CANDIDATE_SET_GENERATION_CHANGED',
          verifiedThrough: verifyOutcome.verifiedThrough,
        }),
      ).toBe(true);
    }),
  );

  it.effect('looks up the original Price Action result and rejects mismatched or ambiguous receipts', () =>
    Effect.gen(function* verifiesPriceActionResult() {
      const actionInvocationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
      const found = {
        actionInvocationId,
        outcome: 'PRICE_ACTION_RESULT_FOUND' as const,
        result: { outcome: 'EFFECTIVE_TIME_INVALID' as const },
      };
      expect(lookupPriceActionResultRoutine.name).toBe('lookup_price_action_result_v1');
      expect(Schema.is(PriceActionResultLookupOutcomeSchema)(found)).toBe(true);

      for (const rows of [
        [{ payload: { ...found, actionInvocationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' } }],
        [{ payload: found }, { payload: found }],
      ]) {
        const transaction = scopedRoutineInvokerFromTransaction(() => Effect.succeed(rows), {
          legalEntityId,
          tenantId,
        });
        const persistence = yield* pricePersistenceForScope(transaction, scope);
        const failure = yield* persistence.lookupResult({ actionInvocationId }).pipe(Effect.flip);
        expect(Schema.is(PricePersistenceUnavailable)(failure)).toBe(true);
      }

      let statement: SQL | undefined;
      const transaction = scopedRoutineInvokerFromTransaction(
        (candidate) => {
          statement = candidate;
          return Effect.succeed([{ payload: found }]);
        },
        { legalEntityId, tenantId },
      );
      const persistence = yield* pricePersistenceForScope(transaction, scope);
      const spoofedQuery = {
        actingPrincipalId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        actionInvocationId,
      };
      expect(yield* persistence.lookupResult(spoofedQuery)).toEqual(found);
      if (statement === undefined) {
        throw new Error('Price result lookup did not invoke the owner routine');
      }
      const bound = new PgDialect().sqlToQuery(statement);
      expect(bound.params).toEqual([
        tenantId,
        legalEntityId,
        PgTypes.jsonb({ actingPrincipalId: scope.principalId, actionInvocationId }),
      ]);
    }),
  );
});
