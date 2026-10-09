import {
  pricingCommercialFeeCurrentSetPredicateRef,
  PricingCommercialFeeCurrentSetSchema,
  PricingCommercialFeeIdentityKeySchema,
} from '@app/pricing-contracts/domain/commercial-fee';
import { scopedRoutineInvokerFromTransaction, TrustedPrincipalContextSchema } from '@app/core-runtime';
import type { OperationalScope } from '@app/core-runtime';
import { PgTypes } from '@effect/sql-pg';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  CommercialFeeSetAuthoritySchema,
  CommercialFeeActionResultLookupOutcomeSchema,
  CommercialFeePersistenceUnavailable,
  ReadCurrentCommercialFeeSetPersistenceOutcomeSchema,
  VerifyCommercialFeeSetGenerationPersistenceOutcomeSchema,
  readCurrentCommercialFeeSetRoutine,
  lookupCommercialFeeActionResultRoutine,
  commercialFeePersistenceForScope,
  verifyCommercialFeeSetGenerationRoutine,
} from '../../src/services/commercial-fee-persistence.service.ts';
import type {
  ReadCurrentCommercialFeeSetPersistenceQuery,
  VerifyCommercialFeeSetGenerationPersistenceQuery,
} from '../../src/services/commercial-fee-persistence.service.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const legalEntityId = '22222222-2222-4222-8222-222222222222';
const scope: OperationalScope = {
  ...Schema.decodeSync(TrustedPrincipalContextSchema)({
    authBindingId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    authContextRef: 'better-auth-session:commercial-fee-set',
    authMethod: 'session',
    legalEntityId,
    principalId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    tenantId,
  }),
  correlationId: 'commercial-fee-set-persistence',
};
const observedAt = '2026-09-28T10:00:00.050Z';
const revalidatedAt = '2026-09-28T10:00:00.075Z';
const through = '2026-09-28T10:00:01.000Z';
const commercialScope = {
  channelId: 'B2C' as const,
  marketId: 'cz-launch',
  sellingLegalEntityId: legalEntityId,
};
const target = {
  variantRef: {
    moduleId: 'commerce.catalog' as const,
    resourceId: '33333333-3333-4333-8333-333333333333',
    resourceType: 'commerce.catalog.variant' as const,
    tenantId,
  },
};
const request = {
  commercialScope,
  currencyCode: 'CZK',
  effectiveAt: '2026-09-28T10:00:00.000Z',
  target,
} satisfies ReadCurrentCommercialFeeSetPersistenceQuery;
const predicateRef = pricingCommercialFeeCurrentSetPredicateRef(request);
const ownerRevision = 'commercial-fee-set:revision:7';
const authority = Schema.decodeSync(CommercialFeeSetAuthoritySchema)({
  generation: 7,
  nextApplicabilityBoundary: '2026-10-01T00:00:00.000Z',
  observedAt,
  ownerRevision,
  ownerRootRef: 'commercial-fee-set:root',
  predicateRef,
  verificationRef: 'commercial-fee-set:verification:7',
});
const completenessEvidence = {
  observedAt,
  ownerRevision,
  scope: { kind: 'EXACT_PREDICATE' as const, predicateRef },
};
if (authority.nextApplicabilityBoundary !== undefined) {
  Object.assign(completenessEvidence, { nextApplicabilityBoundary: authority.nextApplicabilityBoundary });
}
const initializedEmptySet = Schema.decodeSync(PricingCommercialFeeCurrentSetSchema)({
  commercialScope,
  completenessEvidence,
  currencyCode: request.currencyCode,
  currentnessEvidence: {
    observedAt,
    ownerRevision,
    predicateRef,
    revalidatedAt,
    verificationMode: 'OWNER_CURRENT_SET_REVALIDATED',
  },
  fees: [],
  observedAt,
  target,
});

