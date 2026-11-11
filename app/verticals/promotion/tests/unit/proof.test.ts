import { DateTime, Effect, Option, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  PromotionEvaluationRequestSchema,
  PromotionExternalFactsSchema,
  PromotionIssuedProofSchema,
  PromotionMerchandiseResultSchema,
} from '../../shared/apis/preview-promotions.ts';
import { PromotionLifecycleRecordSchema } from '../../src/services/lifecycle.service.ts';
import {
  createPromotionCompletenessEvidence,
  nextPromotionProofBoundary,
  PromotionProofFailure,
  promotionProofPredicateRef,
  verifyPromotionProof,
} from '../../src/services/proof.service.ts';
import type { PromotionProofOwnerPort, PromotionProofVerification } from '../../src/services/proof.service.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const otherId = '22222222-2222-4222-8222-222222222222';
const applicationId = '33333333-3333-4333-8333-333333333333';
const proofId = '44444444-4444-4444-8444-444444444444';
const shippingProofId = '55555555-5555-4555-8555-555555555555';
const at = DateTime.makeUnsafe('2026-11-06T10:00:00Z');
const until = DateTime.makeUnsafe('2026-11-06T12:00:00Z');
const selection = {
  productRef: {
    moduleId: 'commerce.catalog',
    resourceId: tenantId,
    resourceType: 'commerce.catalog.product',
    tenantId,
  },
  variantRef: {
    moduleId: 'commerce.catalog',
    resourceId: tenantId,
    resourceType: 'commerce.catalog.variant',
    tenantId,
  },
};
const occurrence = {
  occurrenceId: 'line-A',
  quantity: {
    amount: '1',
    unitRef: {
      moduleId: 'commerce.catalog',
      resourceId: tenantId,
      resourceType: 'commerce.catalog.product-unit',
      tenantId,
    },
  },
  selection,
};
const purchase = {
  commercialScope: { channelId: 'B2C', marketId: 'cz', sellingLegalEntityId: tenantId },
  currencyCode: 'CZK',
  occurrences: [occurrence, { ...occurrence, occurrenceId: 'line-B' }],
  purchaseRef: 'exact-purchase-1',
  purchasingContext: {
    accessDecision: { decisionRef: 'access', decisionRevision: '1' },
    actor: { guestEvidenceRef: 'guest-evidence', guestSessionRef: 'guest-session', kind: 'GUEST' },
    commercialSettingsDecision: { decisionRef: 'settings', decisionRevision: '1' },
    contextRef: 'purchase-context',
    contextRevision: '1',
    currencyResolution: { currencyCode: 'CZK', resolutionRef: 'currency', resolutionRevision: '1' },
    subject: { guestEvidenceRef: 'guest-evidence', guestSessionRef: 'guest-session', kind: 'GUEST' },
  },
  tenantId,
};
const basis = {
  currencyCode: 'CZK',
  evidenceRef: 'basis-evidence',
  mode: 'GROSS_TAX_INCLUSIVE',
  purchaseRef: purchase.purchaseRef,
  source: { kind: 'B2C_LAUNCH', reference: 'launch', revision: '1' },
};
const requestInput = { purchase, voucherChoices: { product: [{ occurrenceId: 'line-A', voucherId: tenantId }] } };
const application = {
  activation: 'VOUCHER',
  allocations: [],
  applicationId,
  appliedBenefit: '10',
  configuredBenefit: { kind: 'PERCENTAGE', percentage: '10' },
  currencyCode: 'CZK',
  eligibleBasis: '100',
  layer: 'PRODUCT',
  occurrenceId: 'line-A',
  promotionRef: {
    moduleId: 'commerce.promotion',
    resourceId: tenantId,
    resourceType: 'commerce.promotion.promotion',
    tenantId,
  },
  voucherRef: {
    moduleId: 'commerce.promotion',
    resourceId: tenantId,
    resourceType: 'commerce.promotion.voucher',
    tenantId,
  },
};

