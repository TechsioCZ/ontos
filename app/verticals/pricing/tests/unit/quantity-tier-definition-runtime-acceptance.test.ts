import { QuantityTierIdentityKeySchema } from '@app/pricing-contracts/domain/quantity-tier';
import { DateTime, Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { makeQuantityTierAdministration } from '../../src/services/quantity-tier-administration.service.ts';
import type {
  QuantityTierPersistence,
  ReviseQuantityTierPersistenceCommand,
} from '../../src/services/quantity-tier-persistence.service.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const unitRef = {
  moduleId: 'commerce.catalog' as const,
  resourceId: '22222222-2222-4222-8222-222222222222',
  resourceType: 'commerce.catalog.product-unit' as const,
  tenantId,
};
const identityKey = Schema.decodeSync(QuantityTierIdentityKeySchema)({
  priceRef: {
    moduleId: 'commerce.pricing',
    resourceId: '33333333-3333-4333-8333-333333333333',
    resourceType: 'commerce.pricing.price',
    tenantId,
  },
  quantityBasis: {
    catalogQuantityBasis: {
      targetDivisibilityRevision: 3,
      targetRef: {
        moduleId: 'commerce.catalog',
        resourceId: '44444444-4444-4444-8444-444444444444',
        resourceType: 'commerce.catalog.variant',
        tenantId,
      },
      unitRef,
      unitRuleRevision: 5,
    },
    priceUnitBasis: { quantity: '1', unitRef },
  },
  thresholdQuantity: '10',
});
const currentPeriod = {
  effectiveFrom: '2026-09-01T00:00:00.000Z',
  effectiveTo: '2026-09-28T00:00:00.000Z',
} as const;
const valueChangeEffectiveFrom = '2026-09-27T12:00:00.000Z' as const;
const trusted = {
  actingPrincipalId: '55555555-5555-4555-8555-555555555555',
  actionInvocationId: '66666666-6666-4666-8666-666666666666',
  reason: 'Quantity Tier acceptance proof',
  requestCorrelationId: '77777777-7777-4777-8777-777777777777',
  trustedOperationAt: DateTime.toDateUtc(DateTime.makeUnsafe('2026-09-27T12:00:00.000Z')),
};
const valueOnlyCommand: ReviseQuantityTierPersistenceCommand = {
  ...trusted,
  effectiveFrom: valueChangeEffectiveFrom,
  expectedCurrent: {
    effectivePeriod: currentPeriod,
    identityKey,
    revision: 1,
    revisionId: '88888888-8888-4888-8888-888888888888',
    scheduleRevision: 2,
  },
  identityKey,
  intent: 'VALUE_ONLY_CURRENT',
  resultingUnitPrice: { amount: '85', currencyCode: 'CZK' },
};
const persistence = (revise: QuantityTierPersistence['revise']): QuantityTierPersistence => ({
  define: () => Effect.die('unexpected define'),
  readCurrent: () => Effect.die('unexpected readCurrent'),
  readCurrentSet: () => Effect.die('unexpected readCurrentSet'),
  readSchedule: () => Effect.die('unexpected readSchedule'),
  revise,
  verifySetGeneration: () => Effect.die('unexpected verifySetGeneration'),
});

describe('Pricing Quantity Tier definition runtime acceptance', () => {
  it.effect(
    'keeps generalized currency and alternate compatible basis inputs exact while owner mismatch rejects them',
    () => {
      const otherUnitRef = {
        ...unitRef,
        resourceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      };
      const otherBasisIdentity = Schema.decodeSync(QuantityTierIdentityKeySchema)({
        ...identityKey,
        quantityBasis: {
          catalogQuantityBasis: {
            ...identityKey.quantityBasis.catalogQuantityBasis,
            unitRef: otherUnitRef,
          },
          priceUnitBasis: { quantity: '1', unitRef: otherUnitRef },
        },
      });
      const observedCommands: Extract<
        ReviseQuantityTierPersistenceCommand,
        { readonly intent: 'VALUE_ONLY_CURRENT' }
      >[] = [];
      const service = makeQuantityTierAdministration(
        persistence((command) => {
          if (command.intent !== 'VALUE_ONLY_CURRENT') {
            return Effect.die('Expected a value-only Quantity Tier command');
          }
          observedCommands.push(command);
          return Effect.succeed({
            identityKey: command.identityKey,
            outcome: 'QUANTITY_TIER_CONFLICT',
            reason: 'IDENTITY_MISMATCH',
          });
        }),
      );
      const eurCommand = {
        ...valueOnlyCommand,
        resultingUnitPrice: { amount: '85', currencyCode: 'EUR' as const },
      };
      const otherBasisCommand = {
        ...valueOnlyCommand,
        expectedCurrent: { ...valueOnlyCommand.expectedCurrent, identityKey: otherBasisIdentity },
        identityKey: otherBasisIdentity,
      };

      return Effect.gen(function* ownerMismatch() {
        expect(yield* service.revise(eurCommand)).toMatchObject({
          outcome: 'QUANTITY_TIER_CONFLICT',
          reason: 'IDENTITY_MISMATCH',
        });
        expect(yield* service.revise(otherBasisCommand)).toMatchObject({
          outcome: 'QUANTITY_TIER_CONFLICT',
          reason: 'IDENTITY_MISMATCH',
        });
        expect(observedCommands.map(({ resultingUnitPrice }) => resultingUnitPrice.currencyCode)).toEqual([
          'EUR',
          'CZK',
        ]);
        expect(observedCommands[0]?.resultingUnitPrice).toEqual({ amount: '85', currencyCode: 'EUR' });
        expect(observedCommands[1]?.identityKey).toEqual(otherBasisIdentity);
      });
    },
  );
});