describe('Commercial Fee exact Current-set persistence contract (#797)', () => {
  it('keeps the read predicate exact to Variant, commercial scope, and currency', () => {
    expect(request).toEqual({
      commercialScope: {
        channelId: 'B2C',
        marketId: 'cz-launch',
        sellingLegalEntityId: legalEntityId,
      },
      currencyCode: 'CZK',
      effectiveAt: '2026-09-28T10:00:00.000Z',
      target: { variantRef: target.variantRef },
    });
    expect(predicateRef).toContain(target.variantRef.resourceId);
    expect(predicateRef).toContain(legalEntityId);
    expect(predicateRef).toContain('CZK');
  });

  it('decodes an initialized empty set as proven CURRENT absence', () => {
    const decoded = Schema.decodeSync(ReadCurrentCommercialFeeSetPersistenceOutcomeSchema)({
      authority,
      factProofs: [],
      feeSet: initializedEmptySet,
      outcome: 'COMMERCIAL_FEE_SET_CURRENT',
    });

    expect(decoded).toMatchObject({
      authority: { generation: 7, predicateRef },
      feeSet: {
        commercialScope,
        currencyCode: 'CZK',
        fees: [],
        target,
      },
      outcome: 'COMMERCIAL_FEE_SET_CURRENT',
    });
    expect(
      Schema.is(ReadCurrentCommercialFeeSetPersistenceOutcomeSchema)({
        authority,
        factProofs: [],
        feeSet: { ...initializedEmptySet, currencyCode: 'EUR' },
        outcome: 'COMMERCIAL_FEE_SET_CURRENT',
      }),
    ).toBe(false);
  });

  it('decodes missing, conflict, and unverifiable outcomes without inventing an empty Current set', () => {
    expect(
      Schema.decodeSync(ReadCurrentCommercialFeeSetPersistenceOutcomeSchema)({
        outcome: 'COMMERCIAL_FEE_SET_MISSING',
      }),
    ).toEqual({ outcome: 'COMMERCIAL_FEE_SET_MISSING' });
    expect(
      Schema.decodeSync(ReadCurrentCommercialFeeSetPersistenceOutcomeSchema)({
        candidateRevisionIds: ['44444444-4444-4444-8444-444444444444', '55555555-5555-4555-8555-555555555555'],
        outcome: 'COMMERCIAL_FEE_SET_CONFLICT',
      }),
    ).toMatchObject({
      candidateRevisionIds: ['44444444-4444-4444-8444-444444444444', '55555555-5555-4555-8555-555555555555'],
      outcome: 'COMMERCIAL_FEE_SET_CONFLICT',
    });
    expect(
      Schema.decodeSync(ReadCurrentCommercialFeeSetPersistenceOutcomeSchema)({
        outcome: 'COMMERCIAL_FEE_SET_UNVERIFIABLE',
        reason: 'owner completeness could not be verified',
      }),
    ).toEqual({
      outcome: 'COMMERCIAL_FEE_SET_UNVERIFIABLE',
      reason: 'owner completeness could not be verified',
    });
  });

  it('decodes generation CURRENT and CHANGED and exposes only read/verify routines', () => {
    const verifyQuery = { ...request, authority, through } satisfies VerifyCommercialFeeSetGenerationPersistenceQuery;
    expect(
      Schema.decodeSync(VerifyCommercialFeeSetGenerationPersistenceOutcomeSchema)({
        authority,
        outcome: 'COMMERCIAL_FEE_SET_GENERATION_CURRENT',
        verifiedThrough: verifyQuery.through,
      }),
    ).toMatchObject({ authority, outcome: 'COMMERCIAL_FEE_SET_GENERATION_CURRENT', verifiedThrough: through });
    expect(
      Schema.decodeSync(VerifyCommercialFeeSetGenerationPersistenceOutcomeSchema)({
        outcome: 'COMMERCIAL_FEE_SET_GENERATION_CHANGED',
        verifiedThrough: verifyQuery.through,
      }),
    ).toEqual({ outcome: 'COMMERCIAL_FEE_SET_GENERATION_CHANGED', verifiedThrough: through });
    expect([readCurrentCommercialFeeSetRoutine.name, verifyCommercialFeeSetGenerationRoutine.name]).toEqual([
      'read_current_commercial_fee_set_v1',
      'verify_commercial_fee_set_generation_v1',
    ]);
    expect([readCurrentCommercialFeeSetRoutine.name, verifyCommercialFeeSetGenerationRoutine.name]).not.toContain(
      'define_commercial_fee_v2',
    );
  });

  it.effect('looks up the original Fee Action result and rejects mismatched or ambiguous receipts', () =>
    Effect.gen(function* verifiesCommercialFeeActionResult() {
      const actionInvocationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
      const absent = { actionInvocationId, outcome: 'COMMERCIAL_FEE_ACTION_RESULT_ABSENT' as const };
      const found = {
        actionInvocationId,
        outcome: 'COMMERCIAL_FEE_ACTION_RESULT_FOUND' as const,
        result: {
          identityKey: yield* Schema.decodeEffect(PricingCommercialFeeIdentityKeySchema)({
            calculationBasis: { kind: 'FIXED_PER_LINE' },
            commercialScope,
            currencyCode: 'CZK',
            family: 'RECYCLING_FEE',
            monetaryBoundary: 'PRE_TAX',
            target,
          }),
          outcome: 'COMMERCIAL_FEE_CONFLICT' as const,
          reason: 'EXPECTED_CURRENT_STALE' as const,
        },
      };
      expect(lookupCommercialFeeActionResultRoutine.name).toBe('lookup_commercial_fee_action_result_v1');
      expect(Schema.is(CommercialFeeActionResultLookupOutcomeSchema)(absent)).toBe(true);
      expect(Schema.is(CommercialFeeActionResultLookupOutcomeSchema)(found)).toBe(true);
      expect(
        Schema.is(CommercialFeeActionResultLookupOutcomeSchema)({
          ...absent,
          outcome: 'COMMERCIAL_FEE_ACTION_RESULT_FOUND',
          result: { outcome: 'COMMERCIAL_FEE_UNCHANGED' },
        }),
      ).toBe(false);

      for (const rows of [
        [{ payload: { ...absent, actionInvocationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' } }],
        [{ payload: absent }, { payload: absent }],
      ]) {
        const transaction = scopedRoutineInvokerFromTransaction(() => Effect.succeed(rows), {
          legalEntityId,
          tenantId,
        });
        const persistence = yield* commercialFeePersistenceForScope(transaction, scope);
        const failure = yield* persistence.lookupResult({ actionInvocationId }).pipe(Effect.flip);
        expect(Schema.is(CommercialFeePersistenceUnavailable)(failure)).toBe(true);
      }

      let statement: SQL | undefined;
      const transaction = scopedRoutineInvokerFromTransaction(
        (candidate) => {
          statement = candidate;
          return Effect.succeed([{ payload: found }]);
        },
        { legalEntityId, tenantId },
      );
      const persistence = yield* commercialFeePersistenceForScope(transaction, scope);
      const spoofedQuery = {
        actingPrincipalId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        actionInvocationId,
      };
      expect(yield* persistence.lookupResult(spoofedQuery)).toEqual(found);
      if (statement === undefined) {
        throw new Error('Commercial Fee result lookup did not invoke the owner routine');
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
