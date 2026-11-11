import { createHash } from 'node:crypto';
import {
  canonicalizeApplicationComposition,
  defineTenantModuleEntrypoint,
  OntosModuleDeploymentContractSchema,
  ReadPermissionDenied,
  TrustedPrincipalContextSchema,
  trustVerifiedGatewayPrincipalContext,
  validateActiveApplicationCompositionSnapshot,
} from '@app/core-runtime';
import { defineDatabaseIdentityEnrollment } from '@app/core-runtime/db/database-identity-manifest';
import {
  makeApplicationCompositionSnapshotFixture,
  makeModuleContractFixture,
  makeOwnerApplicationCompositionFixture,
} from '@app/core-runtime/testing/module-contract';
import { makeReadTestHarness } from '@app/core-runtime/testing/reads';
import {
  EligibleMarketTuplesApi,
  ResolveCommerceMarketApi,
  EligibleMarketTuplesResponseSchema,
  ResolveCommerceMarketResponseSchema,
} from '@app/commerce-market-catalog/api/client';
import type {
  EligibleMarketTuplesResponse,
  ResolveCommerceMarketRequest,
  ResolveCommerceMarketResponse,
} from '@app/commerce-market-catalog/api/client';
import { GatewayContextApi } from '@app/shared-contracts';
import { NodeCrypto } from '@effect/platform-node';
import { HttpApiBuilder, HttpRouter, HttpServer } from '@modern-js/bff-effect/effect-edge';
import { Cause, ConfigProvider, Context, DateTime, Effect, Exit, Layer, Redacted, Schema } from 'effect';
import { FetchHttpClient } from 'effect/http';
import { TestClock } from 'effect/testing';
import { describe, expect, it } from 'effect-rstest';

import { MarketBootstrapPolicyBatchCurrentResponseSchema } from '../../shared/domain/customer-commerce-policy-administration.ts';
import type { MarketBootstrapPolicyBatchCurrentResponse } from '../../shared/domain/customer-commerce-policy-administration.ts';
import { MarketBootstrapDependencyUnavailable } from '../../shared/domain/market-bootstrap-dependency.ts';
import {
  MarketBootstrapResolutionRequestSchema,
  resolveMarketBootstrapPolicy,
} from '../../shared/domain/market-bootstrap-resolution.ts';
import {
  handleMarketBootstrapResolution,
  marketBootstrapResolutionRead,
} from '../../src/api/market-bootstrap-resolution.read.ts';
import type { MarketBootstrapResolutionServices } from '../../src/api/market-bootstrap-resolution.read.ts';
import { commerceCustomerContextRegistration } from '../../vertical.registration.ts';
import { FIXTURE_DESCRIPTOR } from '../support/database-identities.ts';

/* oxlint-disable anti-slop/no-conditional-empty-object-spread -- Test fixtures preserve exact optional schema fields. */

const tenantId = '11111111-1111-4111-8111-111111111111';
const sellerOneId = '22222222-2222-4222-8222-222222222221';
const sellerTwoId = '22222222-2222-4222-8222-222222222222';
const storefrontId = 'shop-b2b';
const evaluatedAt = '2030-06-01T00:00:00.000Z';
const evaluatedAtInstant = Schema.decodeUnknownSync(Schema.DateTimeUtcFromString)(evaluatedAt);
const catalogBoundary = '2030-09-01T00:00:00.000Z';
const marketBoundary = '2030-08-01T00:00:00.000Z';
const policyBoundary = '2030-07-01T00:00:00.000Z';

type CompleteEligibleMarketResponse = Extract<
  EligibleMarketTuplesResponse,
  { readonly outcome: 'ELIGIBLE_MARKET_TUPLES' }
>;
type EligibleMarketTuple = CompleteEligibleMarketResponse['tuples'][number];
type PolicyCandidate = MarketBootstrapPolicyBatchCurrentResponse['sellers'][number]['candidates'][number];