/** Owner-local acceptance doubles exercise verification; they are not production Pricing/Delivery integrations. */
const fixture = Effect.fn('ProofTest.fixture')(function* fixture() {
  const request = yield* Schema.decodeUnknownEffect(PromotionEvaluationRequestSchema)(requestInput);
  const sourceLines = request.purchase.occurrences.map((line) => ({ inputAmount: '100', occurrence: line }));
  const merchandise = yield* Schema.decodeUnknownEffect(PromotionMerchandiseResultSchema)({
    applications: [application],
    basis,
    completeness: 'COMPLETE_MERCHANDISE_MONETARY',
    lines: sourceLines.map((line, index) => ({ ...line, exactRemainingAmount: index === 0 ? '90' : '100' })),
    notApplicable: [],
    operationAt: DateTime.formatIso(at),
    outcome: 'APPLIED',
    purchase: request.purchase,
    shipping: 'UNRESOLVED',
    voucherChoices: request.voucherChoices,
  });
  const facts = yield* Schema.decodeUnknownEffect(PromotionExternalFactsSchema)({
    basisDecision: {
      authorityFingerprint: 'authority:agreements-vat-and-policy:1',
      basis,
      evidenceRef: 'basis-owner:1',
      observedAt: DateTime.formatIso(at),
      ownerRevision: '1',
      purchase,
      purchaseRef: purchase.purchaseRef,
      tenantId,
      validUntil: DateTime.formatIso(until),
    },
    merchandiseSource: {
      evidenceRef: 'price-source:1',
      lines: sourceLines,
      mode: basis.mode,
      observedAt: DateTime.formatIso(at),
      ownerRevision: '1',
      purchase,
      purchaseRef: purchase.purchaseRef,
      tenantId,
      validUntil: DateTime.formatIso(until),
    },
  });
  const completenessEvidence = yield* createPromotionCompletenessEvidence(request, 5, at, Option.some(until));
  const record = yield* Schema.decodeUnknownEffect(Schema.toType(PromotionIssuedProofSchema))({
    actorPrincipalId: tenantId,
    completenessEvidence,
    externalFacts: facts,
    generation: 5,
    invocationId: otherId,
    issuedAt: at,
    merchandise,
    monetaryRanking: { orderedPromotionIds: [], policyRevision: 0 },
    proofId,
    request,
    stage: 'MERCHANDISE',
    tenantId,
  });
  const records = [record];
  const port: PromotionProofOwnerPort = {
    currentGeneration: () => Effect.succeed(5),
    loadProof: (tenant, id) =>
      Effect.succeed(
        Option.fromUndefinedOr(records.find((candidate) => candidate.tenantId === tenant && candidate.proofId === id)),
      ),
    verifyExternalFacts: (expected) => Effect.succeed(expected),
  };
  const input: PromotionProofVerification = {
    at,
    claim: 'CURRENT',
    handle: { proofId, tenantId },
    presented: Option.none(),
    request,
  };
  return { facts, input, merchandise, port, record, records, request };
});

