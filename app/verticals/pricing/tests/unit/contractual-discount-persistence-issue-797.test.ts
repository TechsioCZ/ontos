import { scopedRoutineInvokerFromTransaction, TrustedPrincipalContextSchema } from '@app/core-runtime';
import type { OperationalScope } from '@app/core-runtime';
import {
  PricingContractualDiscountCurrentSetSchema,
  PricingContractualDiscountSetPredicateSchema,
  pricingContractualDiscountSetPredicateRef,
} from '@app/pricing-contracts/domain/contractual-discount-set';
import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  ContractualDiscountPersistenceUnavailable,
  contractualDiscountPersistenceForScope,
  lookupContractualDiscountResultRoutine,
  manageContractualDiscountRoutine,
  readCurrentContractualDiscountSetRoutine,
  resolveOriginalContractualDiscountSetProofRoutine,
  verifyContractualDiscountSetGenerationRoutine,
} from '../../src/services/contractual-discount-persistence.service.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const legalEntityId = '22222222-2222-4222-8222-222222222222';
const observedAt = '2026-09-28T10:00:00.000Z';
const through = '2026-09-28T10:05:00.000Z';
const scope: OperationalScope = {
  ...Schema.decodeSync(TrustedPrincipalContextSchema)({
    authBindingId: '33333333-3333-4333-8333-333333333333',
    authContextRef: 'better-auth-session:contractual-discount-set',
    authMethod: 'session',
    legalEntityId,
    principalId: '44444444-4444-4444-8444-444444444444',
    tenantId,
  }),
  correlationId: 'contractual-discount-set-persistence',
};
const counterpartyRef = {
  moduleId: 'party.registry' as const,
  resourceId: '55555555-5555-4555-8555-555555555555',
  resourceType: 'party.registry.counterparty' as const,
  tenantId,
};
const predicate = Schema.decodeSync(PricingContractualDiscountSetPredicateSchema)({
  audiences: [{ counterpartyRef, kind: 'COUNTERPARTY' }],
  basis: { kind: 'WHOLE_PURCHASE' },
  commercialScope: { channelId: 'B2B', marketId: 'cz-launch', sellingLegalEntityId: legalEntityId },
  currencyCode: 'CZK',
  effectiveAt: observedAt,
  tenantId,
});

const currentSetFor = (exactPredicate: typeof predicate) => {
  const predicateRef = pricingContractualDiscountSetPredicateRef(exactPredicate);
  const ownerRevision = 'contractual-discount-set:generation:9';
  return Schema.decodeSync(PricingContractualDiscountCurrentSetSchema)({
    authority: {
      generation: 9,
      observedAt,
      ownerRevision,
      ownerRootRef: `pricing:contractual-discount-set:${tenantId}`,
      predicateRef,
      verificationRef: `pricing:contractual-discount-set-proof:${predicateRef}`,
      verifiedAt: observedAt,
    },
    completenessEvidence: {
      observedAt,
      ownerRevision,
      scope: { kind: 'EXACT_PREDICATE', predicateRef },
    },
    currentDiscounts: [],
    factProofs: [],
    predicate: exactPredicate,
  });
};

