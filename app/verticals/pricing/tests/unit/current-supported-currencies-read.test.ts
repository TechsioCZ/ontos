import { CurrentSupportedCurrenciesRequestSchema } from '@app/pricing-contracts/current-supported-currencies';
import { DateTime, Effect, Exit, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';
import { CurrencySupportPersistenceUnavailable } from '../../src/persistence/currency-support-persistence.ts';
import { resolveCurrentSupportedCurrencies } from '../../src/api/current-supported-currencies.read.ts';

const request = Schema.decodeSync(CurrentSupportedCurrenciesRequestSchema)({
  cartId: 'cart-333',
  channelId: 'B2C',
  contextRevision: 'cart-context:7',
  effectiveAt: '2026-09-22T12:00:00.000Z',
  marketId: 'market-cz',
  sellingLegalEntityId: 'legal-entity-cz',
  storefrontId: 'storefront-cz',
  subject: { guestEvidenceRef: 'guest-evidence:9', guestSessionRef: 'guest-session:9', kind: 'GUEST' },
  tenantId: 'tenant-cz',
});
const scope = { legalEntityId: 'legal-entity-cz', storefrontId: 'storefront-cz', tenantId: 'tenant-cz' } as const;
const stored = {
  generation: 4,
  nextApplicabilityBoundary: DateTime.makeUnsafe('2026-09-23T00:00:00.000Z'),
  observedAt: DateTime.makeUnsafe('2026-09-22T11:59:59.000Z'),
  pricingRevision: 'pricing-currency-support:4',
  supportedCurrencies: ['CZK'],
} as const;

describe('Current supported currencies owner read', () => {
  it.effect('returns the exact owner revision, complete unique set, and actual observation boundary', () =>
    Effect.gen(function* currentSupportEvidence() {
      const result = yield* resolveCurrentSupportedCurrencies(request, scope, () => Effect.succeedSome(stored));
      expect(result).toMatchObject({
        completenessEvidence: {
          ownerRevision: 'pricing-currency-support:4',
          scope: { kind: 'EXACT_PREDICATE' },
        },
        outcome: 'SUPPORTED_CURRENCIES_CURRENT',
        pricingRevision: 'pricing-currency-support:4',
        supportedCurrencies: ['CZK'],
      });
      if (result.outcome === 'SUPPORTED_CURRENCIES_CURRENT') {
        expect(result.completenessEvidence.scope.predicateRef).toContain('cart-context:7');
        expect(result.completenessEvidence.scope.predicateRef).toContain('guest-session:9');
      }
    }),
  );

  it.effect('fails closed as stale when actual observation is after the requested effective instant', () =>
    Effect.gen(function* staleSupportEvidence() {
      const late = { ...stored, observedAt: DateTime.makeUnsafe('2026-09-22T12:00:01.000Z') };
      const result = yield* resolveCurrentSupportedCurrencies(request, scope, () => Effect.succeedSome(late));
      expect(result.outcome).toBe('SUPPORTED_CURRENCIES_STALE');
    }),
  );

  it.effect('distinguishes absent support from unverifiable owner state', () =>
    Effect.gen(function* unavailableSupportEvidence() {
      const absent = yield* resolveCurrentSupportedCurrencies(request, scope, () => Effect.succeedNone);
      const unverifiable = yield* resolveCurrentSupportedCurrencies(request, scope, () =>
        Effect.fail(new CurrencySupportPersistenceUnavailable({ reason: 'owner read failed' })),
      );
      expect(absent.outcome).toBe('SUPPORTED_CURRENCIES_UNAVAILABLE');
      expect(unverifiable.outcome).toBe('SUPPORTED_CURRENCIES_UNVERIFIABLE');
    }),
  );

  it.effect('rejects request identity that differs from trusted scope before owner persistence', () =>
    Effect.gen(function* rejectUntrustedScope() {
      const exit = yield* Effect.exit(
        resolveCurrentSupportedCurrencies(request, { ...scope, storefrontId: 'different-storefront' }, () =>
          Effect.die('must not run'),
        ),
      );
      expect(Exit.isFailure(exit)).toBe(true);
    }),
  );
});
