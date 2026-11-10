import { ActionAlreadyCommitted, ReadPermissionDenied, ReadPermissionUnavailable, runAction } from '@app/core-runtime';
import { DateTime, Effect, Option, Schema, Struct } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { PromotionEvaluationRequestSchema } from '../../shared/apis/preview-promotions.ts';
import type {
  PromotionEvaluationRequest,
  PreviewPromotionsRequestSchema,
} from '../../shared/apis/preview-promotions.ts';
import { previewPromotionsRead } from '../../src/api/preview-promotions.read.ts';
import { createPromotionDraftAction } from '../../src/actions/create-promotion-draft.action.ts';
import { issuePromotionProofAction } from '../../src/actions/issue-promotion-proof.action.ts';
import { provisionVoucherAction } from '../../src/actions/provision-voucher.action.ts';
import { promotionPersistenceFactory } from '../../src/services/persistence.service.ts';
import { resolveVoucherChoice } from '../../src/services/voucher.service.ts';
import type { VoucherOwnerPort } from '../../src/services/voucher.service.ts';
import { publishPromotionAction } from '../../src/actions/publish-promotion.action.ts';
import { retirePromotionAction } from '../../src/actions/retire-promotion.action.ts';
import { setCartRankingAction } from '../../src/actions/set-cart-ranking.action.ts';
import { setShippingRankingAction } from '../../src/actions/set-shipping-ranking.action.ts';
import {
  PromotionEvaluationFailure,
  PromotionExternalFactSource,
  promotionEvaluationFactory,
  promotionSubjectBinding,
} from '../../src/services/evaluation.service.ts';
import type { PromotionExternalFactPort } from '../../src/services/evaluation.service.ts';
import { PromotionProofFailure, verifyPromotionProof } from '../../src/services/proof.service.ts';
import { createNativeManagementFixture } from '../support/management.fixture.ts';
import { nativeServices, nextId } from '../support/persistence.fixture.ts';

const reason = 'Native C18 evaluator acceptance; future external producers are owner-port doubles';
type NativeFixture = Effect.Success<ReturnType<typeof createNativeManagementFixture>>['fixture'];
const purchaseRequest = Effect.fn('EvaluationNativeTest.purchase')(function* purchase(fixture: NativeFixture) {
  const productId = yield* nextId;
  const unitId = yield* nextId;
  const occurrenceId = yield* nextId;
  const { tenantId } = fixture.principal;
  return yield* Schema.decodeUnknownEffect(PromotionEvaluationRequestSchema)({
    purchase: {
      commercialScope: { channelId: 'B2C', marketId: 'cz', sellingLegalEntityId: fixture.principal.legalEntityId },
      currencyCode: 'CZK',
      occurrences: [
        {
          occurrenceId,
          quantity: {
            amount: '1',
            unitRef: {
              moduleId: 'commerce.catalog',
              resourceId: unitId,
              resourceType: 'commerce.catalog.product-unit',
              tenantId,
            },
          },
          selection: {
            productRef: {
              moduleId: 'commerce.catalog',
              resourceId: productId,
              resourceType: 'commerce.catalog.product',
              tenantId,
            },
            variantRef: {
              moduleId: 'commerce.catalog',
              resourceId: productId,
              resourceType: 'commerce.catalog.variant',
              tenantId,
            },
          },
        },
      ],
      purchaseRef: yield* nextId,
      purchasingContext: {
        accessDecision: { decisionRef: 'native-owner-access', decisionRevision: '1' },
        actor: { guestEvidenceRef: 'native-guest-evidence', guestSessionRef: 'native-guest-session', kind: 'GUEST' },
        commercialSettingsDecision: { decisionRef: 'native-settings', decisionRevision: '1' },
        contextRef: 'native-context',
        contextRevision: '1',
        currencyResolution: { currencyCode: 'CZK', resolutionRef: 'native-currency', resolutionRevision: '1' },
        subject: { guestEvidenceRef: 'native-guest-evidence', guestSessionRef: 'native-guest-session', kind: 'GUEST' },
      },
      tenantId,
    },
    voucherChoices: { product: [] },
  });
});

