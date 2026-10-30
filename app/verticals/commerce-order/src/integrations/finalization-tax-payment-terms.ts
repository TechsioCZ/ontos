import type {
  OrderFinalizationContext,
  OrderPaymentTermsFinalizationEvidence,
  OrderPaymentTermsFinalizationInput,
  OrderTaxFinalizationEvidence,
  OrderTaxFinalizationIntent,
  OrderTaxHistoricalEvidence,
} from '../../shared/domain/order-finalization-evidence.ts';
import {
  ActiveApplicationCompositionService,
  validateActiveApplicationCompositionSnapshot,
} from '@app/core-runtime/modules/active-application-composition';
import { executeOrderServiceApprovalEvidenceWithAuthorization } from '@app/commerce-customer-context/api/order-service-approval-evidence/client';
import { PaymentTermDefinitionSnapshotSchema } from '@app/payment-term-catalog-contracts/payment-term';
import { executeCurrentPaymentTermsWithAuthorization } from '@app/payment-term-catalog-contracts/current-payment-terms/client';
import { issueApiKeyGatewayContext } from '@app/shared-contracts/server/gateway-context-api-key';
import { executeFinalizeOrderTaxWithAuthorization, executeFinalOrderTaxWithAuthorization } from '@app/tax/api/client';
import { Clock, Config, Context, DateTime, Effect, Layer, Option, Schema, Predicate } from 'effect';
import { OrderCommitmentRejected } from '../../shared/domain/order-commitment.ts';
import {
  OrderPaymentTermsFinalizationEvidenceSchema,
  OrderTaxFinalizationEvidenceSchema,
  OrderTaxFinalizationIntentSchema,
  OrderTaxHistoricalEvidenceSchema,
} from '../../shared/domain/order-finalization-evidence.ts';

type FinalizationScope = OrderFinalizationContext;
export interface FinalizationTaxPaymentTermsService {
  readonly finalizeTax: (
    input: OrderTaxFinalizationIntent,
    scope: FinalizationScope,
  ) => Effect.Effect<OrderTaxFinalizationEvidence, OrderCommitmentRejected>;
  readonly readFinalTax: (
    input: OrderTaxFinalizationIntent,
    scope: FinalizationScope,
  ) => Effect.Effect<OrderTaxHistoricalEvidence, OrderCommitmentRejected>;
  readonly resolvePaymentTerms: (
    input: OrderPaymentTermsFinalizationInput,
    scope: FinalizationScope,
  ) => Effect.Effect<OrderPaymentTermsFinalizationEvidence, OrderCommitmentRejected>;
}
export class FinalizationTaxPaymentTerms extends Context.Service<
  FinalizationTaxPaymentTerms,
  FinalizationTaxPaymentTermsService
>()('@app/commerce-order/integrations/finalization-tax-payment-terms/FinalizationTaxPaymentTerms') {}

const unavailable = (cause: unknown = 'Finalization owner configuration is unavailable') => {
  const error = new OrderCommitmentRejected({
    code: 'order_commitment_unavailable',
    reason: 'The required finalization owner cannot currently establish exact purchase evidence',
  });
  Object.defineProperty(error, 'cause', { configurable: false, enumerable: false, value: cause, writable: false });
  return error;
};
const conflict = () =>
  new OrderCommitmentRejected({
    code: 'order_commitment_conflict',
    reason: 'Finalization evidence does not match the immutable purchase candidate',
  });
const httpUrl = Schema.URLFromString.check(
  Schema.makeFilter((url) =>
    (url.protocol === 'https:' || url.protocol === 'http:') &&
    url.username.length === 0 &&
    url.password.length === 0 &&
    url.search.length === 0 &&
    url.hash.length === 0
      ? undefined
      : 'A trusted HTTP(S) owner URL is required',
  ),
);
const samePaymentTermDefinition = Schema.toEquivalence(PaymentTermDefinitionSnapshotSchema);
const sameTaxPurchase = Schema.toEquivalence(
  OrderTaxFinalizationIntentSchema.fields.request.fields.candidate.fields.purchase,
);
const configuration = Config.all({
  apiKey: Config.Redacted('ONTOS_ORDER_FINALIZATION_GATEWAY_API_KEY'),
  customerContextBaseUrl: Config.schema(httpUrl, 'ONTOS_COMMERCE_CUSTOMER_CONTEXT_API_BASE_URL'),
  paymentTermsBaseUrl: Config.schema(httpUrl, 'ONTOS_PAYMENT_TERM_CATALOG_API_BASE_URL'),
  shellBaseUrl: Config.schema(httpUrl, 'ONTOS_SHELL_GATEWAY_BASE_URL'),
  taxBaseUrl: Config.schema(httpUrl, 'ONTOS_TAX_API_BASE_URL'),
});
const sameRef = (
  left: {
    readonly moduleId: string;
    readonly resourceId: string;
    readonly resourceType: string;
    readonly tenantId: string;
  },
  right: {
    readonly moduleId: string;
    readonly resourceId: string;
    readonly resourceType: string;
    readonly tenantId: string;
  },
) =>
  left.tenantId === right.tenantId &&
  left.moduleId === right.moduleId &&
  left.resourceType === right.resourceType &&
  left.resourceId === right.resourceId;
