import {
  PriceGroupCompatibilityDecisionSchema,
  PriceGroupCompatibilityEvidenceSchema,
  PriceGroupInstantSchema,
  PriceGroupRefSchema,
} from '@app/price-group-catalog-contracts';
import type { ValidatePriceGroupCompatibilityRequest } from '@app/price-group-catalog-contracts/validate-price-group-compatibility';
import { ConfigProvider, Effect, Layer, Match, Redacted, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { CustomerPriceGroupCatalogUnavailable } from '../../shared/domain/price-group-errors.ts';
import { CUSTOMER_PRICE_GROUP_COMPATIBILITY_CONTRACT } from '../../shared/domain/price-group-ports.ts';
import {
  PriceGroupCatalogGatewayCredentialService,
  priceGroupCatalogPort,
  priceGroupCatalogPortFromEnvironment,
} from '../../src/integrations/price-group-catalog.ts';
import type { PriceGroupCompatibilityExecutor } from '../../src/integrations/price-group-catalog.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const otherTenantId = '10000000-0000-4000-8000-000000000002';
const trustedOperationAt = Schema.decodeSync(PriceGroupInstantSchema)('2026-09-23T10:00:00.000Z');
const priceGroupRef = Schema.decodeSync(PriceGroupRefSchema)({
  moduleId: 'pricing.price-group-catalog',
  resourceId: '30000000-0000-4000-8000-000000000001',
  resourceType: 'pricing.price-group-catalog.price-group',
  tenantId,
});
const otherPriceGroupRef = Schema.decodeSync(PriceGroupRefSchema)({
  moduleId: 'pricing.price-group-catalog',
  resourceId: '30000000-0000-4000-8000-000000000002',
  resourceType: 'pricing.price-group-catalog.price-group',
  tenantId: otherTenantId,
});
const compatibility = Schema.decodeSync(PriceGroupCompatibilityEvidenceSchema)({
  catalogRevision: 7,
  definitionEffectivePeriod: {
    effectiveFrom: '2026-09-01T00:00:00.000Z',
    effectiveTo: null,
  },
  definitionRevisionId: '40000000-0000-4000-8000-000000000001',
  definitionRevisionNumber: 3,
  meaningFingerprint: 'a'.repeat(64),
  priceGroupRef,
  requiredContract: {
    contractId: CUSTOMER_PRICE_GROUP_COMPATIBILITY_CONTRACT,
    version: 1,
  },
  trustedOperationAt,
  verifiedAt: '2026-09-23T10:00:01.000Z',
});

const decision = Schema.decodeUnknownSync(PriceGroupCompatibilityDecisionSchema);

it.effect('sends exact compatibility and expected-current evidence and maps USABLE without losing provenance', () =>
  Effect.gen(function* usableDecision() {
    const requests: ValidatePriceGroupCompatibilityRequest[] = [];
    const execute: PriceGroupCompatibilityExecutor = (payload) => {
      requests.push(payload);
      return Effect.succeed(decision({ evidence: compatibility, kind: 'USABLE' }));
    };
    const outcome = yield* priceGroupCatalogPort('price-group-correlation', execute).resolveCurrent(
      priceGroupRef,
      CUSTOMER_PRICE_GROUP_COMPATIBILITY_CONTRACT,
      trustedOperationAt,
      compatibility,
    );

    const usable = Match.value(outcome).pipe(
      Match.tag('USABLE', (value) => value),
      Match.orElse(() => null),
    );
    expect(usable).not.toBeNull();
    expect(usable?.compatibility).toEqual(compatibility);
    expect(usable?.priceGroupRef).toEqual(priceGroupRef);
    expect(requests).toEqual([
      {
        expectedCurrent: {
          catalogRevision: compatibility.catalogRevision,
          definitionRevisionId: compatibility.definitionRevisionId,
          definitionRevisionNumber: compatibility.definitionRevisionNumber,
          meaningFingerprint: compatibility.meaningFingerprint,
          priceGroupRef,
        },
        priceGroupRef,
        requiredContract: {
          contractId: CUSTOMER_PRICE_GROUP_COMPATIBILITY_CONTRACT,
          version: 1,
        },
        trustedOperationAt,
      },
    ]);
  }),
);

it.effect('preserves the exact MISSING, RETIRED, and INCOMPATIBLE owner outcomes', () =>
  Effect.gen(function* knownOutcomes() {
    const missing = decision({
      catalogObservation: {
        catalogRevision: 7,
        observedAt: '2026-09-23T10:00:01.000Z',
        trustedOperationAt,
      },
      kind: 'MISSING',
      priceGroupRef,
    });
    const retired = decision({
      evidence: {
        acceptedCatalogRevision: 8,
        currentDefinitionRevisionId: compatibility.definitionRevisionId,
        currentDefinitionRevisionNumber: compatibility.definitionRevisionNumber,
        priceGroupRef,
        retiredAt: '2026-09-20T00:00:00.000Z',
        retirementProvenance: {
          actionInvocationId: '50000000-0000-4000-8000-000000000001',
          actorPrincipalId: '60000000-0000-4000-8000-000000000001',
          reason: 'Catalog retirement',
          trustedAt: '2026-09-20T00:00:00.000Z',
        },
        trustedOperationAt,
        verifiedAt: '2026-09-23T10:00:01.000Z',
      },
      kind: 'RETIRED',
    });
    const incompatible = decision({
      evidence: {
        definitionRevisionId: compatibility.definitionRevisionId,
        definitionRevisionNumber: compatibility.definitionRevisionNumber,
        evaluatedCatalogRevision: 7,
        meaningFingerprint: compatibility.meaningFingerprint,
        priceGroupRef,
        requiredContract: compatibility.requiredContract,
        trustedOperationAt,
        verifiedAt: '2026-09-23T10:00:01.000Z',
      },
      kind: 'INCOMPATIBLE',
    });

    const resolve = (ownerDecision: ReturnType<typeof decision>) =>
      priceGroupCatalogPort('price-group-correlation', () => Effect.succeed(ownerDecision)).resolveCurrent(
        priceGroupRef,
        CUSTOMER_PRICE_GROUP_COMPATIBILITY_CONTRACT,
        trustedOperationAt,
      );

    expect(
      Match.value(yield* resolve(missing)).pipe(
        Match.tag('MISSING', () => true),
        Match.orElse(() => false),
      ),
    ).toBe(true);
    expect(
      Match.value(yield* resolve(retired)).pipe(
        Match.tag('RETIRED', ({ catalogRevision }) => catalogRevision),
        Match.orElse(() => null),
      ),
    ).toBe(8);
    expect(
      Match.value(yield* resolve(incompatible)).pipe(
        Match.tag('INCOMPATIBLE', ({ catalogRevision, contractId }) => ({ catalogRevision, contractId })),
        Match.orElse(() => null),
      ),
    ).toEqual({ catalogRevision: 7, contractId: CUSTOMER_PRICE_GROUP_COMPATIBILITY_CONTRACT });
  }),
);

it.effect('maps provider failures to one sanitized typed dependency failure', () =>
  Effect.gen(function* providerFailure() {
    const failure = yield* Effect.flip(
      priceGroupCatalogPort('price-group-correlation', () =>
        Effect.fail(
          new CustomerPriceGroupCatalogUnavailable({
            code: 'customer_price_group_catalog_unavailable',
            reason: 'private transport, decode, authorization, or module-state diagnostic',
          }),
        ),
      ).resolveCurrent(priceGroupRef, CUSTOMER_PRICE_GROUP_COMPATIBILITY_CONTRACT, trustedOperationAt),
    );

    expect(Schema.is(CustomerPriceGroupCatalogUnavailable)(failure)).toBe(true);
    expect(failure).toMatchObject({
      code: 'customer_price_group_catalog_unavailable',
      reason: 'The Price Group Catalog compatibility decision could not be resolved',
    });
    expect(JSON.stringify(failure)).not.toContain('private transport');
  }),
);

it.effect('rejects successful evidence for another Tenant or Price Group as unavailable', () =>
  Effect.gen(function* mismatchedIdentity() {
    const mismatched = decision({
      evidence: {
        ...compatibility,
        priceGroupRef: otherPriceGroupRef,
      },
      kind: 'USABLE',
    });
    const failure = yield* Effect.flip(
      priceGroupCatalogPort('price-group-correlation', () => Effect.succeed(mismatched)).resolveCurrent(
        priceGroupRef,
        CUSTOMER_PRICE_GROUP_COMPATIBILITY_CONTRACT,
        trustedOperationAt,
      ),
    );

    expect(Schema.is(CustomerPriceGroupCatalogUnavailable)(failure)).toBe(true);
    expect(failure.reason).toContain('mismatched compatibility evidence');
  }),
);

it.effect('rejects successful evidence for another contract or trusted operation instant as unavailable', () =>
  Effect.gen(function* mismatchedContractOrTime() {
    const mismatches = [
      decision({
        evidence: {
          ...compatibility,
          requiredContract: { contractId: 'another.consumer.v1', version: 1 },
        },
        kind: 'USABLE',
      }),
      decision({
        evidence: {
          ...compatibility,
          trustedOperationAt: '2026-09-23T10:00:00.500Z',
        },
        kind: 'USABLE',
      }),
    ];

    for (const mismatched of mismatches) {
      const failure = yield* Effect.flip(
        priceGroupCatalogPort('price-group-correlation', () => Effect.succeed(mismatched)).resolveCurrent(
          priceGroupRef,
          CUSTOMER_PRICE_GROUP_COMPATIBILITY_CONTRACT,
          trustedOperationAt,
        ),
      );
      expect(Schema.is(CustomerPriceGroupCatalogUnavailable)(failure)).toBe(true);
    }
  }),
);

it.effect('rejects stale expected evidence even when the provider returns a successful decision', () =>
  Effect.gen(function* staleExpectedEvidence() {
    const changed = Schema.decodeSync(PriceGroupCompatibilityEvidenceSchema)({
      ...compatibility,
      catalogRevision: 8,
      definitionRevisionId: '40000000-0000-4000-8000-000000000002',
      definitionRevisionNumber: 4,
      meaningFingerprint: 'b'.repeat(64),
    });
    const failure = yield* Effect.flip(
      priceGroupCatalogPort('price-group-correlation', () =>
        Effect.succeed(decision({ evidence: changed, kind: 'USABLE' })),
      ).resolveCurrent(priceGroupRef, CUSTOMER_PRICE_GROUP_COMPATIBILITY_CONTRACT, trustedOperationAt, compatibility),
    );

    expect(Schema.is(CustomerPriceGroupCatalogUnavailable)(failure)).toBe(true);
  }),
);

it.effect('obtains a fresh server-owned assertion for every provider attempt', () =>
  Effect.gen(function* freshAssertion() {
    const issuanceRequests: {
      readonly audience: 'price-group-catalog';
      readonly requestCorrelation: string;
    }[] = [];
    const authorizations: string[] = [];
    const destinations: (string | URL | undefined)[] = [];
    const port = yield* priceGroupCatalogPortFromEnvironment(
      { requestCorrelation: 'price-group-correlation' },
      (_payload, credential, _correlation, options) => {
        authorizations.push(Redacted.value(credential));
        destinations.push(options.baseUrl);
        return Effect.succeed(decision({ evidence: compatibility, kind: 'USABLE' }));
      },
    ).pipe(
      Effect.provide(
        Layer.succeed(PriceGroupCatalogGatewayCredentialService, {
          issue: (input) =>
            Effect.sync(() => {
              issuanceRequests.push(input);
              return Redacted.make(`Bearer fresh-price-group-assertion-${issuanceRequests.length}`);
            }),
        }),
      ),
      Effect.provide(
        ConfigProvider.layer(
          ConfigProvider.fromUnknown(
            { ONTOS_PRICE_GROUP_CATALOG_BASE_URL: 'https://price-groups.example.test/price-group-catalog-api' },
            { preserveEmptyStrings: true },
          ),
        ),
      ),
    );

    yield* port.resolveCurrent(priceGroupRef, CUSTOMER_PRICE_GROUP_COMPATIBILITY_CONTRACT, trustedOperationAt);
    yield* port.resolveCurrent(priceGroupRef, CUSTOMER_PRICE_GROUP_COMPATIBILITY_CONTRACT, trustedOperationAt);

    expect(authorizations).toEqual(['Bearer fresh-price-group-assertion-1', 'Bearer fresh-price-group-assertion-2']);
    expect(destinations.map(String)).toEqual([
      'https://price-groups.example.test/price-group-catalog-api',
      'https://price-groups.example.test/price-group-catalog-api',
    ]);
    expect(issuanceRequests).toEqual([
      {
        audience: 'price-group-catalog',
        requestCorrelation: 'price-group-correlation',
      },
      {
        audience: 'price-group-catalog',
        requestCorrelation: 'price-group-correlation',
      },
    ]);
  }),
);

it.effect('fails closed before credential issuance when the provider destination is absent', () =>
  Effect.gen(function* missingProviderDestination() {
    let executionCount = 0;
    let issuanceCount = 0;
    const port = yield* priceGroupCatalogPortFromEnvironment({ requestCorrelation: 'price-group-correlation' }, () => {
      executionCount += 1;
      return Effect.succeed(decision({ evidence: compatibility, kind: 'USABLE' }));
    }).pipe(
      Effect.provide(
        Layer.succeed(PriceGroupCatalogGatewayCredentialService, {
          issue: () => {
            issuanceCount += 1;
            return Effect.succeed(Redacted.make('Bearer must-not-be-issued'));
          },
        }),
      ),
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({}, { preserveEmptyStrings: true }))),
    );

    const failure = yield* Effect.flip(
      port.resolveCurrent(priceGroupRef, CUSTOMER_PRICE_GROUP_COMPATIBILITY_CONTRACT, trustedOperationAt),
    );

    expect(Schema.is(CustomerPriceGroupCatalogUnavailable)(failure)).toBe(true);
    expect(failure.reason).toBe('The Price Group Catalog compatibility decision could not be resolved');
    expect(executionCount).toBe(0);
    expect(issuanceCount).toBe(0);
  }),
);