/** Only future Pricing/TAX/Delivery authority ports are doubled; Core Actions, RLS, persistence and all owner services are real. */
const ownerAcceptanceSource = Effect.fn('EvaluationNativeTest.externalSource')(function* externalSource(
  request: PromotionEvaluationRequest,
) {
  const subjectRef = yield* promotionSubjectBinding(request.purchase);
  const controls = { available: true, publicationAmount: '900', publishedGross: true };
  const source: PromotionExternalFactPort = {
    loadMerchandise: (purchase, at, tenantRules) => {
      if (!controls.available) {
        return Effect.fail(
          new PromotionEvaluationFailure({
            code: 'UNAVAILABLE',
            reason: 'Acceptance authority deliberately unavailable',
          }),
        );
      }
      const validUntil = DateTime.add(at, { hours: 1 });
      return Effect.succeed({
        authority: {
          agreements: [],
          agreementsComplete: true,
          businessKind: 'B2C',
          buyerVatStatus: 'REGISTERED',
          evidenceRef: 'native-basis-authority:1',
          kind: 'CURRENT',
          observedAt: at,
          purchaseRef: purchase.purchaseRef,
          sellerVatStatus: 'REGISTERED',
          sellingLegalEntityId: purchase.commercialScope.sellingLegalEntityId,
          subjectRef,
          tenantId: purchase.tenantId,
          tenantRules,
          tenantRulesComplete: true,
          validUntil,
        },
        source: {
          evidenceRef: 'native-merchandise-source:1',
          lines: purchase.occurrences.map((occurrence) => ({ inputAmount: '1000', occurrence })),
          mode: 'GROSS_TAX_INCLUSIVE',
          observedAt: at,
          ownerRevision: '1',
          purchase,
          purchaseRef: purchase.purchaseRef,
          tenantId: purchase.tenantId,
          validUntil,
        },
      });
    },
    loadShipping: (purchase, original, offerRef, at) => {
      const binding = {
        observedAt: at,
        ownerRevision: '1',
        purchase,
        purchaseRef: purchase.purchaseRef,
        tenantId: purchase.tenantId,
        validUntil: DateTime.add(at, { hours: 1 }),
      };
      return Effect.succeed({
        delivery: {
          ...binding,
          evidenceRef: 'native-selected-delivery:1',
          methodRef: { ...offerRef, resourceId: 'method-A', resourceType: 'delivery.method' },
          offerRef,
        },
        publication: Option.some({
          ...binding,
          amount: controls.publicationAmount,
          currencyCode: 'CZK',
          evidenceRef: 'native-owner-published-merchandise:1',
          merchandiseProofId: original.proofId,
          mode: controls.publishedGross ? 'GROSS_TAX_INCLUSIVE' : 'NET_TAX_EXCLUSIVE',
        }),
      });
    },
    verifyExternalFacts: (facts) =>
      controls.available
        ? Effect.succeed(facts)
        : Effect.fail(
            new PromotionEvaluationFailure({
              code: 'UNAVAILABLE',
              reason: 'Acceptance authority deliberately unavailable',
            }),
          ),
  };
  return { controls, source };
});

const verifyNativeCurrent = Effect.fn('EvaluationNativeTest.verifyCurrent')(function* verifyCurrent(
  fixture: NativeFixture,
  handle: { readonly proofId: string; readonly tenantId: string },
  request: PromotionEvaluationRequest,
) {
  return yield* fixture.prepareOwner((transaction, scope) =>
    promotionEvaluationFactory(transaction, scope).pipe(
      Effect.flatMap(
        Effect.fn('EvaluationNativeTest.currentProof')(function* currentProof(services) {
          const at = yield* services.persistence.operationAt;
          return yield* verifyPromotionProof(services.proofPort, {
            at,
            claim: 'CURRENT',
            handle,
            presented: Option.none(),
            request,
          });
        }),
      ),
    ),
  );
});
const voucherSnapshot = (fixture: NativeFixture) =>
  fixture.prepareOwner((transaction, scope) =>
    promotionPersistenceFactory(transaction, scope).pipe(
      Effect.flatMap((service) =>
        Effect.all({ generation: service.generation(), vouchers: service.loadVouchers() }, { concurrency: 1 }),
      ),
    ),
  );
const resolveNativeProductCode = (fixture: NativeFixture, request: PromotionEvaluationRequest, enteredCode: string) =>
  fixture.prepareOwner(
    Effect.fn('EvaluationNativeTest.resolveProductCode')(function* resolveCode(
      transaction: Parameters<typeof promotionPersistenceFactory>[0],
      scope: Parameters<typeof promotionPersistenceFactory>[1],
    ) {
      const service = yield* promotionPersistenceFactory(transaction, scope);
      const { at, promotions, vouchers } = yield* Effect.all(
        { at: service.operationAt, promotions: service.loadPromotions(), vouchers: service.loadVouchers() },
        { concurrency: 1 },
      );
      const port: VoucherOwnerPort = {
        findPromotion: (tenant, id) =>
          Effect.succeed(
            tenant === scope.tenantId
              ? Option.map(
                  Option.fromUndefinedOr(promotions.find((promotion) => promotion.promotionId === id)),
                  (promotion) => ({ promotion, tenantId: tenant }),
                )
              : Option.none(),
          ),
        findVoucher: (tenant, code) =>
          Effect.succeed(
            tenant === scope.tenantId
              ? Option.map(
                  Option.fromUndefinedOr(vouchers.find((voucher) => voucher.normalizedCode === code)),
                  (voucher) => ({ tenantId: tenant, voucher }),
                )
              : Option.none(),
          ),
      };
      const occurrence = Option.getOrThrow(Option.fromUndefinedOr(request.purchase.occurrences[0]));
      return yield* resolveVoucherChoice(
        port,
        {
          at,
          commercialScope: request.purchase.commercialScope,
          target: { kind: 'PRODUCT', occurrence },
          tenantId: scope.tenantId,
        },
        enteredCode,
      );
    }),
  );

const previewNative = (fixture: NativeFixture, request: PromotionEvaluationRequest) =>
  fixture.prepareOwner((transaction, scope) =>
    promotionEvaluationFactory(transaction, scope).pipe(
      Effect.flatMap((services) => services.evaluation.evaluateMerchandise(request)),
    ),
  );
const loadNativeIssued = (fixture: NativeFixture, proofId: string) =>
  fixture.prepareOwner((transaction, scope) =>
    promotionPersistenceFactory(transaction, scope).pipe(Effect.flatMap((service) => service.loadIssuedProof(proofId))),
  );

const runOriginalPreview = Effect.fn('EvaluationNativeTest.originalPreviewRead')(function* originalPreviewRead(
  fixture: NativeFixture,
  input: typeof PreviewPromotionsRequestSchema.Type,
) {
  return yield* fixture.runtime.runRead({
    input,
    principal: fixture.principal,
    registration: previewPromotionsRead,
    transport: { correlationId: yield* nextId },
  });
});
const loadNativePromotion = (fixture: NativeFixture, promotionId: string) =>
  fixture.prepareOwner((transaction, scope) =>
    promotionPersistenceFactory(transaction, scope).pipe(
      Effect.flatMap((services) => services.loadPromotion(promotionId)),
    ),
  );

