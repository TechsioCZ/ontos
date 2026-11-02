import { FetchHttpClient } from 'effect/http';
import {
  PricingCurrentMarketEvidenceRequestSchema,
  PricingCurrentMarketEvidenceResponseSchema,
} from '@app/commerce-market-catalog/api/pricing-current-market-evidence';
import {
  PricingPurposeEquivalenceRequestSchema,
  PricingPurposeEquivalenceResponseSchema,
} from '@app/catalog/api/pricing-purpose-equivalence';
import type { PricingPurposeEquivalenceRequest } from '@app/catalog/api/pricing-purpose-equivalence';
import { PricingLineSchema } from '@app/pricing-contracts/pricing-decision';
import {
  executeMarket,
  makeCurrentPricingDecisionExternalOwnerEvidenceLivePort,
} from '../../src/integrations/current-pricing-decision-external-owner-evidence-live.ts';
import { PricingPurchaseContextVerificationEvidenceSchema } from '@app/commerce-customer-context/api/pricing-purchase-context-verification';
import { CurrentPricingDecisionRequestSchema } from '@app/pricing-contracts/current-pricing-decision';
import { DateTime, Effect, Exit, Redacted, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import type {
  CurrentPricingDecisionExternalOwnerEvidenceDependencies,
  CurrentPricingDecisionExternalOwnerEvidenceReadContext,
} from '../../src/integrations/current-pricing-decision-external-owner-evidence.ts';
import { makeCurrentPricingDecisionExternalOwnerEvidencePort } from '../../src/integrations/current-pricing-decision-external-owner-evidence.ts';
import { CurrentPricingDecisionOwnerReadFailure } from '../../src/services/current-pricing-decision-whole-evaluation.service.ts';
import { makePricingExternalOwnerEvidenceValidationService } from '../../src/services/external-owner-evidence-validation.service.ts';
import {
  makeIssue788Attempt,
  makeIssue788CommercialTotal,
  makeIssue788MaterialEvidence,
} from './support/issue-788-confirmation.fixture.ts';

const inputFixture = Effect.fn('test.currentPricingDecisionExternalOwnerEvidence.inputFixture')(
  function* inputFixtureProgram() {
    const rawCommercialTotal = yield* makeIssue788CommercialTotal();
    const subject = {
      guestEvidenceRef: 'guest-evidence:external-owner-790',
      guestSessionRef: 'guest-session:external-owner-790',
      kind: 'GUEST' as const,
    };
    const commercialTotal = {
      ...rawCommercialTotal,
      decision: {
        ...rawCommercialTotal.decision,
        purchasingContext: {
          ...rawCommercialTotal.decision.purchasingContext,
          actor: subject,
          subject,
        },
      },
    };
    const request = yield* Schema.decodeEffect(CurrentPricingDecisionRequestSchema)({
      decision: commercialTotal.decision,
      subject,
    });
    const materialEvidence = makeIssue788MaterialEvidence(commercialTotal);
    const attempt = makeIssue788Attempt(commercialTotal, materialEvidence);
    const purchaseContextEvidence = yield* Schema.decodeEffect(PricingPurchaseContextVerificationEvidenceSchema)({
      currentness: {
        evaluatedAt: commercialTotal.decision.operationTime,
        observedAt: commercialTotal.decision.operationTime,
        validFrom: commercialTotal.decision.operationTime,
        validTo: null,
      },
      ownerRef: commercialTotal.decision.purchasingContext.contextRef,
      ownerRevisionRef: commercialTotal.decision.purchasingContext.contextRevision,
      subjectAuthority: {
        guestEvidenceAuthorityRef: 'guest-evidence-authority:external-owner-790',
        guestSessionAuthorityRef: 'guest-session-authority:external-owner-790',
        kind: 'GUEST',
        subject,
        subjectAuthorityRevisionRef: 'guest-authority-revision:external-owner-790',
      },
      verificationRef: 'purchase-context-verification:external-owner-790',
      verifiedScope: {
        channelId: commercialTotal.decision.commercialScope.channelId,
        legalEntityId: commercialTotal.decision.commercialScope.sellingLegalEntityId,
        marketId: commercialTotal.decision.commercialScope.marketId,
        tenantId: commercialTotal.decision.tenantId,
      },
    });
    return { attempt, commercialTotal, purchaseContextEvidence, request };
  },
);

const allFailingDependencies = (
  failure: CurrentPricingDecisionOwnerReadFailure,
  observedContexts: CurrentPricingDecisionExternalOwnerEvidenceReadContext[],
): CurrentPricingDecisionExternalOwnerEvidenceDependencies => {
  const fail = (context: CurrentPricingDecisionExternalOwnerEvidenceReadContext) => {
    observedContexts.push(context);
    return Effect.fail(failure);
  };
  return {
    catalog: { loadFresh: fail },
    customerContext: { loadFresh: fail },
    market: { loadFresh: fail },
    promotion: { loadFresh: fail },
    validation: makePricingExternalOwnerEvidenceValidationService(),
  };
};

describe('Current Pricing Decision external-owner evidence aggregation #790', () => {
  it.effect('starts every owner read from one exact time-bound context and preserves owner unavailability', () =>
    Effect.gen(function* preservesOwnerFailure() {
      const input = yield* inputFixture();
      const ownerFailure = new CurrentPricingDecisionOwnerReadFailure({
        kind: 'UNAVAILABLE',
        ownerRefs: ['commerce.market-catalog'],
        reason: 'Market owner is unavailable',
      });
      const observedContexts: CurrentPricingDecisionExternalOwnerEvidenceReadContext[] = [];
      const port = makeCurrentPricingDecisionExternalOwnerEvidencePort(
        allFailingDependencies(ownerFailure, observedContexts),
      );

      const failure = yield* port.loadFresh(input).pipe(Effect.flip);

      expect(failure).toBe(ownerFailure);
      expect(failure.kind).toBe('UNAVAILABLE');
      expect(observedContexts).toHaveLength(4);
      expect(
        observedContexts.every(
          (context) =>
            context.effectiveAt === input.request.decision.operationTime &&
            context.requestedAt === input.attempt.snapshot.requestedAt &&
            context.request === input.request &&
            context.purchaseContextEvidence === input.purchaseContextEvidence,
        ),
      ).toBe(true);
    }),
  );

  it.effect('rejects a mixed candidate before invoking any external owner', () =>
    Effect.gen(function* rejectsMixedCandidate() {
      const input = yield* inputFixture();
      let readCount = 0;
      const neverRead = () => {
        readCount += 1;
        return Effect.die('Mixed candidate must fail before external owner reads');
      };
      const port = makeCurrentPricingDecisionExternalOwnerEvidencePort({
        catalog: { loadFresh: neverRead },
        customerContext: { loadFresh: neverRead },
        market: { loadFresh: neverRead },
        promotion: { loadFresh: neverRead },
        validation: makePricingExternalOwnerEvidenceValidationService(),
      });

      const failure = yield* port
        .loadFresh({ ...input, commercialTotal: { ...input.commercialTotal, candidateRef: 'candidate:mixed-790' } })
        .pipe(Effect.flip);

      expect(failure.kind).toBe('UNVERIFIABLE');
      expect(failure.reason).toContain('exact coherent Pricing attempt');
      expect(readCount).toBe(0);
    }),
  );
});

describe('actual Catalog reader whole-candidate boundary #1225', () => {
  for (const variant of ['heterogeneous Products', 'non-equivalent same-Product Variants', 'singleton'] as const) {
    it.effect(`uses legal singleton owner questions for ${variant}`, () =>
      Effect.gen(function* legalOwnerQuestions() {
        const input = yield* inputFixture();
        const [first] = input.request.decision.lines;
        expect(first).toBeDefined();
        if (first === undefined) {
          return yield* Effect.die('TEST fixture requires a line');
        }
        const productRef =
          variant === 'heterogeneous Products'
            ? { ...first.catalog.selection.productRef, resourceId: 'f1111111-1111-4111-8111-111111111111' }
            : first.catalog.selection.productRef;
        const variantRef = {
          ...first.catalog.selection.variantRef,
          resourceId: 'f2222222-2222-4222-8222-222222222222',
        };
        const selection = { ...first.catalog.selection, productRef, variantRef };
        const second = yield* Schema.decodeEffect(PricingLineSchema)({
          ...first,
          catalog: {
            ...first.catalog,
            equivalentSelectionKey: 'catalog:test:separate-owner-meaning',
            evidence: {
              ...first.catalog.evidence,
              basis: first.catalog.evidence.basis.map((basis) => {
                let { resourceRef } = basis.source;
                if (resourceRef.resourceId === first.catalog.selection.productRef.resourceId) {
                  resourceRef = productRef;
                } else if (resourceRef.resourceId === first.catalog.selection.variantRef.resourceId) {
                  resourceRef = variantRef;
                }
                return { ...basis, source: { ...basis.source, resourceRef } };
              }),
              membership: {
                ...first.catalog.evidence.membership,
                productRef,
                variant: { ...first.catalog.evidence.membership.variant, resourceRef: variantRef },
              },
              selection,
            },
            quantity: { ...first.catalog.quantity, targetId: variantRef.resourceId },
            quantityBasis: { ...first.catalog.quantityBasis, targetRef: variantRef },
            selection,
          },
          occurrenceId: 'occurrence:1225:second',
        });
        const decision = { ...input.request.decision, lines: variant === 'singleton' ? [first] : [first, second] };
        const request = yield* Schema.decodeEffect(CurrentPricingDecisionRequestSchema)({ ...input.request, decision });
        const seen: PricingPurposeEquivalenceRequest[] = [];
        const port = makeCurrentPricingDecisionExternalOwnerEvidenceLivePort(
          {
            compositionRevision: 'test:1225',
            legalEntityId: decision.commercialScope.sellingLegalEntityId,
            requestCorrelation: 'test:1225',
            tenantId: decision.tenantId,
          },
          {
            catalog: {
              execute: (payload) =>
                Effect.sync(() => {
                  expect(Schema.is(PricingPurposeEquivalenceRequestSchema)(payload)).toBe(true);
                  seen.push(payload);
                  return {
                    currentness: { effectiveAt: payload.effectiveAt, status: 'UNAVAILABLE' },
                    outcome: 'CATALOG_EQUIVALENCE_UNAVAILABLE',
                    reason: 'TEST bounded transport stop after the genuine request schema',
                    retryable: true,
                  };
                }),
              executeCompatibility: () => Effect.die('Compatibility must not execute after owner unavailability'),
              issuer: {
                issue: () =>
                  Effect.succeed({ baseUrl: new URL('http://127.0.0.1:1225'), credential: Redacted.make('TEST-only') }),
              },
            },
            customerContext: { execute: () => Effect.never, issuer: { issue: () => Effect.never } },
            market: { execute: () => Effect.never, issuer: { issue: () => Effect.never } },
            validation: makePricingExternalOwnerEvidenceValidationService(),
          },
        );
        yield* port
          .loadFresh({
            ...input,
            attempt: { ...input.attempt, snapshot: { ...input.attempt.snapshot, decision } },
            commercialTotal: { ...input.commercialTotal, decision },
            request,
          })
          .pipe(Effect.exit);
        expect(seen.length).toBeGreaterThan(0);
        expect(
          seen.every(
            ({ anchorSelection, members }) =>
              members.length === 1 &&
              members[0]?.handoff.selection.productRef.resourceId === anchorSelection.productRef.resourceId,
          ),
        ).toBe(true);
        expect(
          seen.every(
            ({ members }) =>
              members[0]?.occurrenceId === first.occurrenceId || members[0]?.occurrenceId === second.occurrenceId,
          ),
        ).toBe(true);
        return yield* Effect.void;
      }),
    );
  }
});

it.effect('actual Catalog reader acquires a fresh credential for compatibility after equivalence #1225', () =>
  Effect.gen(function* freshCatalogAttempts() {
    const input = yield* inputFixture();
    const [line] = input.request.decision.lines;
    if (line === undefined) {
      return yield* Effect.die('TEST fixture requires one line');
    }
    const effectiveAt = input.request.decision.operationTime;
    const observedAt = effectiveAt;
    const validThrough = '2099-01-01T00:00:00.000Z';
    const generation = 'catalog:test:initial-generation';
    const predicateRef = 'catalog:test:equivalence-predicate';
    const target = {
      quantityBasis: line.catalog.quantityBasis,
      requestedQuantity: line.catalog.quantity.requested,
      selection: line.catalog.selection,
    };
    const observedCredentials: string[] = [];
    let issued = 0;
    const port = makeCurrentPricingDecisionExternalOwnerEvidenceLivePort(
      {
        compositionRevision: 'test:1225',
        legalEntityId: input.request.decision.commercialScope.sellingLegalEntityId,
        requestCorrelation: 'test:1225',
        tenantId: input.request.decision.tenantId,
      },
      {
        applicationComposition: { load: Effect.never },
        catalog: {
          execute: (request, credential) =>
            Effect.gen(function* confirmedSingleton() {
              observedCredentials.push(Redacted.value(credential));
              return yield* Schema.decodeUnknownEffect(PricingPurposeEquivalenceResponseSchema)({
                assessments: [
                  { handoff: line.catalog, role: 'ANCHOR' },
                  ...request.members.map(({ handoff, occurrenceId }) => ({ handoff, occurrenceId, role: 'MEMBER' })),
                ],
                currentness: { effectiveAt, observedAt, status: 'CURRENT', validThrough },
                currentnessEvidence: {
                  effectiveAt,
                  generation,
                  observedAt,
                  predicateRef,
                  revalidatedAt: observedAt,
                  validThrough,
                  verificationMode: 'OWNER_CURRENT_QUANTITY_REVALIDATED',
                },
                evidence: {
                  anchorSelection: line.catalog.selection,
                  assessmentId: 'catalog:test:assessment',
                  effectiveAt,
                  members: request.members.map(({ occurrenceId }) => ({
                    occurrenceId,
                    selection: line.catalog.selection,
                  })),
                  observedAt,
                  ownerModuleId: 'commerce.catalog',
                  ownerRevision: 'catalog:test:owner-revision',
                  purpose: 'PRICING',
                  status: 'CONFIRMED',
                  validThrough,
                },
                generation,
                outcome: 'CATALOG_EQUIVALENCE_CONFIRMED',
                verificationReceipt: {
                  generation,
                  issuedAt: observedAt,
                  ownerModuleId: 'commerce.catalog',
                  ownerRevision: 'catalog:test:owner-revision',
                  predicate: {
                    anchor: target,
                    effectiveAt,
                    members: request.members.map(({ occurrenceId }) => ({ ...target, occurrenceId })),
                    purpose: 'PRICING',
                  },
                  predicateRef,
                  verificationRef: 'catalog:test:verification',
                },
              });
            }).pipe(Effect.orDie),
          executeCompatibility: (request, credential) =>
            Effect.gen(function* observeCompatibilityCredential() {
              expect(request.handoff.selection).toEqual(line.catalog.selection);
              observedCredentials.push(Redacted.value(credential));
              return yield* Effect.die('TEST stop after both actual owner-client attempt boundaries');
            }),
          issuer: {
            issue: () =>
              Effect.sync(() => {
                issued += 1;
                return { baseUrl: new URL('http://127.0.0.1:1225'), credential: Redacted.make(`TEST:${issued}`) };
              }),
          },
        },
        customerContext: { execute: () => Effect.never, issuer: { issue: () => Effect.never } },
        market: { execute: () => Effect.never, issuer: { issue: () => Effect.never } },
        validation: makePricingExternalOwnerEvidenceValidationService(),
      },
    );
    yield* port.loadFresh(input).pipe(Effect.exit);
    expect(observedCredentials).toEqual(['TEST:1', 'TEST:2']);
    expect(issued).toBe(2);
    return yield* Effect.void;
  }),
);

it.effect('actual Catalog reader reaches compatibility with a later unchanged owner observation #1225', () =>
  Effect.gen(function* laterCatalogObservation() {
    const input = yield* inputFixture();
    const [line] = input.request.decision.lines;
    if (line === undefined) {
      return yield* Effect.die('TEST fixture requires one line');
    }
    const effectiveAt = input.request.decision.operationTime;
    const observedAt = DateTime.formatIso(DateTime.add(DateTime.makeUnsafe(effectiveAt), { milliseconds: 500 }));
    const freshLine = yield* Schema.decodeEffect(PricingLineSchema)({
      ...line,
      catalog: {
        ...line.catalog,
        completeness: { ...line.catalog.completeness, observedAt },
        evidence: {
          ...line.catalog.evidence,
          assessedAt: observedAt,
          membership: {
            ...line.catalog.evidence.membership,
            attestationId: 'f3333333-3333-4333-8333-333333333333',
            observedAt,
          },
        },
      },
    });
    const freshHandoff = freshLine.catalog;
    const validThrough = '2099-01-01T00:00:00.000Z';
    const generation = 'catalog:test:initial-generation';
    const predicateRef = 'catalog:test:equivalence-predicate';
    const target = {
      quantityBasis: freshHandoff.quantityBasis,
      requestedQuantity: freshHandoff.quantity.requested,
      selection: freshHandoff.selection,
    };
    const observedCredentials: string[] = [];
    let issued = 0;
    const port = makeCurrentPricingDecisionExternalOwnerEvidenceLivePort(
      {
        compositionRevision: 'test:1225',
        legalEntityId: input.request.decision.commercialScope.sellingLegalEntityId,
        requestCorrelation: 'test:1225',
        tenantId: input.request.decision.tenantId,
      },
      {
        applicationComposition: { load: Effect.never },
        catalog: {
          execute: (request, credential) =>
            Effect.gen(function* confirmedSingleton() {
              observedCredentials.push(Redacted.value(credential));
              return yield* Schema.decodeUnknownEffect(PricingPurposeEquivalenceResponseSchema)({
                assessments: [
                  { handoff: freshHandoff, role: 'ANCHOR' },
                  ...request.members.map(({ occurrenceId }) => ({
                    handoff: freshHandoff,
                    occurrenceId,
                    role: 'MEMBER',
                  })),
                ],
                currentness: { effectiveAt, observedAt, status: 'CURRENT', validThrough },
                currentnessEvidence: {
                  effectiveAt,
                  generation,
                  observedAt,
                  predicateRef,
                  revalidatedAt: observedAt,
                  validThrough,
                  verificationMode: 'OWNER_CURRENT_QUANTITY_REVALIDATED',
                },
                evidence: {
                  anchorSelection: freshHandoff.selection,
                  assessmentId: 'catalog:test:assessment',
                  effectiveAt,
                  members: request.members.map(({ occurrenceId }) => ({
                    occurrenceId,
                    selection: freshHandoff.selection,
                  })),
                  observedAt,
                  ownerModuleId: 'commerce.catalog',
                  ownerRevision: 'catalog:test:owner-revision',
                  purpose: 'PRICING',
                  status: 'CONFIRMED',
                  validThrough,
                },
                generation,
                outcome: 'CATALOG_EQUIVALENCE_CONFIRMED',
                verificationReceipt: {
                  generation,
                  issuedAt: observedAt,
                  ownerModuleId: 'commerce.catalog',
                  ownerRevision: 'catalog:test:owner-revision',
                  predicate: {
                    anchor: target,
                    effectiveAt,
                    members: request.members.map(({ occurrenceId }) => ({ ...target, occurrenceId })),
                    purpose: 'PRICING',
                  },
                  predicateRef,
                  verificationRef: 'catalog:test:verification',
                },
              });
            }).pipe(Effect.orDie),
          executeCompatibility: (request, credential) =>
            Effect.gen(function* observeCompatibilityCredential() {
              expect(request.handoff.selection).toEqual(freshHandoff.selection);
              expect(request.effectiveAt).toBe(observedAt);
              observedCredentials.push(Redacted.value(credential));
              return yield* Effect.die('TEST stop after both actual owner-client attempt boundaries');
            }),
          issuer: {
            issue: () =>
              Effect.sync(() => {
                issued += 1;
                return { baseUrl: new URL('http://127.0.0.1:1225'), credential: Redacted.make(`TEST:${issued}`) };
              }),
          },
        },
        customerContext: { execute: () => Effect.never, issuer: { issue: () => Effect.never } },
        market: { execute: () => Effect.never, issuer: { issue: () => Effect.never } },
        validation: makePricingExternalOwnerEvidenceValidationService(),
      },
    );
    let failureReason: string | undefined;
    yield* port.loadFresh(input).pipe(
      Effect.tapError((failure) =>
        Effect.sync(() => {
          failureReason = failure.reason;
        }),
      ),
      Effect.exit,
    );
    expect(failureReason).toBeUndefined();
    expect(observedCredentials).toEqual(['TEST:1', 'TEST:2']);
    expect(issued).toBe(2);
    return yield* Effect.void;
  }),
);

describe('native generated Market client wire boundary #1250', () => {
  for (const invalidObservedAt of [false, true]) {
    it.effect(`preserves actual client dates for strict readers; invalid wire=${invalidObservedAt}`, () =>
      Effect.gen(function* preservesGeneratedMarketClientWire() {
        const rawRequest = {
          commercialScope: {
            channel: 'B2C',
            marketRef: {
              moduleId: 'commerce.market-catalog',
              resourceId: 'market:1250',
              resourceType: 'commerce.market-catalog.market',
              tenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            },
            sellingLegalEntityRef: {
              moduleId: 'core.identity',
              resourceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
              resourceType: 'core.identity.legal-entity',
              tenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            },
          },
          effectiveAt: '2026-10-22T10:00:00.000Z',
          requestedAt: '2026-10-22T10:00:00.000Z',
        };
        const request = yield* Schema.decodeUnknownEffect(PricingCurrentMarketEvidenceRequestSchema)(rawRequest);
        const wireResponse = {
          observedAt: invalidObservedAt ? 'not-an-instant' : '2026-10-22T10:00:01.000Z',
          outcome: 'PRICING_MARKET_SOURCE_MISSING',
          reason: 'The native owner has no complete source set',
          request: rawRequest,
        };
        const responseBody = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(wireResponse);
        let requests = 0;
        const fetchClient: typeof globalThis.fetch = (url) => {
          requests += 1;
          expect(new Request(url).url).toContain('/reads/pricing-current-market-evidence');
          return Promise.resolve(new Response(responseBody, { headers: { 'content-type': 'application/json' } }));
        };
        const actual = executeMarket(request, Redacted.make('test-native-1250'), 'test-native-1250', {
          baseUrl: new URL('https://market-native.invalid/commerce-market-catalog-api'),
          compositionRevision: 'test-native-1250',
        }).pipe(Effect.provideService(FetchHttpClient.Fetch, fetchClient));
        if (invalidObservedAt) {
          const exit = yield* Effect.exit(actual);
          expect(Exit.isFailure(exit)).toBe(true);
        } else {
          const encoded = yield* actual;
          expect(encoded).toMatchObject(wireResponse);
          // This is the same strict published decoder used by the real collection/final-fence reader.
          const decoded = yield* Schema.decodeUnknownEffect(PricingCurrentMarketEvidenceResponseSchema)(encoded);
          expect(decoded.outcome).toBe('PRICING_MARKET_SOURCE_MISSING');
          expect(DateTime.formatIso(decoded.request.effectiveAt)).toBe(rawRequest.effectiveAt);
        }
        expect(requests).toBe(1);
      }),
    );
  }
});