const requestOutsideScope = (
  request: { readonly candidateRef: { readonly tenantId: string }; readonly requestRef: { readonly tenantId: string } },
  expectedPaymentTerm: { readonly definitionRef: { readonly tenantId: string } },
  scope: FinalizationScope,
) =>
  request.requestRef.tenantId !== scope.tenantId ||
  request.candidateRef.tenantId !== scope.tenantId ||
  expectedPaymentTerm.definitionRef.tenantId !== scope.tenantId;

export const FinalizationTaxPaymentTermsLive = Layer.effect(
  FinalizationTaxPaymentTerms,
  Effect.gen(function* finalizationTaxPaymentTermsLayer() {
    const composition = yield* ActiveApplicationCompositionService;
    const configured = yield* configuration.pipe(Effect.match({ onFailure: Option.none, onSuccess: Option.some }));
    const credential = Effect.fn('FinalizationTaxPaymentTerms.credential')(function* credential(
      audience: 'tax' | 'payment-term-catalog' | 'commerce-customer-context',
      scope: FinalizationScope,
    ) {
      if (Option.isNone(configured)) {
        return yield* unavailable();
      }
      const active = yield* composition.load.pipe(
        Effect.flatMap(validateActiveApplicationCompositionSnapshot),
        Effect.mapError(unavailable),
      );
      const issued = yield* issueApiKeyGatewayContext(
        { audience, compositionRevision: active.composition.revision, legalEntityId: scope.legalEntityId },
        {
          apiKey: configured.value.apiKey,
          baseUrl: configured.value.shellBaseUrl,
          requestCorrelation: scope.correlationId,
        },
      ).pipe(Effect.mapError(unavailable));
      if (
        issued.compositionRevision !== active.composition.revision ||
        issued.expiresAt * 1000 <= (yield* Clock.currentTimeMillis)
      ) {
        return yield* unavailable('The owner gateway credential is expired or bound to a different composition');
      }
      return {
        authorization: `Bearer ${issued.token}`,
        compositionRevision: active.composition.revision,
        configured: configured.value,
      };
    });
    const recoverTax = Effect.fn('FinalizationTaxPaymentTerms.recoverTax')(function* recoverTax(
      input: OrderTaxFinalizationIntent,
      scope: FinalizationScope,
    ) {
      const { request } = input;
      if (
        request.candidate.purchase.tenantId !== scope.tenantId ||
        request.candidate.purchase.sellingLegalEntityRef !== scope.legalEntityId
      ) {
        return yield* conflict();
      }
      const authorized = yield* credential('tax', scope);
      const historical = yield* executeFinalOrderTaxWithAuthorization(
        { submissionRef: request.submissionRef },
        authorized.authorization,
        scope.correlationId,
        { baseUrl: authorized.configured.taxBaseUrl, compositionRevision: authorized.compositionRevision },
      ).pipe(
        Effect.catchTag('FinalOrderTaxNotFoundProblem', () => Effect.succeed(null)),
        Effect.mapError(unavailable),
      );
      if (historical === null) {
        return null;
      }
      if (
        historical.handoff.submissionRef !== request.submissionRef ||
        DateTime.toEpochMillis(historical.handoff.orderCommitmentTime) !==
          DateTime.toEpochMillis(request.orderCommitmentTime) ||
        !sameTaxPurchase(historical.handoff.outcome.decision.purchaseBinding, request.candidate.purchase) ||
        DateTime.toEpochMillis(historical.handoff.outcome.decision.taxRelevantTime) !==
          DateTime.toEpochMillis(request.orderCommitmentTime)
      ) {
        return yield* conflict();
      }
      return yield* Schema.decodeEffect(Schema.toType(OrderTaxFinalizationEvidenceSchema))({
        result: {
          _tag: 'FINALIZED',
          created: false,
          customerSafe: historical.customerSafe,
          evidence: historical.evidence,
          finalOrderTaxRef: historical.finalOrderTaxRef,
          handoff: historical.handoff,
        },
      }).pipe(Effect.mapError(unavailable));
    });
    return {
      finalizeTax: Effect.fn('FinalizationTaxPaymentTerms.finalizeTax')(function* finalizeTax(
        input: OrderTaxFinalizationIntent,
        scope: FinalizationScope,
      ) {
        const { request } = input;
        if (
          request.candidate.purchase.tenantId !== scope.tenantId ||
          request.candidate.purchase.sellingLegalEntityRef !== scope.legalEntityId
        ) {
          return yield* conflict();
        }
        // The worker reloads this immutable intent before every delivery. The public
        // historical read resolves the same original submission after response loss.
        const retained = yield* recoverTax(input, scope);
        if (retained !== null) {
          return retained;
        }
        const authorized = yield* credential('tax', scope);
        const result = yield* executeFinalizeOrderTaxWithAuthorization(
          request,
          authorized.authorization,
          scope.correlationId,
          {
            baseUrl: authorized.configured.taxBaseUrl,
            compositionRevision: authorized.compositionRevision,
            idempotencyKey: input.idempotencyKey,
          },
        ).pipe(
          Effect.catch((error) => {
            // A known changed-command conflict cannot be turned into successful recovery.
            if (Schema.is(Schema.Struct({ code: Schema.Literal('action_request_hash_conflict') }))(error)) {
              return Effect.fail(conflict());
            }
            return recoverTax(input, scope).pipe(
              Effect.flatMap((recovered) =>
                recovered === null ? Effect.fail(unavailable(error)) : Effect.succeed(recovered.result),
              ),
            );
          }),
        );
        if (!Predicate.isTagged(result, 'FINALIZED')) {
          return yield* conflict();
        }
        if (
          result.handoff.submissionRef !== request.submissionRef ||
          DateTime.toEpochMillis(result.handoff.orderCommitmentTime) !==
            DateTime.toEpochMillis(request.orderCommitmentTime) ||
          !sameTaxPurchase(result.handoff.outcome.decision.purchaseBinding, request.candidate.purchase) ||
          DateTime.toEpochMillis(result.handoff.outcome.decision.taxRelevantTime) !==
            DateTime.toEpochMillis(request.orderCommitmentTime)
        ) {
          return yield* conflict();
        }
        // FINALIZED/created:false is Tax's genuine durable recovery. Prospective outcomes never enter this path.
        // The original CALLER_SUPPLIED_UNVERIFIED label is retained; Cart authority is proven independently by orchestration.
        return yield* Schema.decodeEffect(Schema.toType(OrderTaxFinalizationEvidenceSchema))({ result }).pipe(
          Effect.mapError(unavailable),
        );
      }),
      readFinalTax: Effect.fn('FinalizationTaxPaymentTerms.readFinalTax')(function* readFinalTax(
        input: OrderTaxFinalizationIntent,
        scope: FinalizationScope,
      ) {
        const { request } = input;
        if (
          request.candidate.purchase.tenantId !== scope.tenantId ||
          request.candidate.purchase.sellingLegalEntityRef !== scope.legalEntityId
        ) {
          return yield* conflict();
        }
        const authorized = yield* credential('tax', scope);
        const historical = yield* executeFinalOrderTaxWithAuthorization(
          { submissionRef: request.submissionRef },
          authorized.authorization,
          scope.correlationId,
          { baseUrl: authorized.configured.taxBaseUrl, compositionRevision: authorized.compositionRevision },
        ).pipe(Effect.mapError(unavailable));
        if (
          historical.handoff.submissionRef !== request.submissionRef ||
          DateTime.toEpochMillis(historical.handoff.orderCommitmentTime) !==
            DateTime.toEpochMillis(request.orderCommitmentTime) ||
          !sameTaxPurchase(historical.handoff.outcome.decision.purchaseBinding, request.candidate.purchase) ||
          DateTime.toEpochMillis(historical.handoff.outcome.decision.taxRelevantTime) !==
            DateTime.toEpochMillis(request.orderCommitmentTime)
        ) {
          return yield* conflict();
        }
        return yield* Schema.decodeEffect(Schema.toType(OrderTaxHistoricalEvidenceSchema))({ historical }).pipe(
          Effect.mapError(unavailable),
        );
      }),
      resolvePaymentTerms: Effect.fn('FinalizationTaxPaymentTerms.resolvePaymentTerms')(function* resolvePaymentTerms(
        input: OrderPaymentTermsFinalizationInput,
        scope: FinalizationScope,
      ) {
        const { expectedPaymentTerm, request } = input;
        if (request.operation !== 'RESOLVE_PAYMENT_TERMS') {
          return yield* conflict();
        }
        if (requestOutsideScope(request, expectedPaymentTerm, scope)) {
          return yield* conflict();
        }
        const ownerAuthorization = yield* credential('commerce-customer-context', scope);
        const observed = yield* executeOrderServiceApprovalEvidenceWithAuthorization(
          request,
          ownerAuthorization.authorization,
          scope.correlationId,
          {
            baseUrl: ownerAuthorization.configured.customerContextBaseUrl,
            compositionRevision: ownerAuthorization.compositionRevision,
          },
        ).pipe(Effect.mapError(unavailable));
        if (
          observed.operation !== 'RESOLVE_PAYMENT_TERMS' ||
          !sameRef(observed.candidateRef, request.candidateRef) ||
          observed.candidateHash !== request.candidateHash
        ) {
          return yield* conflict();
        }
        const { resolution } = observed;
        if (
          !Predicate.isTagged(resolution, 'EXPLICIT_CHOICE') &&
          !Predicate.isTagged(resolution, 'PREFERRED_ENTITLEMENT') &&
          !Predicate.isTagged(resolution, 'POLICY_FALLBACK')
        ) {
          return yield* conflict();
        }
        const expectedDefinition = resolution.definition;
        if (
          !sameRef(expectedDefinition.paymentTermRef, expectedPaymentTerm.definitionRef) ||
          expectedDefinition.code !== expectedPaymentTerm.code ||
          expectedDefinition.definitionRevisionId !== expectedPaymentTerm.definitionRevision
        ) {
          return yield* conflict();
        }
        const catalogAuthorization = yield* credential('payment-term-catalog', scope);
        if (catalogAuthorization.compositionRevision !== ownerAuthorization.compositionRevision) {
          return yield* unavailable('The active composition changed between Payment Term owner observations');
        }
        const catalog = yield* executeCurrentPaymentTermsWithAuthorization(
          {
            at: resolution.resolvedAt,
            limit: 1,
            references: [
              {
                expectedCompatibilityId: expectedDefinition.compatibilityId,
                expectedSemanticRevisionId: expectedDefinition.semanticRevisionId,
                paymentTermRef: expectedDefinition.paymentTermRef,
              },
            ],
          },
          catalogAuthorization.authorization,
          scope.correlationId,
          {
            baseUrl: catalogAuthorization.configured.paymentTermsBaseUrl,
            compositionRevision: catalogAuthorization.compositionRevision,
          },
        ).pipe(Effect.mapError(unavailable));
        const [outcome] = catalog.referenceOutcomes;
        // referenceOutcomes are independent exact lookups; truncated describes only the unrelated Current listing.
        if (
          catalog.effectiveAt !== resolution.resolvedAt ||
          catalog.referenceOutcomes.length !== 1 ||
          outcome === undefined ||
          outcome.kind !== 'USABLE'
        ) {
          return yield* conflict();
        }
        if (
          !sameRef(outcome.requestedPaymentTermRef, expectedDefinition.paymentTermRef) ||
          !samePaymentTermDefinition(outcome.definition, resolution.definition) ||
          outcome.definition.semantics.calculationRuleVersion !== 2
        ) {
          return yield* conflict();
        }
        return yield* Schema.decodeEffect(Schema.toType(OrderPaymentTermsFinalizationEvidenceSchema))({
          catalogDefinition: outcome.definition,
          effectiveAt: catalog.effectiveAt,
          observedAt: catalog.observedAt,
          resolution,
        }).pipe(Effect.mapError(unavailable));
      }),
    } satisfies FinalizationTaxPaymentTermsService;
  }),
);