describe('Promotion evaluator through native Core Actions and PostgreSQL', () => {
  it.live('invalidates a proven empty set when an already ranked draft becomes a newly matching published offer', () =>
    Effect.gen(function* newlyMatchingPublication() {
      const { fixture } = yield* createNativeManagementFixture();
      const request = yield* purchaseRequest(fixture);
      const external = yield* ownerAcceptanceSource(request);
      const promotionId = yield* nextId;
      yield* Effect.forEach(
        [createPromotionDraftAction, setCartRankingAction, publishPromotionAction, issuePromotionProofAction],
        (action) => fixture.grantActionExecution(action),
        { concurrency: 1 },
      );
      yield* Effect.gen(function* nativeRuntime() {
        const ownerAt = yield* fixture.prepareOwner((transaction, scope) =>
          promotionEvaluationFactory(transaction, scope).pipe(
            Effect.flatMap((services) => services.persistence.operationAt),
          ),
        );
        const meaning = {
          activation: 'AUTOMATIC',
          benefit: { kind: 'PERCENTAGE', percentage: '10' },
          displayName: 'Newly matching publication',
          effectivePeriod: { from: DateTime.formatIso(DateTime.subtract(ownerAt, { minutes: 1 })) },
          eligibility: { commercialScopes: [request.purchase.commercialScope] },
          family: 'AUTOMATIC_CART',
          target: 'MERCHANDISE_CART',
        };
        yield* runAction({
          audience: 'promotion',
          payload: { meaning, promotionId, reason },
          principal: fixture.principal,
          registration: createPromotionDraftAction,
          transport: { correlationId: yield* nextId, idempotencyKey: yield* nextId },
        });
        yield* runAction({
          audience: 'promotion',
          payload: { expectedVersion: 0, orderedPromotionIds: [promotionId], reason },
          principal: Struct.omit(fixture.principal, ['legalEntityId']),
          registration: setCartRankingAction,
          transport: { correlationId: yield* nextId, idempotencyKey: yield* nextId },
        });
        const handle = yield* runAction({
          audience: 'promotion',
          payload: { reason, request, stage: 'MERCHANDISE' },
          principal: fixture.principal,
          registration: issuePromotionProofAction,
          transport: { correlationId: yield* nextId, idempotencyKey: yield* nextId },
        });
        const before = yield* fixture.prepareOwner((transaction, scope) =>
          promotionEvaluationFactory(transaction, scope).pipe(
            Effect.flatMap((services) => services.persistence.loadIssuedProof(handle.proofId)),
          ),
        );
        expect(Option.getOrThrow(before).merchandise.outcome).toBe('PROVEN_NONE');
        yield* runAction({
          audience: 'promotion',
          payload: { expectedVersion: 1, promotionId, reason },
          principal: fixture.principal,
          registration: publishPromotionAction,
          transport: { correlationId: yield* nextId, idempotencyKey: yield* nextId },
        });
        const stale = yield* Effect.flip(verifyNativeCurrent(fixture, handle, request));
        expect(Schema.is(PromotionProofFailure)(stale)).toBe(true);
        if (Schema.is(PromotionProofFailure)(stale)) {
          expect(stale.code).toBe('STALE');
        }
        const fresh = yield* runAction({
          audience: 'promotion',
          payload: { reason, request, stage: 'MERCHANDISE' },
          principal: fixture.principal,
          registration: issuePromotionProofAction,
          transport: { correlationId: yield* nextId, idempotencyKey: yield* nextId },
        });
        const after = yield* fixture.prepareOwner((transaction, scope) =>
          promotionEvaluationFactory(transaction, scope).pipe(
            Effect.flatMap((services) => services.persistence.loadIssuedProof(fresh.proofId)),
          ),
        );
        expect(
          Option.getOrThrow(after).merchandise.applications.map((application) => application.promotionRef.resourceId),
        ).toEqual([promotionId]);
        expect(Option.getOrThrow(before).merchandise.outcome).toBe('PROVEN_NONE');
      }).pipe(Effect.provide(fixture.context), Effect.provideService(PromotionExternalFactSource, external.source));
    }).pipe(Effect.provide(nativeServices)),
  );

  it.live(
    'persists authentic proven monetary absence and distinguishes an unavailable authority without Read writes',
    () =>
      Effect.gen(function* nativeNoPromotionProof() {
        const { fixture } = yield* createNativeManagementFixture();
        const request = yield* purchaseRequest(fixture);
        const external = yield* ownerAcceptanceSource(request);
        yield* fixture.grantActionExecution(issuePromotionProofAction);
        yield* Effect.gen(function* nativeRuntime() {
          const before = yield* fixture.prepareOwner((transaction, scope) =>
            promotionEvaluationFactory(transaction, scope).pipe(
              Effect.flatMap((services) => services.persistence.generation()),
            ),
          );
          expect(before).toBe(0);
          const preview = yield* fixture.prepareOwner((transaction, scope) =>
            promotionEvaluationFactory(transaction, scope).pipe(
              Effect.flatMap((services) => services.evaluation.evaluateMerchandise(request)),
            ),
          );
          expect(preview.result.outcome).toBe('PROVEN_NONE');
          expect(preview.result.shipping).toBe('UNRESOLVED');
          expect(
            yield* fixture.prepareOwner((transaction, scope) =>
              promotionEvaluationFactory(transaction, scope).pipe(
                Effect.flatMap((services) => services.persistence.generation()),
              ),
            ),
          ).toBe(0);
          const issuanceTransport = { correlationId: yield* nextId, idempotencyKey: yield* nextId };
          const handle = yield* runAction({
            audience: 'promotion',
            payload: { reason, request, stage: 'MERCHANDISE' },
            principal: fixture.principal,
            registration: issuePromotionProofAction,
            transport: issuanceTransport,
          });
          const stored = yield* fixture.prepareOwner((transaction, scope) =>
            promotionEvaluationFactory(transaction, scope).pipe(
              Effect.flatMap((services) =>
                verifyPromotionProof(services.proofPort, {
                  at: preview.result.operationAt,
                  claim: 'HISTORICAL',
                  handle,
                  presented: Option.none(),
                  request,
                }),
              ),
            ),
          );
          expect(stored.claim).toBe('AUTHENTIC_HISTORICAL');
          expect(stored.proof.merchandise.applications).toEqual([]);
          expect(stored.proof.merchandise.shipping).toBe('UNRESOLVED');
          const beforeReplay = yield* fixture.evidenceCount();
          const replay = yield* Effect.flip(
            runAction({
              audience: 'promotion',
              payload: { reason, request, stage: 'MERCHANDISE' },
              principal: fixture.principal,
              registration: issuePromotionProofAction,
              transport: issuanceTransport,
            }),
          );
          expect(Schema.is(ActionAlreadyCommitted)(replay)).toBe(true);
          expect(yield* fixture.evidenceCount()).toBe(beforeReplay);
          const evidenceBeforeFailure = yield* fixture.evidenceCount();
          external.controls.available = false;
          const unavailable = yield* Effect.flip(
            runAction({
              audience: 'promotion',
              payload: { reason, request, stage: 'MERCHANDISE' },
              principal: fixture.principal,
              registration: issuePromotionProofAction,
              transport: { correlationId: yield* nextId, idempotencyKey: yield* nextId },
            }),
          );
          expect(Schema.is(PromotionEvaluationFailure)(unavailable)).toBe(true);
          expect(yield* fixture.evidenceCount()).toBe(evidenceBeforeFailure);
        }).pipe(Effect.provide(fixture.context), Effect.provideService(PromotionExternalFactSource, external.source));
      }).pipe(Effect.provide(nativeServices)),
  );

  it.live(
    'joins stored monetary identities to separate Shipping proof, rejects NET fallback and invalidates policy changes',
    () =>
      Effect.gen(function* nativeStagedProof() {
        const { fixture } = yield* createNativeManagementFixture();
        const request = yield* purchaseRequest(fixture);
        const external = yield* ownerAcceptanceSource(request);
        const cartId = yield* nextId;
        const otherCartId = yield* nextId;
        const shippingId = yield* nextId;
        const { principal } = fixture;
        const tenantPrincipal = Struct.omit(principal, ['legalEntityId']);
        const offerRef = {
          moduleId: 'delivery.offer',
          resourceId: 'native-chosen-offer',
          resourceType: 'delivery.offer',
          tenantId: principal.tenantId,
        };
        yield* Effect.forEach(
          [
            createPromotionDraftAction,
            publishPromotionAction,
            setCartRankingAction,
            setShippingRankingAction,
            issuePromotionProofAction,
            retirePromotionAction,
          ],
          (action) => fixture.grantActionExecution(action),
          { concurrency: 1 },
        );
        yield* Effect.gen(function* nativeRuntime() {
          const ownerAt = yield* fixture.prepareOwner((transaction, scope) =>
            promotionEvaluationFactory(transaction, scope).pipe(
              Effect.flatMap((services) => services.persistence.operationAt),
            ),
          );
          const from = DateTime.formatIso(DateTime.subtract(ownerAt, { minutes: 1 }));
          const common = {
            displayName: 'Native staged owner offer',
            effectivePeriod: { from },
            eligibility: { commercialScopes: [request.purchase.commercialScope] },
          };
          const definitions = [
            {
              id: cartId,
              meaning: {
                ...common,
                activation: 'AUTOMATIC',
                benefit: { amount: '100', currencyCode: 'CZK', kind: 'FIXED_MONETARY_AMOUNT' },
                family: 'AUTOMATIC_CART',
                target: 'MERCHANDISE_CART',
              },
            },
            {
              id: otherCartId,
              meaning: {
                ...common,
                activation: 'AUTOMATIC',
                benefit: { amount: '50', currencyCode: 'CZK', kind: 'FIXED_MONETARY_AMOUNT' },
                family: 'AUTOMATIC_CART',
                target: 'MERCHANDISE_CART',
              },
            },
            {
              id: shippingId,
              meaning: {
                ...common,
                activation: 'AUTOMATIC',
                allowedMethodRefs: [{ ...offerRef, resourceId: 'method-A', resourceType: 'delivery.method' }],
                benefit: { kind: 'FREE_SHIPPING' },
                family: 'AUTOMATIC_FREE_SHIPPING',
                minimumMerchandise: { amount: '900', currencyCode: 'CZK' },
                target: 'SELECTED_DELIVERY_OFFER',
              },
            },
          ];
          yield* Effect.forEach(
            definitions,
            Effect.fn('EvaluationNativeTest.createDraft')(function* createDraft(definition) {
              yield* runAction({
                audience: 'promotion',
                payload: { meaning: definition.meaning, promotionId: definition.id, reason },
                principal,
                registration: createPromotionDraftAction,
                transport: { correlationId: yield* nextId, idempotencyKey: yield* nextId },
              });
            }),
            { concurrency: 1 },
          );
          yield* runAction({
            audience: 'promotion',
            payload: { expectedVersion: 0, orderedPromotionIds: [cartId, otherCartId], reason },
            principal: tenantPrincipal,
            registration: setCartRankingAction,
            transport: { correlationId: yield* nextId, idempotencyKey: yield* nextId },
          });
          yield* runAction({
            audience: 'promotion',
            payload: { expectedVersion: 0, orderedPromotionIds: [shippingId], reason },
            principal: tenantPrincipal,
            registration: setShippingRankingAction,
            transport: { correlationId: yield* nextId, idempotencyKey: yield* nextId },
          });
          yield* Effect.forEach(
            definitions,
            Effect.fn('EvaluationNativeTest.publish')(function* publish(definition) {
              yield* runAction({
                audience: 'promotion',
                payload: { expectedVersion: 1, promotionId: definition.id, reason },
                principal,
                registration: publishPromotionAction,
                transport: { correlationId: yield* nextId, idempotencyKey: yield* nextId },
              });
            }),
            { concurrency: 1 },
          );
          const merchandise = yield* runAction({
            audience: 'promotion',
            payload: { reason, request, stage: 'MERCHANDISE' },
            principal,
            registration: issuePromotionProofAction,
            transport: { correlationId: yield* nextId, idempotencyKey: yield* nextId },
          });
          external.controls.publishedGross = false;
          const unavailableGross = yield* Effect.flip(
            runAction({
              audience: 'promotion',
              payload: {
                merchandiseProofId: merchandise.proofId,
                reason,
                request,
                selectedOffer: offerRef,
                stage: 'SHIPPING',
              },
              principal,
              registration: issuePromotionProofAction,
              transport: { correlationId: yield* nextId, idempotencyKey: yield* nextId },
            }),
          );
          expect(Schema.is(PromotionEvaluationFailure)(unavailableGross)).toBe(true);
          external.controls.publishedGross = true;
          const shipping = yield* runAction({
            audience: 'promotion',
            payload: {
              merchandiseProofId: merchandise.proofId,
              reason,
              request,
              selectedOffer: offerRef,
              stage: 'SHIPPING',
            },
            principal,
            registration: issuePromotionProofAction,
            transport: { correlationId: yield* nextId, idempotencyKey: yield* nextId },
          });
          const records = yield* fixture.prepareOwner((transaction, scope) =>
            promotionEvaluationFactory(transaction, scope).pipe(
              Effect.flatMap((services) =>
                Effect.all(
                  [
                    services.persistence.loadIssuedProof(merchandise.proofId),
                    services.persistence.loadIssuedProof(shipping.proofId),
                  ],
                  { concurrency: 1 },
                ),
              ),
            ),
          );
          const original = Option.getOrThrow(records[0]);
          const joined = Option.getOrThrow(records[1]);
          expect(joined.merchandise.applications).toEqual(original.merchandise.applications);
          expect(original.merchandise.lines[0]?.exactRemainingAmount).toBe('900');
          if (joined.stage === 'SHIPPING') {
            expect(joined.shipping.application?.minimumOutcome).toBe('MET');
            expect(joined.shipping.merchandiseProofId).toBe(original.proofId);
            expect(joined.shipping.shippingAmount).toBe('OWNED_BY_DELIVERY');
          }
          yield* runAction({
            audience: 'promotion',
            payload: { expectedVersion: 1, orderedPromotionIds: [otherCartId, cartId], reason },
            principal: tenantPrincipal,
            registration: setCartRankingAction,
            transport: { correlationId: yield* nextId, idempotencyKey: yield* nextId },
          });
          const stale = yield* Effect.flip(
            runAction({
              audience: 'promotion',
              payload: {
                merchandiseProofId: merchandise.proofId,
                reason,
                request,
                selectedOffer: offerRef,
                stage: 'SHIPPING',
              },
              principal,
              registration: issuePromotionProofAction,
              transport: { correlationId: yield* nextId, idempotencyKey: yield* nextId },
            }),
          );
          expect(Schema.is(PromotionProofFailure)(stale)).toBe(true);
          if (Schema.is(PromotionProofFailure)(stale)) {
            expect(stale.code).toBe('STALE');
          }
          const retained = yield* fixture.prepareOwner((transaction, scope) =>
            promotionEvaluationFactory(transaction, scope).pipe(
              Effect.flatMap((services) =>
                verifyPromotionProof(services.proofPort, {
                  at: joined.issuedAt,
                  claim: 'HISTORICAL',
                  handle: shipping,
                  presented: Option.none(),
                  request,
                }),
              ),
            ),
          );
          expect(retained.claim).toBe('AUTHENTIC_HISTORICAL');
          expect(retained.proof.merchandise.applications).toEqual(original.merchandise.applications);
          const beforeRetirementHandle = yield* runAction({
            audience: 'promotion',
            payload: { reason, request, stage: 'MERCHANDISE' },
            principal,
            registration: issuePromotionProofAction,
            transport: { correlationId: yield* nextId, idempotencyKey: yield* nextId },
          });
          const beforeRetirement = yield* fixture.prepareOwner((transaction, scope) =>
            Effect.gen(function* loadBeforeRetirement() {
              const services = yield* promotionEvaluationFactory(transaction, scope);
              return {
                promotion: yield* services.persistence.loadPromotion(otherCartId),
                verified: yield* verifyPromotionProof(services.proofPort, {
                  at: yield* services.persistence.operationAt,
                  claim: 'CURRENT',
                  handle: beforeRetirementHandle,
                  presented: Option.none(),
                  request,
                }),
              };
            }),
          );
          const beforeApplications = beforeRetirement.verified.proof.merchandise.applications;
          expect(beforeApplications).toHaveLength(1);
          expect(beforeApplications[0]?.promotionRef.resourceId).toBe(otherCartId);
          yield* runAction({
            audience: 'promotion',
            payload: { expectedVersion: beforeRetirement.promotion.technicalVersion, promotionId: otherCartId, reason },
            principal,
            registration: retirePromotionAction,
            transport: { correlationId: yield* nextId, idempotencyKey: yield* nextId },
          });
          yield* fixture.prepareOwner((transaction, scope) =>
            Effect.gen(function* verifyRetirementHistory() {
              const services = yield* promotionEvaluationFactory(transaction, scope);
              const at = yield* services.persistence.operationAt;
              const verification = {
                at,
                handle: beforeRetirementHandle,
                presented: Option.none(),
                request,
              };
              const retiredCurrent = yield* Effect.flip(
                verifyPromotionProof(services.proofPort, { ...verification, claim: 'CURRENT' }),
              );
              expect(Schema.is(PromotionProofFailure)(retiredCurrent)).toBe(true);
              if (Schema.is(PromotionProofFailure)(retiredCurrent)) {
                expect(retiredCurrent.code).toBe('STALE');
              }
              const historical = yield* verifyPromotionProof(services.proofPort, {
                ...verification,
                claim: 'HISTORICAL',
              });
              expect(historical.claim).toBe('AUTHENTIC_HISTORICAL');
              expect(historical.proof).toEqual(beforeRetirement.verified.proof);
              const retired = yield* services.persistence.loadPromotion(otherCartId);
              expect(retired.retiredAt).toBeDefined();
              expect(retired.meaning).toEqual(beforeRetirement.promotion.meaning);
            }),
          );
        }).pipe(Effect.provide(fixture.context), Effect.provideService(PromotionExternalFactSource, external.source));
      }).pipe(Effect.provide(nativeServices)),
  );
  it.live(
    'reuses the same persisted product, cart and shipping Vouchers for repeated and different buyers without consumption',
    () =>
      Effect.gen(function* persistedReusableVoucherFamilies() {
        const { fixture } = yield* createNativeManagementFixture();
        const first = yield* purchaseRequest(fixture);
        const second = yield* purchaseRequest(fixture);
        const thirdBase = yield* purchaseRequest(fixture);
        const third: PromotionEvaluationRequest = {
          ...thirdBase,
          purchase: {
            ...thirdBase.purchase,
            purchasingContext: {
              ...thirdBase.purchase.purchasingContext,
              actor: {
                guestEvidenceRef: 'different-buyer-evidence',
                guestSessionRef: 'different-buyer-session',
                kind: 'GUEST',
              },
              subject: {
                guestEvidenceRef: 'different-buyer-evidence',
                guestSessionRef: 'different-buyer-session',
                kind: 'GUEST',
              },
            },
          },
        };
        const productPromotionId = yield* nextId;
        const cartPromotionId = yield* nextId;
        const shippingPromotionId = yield* nextId;
        const productVoucherId = yield* nextId;
        const cartVoucherId = yield* nextId;
        const shippingVoucherId = yield* nextId;
        const inputs = [first, second, third].map((request) => ({
          ...request,
          voucherChoices: {
            cartVoucherId,
            product: [
              {
                occurrenceId: Option.getOrThrow(Option.fromUndefinedOr(request.purchase.occurrences[0])).occurrenceId,
                voucherId: productVoucherId,
              },
            ],
            shippingVoucherId,
          },
        }));
        const sources = yield* Effect.forEach(inputs, ownerAcceptanceSource, { concurrency: 1 });
        for (const source of sources) {
          source.controls.publicationAmount = '800';
        }
        const { principal } = fixture;
        const tenantPrincipal = Struct.omit(principal, ['legalEntityId']);
        const offerRef = {
          moduleId: 'delivery.offer',
          resourceId: 'reusable-chosen-offer',
          resourceType: 'delivery.offer',
          tenantId: principal.tenantId,
        };
        yield* Effect.forEach(
          [
            createPromotionDraftAction,
            publishPromotionAction,
            setCartRankingAction,
            setShippingRankingAction,
            provisionVoucherAction,
            issuePromotionProofAction,
          ],
          (action) => fixture.grantActionExecution(action),
          { concurrency: 1 },
        );
        yield* Effect.gen(function* nativeRuntime() {
          const ownerAt = yield* fixture.prepareOwner((transaction, scope) =>
            promotionPersistenceFactory(transaction, scope).pipe(Effect.flatMap((service) => service.operationAt)),
          );
          const common = {
            displayName: 'Native reusable Voucher',
            effectivePeriod: { from: DateTime.formatIso(DateTime.subtract(ownerAt, { minutes: 1 })) },
            eligibility: { commercialScopes: [first.purchase.commercialScope] },
          };
          const definitions = [
            {
              code: ' PRODUCT10 ',
              id: productPromotionId,
              meaning: {
                ...common,
                activation: 'VOUCHER',
                benefit: { kind: 'PERCENTAGE', percentage: '10' },
                family: 'PRODUCT_VOUCHER',
                target: 'PURCHASE_DEMAND_OCCURRENCE',
              },
              voucherId: productVoucherId,
            },
            {
              code: 'CART100',
              id: cartPromotionId,
              meaning: {
                ...common,
                activation: 'VOUCHER',
                benefit: { amount: '100', currencyCode: 'CZK', kind: 'FIXED_MONETARY_AMOUNT' },
                family: 'CART_VOUCHER',
                target: 'MERCHANDISE_CART',
              },
              voucherId: cartVoucherId,
            },
            {
              code: 'DOPRAVA',
              id: shippingPromotionId,
              meaning: {
                ...common,
                activation: 'VOUCHER',
                allowedMethodRefs: [{ ...offerRef, resourceId: 'method-A', resourceType: 'delivery.method' }],
                benefit: { kind: 'FREE_SHIPPING' },
                family: 'SHIPPING_VOUCHER',
                target: 'SELECTED_DELIVERY_OFFER',
              },
              voucherId: shippingVoucherId,
            },
          ];
          yield* Effect.forEach(
            definitions,
            Effect.fn('EvaluationNativeTest.createReusable')(function* createReusable(definition) {
              yield* runAction({
                audience: 'promotion',
                payload: { meaning: definition.meaning, promotionId: definition.id, reason },
                principal,
                registration: createPromotionDraftAction,
                transport: { correlationId: yield* nextId, idempotencyKey: yield* nextId },
              });
            }),
            { concurrency: 1 },
          );
          yield* runAction({
            audience: 'promotion',
            payload: { expectedVersion: 0, orderedPromotionIds: [cartPromotionId], reason },
            principal: tenantPrincipal,
            registration: setCartRankingAction,
            transport: { correlationId: yield* nextId, idempotencyKey: yield* nextId },
          });
          yield* runAction({
            audience: 'promotion',
            payload: { expectedVersion: 0, orderedPromotionIds: [shippingPromotionId], reason },
            principal: tenantPrincipal,
            registration: setShippingRankingAction,
            transport: { correlationId: yield* nextId, idempotencyKey: yield* nextId },
          });
          yield* Effect.forEach(
            definitions,
            Effect.fn('EvaluationNativeTest.publishAndProvisionReusable')(function* publishAndProvision(definition) {
              yield* runAction({
                audience: 'promotion',
                payload: { expectedVersion: 1, promotionId: definition.id, reason },
                principal,
                registration: publishPromotionAction,
                transport: { correlationId: yield* nextId, idempotencyKey: yield* nextId },
              });
              yield* runAction({
                audience: 'promotion',
                payload: { code: definition.code, promotionId: definition.id, reason, voucherId: definition.voucherId },
                principal,
                registration: provisionVoucherAction,
                transport: { correlationId: yield* nextId, idempotencyKey: yield* nextId },
              });
            }),
            { concurrency: 1 },
          );
          const before = yield* voucherSnapshot(fixture);
          const results = yield* Effect.forEach(
            inputs,
            Effect.fn('EvaluationNativeTest.reusablePurchase')(function* reusablePurchase(request, index) {
              const external = Option.getOrThrow(Option.fromUndefinedOr(sources[index]));
              const resolved = yield* resolveNativeProductCode(fixture, request, ' pRoDuCt10 ');
              expect(resolved.voucher.voucherId).toBe(productVoucherId);
              const readBefore = yield* voucherSnapshot(fixture);
              const preview = yield* previewNative(fixture, request).pipe(
                Effect.provideService(PromotionExternalFactSource, external.source),
              );
              expect(preview.result.applications.map((application) => application.layer)).toEqual(['PRODUCT', 'CART']);
              expect(preview.result.lines[0]?.exactRemainingAmount).toBe('800');
              expect(yield* voucherSnapshot(fixture)).toEqual(readBefore);
              const monetary = yield* runAction({
                audience: 'promotion',
                payload: { reason, request, stage: 'MERCHANDISE' },
                principal,
                registration: issuePromotionProofAction,
                transport: { correlationId: yield* nextId, idempotencyKey: yield* nextId },
              }).pipe(Effect.provideService(PromotionExternalFactSource, external.source));
              const shipping = yield* runAction({
                audience: 'promotion',
                payload: {
                  merchandiseProofId: monetary.proofId,
                  reason,
                  request,
                  selectedOffer: offerRef,
                  stage: 'SHIPPING',
                },
                principal,
                registration: issuePromotionProofAction,
                transport: { correlationId: yield* nextId, idempotencyKey: yield* nextId },
              }).pipe(Effect.provideService(PromotionExternalFactSource, external.source));
              const stored = yield* loadNativeIssued(fixture, shipping.proofId);
              const proof = Option.getOrThrow(stored);
              expect(proof.merchandise.applications.map((application) => application.voucherRef?.resourceId)).toEqual([
                productVoucherId,
                cartVoucherId,
              ]);
              if (proof.stage === 'SHIPPING') {
                expect(proof.shipping.application?.voucherRef?.resourceId).toBe(shippingVoucherId);
                expect(proof.shipping.application?.minimumOutcome).toBe('NOT_CONFIGURED');
              }
              return proof;
            }),
            { concurrency: 1 },
          );
          expect(results).toHaveLength(3);
          expect(new Set(results.map((proof) => proof.request.purchase.purchaseRef)).size).toBe(3);
          expect(yield* voucherSnapshot(fixture)).toEqual(before);
        }).pipe(Effect.provide(fixture.context));
      }).pipe(Effect.provide(nativeServices)),
  );
  it.live(
    'runs the original governed preview Read for real monetary and Shipping drafts without publishing or mutating owner state',
    () =>
      Effect.gen(function* originalGovernedDraftPreview() {
        const test = yield* createNativeManagementFixture();
        const { fixture } = test;
        const request = yield* purchaseRequest(fixture);
        const external = yield* ownerAcceptanceSource(request);
        const productDraftId = yield* nextId;
        const shippingDraftId = yield* nextId;
        const { occurrenceId } = Option.getOrThrow(Option.fromUndefinedOr(request.purchase.occurrences[0]));
        yield* Effect.forEach(
          [createPromotionDraftAction, setShippingRankingAction],
          (action) => fixture.grantActionExecution(action),
          { concurrency: 1 },
        );
        yield* Effect.gen(function* nativeRuntime() {
          const ownerAt = yield* fixture.prepareOwner((transaction, scope) =>
            promotionPersistenceFactory(transaction, scope).pipe(Effect.flatMap((services) => services.operationAt)),
          );
          const common = {
            displayName: 'Original governed draft preview',
            effectivePeriod: { from: DateTime.formatIso(DateTime.subtract(ownerAt, { minutes: 1 })) },
            eligibility: { commercialScopes: [request.purchase.commercialScope] },
          };
          yield* runAction({
            audience: 'promotion',
            payload: {
              meaning: {
                ...common,
                activation: 'VOUCHER',
                benefit: { kind: 'PERCENTAGE', percentage: '10' },
                family: 'PRODUCT_VOUCHER',
                target: 'PURCHASE_DEMAND_OCCURRENCE',
              },
              promotionId: productDraftId,
              reason,
            },
            principal: fixture.principal,
            registration: createPromotionDraftAction,
            transport: { correlationId: yield* nextId, idempotencyKey: yield* nextId },
          });
          const productInput = { ...request, draftPreview: { occurrenceId, promotionId: productDraftId } };
          const before = yield* voucherSnapshot(fixture);
          const evidenceBefore = yield* fixture.evidenceCount();
          const preview = yield* runOriginalPreview(fixture, productInput);
          expect(preview.kind).toBe('MANAGEMENT_PREVIEW');
          if (preview.kind === 'MANAGEMENT_PREVIEW') {
            expect(preview.draftPromotionId).toBe(productDraftId);
            expect(preview.evaluation.lines[0]?.exactRemainingAmount).toBe('900');
            expect(preview.evaluation.applications[0]?.activation).toBe('VOUCHER');
            expect(preview.evaluation.applications[0]?.voucherRef).toBeUndefined();
          }
          expect(yield* voucherSnapshot(fixture)).toEqual(before);
          expect((yield* loadNativePromotion(fixture, productDraftId)).status).toBe('DRAFT');
          expect(yield* fixture.evidenceCount()).toBe(evidenceBefore + 1);
          const offerRef = {
            moduleId: 'delivery.offer',
            resourceId: 'method-A',
            resourceType: 'delivery.method',
            tenantId: fixture.principal.tenantId,
          };
          yield* runAction({
            audience: 'promotion',
            payload: {
              meaning: {
                ...common,
                activation: 'VOUCHER',
                allowedMethodRefs: [offerRef],
                benefit: { kind: 'FREE_SHIPPING' },
                family: 'SHIPPING_VOUCHER',
                target: 'SELECTED_DELIVERY_OFFER',
              },
              promotionId: shippingDraftId,
              reason,
            },
            principal: fixture.principal,
            registration: createPromotionDraftAction,
            transport: { correlationId: yield* nextId, idempotencyKey: yield* nextId },
          });
          yield* runAction({
            audience: 'promotion',
            payload: { expectedVersion: 0, orderedPromotionIds: [shippingDraftId], reason },
            principal: Struct.omit(fixture.principal, ['legalEntityId']),
            registration: setShippingRankingAction,
            transport: { correlationId: yield* nextId, idempotencyKey: yield* nextId },
          });
          const shippingBefore = yield* voucherSnapshot(fixture);
          external.controls.available = false;
          const validated = yield* runOriginalPreview(fixture, {
            ...request,
            draftPreview: { promotionId: shippingDraftId },
          });
          expect(validated.kind).toBe('DRAFT_VALIDATION');
          if (validated.kind === 'DRAFT_VALIDATION') {
            expect(validated.draft.promotionId).toBe(shippingDraftId);
            expect(validated.draft.status).toBe('DRAFT');
            expect(validated.valid).toBe(true);
          }
          expect(validated).not.toHaveProperty('shippingAmount');
          expect(validated).not.toHaveProperty('evaluation');
          expect(yield* voucherSnapshot(fixture)).toEqual(shippingBefore);
          expect((yield* loadNativePromotion(fixture, shippingDraftId)).status).toBe('DRAFT');
          external.controls.available = true;
          test.access.defaultAnswer.outcome = 'DENIED';
          const denied = yield* Effect.flip(runOriginalPreview(fixture, productInput));
          expect(Schema.is(ReadPermissionDenied)(denied)).toBe(true);
          test.access.defaultAnswer.outcome = 'UNAVAILABLE';
          const unavailable = yield* Effect.flip(runOriginalPreview(fixture, productInput));
          expect(Schema.is(ReadPermissionUnavailable)(unavailable)).toBe(true);
          expect(yield* voucherSnapshot(fixture)).toEqual(shippingBefore);
        }).pipe(Effect.provide(fixture.context), Effect.provideService(PromotionExternalFactSource, external.source));
      }).pipe(Effect.provide(nativeServices)),
  );
});