const storefrontRef = { appId: storefrontId, tenantId } as const;
const sellerRef = (resourceId: string) => ({
  moduleId: 'core.identity' as const,
  resourceId,
  resourceType: 'core.identity.legal-entity' as const,
  tenantId,
});
const marketRef = (resourceId: string) => ({
  moduleId: 'commerce.market-catalog' as const,
  resourceId,
  resourceType: 'commerce.market-catalog.market' as const,
  tenantId,
});
const tuple = (index: 1 | 2, sellerId = sellerOneId): EligibleMarketTuple => ({
  associationRef: {
    moduleId: 'commerce.market-catalog',
    resourceId: `40000000-0000-4000-8000-00000000000${index}`,
    resourceType: 'commerce.market-catalog.storefront-association',
    tenantId,
  },
  associationRevision: index,
  channel: 'B2B',
  marketDefinitionRevisionRef: {
    moduleId: 'commerce.market-catalog',
    resourceId: `50000000-0000-4000-8000-00000000000${index}`,
    resourceType: 'commerce.market-catalog.market-definition-revision',
    tenantId,
  },
  marketRef: marketRef(`60000000-0000-4000-8000-00000000000${index}`),
  sellingLegalEntityRef: sellerRef(sellerId),
});
const firstTuple = tuple(1);
const secondTuple = tuple(2, sellerTwoId);

const request = (overrides: Partial<typeof MarketBootstrapResolutionRequestSchema.Encoded> = {}) =>
  Schema.decodeUnknownSync(MarketBootstrapResolutionRequestSchema)({
    channel: 'B2B',
    storefrontRef,
    ...overrides,
  });

const eligible = (
  tuples: readonly EligibleMarketTuple[],
  nextApplicabilityBoundary?: string,
): CompleteEligibleMarketResponse => {
  const response = Schema.decodeUnknownSync(EligibleMarketTuplesResponseSchema)({
    completenessEvidence: {
      observedAt: evaluatedAt,
      ownerRevision: 'market-catalog:eligible:17',
      scope: { kind: 'EXACT_PREDICATE', predicateRef: 'market-catalog:shop-b2b:B2B:all-sellers' },
    },
    effectiveAt: evaluatedAt,
    evaluatedAt,
    ...(nextApplicabilityBoundary === undefined ? {} : { nextApplicabilityBoundary }),
    outcome: 'ELIGIBLE_MARKET_TUPLES',
    tuples,
  });
  if (response.outcome !== 'ELIGIBLE_MARKET_TUPLES') {
    throw new Error('Expected a complete eligible Market tuple fixture');
  }
  return response;
};

const resolved = (
  selectedTuple: EligibleMarketTuple,
  selectionSource: 'BOOTSTRAP_DEFAULT' | 'EXPLICIT' | 'SOLE_ELIGIBLE',
  nextApplicabilityBoundary?: string,
): ResolveCommerceMarketResponse =>
  Schema.decodeUnknownSync(ResolveCommerceMarketResponseSchema)({
    associationRevision: selectedTuple.associationRevision,
    completenessEvidence: {
      observedAt: evaluatedAt,
      ownerRevision: 'market-catalog:resolution:17',
      scope: { kind: 'EXACT_PREDICATE', predicateRef: 'market-catalog:shop-b2b:B2B:all-sellers' },
    },
    effectiveAt: evaluatedAt,
    evaluatedAt,
    marketDefinitionRevisionRef: selectedTuple.marketDefinitionRevisionRef,
    ...(nextApplicabilityBoundary === undefined ? {} : { nextApplicabilityBoundary }),
    outcome: 'MARKET_RESOLVED',
    selectedTuple,
    selectionSource,
  });

const selectionRequired = (
  choices: readonly [EligibleMarketTuple, EligibleMarketTuple],
): ResolveCommerceMarketResponse =>
  Schema.decodeUnknownSync(ResolveCommerceMarketResponseSchema)({
    choices,
    completenessEvidence: {
      observedAt: evaluatedAt,
      ownerRevision: 'market-catalog:resolution:18',
      scope: { kind: 'EXACT_PREDICATE', predicateRef: 'market-catalog:shop-b2b:B2B:all-sellers' },
    },
    effectiveAt: evaluatedAt,
    evaluatedAt,
    outcome: 'MARKET_SELECTION_REQUIRED',
  });

const policyCandidate = (
  policyRevisionId: string,
  scope: PolicyCandidate['scope'],
  selectedTuple: EligibleMarketTuple = firstTuple,
): PolicyCandidate => ({
  defaultTuple: {
    channelId: selectedTuple.channel,
    commerceMarketId: selectedTuple.marketRef.resourceId,
    sellingLegalEntityId: selectedTuple.sellingLegalEntityRef.resourceId,
  },
  policyRevisionId,
  scope,
});