type Fixture = Effect.Success<ReturnType<typeof fixture>>;
const shippingFixture = Effect.fn('ProofTest.shippingFixture')(function* shippingFixture(f: Fixture) {
  const shippingAt = DateTime.makeUnsafe('2026-11-06T10:15:00Z');
  const factBinding = {
    observedAt: DateTime.formatIso(at),
    ownerRevision: '1',
    purchase: f.request.purchase,
    purchaseRef: f.request.purchase.purchaseRef,
    tenantId,
    validUntil: DateTime.formatIso(until),
  };
  const deliveryRef = {
    moduleId: 'delivery.offer',
    resourceId: 'chosen-offer',
    resourceType: 'delivery.offer',
    tenantId,
  };
  const methodRef = { ...deliveryRef, resourceId: 'method-A', resourceType: 'delivery.method' };
  const facts = yield* Schema.decodeUnknownEffect(PromotionExternalFactsSchema)({
    ...(yield* Schema.encodeEffect(PromotionExternalFactsSchema)(f.facts)),
    delivery: { ...factBinding, evidenceRef: 'selected-delivery:1', methodRef, offerRef: deliveryRef },
    publication: {
      ...factBinding,
      amount: '190',
      currencyCode: 'CZK',
      evidenceRef: 'published-gross:1',
      merchandiseProofId: proofId,
      mode: 'GROSS_TAX_INCLUSIVE',
    },
  });
  const evidence = yield* createPromotionCompletenessEvidence(f.request, 5, shippingAt, Option.some(until));
  const record = yield* Schema.decodeUnknownEffect(Schema.toType(PromotionIssuedProofSchema))({
    ...f.record,
    completenessEvidence: evidence,
    externalFacts: facts,
    issuedAt: shippingAt,
    proofId: shippingProofId,
    shipping: {
      application: {
        activation: 'AUTOMATIC',
        allowedMethodRefs: [methodRef],
        applicationId: otherId,
        benefit: 'FREE_SHIPPING',
        effectivePeriod: { from: at, to: until },
        minimumMerchandise: { amount: '190', currencyCode: 'CZK' },
        minimumOutcome: 'MET',
        promotionRef: { ...application.promotionRef, resourceId: otherId },
      },
      completeness: 'COMPLETE_PROMOTION_SHIPPING_ENTITLEMENT',
      delivery: facts.delivery,
      merchandiseApplicationIds: [applicationId],
      merchandiseProofId: proofId,
      operationAt: shippingAt,
      outcome: 'APPLIED',
      publication: facts.publication,
      purchase: f.request.purchase,
      shippingAmount: 'OWNED_BY_DELIVERY',
      shippingRanking: { orderedPromotionIds: [otherId], policyRevision: 1 },
    },
    stage: 'SHIPPING',
  });
  f.records.push(record);
  return { input: { ...f.input, at: shippingAt, handle: { proofId: shippingProofId, tenantId } }, record };
});

