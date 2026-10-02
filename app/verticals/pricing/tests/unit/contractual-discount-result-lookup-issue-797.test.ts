import { ReadHandlerUnavailable } from '@app/core-runtime';
import { PricingDiscountIdentityKeySchema } from '@app/pricing-contracts/domain/discount';
import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  ContractualDiscountResultLookupRequestSchema,
  ContractualDiscountResultLookupResponseSchema,
} from '../../shared/apis/contractual-discount-result-lookup.ts';
import { readContractualDiscountResult } from '../../src/api/contractual-discount-result-lookup.read.ts';
import { ContractualDiscountPersistenceUnavailable } from '../../src/services/contractual-discount-persistence.service.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const legalEntityId = '22222222-2222-4222-8222-222222222222';
const actionInvocationId = '33333333-3333-4333-8333-333333333333';
const input = Schema.decodeSync(ContractualDiscountResultLookupRequestSchema)({ actionInvocationId });
const identityKey = Schema.decodeSync(PricingDiscountIdentityKeySchema)({
  audience: {
    counterpartyRef: {
      moduleId: 'party.registry',
      resourceId: '44444444-4444-4444-8444-444444444444',
      resourceType: 'party.registry.counterparty',
      tenantId,
    },
    kind: 'COUNTERPARTY',
  },
  basis: { kind: 'WHOLE_PURCHASE' },
  commercialScope: { channelId: 'B2B', marketId: 'cz-launch', sellingLegalEntityId: legalEntityId },
  currencyCode: 'CZK',
  effectKind: 'FIXED_MONETARY_AMOUNT',
  family: 'CONTRACTUAL_DISCOUNT',
  monetaryBoundary: 'PRE_TAX',
  scope: 'WHOLE_PURCHASE',
});

describe('Contractual Discount governed result lookup issue #797', () => {
  it.effect('returns a typed original owner result and a typed absence', () =>
    Effect.gen(function* lookupCommittedResult() {
      const found = {
        actionInvocationId,
        outcome: 'CONTRACTUAL_DISCOUNT_RESULT_FOUND' as const,
        result: {
          identityKey,
          outcome: 'CONTRACTUAL_DISCOUNT_CONFLICT' as const,
          reason: 'EXPECTED_CURRENT_STALE' as const,
        },
      };
      const absent = { actionInvocationId, outcome: 'CONTRACTUAL_DISCOUNT_RESULT_ABSENT' as const };
      const foundResult = yield* readContractualDiscountResult(
        input,
        { legalEntityId },
        {
          lookupResult: () => Effect.succeed(found),
        },
      );
      const absentResult = yield* readContractualDiscountResult(
        input,
        { legalEntityId },
        {
          lookupResult: () => Effect.succeed(absent),
        },
      );
      expect(foundResult).toEqual(found);
      expect(absentResult).toEqual(absent);
      expect(Schema.is(ContractualDiscountResultLookupResponseSchema)(foundResult)).toBe(true);
      expect(Schema.is(ContractualDiscountResultLookupResponseSchema)(absentResult)).toBe(true);
    }),
  );

  it.effect('preserves owner persistence failure and does not read without trusted Legal Entity scope', () =>
    Effect.gen(function* unavailableOrMissingScope() {
      let reads = 0;
      const services = {
        lookupResult: () => {
          reads += 1;
          return Effect.fail(new ContractualDiscountPersistenceUnavailable({ reason: 'Unavailable owner storage' }));
        },
      };
      const missingScope = yield* readContractualDiscountResult(input, { legalEntityId: null }, services);
      expect(missingScope).toEqual({
        actionInvocationId,
        outcome: 'CONTRACTUAL_DISCOUNT_RESULT_UNAVAILABLE',
        retryable: true,
      });
      const failure = yield* readContractualDiscountResult(input, { legalEntityId }, services).pipe(Effect.flip);
      expect(failure).toBeInstanceOf(ReadHandlerUnavailable);
      expect(failure.cause).toBeInstanceOf(ContractualDiscountPersistenceUnavailable);
      expect(reads).toBe(1);
    }),
  );
});