const sellerScope = (sellingLegalEntityId = sellerOneId) =>
  ({ kind: 'SELLER', sellingLegalEntityId }) satisfies PolicyCandidate['scope'];
const channelScope = (sellingLegalEntityId = sellerOneId) =>
  ({ channelId: 'B2B', kind: 'CHANNEL_SELLER', sellingLegalEntityId }) satisfies PolicyCandidate['scope'];
const storefrontScope = (sellingLegalEntityId = sellerOneId) =>
  ({
    channelId: 'B2B',
    kind: 'STOREFRONT_CHANNEL_SELLER',
    sellingLegalEntityId,
    storefrontId,
  }) satisfies PolicyCandidate['scope'];

const partition = (
  sellingLegalEntityId: string,
  candidates: readonly PolicyCandidate[],
  nextApplicabilityBoundary?: string,
) => ({
  candidates,
  completeness: {
    observedAt: evaluatedAt,
    ownerRevision: `market-bootstrap:${sellingLegalEntityId}`,
    scope: {
      kind: 'EXACT_PREDICATE' as const,
      predicateRef: `commerce.customer-context.market-bootstrap:${sellingLegalEntityId}`,
    },
    ...(nextApplicabilityBoundary === undefined ? {} : { nextApplicabilityBoundary }),
  },
  sellingLegalEntityId,
});

const policy = (sellers: readonly ReturnType<typeof partition>[]): MarketBootstrapPolicyBatchCurrentResponse =>
  Schema.decodeUnknownSync(MarketBootstrapPolicyBatchCurrentResponseSchema)({ sellers });

const scope = {
  authMethod: 'system' as const,
  correlationId: 'market-bootstrap-test',
  legalEntityId: sellerOneId,
  principalId: '33333333-3333-4333-8333-333333333333',
  tenantId,
  trustedStorefrontId: storefrontId,
};

const context = (services: MarketBootstrapResolutionServices) => ({
  readKey: 'commerce.customer-context.api.market-bootstrap-resolution',
  scope,
  services,
});