describe('Owner-issued Promotion proof component', () => {
  it.effect('roundtrips the full attributable set and replays original application/occurrence identities', () =>
    Effect.gen(function* roundtrip() {
      const f = yield* fixture();
      const encoded = yield* Schema.encodeEffect(PromotionIssuedProofSchema)(f.record);
      const decoded = yield* Schema.decodeUnknownEffect(PromotionIssuedProofSchema)(encoded);
      const replay = yield* verifyPromotionProof(f.port, { ...f.input, presented: Option.some(decoded) });
      expect(replay.claim).toBe('CURRENT');
      expect(replay.proof.merchandise.applications.map((entry) => entry.applicationId)).toEqual([applicationId]);
      expect(replay.proof.merchandise.lines.map((line) => line.occurrence.occurrenceId)).toEqual(['line-A', 'line-B']);
      expect(yield* Schema.encodeEffect(PromotionIssuedProofSchema)(replay.proof)).toEqual(encoded);
    }),
  );

  it.effect('does not treat a reproducible content fingerprint as issuance authenticity', () =>
    Effect.gen(function* forgedAndModified() {
      const f = yield* fixture();
      expect(yield* promotionProofPredicateRef(f.request)).toBe(f.record.completenessEvidence.scope.predicateRef);
      expect(
        (yield* Effect.flip(verifyPromotionProof(f.port, { ...f.input, handle: { proofId: otherId, tenantId } }))).code,
      ).toBe('FORGED');
      const modified = {
        ...f.record,
        merchandise: { ...f.merchandise, applications: [{ ...f.merchandise.applications[0], appliedBenefit: '99' }] },
      };
      const presented = yield* Schema.decodeUnknownEffect(Schema.toType(PromotionIssuedProofSchema))(modified);
      expect(
        (yield* Effect.flip(verifyPromotionProof(f.port, { ...f.input, presented: Option.some(presented) }))).code,
      ).toBe('MISMATCH');
      expect(
        (yield* Effect.flip(verifyPromotionProof(f.port, { ...f.input, handle: { proofId, tenantId: otherId } }))).code,
      ).toBe('FORGED');
    }),
  );

  it.effect('invalidates full purchase insertions, removals, quantity/unit, selection and subject changes', () =>
    Effect.gen(function* exactBindingMutations() {
      const f = yield* fixture();
      const changes = [
        { ...purchase, occurrences: [...purchase.occurrences, { ...occurrence, occurrenceId: 'line-C' }] },
        { ...purchase, occurrences: [occurrence] },
        {
          ...purchase,
          occurrences: [{ ...occurrence, quantity: { ...occurrence.quantity, amount: '2' } }, purchase.occurrences[1]],
        },
        {
          ...purchase,
          occurrences: [
            {
              ...occurrence,
              quantity: { ...occurrence.quantity, unitRef: { ...occurrence.quantity.unitRef, resourceId: otherId } },
            },
            purchase.occurrences[1],
          ],
        },
        {
          ...purchase,
          occurrences: [
            {
              ...occurrence,
              selection: { ...selection, variantRef: { ...selection.variantRef, resourceId: otherId } },
            },
            purchase.occurrences[1],
          ],
        },
        { ...purchase, commercialScope: { ...purchase.commercialScope, marketId: 'sk' } },
        {
          ...purchase,
          purchasingContext: {
            ...purchase.purchasingContext,
            actor: { ...purchase.purchasingContext.actor, guestSessionRef: 'other-session' },
            subject: { ...purchase.purchasingContext.subject, guestSessionRef: 'other-session' },
          },
        },
      ];
      for (const changed of changes) {
        const request = yield* Schema.decodeUnknownEffect(PromotionEvaluationRequestSchema)({
          ...requestInput,
          purchase: changed,
        });
        expect((yield* Effect.flip(verifyPromotionProof(f.port, { ...f.input, request }))).code).toBe('MISMATCH');
      }
      expect(
        yield* Effect.flip(
          Schema.decodeUnknownEffect(PromotionEvaluationRequestSchema)({
            ...requestInput,
            purchase: { ...purchase, currencyCode: 'EUR' },
          }),
        ),
      ).toBeDefined();
    }),
  );

  it.effect(
    'invalidates broader owner generations and external basis/source revisions while preserving authentic history',
    () =>
      Effect.gen(function* currentAndHistorical() {
        const f = yield* fixture();
        const changed: PromotionProofOwnerPort = { ...f.port, currentGeneration: () => Effect.succeed(6) };
        expect((yield* Effect.flip(verifyPromotionProof(changed, f.input))).code).toBe('STALE');
        const changedAuthority: PromotionProofOwnerPort = {
          ...f.port,
          verifyExternalFacts: (facts) =>
            Effect.succeed({
              ...facts,
              basisDecision: { ...facts.basisDecision, authorityFingerprint: 'agreement-or-vat-change' },
            }),
        };
        expect((yield* Effect.flip(verifyPromotionProof(changedAuthority, f.input))).code).toBe('STALE');
        const changedPrices: PromotionProofOwnerPort = {
          ...f.port,
          verifyExternalFacts: (facts) =>
            Effect.succeed({ ...facts, merchandiseSource: { ...facts.merchandiseSource, ownerRevision: '2' } }),
        };
        expect((yield* Effect.flip(verifyPromotionProof(changedPrices, f.input))).code).toBe('STALE');
        const unavailable: PromotionProofOwnerPort = {
          ...changed,
          verifyExternalFacts: () =>
            Effect.fail(new PromotionProofFailure({ code: 'UNAVAILABLE', reason: 'External authority unavailable' })),
        };
        const history = yield* verifyPromotionProof(unavailable, {
          ...f.input,
          at: DateTime.makeUnsafe('2027-01-01T10:00:00Z'),
          claim: 'HISTORICAL',
        });
        expect(history.claim).toBe('AUTHENTIC_HISTORICAL');
        expect(history.proof.merchandise.applications[0]?.applicationId).toBe(applicationId);
        expect(
          (yield* Effect.flip(
            verifyPromotionProof({ ...f.port, verifyExternalFacts: unavailable.verifyExternalFacts }, f.input),
          )).code,
        ).toBe('UNAVAILABLE');
      }),
  );

  it.effect('captures future validity of all owner offers rather than only selected rows', () =>
    Effect.gen(function* futureOwnerBoundary() {
      const f = yield* fixture();
      const future = yield* Schema.decodeUnknownEffect(PromotionLifecycleRecordSchema)({
        createdAt: DateTime.formatIso(at),
        meaning: {
          activation: 'AUTOMATIC',
          benefit: { kind: 'PERCENTAGE', percentage: '50' },
          displayName: 'Future offer',
          effectivePeriod: { from: '2026-11-06T10:30:00Z' },
          eligibility: { commercialScopes: [purchase.commercialScope] },
          family: 'AUTOMATIC_CART',
          target: 'MERCHANDISE_CART',
        },
        promotionId: otherId,
        publishedAt: DateTime.formatIso(at),
        status: 'PUBLISHED',
        technicalVersion: 2,
        updatedAt: DateTime.formatIso(at),
      });
      const boundary = nextPromotionProofBoundary([future], f.facts, at);
      const evidence = yield* createPromotionCompletenessEvidence(f.request, 5, at, boundary);
      const record = { ...f.record, completenessEvidence: evidence };
      const port: PromotionProofOwnerPort = { ...f.port, loadProof: () => Effect.succeed(Option.some(record)) };
      expect(
        (yield* Effect.flip(
          verifyPromotionProof(port, { ...f.input, at: DateTime.makeUnsafe('2026-11-06T10:30:00Z') }),
        )).code,
      ).toBe('STALE');
      expect((yield* Effect.flip(verifyPromotionProof(f.port, { ...f.input, at: until }))).code).toBe('STALE');
    }),
  );

  it.effect('rejects incomplete original occurrences and noncanonical application cardinality in stored evidence', () =>
    Effect.gen(function* incompleteSnapshots() {
      const f = yield* fixture();
      const missing = { ...f.record, merchandise: { ...f.merchandise, lines: f.merchandise.lines.slice(0, 1) } };
      const duplicate = {
        ...f.record,
        merchandise: { ...f.merchandise, applications: [...f.merchandise.applications, ...f.merchandise.applications] },
      };
      for (const record of [missing, duplicate]) {
        const port: PromotionProofOwnerPort = { ...f.port, loadProof: () => Effect.succeed(Option.some(record)) };
        expect((yield* Effect.flip(verifyPromotionProof(port, f.input))).code).toBe('INCOMPLETE');
      }
    }),
  );

  it.effect(
    'joins Shipping to the same authentic monetary applications and authoritative publication without claiming Shipping price',
    () =>
      Effect.gen(function* shippingLineage() {
        const f = yield* fixture();
        const shipping = yield* shippingFixture(f);
        const encoded = yield* Schema.encodeEffect(PromotionIssuedProofSchema)(shipping.record);
        const decoded = yield* Schema.decodeUnknownEffect(PromotionIssuedProofSchema)(encoded);
        const replay = yield* verifyPromotionProof(f.port, { ...shipping.input, presented: Option.some(decoded) });
        expect(replay.proof.stage).toBe('SHIPPING');
        expect(replay.proof.merchandise).toEqual(f.record.merchandise);
        if (replay.proof.stage === 'SHIPPING') {
          expect(replay.proof.shipping.merchandiseApplicationIds).toEqual([applicationId]);
          expect(replay.proof.shipping.merchandiseProofId).toBe(proofId);
          expect(replay.proof.shipping.shippingAmount).toBe('OWNED_BY_DELIVERY');
          expect(replay.proof.shipping.application?.minimumOutcome).toBe('MET');
        }
        expect(f.records).toHaveLength(2);
        expect((yield* verifyPromotionProof(f.port, f.input)).proof.stage).toBe('MERCHANDISE');
      }),
  );

  it.effect('rejects wrong monetary lineage, NET fallback, and changed Delivery/publication revisions', () =>
    Effect.gen(function* shippingMutations() {
      const f = yield* fixture();
      const shipping = yield* shippingFixture(f);
      if (shipping.record.stage !== 'SHIPPING') {
        return yield* Effect.die('Shipping fixture must retain its stage');
      }
      const wrongLineage = {
        ...shipping.record,
        shipping: { ...shipping.record.shipping, merchandiseProofId: otherId },
      };
      const { publication: _publication, ...withoutPublication } = shipping.record.shipping;
      const missingPublication = {
        ...shipping.record,
        externalFacts: {
          basisDecision: f.facts.basisDecision,
          delivery: shipping.record.externalFacts.delivery,
          merchandiseSource: f.facts.merchandiseSource,
        },
        shipping: withoutPublication,
      };
      const netPublication = {
        ...shipping.record,
        externalFacts: {
          ...shipping.record.externalFacts,
          publication: { ...shipping.record.externalFacts.publication, mode: 'NET_TAX_EXCLUSIVE' },
        },
        shipping: {
          ...shipping.record.shipping,
          publication: { ...shipping.record.shipping.publication, mode: 'NET_TAX_EXCLUSIVE' },
        },
      };
      for (const invalid of [wrongLineage, missingPublication, netPublication]) {
        const record = yield* Schema.decodeUnknownEffect(Schema.toType(PromotionIssuedProofSchema))(invalid);
        const port: PromotionProofOwnerPort = {
          ...f.port,
          loadProof: (tenant, id) =>
            id === shippingProofId ? Effect.succeed(Option.some(record)) : f.port.loadProof(tenant, id),
        };
        const error = yield* Effect.flip(verifyPromotionProof(port, shipping.input));
        expect(['MISMATCH', 'UNVERIFIABLE']).toContain(error.code);
      }
      for (const fact of ['delivery', 'publication'] as const) {
        const changed: PromotionProofOwnerPort = {
          ...f.port,
          verifyExternalFacts: (facts) => Effect.succeed({ ...facts, [fact]: { ...facts[fact], ownerRevision: '2' } }),
        };
        expect((yield* Effect.flip(verifyPromotionProof(changed, shipping.input))).code).toBe('STALE');
      }
      return yield* Effect.void;
    }),
  );

  it.effect('preserves an absent Shipping minimum without requiring or inventing a publication threshold', () =>
    Effect.gen(function* absentShippingMinimum() {
      const f = yield* fixture();
      const shipping = yield* shippingFixture(f);
      if (shipping.record.stage !== 'SHIPPING' || shipping.record.shipping.application === undefined) {
        return yield* Effect.die('Shipping fixture must have its attributable application');
      }
      const { minimumMerchandise: _minimum, ...withoutMinimum } = shipping.record.shipping.application;
      const { publication: _publication, ...withoutPublication } = shipping.record.shipping;
      const record = yield* Schema.decodeUnknownEffect(Schema.toType(PromotionIssuedProofSchema))({
        ...shipping.record,
        externalFacts: {
          basisDecision: f.facts.basisDecision,
          delivery: shipping.record.externalFacts.delivery,
          merchandiseSource: f.facts.merchandiseSource,
        },
        shipping: { ...withoutPublication, application: { ...withoutMinimum, minimumOutcome: 'NOT_CONFIGURED' } },
      });
      const port: PromotionProofOwnerPort = {
        ...f.port,
        loadProof: (tenant, id) =>
          id === shippingProofId ? Effect.succeed(Option.some(record)) : f.port.loadProof(tenant, id),
      };
      expect((yield* verifyPromotionProof(port, shipping.input)).claim).toBe('CURRENT');
      const malformed = {
        ...shipping.record,
        shipping: {
          ...shipping.record.shipping,
          application: { ...shipping.record.shipping.application, minimumOutcome: 'NOT_CONFIGURED' },
        },
      };
      expect(
        yield* Effect.flip(Schema.decodeUnknownEffect(Schema.toType(PromotionIssuedProofSchema))(malformed)),
      ).toBeDefined();
      return yield* Effect.void;
    }),
  );
});
