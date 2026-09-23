import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';
import {
  SetSupportedCurrenciesPayloadSchema,
  SupportedCurrenciesAdministrationRejected,
  SupportedCurrenciesRevisionConflict,
  applySupportedCurrencies,
} from '../../src/actions/set-supported-currencies.action.ts';

const payload = Schema.decodeSync(SetSupportedCurrenciesPayloadSchema)({
  cartId: 'cart-333',
  channelId: 'B2C',
  contextRevision: 'cart-context:7',
  effectiveFrom: '2026-09-22T12:00:00.000Z',
  expectedGeneration: 0,
  marketId: 'market-cz',
  reason: 'Install Czech launch currency support',
  storefrontId: 'storefront-cz',
  subject: { guestEvidenceRef: 'guest-evidence:9', guestSessionRef: 'guest-session:9', kind: 'GUEST' },
  supportedCurrencies: ['EUR', 'CZK'],
});
const trusted = {
  actionInvocationId: '20000000-0000-4000-8000-000000000001',
  actorPrincipalId: '20000000-0000-4000-8000-000000000002',
  legalEntityId: 'legal-entity-cz',
  tenantId: 'tenant-cz',
} as const;

describe('Set supported currencies Action', () => {
  it.effect('canonicalizes and installs the first owner revision', () =>
    Effect.gen(function* installSupport() {
      let received: readonly string[] = [];
      const result = yield* applySupportedCurrencies(payload, trusted, (command) => {
        received = command.supportedCurrencies;
        return Effect.succeed({
          _tag: 'applied',
          result: {
            changed: true,
            generation: 1,
            pricingRevision: 'pricing-currency-support:1',
            supportedCurrencies: command.supportedCurrencies,
          },
        });
      });
      expect(received).toEqual(['CZK', 'EUR']);
      expect(result).toEqual({
        changed: true,
        generation: 1,
        pricingRevision: 'pricing-currency-support:1',
        supportedCurrencies: ['CZK', 'EUR'],
      });
    }),
  );

  it.effect('returns the existing revision for an idempotent rerun', () =>
    Effect.gen(function* rerunSupport() {
      const result = yield* applySupportedCurrencies(payload, trusted, () =>
        Effect.succeed({
          _tag: 'unchanged',
          result: {
            changed: false,
            generation: 1,
            pricingRevision: 'pricing-currency-support:1',
            supportedCurrencies: ['CZK', 'EUR'],
          },
        }),
      );
      expect(result.changed).toBe(false);
      expect(result.generation).toBe(1);
    }),
  );

  it.effect('fails with typed revision and trusted-scope conflicts', () =>
    Effect.gen(function* rejectConflicts() {
      const revisionExit = yield* Effect.exit(
        applySupportedCurrencies(payload, trusted, () =>
          Effect.succeed({ _tag: 'revision_conflict', actualGeneration: 2, expectedGeneration: 0 }),
        ),
      );
      expect(revisionExit.toString()).toContain(SupportedCurrenciesRevisionConflict.name);

      const profilePayload = yield* Schema.decodeEffect(SetSupportedCurrenciesPayloadSchema)({
        ...payload,
        subject: {
          authorizationSubject: { kind: 'RETAIL' },
          kind: 'PROFILE',
          profileRef: {
            moduleId: 'commerce.customer-context',
            resourceId: 'profile-1',
            resourceType: 'commerce.customer-context.retail-customer-profile',
            tenantId: 'different-tenant',
          },
        },
      });
      const scopeExit = yield* Effect.exit(
        applySupportedCurrencies(profilePayload, trusted, () => Effect.die('must not persist')),
      );
      expect(scopeExit.toString()).toContain(SupportedCurrenciesAdministrationRejected.name);
    }),
  );
});