describe('Market bootstrap policy resolution', () => {
  it('selects Storefront + Channel + Seller over Channel + Seller over Seller', () => {
    const decision = resolveMarketBootstrapPolicy(
      request(),
      eligible([firstTuple]),
      policy([
        partition(sellerOneId, [
          policyCandidate('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', sellerScope()),
          policyCandidate('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2', channelScope()),
          policyCandidate('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3', storefrontScope()),
        ]),
      ]),
      evaluatedAtInstant,
    );

    expect(decision).toMatchObject({
      evidence: {
        selectedPolicyRevisionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3',
        status: 'APPLIED',
      },
      kind: 'DEFAULT',
    });
  });

  it('applies a Channel + Seller default across eligible Storefront contexts', () => {
    const decision = resolveMarketBootstrapPolicy(
      request({ storefrontRef: { appId: 'another-shop', tenantId } }),
      eligible([firstTuple]),
      policy([partition(sellerOneId, [policyCandidate('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2', channelScope())])]),
      evaluatedAtInstant,
    );

    expect(decision).toMatchObject({
      evidence: { selectedPolicyRevisionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2' },
      kind: 'DEFAULT',
    });
  });

  it('falls through only to the highest applicable Market-free rank', () => {
    const wrongStorefront = policyCandidate('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3', {
      ...storefrontScope(),
      storefrontId: 'another-shop',
    });
    const wrongChannel = policyCandidate('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2', {
      ...channelScope(),
      channelId: 'B2C',
    });
    const decision = resolveMarketBootstrapPolicy(
      request(),
      eligible([firstTuple]),
      policy([
        partition(sellerOneId, [
          policyCandidate('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', sellerScope()),
          {
            ...wrongChannel,
            defaultTuple: { ...wrongChannel.defaultTuple, channelId: 'B2C' },
          },
          wrongStorefront,
        ]),
      ]),
      evaluatedAtInstant,
    );

    expect(decision).toMatchObject({
      evidence: { selectedPolicyRevisionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1' },
      kind: 'DEFAULT',
    });
  });

  it('distinguishes missing policy, same-rank conflict, and an ineligible configured default', () => {
    const completeEligible = eligible([firstTuple]);
    expect(
      resolveMarketBootstrapPolicy(
        request(),
        completeEligible,
        policy([partition(sellerOneId, [])]),
        evaluatedAtInstant,
      ),
    ).toMatchObject({ evidence: { status: 'MISSING' }, kind: 'NONE' });

    expect(
      resolveMarketBootstrapPolicy(
        request(),
        completeEligible,
        policy([
          partition(sellerOneId, [
            policyCandidate('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', channelScope()),
            policyCandidate('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2', channelScope()),
          ]),
        ]),
        evaluatedAtInstant,
      ),
    ).toMatchObject({ evidence: { status: 'INCONSISTENT' }, kind: 'CONFLICT' });

    expect(
      resolveMarketBootstrapPolicy(
        request(),
        completeEligible,
        policy([
          partition(sellerTwoId, [
            policyCandidate('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3', sellerScope(sellerTwoId), secondTuple),
          ]),
        ]),
        evaluatedAtInstant,
      ),
    ).toMatchObject({ evidence: { status: 'BROKEN' }, kind: 'BROKEN' });
  });

  it('makes Market-dependent bootstrap scope impossible through the schema', () => {
    expect(() =>
      Schema.decodeUnknownSync(MarketBootstrapPolicyBatchCurrentResponseSchema)({
        sellers: [
          partition(sellerOneId, [
            {
              ...policyCandidate('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', sellerScope()),
              scope: {
                channelId: 'B2B',
                commerceMarketId: firstTuple.marketRef.resourceId,
                // @ts-expect-error -- Bootstrap policy deliberately rejects Market-dependent scopes.
                kind: 'MARKET_CHANNEL_SELLER',
                sellingLegalEntityId: sellerOneId,
              },
            },
          ]),
        ],
      }),
    ).toThrow();
  });
});

describe('Governed Market bootstrap resolution', () => {
  it.effect('preserves valid and invalid explicit selections without loading policy or falling back', () =>
    Effect.gen(function* explicitSelectionIsFinal() {
      const explicitRequest = request({
        explicitSelection: {
          marketRef: firstTuple.marketRef,
          sellingLegalEntityRef: firstTuple.sellingLegalEntityRef,
        },
      });
      const explicitOutcomes: readonly ResolveCommerceMarketResponse[] = [
        resolved(firstTuple, 'EXPLICIT'),
        Schema.decodeUnknownSync(ResolveCommerceMarketResponseSchema)({
          outcome: 'MARKET_NOT_ALLOWED_FOR_STOREFRONT',
          reason: 'The explicitly selected Market is not eligible for this Storefront',
        }),
      ];

      for (const explicitOutcome of explicitOutcomes) {
        let policyCalls = 0;
        let observedRequest: ResolveCommerceMarketRequest | undefined;
        const result = yield* handleMarketBootstrapResolution(
          explicitRequest,
          context({
            loadEligibleTuples: () => Effect.succeed(eligible([firstTuple, secondTuple])),
            loadPolicyCandidates: () => {
              policyCalls += 1;
              return Effect.die('Explicit resolution must not load bootstrap policy');
            },
            resolveMarket: (input) => {
              observedRequest = input;
              return Effect.succeed(explicitOutcome);
            },
          }),
        );

        expect(result.result.marketResolution).toEqual(explicitOutcome);
        expect(result.result.policyEvidence.status).toBe('NOT_EVALUATED_EXPLICIT');
        expect(policyCalls).toBe(0);
        expect(observedRequest?.bootstrapDefault).toBeUndefined();
      }
    }),
  );

  it.effect('uses SOLE_ELIGIBLE for one complete tuple when no bootstrap policy exists', () =>
    Effect.gen(function* soleEligibleWithoutPolicy() {
      let observedRequest: ResolveCommerceMarketRequest | undefined;
      const result = yield* handleMarketBootstrapResolution(
        request(),
        context({
          loadEligibleTuples: () => Effect.succeed(eligible([firstTuple])),
          loadPolicyCandidates: () => Effect.succeed(policy([partition(sellerOneId, [])])),
          resolveMarket: (input) => {
            observedRequest = input;
            return Effect.succeed(resolved(firstTuple, 'SOLE_ELIGIBLE'));
          },
        }),
      );

      expect(result.result.marketResolution).toMatchObject({
        outcome: 'MARKET_RESOLVED',
        selectionSource: 'SOLE_ELIGIBLE',
      });
      expect(result.result.policyEvidence.status).toBe('MISSING');
      expect(observedRequest?.bootstrapDefault).toBeUndefined();
    }),
  );

  it.effect('returns MARKET_SELECTION_REQUIRED for a complete multi-Market set without policy', () =>
    Effect.gen(function* selectionRequiredWithoutPolicy() {
      const result = yield* handleMarketBootstrapResolution(
        request(),
        context({
          loadEligibleTuples: () => Effect.succeed(eligible([firstTuple, secondTuple])),
          loadPolicyCandidates: () => Effect.succeed(policy([partition(sellerOneId, []), partition(sellerTwoId, [])])),
          resolveMarket: () => Effect.succeed(selectionRequired([firstTuple, secondTuple])),
        }),
      );

      expect(result.result.marketResolution).toMatchObject({ outcome: 'MARKET_SELECTION_REQUIRED' });
      expect(result.result.policyEvidence.status).toBe('MISSING');
    }),
  );

  it.effect('turns a Market owner outage into a retryable legitimate outcome without consulting policy', () =>
    Effect.gen(function* marketOutage() {
      let policyCalled = false;
      const result = yield* handleMarketBootstrapResolution(
        request(),
        context({
          loadEligibleTuples: () =>
            Effect.fail(
              new MarketBootstrapDependencyUnavailable({
                dependency: 'MARKET',
                reason: 'Catalog is unavailable',
                retryable: true,
              }),
            ),
          loadPolicyCandidates: () => {
            policyCalled = true;
            return Effect.die('Market outage must short-circuit policy resolution');
          },
          resolveMarket: () => Effect.die('Market outage must short-circuit final resolution'),
        }),
      );

      expect(result.result.eligibleMarketResponse).toMatchObject({
        outcome: 'MARKET_ELIGIBILITY_UNAVAILABLE',
        retryable: true,
      });
      expect(result.result.marketResolution).toMatchObject({
        outcome: 'MARKET_ELIGIBILITY_UNAVAILABLE',
        retryable: true,
      });
      expect(result.result.policyEvidence.status).toBe('NOT_EVALUATED_MARKET_UNAVAILABLE');
      expect(policyCalled).toBe(false);
    }),
  );

  it.effect('fails closed when the Current bootstrap policy owner is unavailable', () =>
    Effect.gen(function* policyOutage() {
      let resolveCalled = false;
      const result = yield* handleMarketBootstrapResolution(
        request(),
        context({
          loadEligibleTuples: () => Effect.succeed(eligible([firstTuple])),
          loadPolicyCandidates: () =>
            Effect.fail(
              new MarketBootstrapDependencyUnavailable({
                dependency: 'POLICY',
                reason: 'Policy store is unavailable',
                retryable: true,
              }),
            ),
          resolveMarket: () => {
            resolveCalled = true;
            return Effect.die('Unverifiable policy must not permit Market resolution');
          },
        }),
      );

      expect(result.result.marketResolution).toMatchObject({
        outcome: 'MARKET_ELIGIBILITY_UNAVAILABLE',
        retryable: true,
      });
      expect(result.result.policyEvidence.status).toBe('UNVERIFIABLE');
      expect(resolveCalled).toBe(false);
    }),
  );

  it.effect('passes one valid configured default to the Market owner', () =>
    Effect.gen(function* validBootstrapDefault() {
      let observedRequest: ResolveCommerceMarketRequest | undefined;
      const policyRevisionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
      const result = yield* handleMarketBootstrapResolution(
        request(),
        context({
          loadEligibleTuples: () => Effect.succeed(eligible([firstTuple, secondTuple])),
          loadPolicyCandidates: () =>
            Effect.succeed(
              policy([
                partition(sellerOneId, [policyCandidate(policyRevisionId, sellerScope())]),
                partition(sellerTwoId, []),
              ]),
            ),
          resolveMarket: (input) => {
            observedRequest = input;
            return Effect.succeed(resolved(firstTuple, 'BOOTSTRAP_DEFAULT'));
          },
        }),
      );

      expect(observedRequest?.bootstrapDefault).toEqual({
        marketRef: firstTuple.marketRef,
        policyRevision: policyRevisionId,
        sellingLegalEntityRef: firstTuple.sellingLegalEntityRef,
      });
      expect(result.result.marketResolution).toMatchObject({
        outcome: 'MARKET_RESOLVED',
        selectionSource: 'BOOTSTRAP_DEFAULT',
      });
      expect(result.result.policyEvidence).toMatchObject({
        selectedPolicyRevisionId: policyRevisionId,
        status: 'APPLIED',
      });
    }),
  );

  it.effect('uses the actual evaluation instant and publishes the earliest owner boundary with evidence', () =>
    Effect.gen(function* authoritativeTimeAndBoundary() {
      yield* TestClock.setTime(Date.parse(evaluatedAt));
      let eligibleAt = '';
      let policyAt = '';
      let marketAt = '';
      const result = yield* handleMarketBootstrapResolution(
        request(),
        context({
          loadEligibleTuples: (input) => {
            eligibleAt = DateTime.formatIso(input.effectiveAt);
            return Effect.succeed(eligible([firstTuple], catalogBoundary));
          },
          loadPolicyCandidates: (_sellerIds, at) => {
            policyAt = at;
            return Effect.succeed(
              policy([
                partition(
                  sellerOneId,
                  [policyCandidate('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', sellerScope())],
                  policyBoundary,
                ),
              ]),
            );
          },
          resolveMarket: (input) => {
            marketAt = DateTime.formatIso(input.effectiveAt);
            return Effect.succeed(resolved(firstTuple, 'BOOTSTRAP_DEFAULT', marketBoundary));
          },
        }),
      );

      expect({ eligibleAt, marketAt, policyAt }).toEqual({
        eligibleAt: evaluatedAt,
        marketAt: evaluatedAt,
        policyAt: evaluatedAt,
      });
      expect(result.evidence).toEqual({ resultCount: 1 });
      expect(DateTime.formatIso(result.result.evaluatedAt)).toBe(evaluatedAt);
      expect(
        result.result.nextApplicabilityBoundary === undefined
          ? undefined
          : DateTime.formatIso(result.result.nextApplicabilityBoundary),
      ).toBe(policyBoundary);
      expect(DateTime.formatIso(result.result.policyEvidence.evaluatedAt)).toBe(evaluatedAt);
      expect(result.result.policyEvidence.status).toBe('APPLIED');
    }),
  );
});
/* oxlint-enable anti-slop/no-conditional-empty-object-spread */

const digest = (document: string) => createHash('sha256').update(document, 'utf-8').digest('hex');

/** Public provider metadata and HTTP are test-owned; only the consumer's real registered lifecycle is exercised. */
const bootstrapComposition = Effect.gen(function* bootstrapCompositionFixture() {
  const owner = yield* makeOwnerApplicationCompositionFixture({
    appId: 'commerce-customer-context',
    ownerRegistration: commerceCustomerContextRegistration,
  });
  const provider = yield* makeApplicationCompositionSnapshotFixture(['commerce-market-catalog']);
  const [providerModule] = provider.composition.modules;
  if (providerModule === undefined) {
    return yield* Effect.die('The Market public contract fixture is required');
  }
  const base = makeModuleContractFixture({
    appId: 'commerce-market-catalog',
    buildMarker: providerModule.deployment.buildMarker,
    moduleId: 'commerce.market-catalog',
  });
  const operations = [
    { apiKey: 'eligible-market-tuples', operationKey: 'eligibleMarketTuples.execute' },
    { apiKey: 'resolve-commerce-market', operationKey: 'resolveCommerceMarket.execute' },
  ];
  const contract = yield* Schema.decodeUnknownEffect(OntosModuleDeploymentContractSchema)({
    ...base,
    manifest: {
      ...base.manifest,
      publicSurface: {
        ...base.manifest.publicSurface,
        api: operations.map(({ apiKey, operationKey }) => ({
          key: `commerce.market-catalog.${apiKey}`,
          operationKeys: [operationKey],
        })),
        operationContracts: operations.map(({ apiKey, operationKey }) => ({
          apiKey: `commerce.market-catalog.${apiKey}`,
          entrypoint: defineTenantModuleEntrypoint({
            access: 'read',
            authorization: { kind: 'protected' },
            entrypointKey: `commerce.market-catalog.api.${apiKey}`,
            moduleKey: 'commerce.market-catalog',
            role: 'api',
          }),
          operationKey,
          schemaVersion: '1',
        })),
      },
    },
  });
  const contractDocument = yield* Schema.encodeEffect(Schema.fromJsonString(OntosModuleDeploymentContractSchema))(
    contract,
  );
  const sha256 = digest(contractDocument);
  const composition = {
    ...owner.snapshot.composition,
    modules: [
      ...owner.snapshot.composition.modules,
      {
        ...providerModule,
        contract: { ...providerModule.contract, sha256 },
        contractDocument,
        moduleId: 'commerce.market-catalog',
        publicContract: { ...providerModule.publicContract, id: 'commerce.market-catalog', sha256 },
      },
    ],
    revision: '0'.repeat(64),
  };
  const snapshot = yield* validateActiveApplicationCompositionSnapshot({
    ...owner.snapshot,
    composition: { ...composition, revision: digest(canonicalizeApplicationComposition(composition)) },
  });
  return { ...owner, applicationComposition: { load: Effect.succeed(snapshot) }, snapshot };
});

const bootstrapDatabaseIdentities = defineDatabaseIdentityEnrollment([
  {
    ...FIXTURE_DESCRIPTOR,
    moduleKey: 'commerce.customer-context',
    request: {
      ...FIXTURE_DESCRIPTOR.request,
      gatewayScopeAudiences: ['commerce-customer-context'],
      ownerModuleKey: 'commerce.customer-context',
    },
    schemas: ['commerce_customer_context'],
    worker: { ...FIXTURE_DESCRIPTOR.worker, ownerModuleKey: 'commerce.customer-context' },
  },
]);

it.layer(Layer.mergeAll(NodeCrypto.layer, TestClock.layer()))('registered Market bootstrap phases', (test) => {
  for (const scenario of ['ELIGIBLE', 'EMPTY', 'DENIED'] as const) {
    test.effect(`${scenario} releases SQL before Market HTTP and reads policy in a fresh scoped transaction`, () =>
      Effect.gen(function* registeredBootstrap() {
        yield* TestClock.setTime(Date.parse(evaluatedAt));
        const composition = yield* bootstrapComposition;
        const { revision } = composition.snapshot.composition;
        const sourceAssertion = 'bootstrap-original-requester-assertion';
        const principal = trustVerifiedGatewayPrincipalContext(
          Schema.decodeSync(TrustedPrincipalContextSchema)({
            ...scope,
            authBindingId: '44444444-4444-4444-8444-444444444444',
            authContextRef: 'session:bootstrap-native-phase',
            authMethod: 'session',
          }),
          revision,
          { assertion: Redacted.make(sourceAssertion), audience: 'commerce-customer-context' },
        );
        const events: string[] = [];
        const harness = yield* makeReadTestHarness({
          ...composition,
          access: scenario === 'DENIED' ? 'denied' : 'allowed',
          compositionRevision: revision,
          databaseIdentities: bootstrapDatabaseIdentities,
          executeOwnerQuery: ({ params, scope: installed, sql }) =>
            Effect.sync(() => {
              expect(sql).toContain('load_current_market_bootstrap_policy_candidates');
              expect(installed).toEqual({ legalEntityId: sellerOneId, tenantId });
              expect(params).toContain(tenantId);
              expect(events).toEqual(['eligible']);
              events.push('policy');
              return [{ result: policy([partition(sellerOneId, [])]) }];
            }),
          operationTime: new Date(evaluatedAt),
          ownerAuthorizationDecision: 'allowed',
          scope: trustVerifiedGatewayPrincipalContext({ ...principal, correlationId: scope.correlationId }, revision, {
            assertion: Redacted.make(sourceAssertion),
            audience: 'commerce-customer-context',
          }),
        });
        const paths: string[] = [];
        const api = GatewayContextApi.addHttpApi(EligibleMarketTuplesApi.prefix('/market-owner')).addHttpApi(
          ResolveCommerceMarketApi.prefix('/market-owner'),
        );
        const gateway = HttpApiBuilder.group(api, 'gatewayContext', (handlers) =>
          handlers
            .handle('issueGatewayContext', () => Effect.die('Bootstrap must delegate the original requester'))
            .handle('issueApiKeyGatewayContext', () => Effect.die('Bootstrap must not replace the requester'))
            .handle('readWithApiKeyGatewayContext', () => Effect.die('Use the published Market contract'))
            .handle('issueDelegatedGatewayContext', ({ payload: exchange }) => {
              expect(exchange.audience).toBe('commerce-market-catalog');
              expect(exchange.compositionRevision).toBe(revision);
              expect(
                exchange.subject._tag === 'Assertion' ? Redacted.value(exchange.subject.sourceAssertion) : undefined,
              ).toBe(sourceAssertion);
              return Effect.succeed({
                apiBaseUrl: '/market-owner',
                compositionRevision: revision,
                expiresAt: 1_906_502_700,
                token: 'delegated-market-assertion',
              });
            }),
        );
        const marketEligible = HttpApiBuilder.group(api, 'eligibleMarketTuples', (handlers) =>
          handlers.handle('execute', () => {
            events.push('eligible');
            return Effect.succeed(eligible(scenario === 'EMPTY' ? [] : [firstTuple]));
          }),
        );
        const marketResolve = HttpApiBuilder.group(api, 'resolveCommerceMarket', (handlers) =>
          handlers.handle('execute', () => {
            events.push('resolve');
            return Effect.succeed(
              scenario === 'EMPTY'
                ? { outcome: 'MARKET_CONFIGURATION_MISSING_OR_INCONSISTENT' as const, reason: 'No eligible Market' }
                : resolved(firstTuple, 'SOLE_ELIGIBLE'),
            );
          }),
        );
        const server = yield* Effect.acquireRelease(
          Effect.sync(() =>
            HttpRouter.toWebHandler(
              HttpApiBuilder.layer(api).pipe(
                Layer.provide(Layer.mergeAll(gateway, marketEligible, marketResolve)),
                Layer.provide(HttpServer.layerServices),
              ),
              { disableLogger: true },
            ),
          ),
          (web) => Effect.promise(() => web.dispose()),
        );
        const nativeFetch: typeof fetch = (input, init) => {
          const outboundRequest = new Request(input, init);
          expect(harness.snapshot().statements.at(-1)?.trim().toLowerCase()).toBe('commit');
          paths.push(new URL(outboundRequest.url).pathname);
          return server.handler(outboundRequest, Context.empty());
        };
        const transport = Layer.mergeAll(
          ConfigProvider.layer(
            ConfigProvider.fromUnknown({
              ONTOS_GATEWAY_MODULE_API_KEY: 'bootstrap-module-credential',
              ONTOS_SHELL_GATEWAY_BASE_URL: 'https://bootstrap-owner.test',
            }),
          ),
          Layer.succeed(FetchHttpClient.Fetch, nativeFetch),
        );
        const outcome = yield* harness.runtime
          .runRead({
            input: request(),
            principal,
            registration: marketBootstrapResolutionRead,
            transport: { correlationId: scope.correlationId },
          })
          .pipe(Effect.provide(transport), Effect.exit);
        if (scenario === 'DENIED') {
          expect(Exit.isFailure(outcome)).toBe(true);
          if (Exit.isFailure(outcome)) {
            expect(
              outcome.cause.reasons.some(
                (reason) => Cause.isFailReason(reason) && Schema.is(ReadPermissionDenied)(reason.error),
              ),
            ).toBe(true);
          }
          expect(paths).toEqual([]);
          expect(harness.snapshot().ownerQueries).toEqual([]);
        } else {
          const result = yield* outcome;
          expect(result.marketResolution.outcome).toBe(
            scenario === 'EMPTY' ? 'MARKET_CONFIGURATION_MISSING_OR_INCONSISTENT' : 'MARKET_RESOLVED',
          );
          expect(events).toEqual(scenario === 'EMPTY' ? ['eligible', 'resolve'] : ['eligible', 'policy', 'resolve']);
          expect(paths).toHaveLength(4);
          expect(harness.snapshot().ownerQueries).toHaveLength(scenario === 'EMPTY' ? 0 : 1);
          expect(harness.snapshot().evidenceWrites).toBe(1);
        }
      }),
    );
  }
});