describe('Contractual Discount scoped persistence issue #797', () => {
  it('declares management, complete Current-set, and final generation-fence routines', () => {
    expect(
      [
        manageContractualDiscountRoutine,
        lookupContractualDiscountResultRoutine,
        readCurrentContractualDiscountSetRoutine,
        resolveOriginalContractualDiscountSetProofRoutine,
        verifyContractualDiscountSetGenerationRoutine,
      ].map(({ name, ownerModuleKey, schema }) => ({ name, ownerModuleKey, schema })),
    ).toEqual([
      { name: 'manage_contractual_discount_v1', ownerModuleKey: 'commerce.pricing', schema: 'pricing' },
      { name: 'lookup_contractual_discount_result_v1', ownerModuleKey: 'commerce.pricing', schema: 'pricing' },
      {
        name: 'read_current_contractual_discount_set_v1',
        ownerModuleKey: 'commerce.pricing',
        schema: 'pricing',
      },
      {
        name: 'resolve_contractual_discount_set_proof_v1',
        ownerModuleKey: 'commerce.pricing',
        schema: 'pricing',
      },
      {
        name: 'verify_contractual_discount_set_generation_v1',
        ownerModuleKey: 'commerce.pricing',
        schema: 'pricing',
      },
    ]);
  });

  it.effect('binds result lookup to the original invocation and rejects ambiguous routine rows', () =>
    Effect.gen(function* verifyResultLookup() {
      const actionInvocationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
      const payloads = [
        { actionInvocationId, outcome: 'CONTRACTUAL_DISCOUNT_RESULT_ABSENT' },
        { actionInvocationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', outcome: 'CONTRACTUAL_DISCOUNT_RESULT_ABSENT' },
      ];
      let callCount = 0;
      const transaction = scopedRoutineInvokerFromTransaction(
        () => {
          const payload = payloads[callCount];
          callCount += 1;
          return Effect.succeed(payload === undefined ? [] : [{ payload }]);
        },
        { legalEntityId, tenantId },
      );
      const persistence = yield* contractualDiscountPersistenceForScope(transaction, scope);
      expect(yield* persistence.lookupResult({ actionInvocationId })).toEqual(payloads[0]);
      const mismatch = yield* persistence.lookupResult({ actionInvocationId }).pipe(Effect.flip);
      expect(mismatch).toBeInstanceOf(ContractualDiscountPersistenceUnavailable);

      const ambiguousTransaction = scopedRoutineInvokerFromTransaction(
        () => Effect.succeed([{ payload: payloads[0] }, { payload: payloads[0] }]),
        { legalEntityId, tenantId },
      );
      const ambiguousPersistence = yield* contractualDiscountPersistenceForScope(ambiguousTransaction, scope);
      const ambiguity = yield* ambiguousPersistence.lookupResult({ actionInvocationId }).pipe(Effect.flip);
      expect(ambiguity).toBeInstanceOf(ContractualDiscountPersistenceUnavailable);
    }),
  );

  it.effect('decodes a proven empty Current set and verifies the exact root generation', () =>
    Effect.gen(function* readAndVerifyExactGeneration() {
      const currentSet = currentSetFor(predicate);
      const verification = {
        authority: currentSet.authority,
        outcome: 'CONTRACTUAL_DISCOUNT_SET_GENERATION_CURRENT' as const,
        verifiedThrough: through,
      };
      const resolved = {
        authority: currentSet.authority,
        currentFacts: currentSet.factProofs,
        outcome: 'CONTRACTUAL_DISCOUNT_SET_PROOF_RESOLVED' as const,
        predicate,
      };
      const payloads: object[] = [currentSet, resolved, verification];
      let invocationCount = 0;
      const transaction = scopedRoutineInvokerFromTransaction(
        () => {
          const payload = payloads[invocationCount];
          invocationCount += 1;
          return Effect.succeed(payload === undefined ? [] : [{ payload }]);
        },
        { legalEntityId, tenantId },
      );
      const persistence = yield* contractualDiscountPersistenceForScope(transaction, scope);

      expect(yield* persistence.readCurrentSet(predicate)).toEqual(currentSet);
      expect(
        yield* persistence.resolveOriginalSetProof({ verificationRef: currentSet.authority.verificationRef }),
      ).toEqual(resolved);
      expect(yield* persistence.verifySetGeneration({ authority: currentSet.authority, predicate, through })).toEqual(
        verification,
      );
      expect(invocationCount).toBe(3);
    }),
  );

  it.effect('rejects a valid but different predicate or generation proof instead of replaying it', () =>
    Effect.gen(function* rejectDriftedProofs() {
      const currentSet = currentSetFor(predicate);
      const driftedPredicate = yield* Schema.decodeEffect(PricingContractualDiscountSetPredicateSchema)({
        ...predicate,
        effectiveAt: '2026-09-28T09:59:59.000Z',
      });
      const driftedSet = currentSetFor(driftedPredicate);
      const driftedAuthority = { ...currentSet.authority, generation: currentSet.authority.generation + 1 };
      const payloads: object[] = [
        driftedSet,
        {
          authority: driftedAuthority,
          outcome: 'CONTRACTUAL_DISCOUNT_SET_GENERATION_CURRENT',
          verifiedThrough: through,
        },
      ];
      let invocationCount = 0;
      const transaction = scopedRoutineInvokerFromTransaction(
        () => {
          const payload = payloads[invocationCount];
          invocationCount += 1;
          return Effect.succeed(payload === undefined ? [] : [{ payload }]);
        },
        { legalEntityId, tenantId },
      );
      const persistence = yield* contractualDiscountPersistenceForScope(transaction, scope);

      const setFailure = yield* persistence.readCurrentSet(predicate).pipe(Effect.flip);
      const generationFailure = yield* persistence
        .verifySetGeneration({ authority: currentSet.authority, predicate, through })
        .pipe(Effect.flip);
      expect(setFailure).toBeInstanceOf(ContractualDiscountPersistenceUnavailable);
      expect(generationFailure).toBeInstanceOf(ContractualDiscountPersistenceUnavailable);
    }),
  );
});
