import {
  PriceGroupCompatibilityDecisionSchema,
  PriceGroupCompatibilityEvidenceSchema,
  PriceGroupInstantSchema,
  PriceGroupRefSchema,
} from '@app/price-group-catalog-contracts';
import type { ValidatePriceGroupCompatibilityRequest } from '@app/price-group-catalog-contracts/validate-price-group-compatibility';
import { ValidatePriceGroupCompatibilityRequestSchema } from '@app/price-group-catalog-contracts/validate-price-group-compatibility';
import { computeCanonicalValueHash } from '@app/core-runtime/access/enforcement';
import { layer as nodeCryptoLayer } from '@effect/platform-node/NodeCrypto';
import { Effect, Match, Redacted, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { GatewayDelegationSourceError } from '@app/shared-contracts/gateway-context-server';
import type { GatewayDelegationRequest } from '@app/shared-contracts/gateway-context-server';
import { TrustedPrincipalContextSchema } from '@app/core-runtime/actions/principal-context';
import {
  RegisteredGatewayWorkloadSchema,
  trustVerifiedGatewayPrincipalContext,
} from '@app/core-runtime/auth/system-principal-context-provenance';

import { CustomerPriceGroupCatalogUnavailable } from '../../shared/domain/price-group-errors.ts';
import { CUSTOMER_PRICE_GROUP_COMPATIBILITY_CONTRACT } from '../../shared/domain/price-group-ports.ts';
import {
  priceGroupCatalogPort,
  priceGroupCatalogPortFromEnvironment,
} from '../../src/integrations/price-group-catalog.ts';
import type { PriceGroupCompatibilityExecutor } from '../../src/integrations/price-group-catalog.ts';
import { issuedDelegatedContext, originatorSubject } from '../support/delegated-gateway-acquisition.fixture.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const priceGroupSubject = originatorSubject('a'.repeat(64), tenantId);
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

it.effect('obtains a fresh Shell-issued context for every provider attempt', () =>
  Effect.gen(function* freshAssertion() {
    const issuanceRequests: unknown[] = [];
    const authorizations: string[] = [];
    const destinations: (string | URL | undefined)[] = [];
    const selectedRevisions: (string | undefined)[] = [];
    const port = yield* priceGroupCatalogPortFromEnvironment(
      { requestCorrelation: 'price-group-correlation', subject: priceGroupSubject },
      (_payload, credential, _correlation, options) => {
        authorizations.push(Redacted.value(credential));
        destinations.push(options.baseUrl);
        selectedRevisions.push(options.compositionRevision);
        return Effect.succeed(decision({ evidence: compatibility, kind: 'USABLE' }));
      },
      (request) =>
        Effect.sync(() => {
          issuanceRequests.push(request);
          return issuedDelegatedContext({
            compositionRevision: 'a'.repeat(64),
            token: `fresh-price-group-assertion-${issuanceRequests.length}`,
          });
        }),
    ).pipe(Effect.provide(nodeCryptoLayer));

    yield* port.resolveCurrent(priceGroupRef, CUSTOMER_PRICE_GROUP_COMPATIBILITY_CONTRACT, trustedOperationAt);
    yield* port.resolveCurrent(priceGroupRef, CUSTOMER_PRICE_GROUP_COMPATIBILITY_CONTRACT, trustedOperationAt);

    expect(authorizations).toEqual(['Bearer fresh-price-group-assertion-1', 'Bearer fresh-price-group-assertion-2']);
    expect(selectedRevisions).toEqual(['a'.repeat(64), 'a'.repeat(64)]);
    expect(destinations.map(String)).toEqual([
      'https://shell.example.test/owner-api',
      'https://shell.example.test/owner-api',
    ]);
    expect(issuanceRequests).toEqual([
      {
        audience: 'price-group-catalog',
        callingAppId: 'commerce-customer-context',
        legalEntityScope: 'tenant',
        requestCorrelation: 'price-group-correlation',
        subject: priceGroupSubject,
      },
      {
        audience: 'price-group-catalog',
        callingAppId: 'commerce-customer-context',
        legalEntityScope: 'tenant',
        requestCorrelation: 'price-group-correlation',
        subject: priceGroupSubject,
      },
    ]);
  }),
);

it.effect('fails closed before provider execution when the selected connection cannot be issued', () =>
  Effect.gen(function* missingProviderDestination() {
    let executionCount = 0;
    let issuanceCount = 0;
    const port = yield* priceGroupCatalogPortFromEnvironment(
      { requestCorrelation: 'price-group-correlation', subject: priceGroupSubject },
      () => {
        executionCount += 1;
        return Effect.succeed(decision({ evidence: compatibility, kind: 'USABLE' }));
      },
      () => {
        issuanceCount += 1;
        return Effect.fail(new GatewayDelegationSourceError({ reason: 'Selected release credential unavailable' }));
      },
    ).pipe(Effect.provide(nodeCryptoLayer));

    const failure = yield* Effect.flip(
      port.resolveCurrent(priceGroupRef, CUSTOMER_PRICE_GROUP_COMPATIBILITY_CONTRACT, trustedOperationAt),
    );

    expect(Schema.is(CustomerPriceGroupCatalogUnavailable)(failure)).toBe(true);
    expect(failure.reason).toBe('The Price Group Catalog compatibility decision could not be resolved');
    expect(executionCount).toBe(0);
    expect(issuanceCount).toBe(1);
  }),
);

it.effect('explicitly delegates sealed workload compatibility reads and ignores caller-shaped workload metadata', () =>
  Effect.gen(function* registeredCompatibilitySubject() {
    const revision = 'a'.repeat(64);
    const principal = Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
      authContextRef: 'job:symmy:run:compatibility-unit',
      authMethod: 'system',
      principalId: '60000000-0000-4000-8000-000000000001',
      tenantId,
    });
    const workload = Schema.decodeUnknownSync(RegisteredGatewayWorkloadSchema)({
      admissionInvocationId: '50000000-0000-4000-8000-000000000001',
      bindingIncarnation: '50000000-0000-4000-8000-000000000002',
      declarationKey: 'commerce.customer-context.assign-customer-price-group',
      entrypointKey: 'commerce.customer-context.assign-customer-price-group',
      jobKey: 'symmy-integration.apply',
      legalEntityScope: 'forbidden',
      originalOwnerBindingIncarnation: '50000000-0000-4000-8000-000000000003',
      originalPrincipalId: principal.principalId,
      originalWorkloadBindingIncarnation: '50000000-0000-4000-8000-000000000004',
      originalWorkloadKey: 'commerce.customer-context.source-write',
      runReference: '50000000-0000-4000-8000-000000000005',
      schemaVersion: '1',
      sourceAppId: 'symmy-integration',
      sourceBuildMarker: 'fixture-build',
      sourceMode: 'admission',
      workloadKey: 'commerce.customer-context.source-write',
    });
    // Core's public provenance constructor is a unit seam here; this does not claim signed HTTP admission.
    const sealed = trustVerifiedGatewayPrincipalContext(principal, revision, undefined, undefined, workload);
    const ordinary = trustVerifiedGatewayPrincipalContext({ ...principal, workload }, revision);
    const recoveryWorkload = Schema.decodeUnknownSync(RegisteredGatewayWorkloadSchema)({
      ...workload,
      recovery: {
        originalActionInvocationId: workload.admissionInvocationId,
        originalActionKey: 'commerce.customer-context.assign-customer-price-group',
        originalAuthContextRef: 'job:symmy:run:original',
        originalIdempotencyKey: 'original-effect-key',
        originalPrincipalId: principal.principalId,
        originalRequestHash: 'b'.repeat(64),
        requestHash: 'c'.repeat(64),
      },
    });
    const sealedRecovery = trustVerifiedGatewayPrincipalContext(
      principal,
      revision,
      undefined,
      undefined,
      recoveryWorkload,
    );
    const decodedCompatibilityRead = Schema.decodeUnknownSync(ValidatePriceGroupCompatibilityRequestSchema)({
      priceGroupRef,
      requiredContract: { contractId: CUSTOMER_PRICE_GROUP_COMPATIBILITY_CONTRACT, version: 1 },
      trustedOperationAt,
    });
    for (const [scope, expectedSubject] of [
      [
        sealed,
        {
          _tag: 'RegisteredAssertion',
          declarationKey: 'pricing.price-group-catalog.price-group.read.compatibility',
          operationRequirementKey: 'commerce.customer-context.requirement.assign-customer-price-group-catalog',
          scope: sealed,
        },
      ],
      [ordinary, { _tag: 'Assertion', scope: ordinary }],
      [
        sealedRecovery,
        {
          _tag: 'RegisteredAssertion',
          declarationKey: 'pricing.price-group-catalog.price-group.read.compatibility',
          operationRequirementKey: 'commerce.customer-context.requirement.assign-customer-price-group-catalog',
          recoveryRequestHash: computeCanonicalValueHash(decodedCompatibilityRead),
          scope: sealedRecovery,
        },
      ],
    ] as const) {
      const requests: GatewayDelegationRequest[] = [];
      const credentials: string[] = [];
      const port = yield* priceGroupCatalogPortFromEnvironment(
        {
          operationRequirementKey: 'commerce.customer-context.requirement.assign-customer-price-group-catalog',
          requestCorrelation: 'registered-price-group',
          subject: { _tag: 'Assertion', scope },
        },
        (_payload, credential) => {
          credentials.push(Redacted.value(credential));
          return Effect.succeed(decision({ evidence: compatibility, kind: 'USABLE' }));
        },
        (request) =>
          Effect.sync(() => {
            requests.push(request);
            return issuedDelegatedContext({ compositionRevision: revision, token: `attempt-${requests.length}` });
          }),
      ).pipe(Effect.provide(nodeCryptoLayer));
      yield* port.resolveCurrent(priceGroupRef, CUSTOMER_PRICE_GROUP_COMPATIBILITY_CONTRACT, trustedOperationAt);
      yield* port.resolveCurrent(priceGroupRef, CUSTOMER_PRICE_GROUP_COMPATIBILITY_CONTRACT, trustedOperationAt);
      expect(requests).toEqual(
        Array.from({ length: 2 }, () => ({
          audience: 'price-group-catalog',
          callingAppId: 'commerce-customer-context',
          legalEntityScope: 'tenant',
          requestCorrelation: 'registered-price-group',
          subject: expectedSubject,
        })),
      );
      expect(credentials).toEqual(['Bearer attempt-1', 'Bearer attempt-2']);
    }
    let missingRequirementAcquisitions = 0;
    const missingRequirement = yield* priceGroupCatalogPortFromEnvironment(
      { requestCorrelation: 'missing-native-requirement', subject: { _tag: 'Assertion', scope: sealed } },
      () => Effect.succeed(decision({ evidence: compatibility, kind: 'USABLE' })),
      () =>
        Effect.sync(() => {
          missingRequirementAcquisitions += 1;
          return issuedDelegatedContext({ compositionRevision: revision });
        }),
    ).pipe(Effect.provide(nodeCryptoLayer));
    expect(
      Schema.is(CustomerPriceGroupCatalogUnavailable)(
        yield* Effect.flip(
          missingRequirement.resolveCurrent(
            priceGroupRef,
            CUSTOMER_PRICE_GROUP_COMPATIBILITY_CONTRACT,
            trustedOperationAt,
          ),
        ),
      ),
    ).toBe(true);
    expect(missingRequirementAcquisitions).toBe(0);
  }),
);
