import type { CoreSearchResourceRefSchema } from '@app/core-runtime';
import type { PurchaseApprovalFinalBinding } from '../../shared/domain/purchasing-approval.ts';
import {
  ActiveApplicationCompositionService,
  validateActiveApplicationCompositionSnapshot,
} from '@app/core-runtime/modules/active-application-composition';
import { executeVerifyOrderCommitmentBindingWithAuthorization } from '@app/commerce-order-contracts/verify-order-commitment-binding/client';
import { executeCommittedOrderApprovalEvidenceWithAuthorization } from '@app/commerce-order-contracts/committed-order-approval-evidence/client';
import { VerifyOrderCommitmentBindingRequestSchema } from '@app/commerce-order-contracts/verify-order-commitment-binding';
import { issueApiKeyGatewayContext } from '@app/shared-contracts/server/gateway-context-api-key';
import { Clock, Config, DateTime, Effect, Layer, Option, Schema } from 'effect';
import { PurchaseApprovalFinalBindingAuthority } from '../../shared/domain/purchase-approval-currentness-port.ts';
import type { PurchaseApprovalFinalBindingAuthorityService } from '../../shared/domain/purchase-approval-currentness-port.ts';
import {
  PurchasingApprovalRejected,
  computePurchaseProposalCanonicalHash,
  PurchaseApprovalFinalBindingEvidenceSchema,
} from '../../shared/domain/purchasing-approval.ts';

type VerificationResourceRef = typeof CoreSearchResourceRefSchema.Encoded;
interface VerificationClaim {
  readonly binding: PurchaseApprovalFinalBinding;
  readonly commitmentCorrelationId: string;
  readonly mode: 'REVALIDATION' | 'CONSUMPTION';
  readonly orderRef?: VerificationResourceRef;
  readonly proposalHash?: string;
  readonly proposalRevisionRef: VerificationResourceRef;
  readonly requestRef: VerificationResourceRef;
  readonly revalidationRef?: VerificationResourceRef;
}
const unavailable = (cause: unknown = 'Gateway configuration is unavailable') => {
  const failure = new PurchasingApprovalRejected({
    code: 'DEPENDENCY_UNAVAILABLE',
    reason: 'The final Order owner cannot currently verify this commitment',
    retryable: true,
  });
  Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
  return failure;
};
const conflict = () =>
  new PurchasingApprovalRejected({
    code: 'COMMIT_CONFLICT',
    reason: 'The final Order owner did not verify the exact commitment binding',
    retryable: false,
  });
const httpUrl = Schema.URLFromString.check(
  Schema.makeFilter((url) =>
    (url.protocol === 'https:' || url.protocol === 'http:') &&
    url.username.length === 0 &&
    url.password.length === 0 &&
    url.search.length === 0 &&
    url.hash.length === 0
      ? undefined
      : 'A trusted HTTP(S) gateway URL is required',
  ),
);
const sameRef = (
  left: {
    readonly moduleId: string;
    readonly resourceId: string;
    readonly resourceType: string;
    readonly tenantId: string;
  } | null,
  right: {
    readonly moduleId: string;
    readonly resourceId: string;
    readonly resourceType: string;
    readonly tenantId: string;
  } | null,
) =>
  left !== null &&
  right !== null &&
  left.tenantId === right.tenantId &&
  left.moduleId === right.moduleId &&
  left.resourceType === right.resourceType &&
  left.resourceId === right.resourceId;
const sameBinding = (
  left: {
    readonly attemptRef: Parameters<typeof sameRef>[0];
    readonly bundleHash: string;
    readonly bundleRef: Parameters<typeof sameRef>[0];
    readonly bundleVersion: string;
  },
  right: {
    readonly attemptRef: Parameters<typeof sameRef>[0];
    readonly bundleHash: string;
    readonly bundleRef: Parameters<typeof sameRef>[0];
    readonly bundleVersion: string;
  },
) =>
  sameRef(left.attemptRef, right.attemptRef) &&
  sameRef(left.bundleRef, right.bundleRef) &&
  left.bundleHash === right.bundleHash &&
  left.bundleVersion === right.bundleVersion;
const committedBindingConflicts = ({
  committed,
  correlation,
  now,
  observed,
  request,
  scope,
  until,
}: {
  readonly committed: Effect.Success<ReturnType<typeof executeCommittedOrderApprovalEvidenceWithAuthorization>>;
  readonly correlation: string;
  readonly now: number;
  readonly observed: number;
  readonly request: Extract<typeof VerifyOrderCommitmentBindingRequestSchema.Type, { readonly mode: 'CONSUMPTION' }>;
  readonly scope: { readonly legalEntityId: string; readonly tenantId: string };
  readonly until: number;
}) =>
  committed.tenantId !== scope.tenantId ||
  committed.legalEntityId !== scope.legalEntityId ||
  !sameBinding(committed.finalBinding, request.binding) ||
  !sameRef(committed.orderRef, request.orderRef) ||
  !sameRef(committed.revalidationRef, request.revalidationRef) ||
  !sameRef(committed.requestRef, request.requestRef) ||
  !sameRef(committed.proposalRevisionRef, request.proposalRevisionRef) ||
  committed.commitmentCorrelationId !== correlation ||
  committed.provenance !== 'commerce.order.committed-approval-evidence.v1' ||
  observed > now ||
  until <= now ||
  until - observed > 30_000;

const configuration = Config.all({
  apiKey: Config.Redacted('ONTOS_CCC_ORDER_GATEWAY_API_KEY'),
  orderBaseUrl: Config.schema(httpUrl, 'ONTOS_COMMERCE_ORDER_API_BASE_URL'),
  shellBaseUrl: Config.schema(httpUrl, 'ONTOS_SHELL_GATEWAY_BASE_URL'),
});

export const PurchaseApprovalFinalBindingAuthorityLive = Layer.effect(
  PurchaseApprovalFinalBindingAuthority,
  Effect.gen(function* finalBindingAuthorityLayer() {
    const composition = yield* ActiveApplicationCompositionService;
    const configured = yield* configuration.pipe(Effect.match({ onFailure: Option.none, onSuccess: Option.some }));
    const verify = Effect.fn('PurchaseApprovalFinalBindingAuthority.verify')(function* verify(
      input: VerificationClaim,
      scope: { readonly legalEntityId: string; readonly tenantId: string },
    ) {
      const request = yield* Schema.decodeUnknownEffect(Schema.toType(VerifyOrderCommitmentBindingRequestSchema))(
        input,
      ).pipe(Effect.mapError(unavailable));
      if (Option.isNone(configured)) {
        return yield* unavailable();
      }
      if (
        [request.requestRef, request.binding.attemptRef, request.binding.bundleRef, request.proposalRevisionRef].some(
          (ref) => ref.tenantId !== scope.tenantId,
        )
      ) {
        return yield* conflict();
      }
      const active = yield* composition.load.pipe(
        Effect.flatMap(validateActiveApplicationCompositionSnapshot),
        Effect.mapError(unavailable),
      );
      const correlation = request.commitmentCorrelationId;
      const assertion = yield* issueApiKeyGatewayContext(
        {
          audience: 'commerce-order',
          compositionRevision: active.composition.revision,
          legalEntityId: scope.legalEntityId,
        },
        { apiKey: configured.value.apiKey, baseUrl: configured.value.shellBaseUrl, requestCorrelation: correlation },
      ).pipe(Effect.mapError(unavailable));
      if (
        assertion.compositionRevision !== active.composition.revision ||
        assertion.expiresAt * 1000 <= (yield* Clock.currentTimeMillis)
      ) {
        return yield* unavailable('Shell returned an expired or mismatched gateway credential');
      }
      if (request.mode === 'CONSUMPTION') {
        const committed = yield* executeCommittedOrderApprovalEvidenceWithAuthorization(
          {
            finalBinding: request.binding,
            orderRef: request.orderRef,
            revalidationRef: request.revalidationRef,
          },
          `Bearer ${assertion.token}`,
          correlation,
          {
            baseUrl: configured.value.orderBaseUrl,
            compositionRevision: active.composition.revision,
          },
        ).pipe(Effect.mapError(unavailable));
        const observed = DateTime.toEpochMillis(committed.observedAt);
        const until = DateTime.toEpochMillis(committed.validUntil);
        const now = yield* Clock.currentTimeMillis;
        if (committedBindingConflicts({ committed, correlation, now, observed, request, scope, until })) {
          return yield* conflict();
        }
        return {
          binding: committed.finalBinding,
          commitmentCorrelationId: committed.commitmentCorrelationId,
          committedAt: committed.committedAt,
          observedAt: committed.observedAt,
          orderRef: committed.orderRef,
          provenance: 'commerce.order.durable-commitment.v1' as const,
          revalidationRef: committed.revalidationRef,
          validUntil: committed.validUntil,
        };
      }
      const verified = yield* executeVerifyOrderCommitmentBindingWithAuthorization(
        request,
        `Bearer ${assertion.token}`,
        correlation,
        { baseUrl: configured.value.orderBaseUrl, compositionRevision: active.composition.revision },
      ).pipe(Effect.mapError(unavailable));
      const now = yield* Clock.currentTimeMillis;
      const observed = DateTime.toEpochMillis(verified.observedAt);
      const until = DateTime.toEpochMillis(verified.validUntil);
      if (
        !sameBinding(verified.binding, request.binding) ||
        verified.commitmentCorrelationId !== request.commitmentCorrelationId ||
        verified.provenance !== 'commerce.order.durable-commitment.v1' ||
        observed > now ||
        until <= now ||
        until - observed > 30_000 ||
        verified.orderRef !== null ||
        verified.committedAt !== null
      ) {
        return yield* conflict();
      }
      return verified;
    });
    return {
      verifyConsumption: Effect.fn('PurchaseApprovalFinalBindingAuthority.verifyConsumption')(
        function* verifyConsumption({
          claimed,
          scope,
        }: Parameters<PurchaseApprovalFinalBindingAuthorityService['verifyConsumption']>[0]) {
          if (
            claimed.finalBinding === undefined ||
            claimed.revalidationRef === undefined ||
            scope.legalEntityId === undefined
          ) {
            return yield* conflict();
          }
          const verified = yield* verify(
            {
              binding: claimed.finalBinding,
              commitmentCorrelationId: claimed.commitmentCorrelationId,
              mode: 'CONSUMPTION',
              orderRef: claimed.orderRef,
              proposalRevisionRef: claimed.proposalRevisionRef,
              requestRef: claimed.requestRef,
              revalidationRef: claimed.revalidationRef,
            },
            { ...scope, legalEntityId: scope.legalEntityId },
          );
          if (
            verified.committedAt === null ||
            DateTime.toEpochMillis(verified.committedAt) !== DateTime.toEpochMillis(claimed.committedAt)
          ) {
            return yield* conflict();
          }
          const bindingEvidence = yield* Schema.decodeUnknownEffect(
            Schema.toType(PurchaseApprovalFinalBindingEvidenceSchema),
          )({
            binding: verified.binding,
            observedAt: verified.observedAt,
            provenance: verified.provenance,
            validUntil: verified.validUntil,
          }).pipe(Effect.mapError(unavailable));
          return {
            bindingEvidence,
            orderRef: claimed.orderRef,
            revalidationRef: claimed.revalidationRef,
          };
        },
      ),
      verifyRevalidation: Effect.fn('PurchaseApprovalFinalBindingAuthority.verifyRevalidation')(
        function* verifyRevalidation({
          binding,
          claimed,
          request,
          scope,
        }: Parameters<PurchaseApprovalFinalBindingAuthorityService['verifyRevalidation']>[0]) {
          const proposalHash = computePurchaseProposalCanonicalHash(request.proposal);
          if (
            !sameRef(request.requestRef, claimed.requestRef) ||
            !sameRef(request.proposal.proposalRevisionRef, claimed.proposalRevisionRef) ||
            proposalHash !== claimed.expectedProposalHash ||
            request.proposal.identity.buyer.principalId !== scope.principalId ||
            request.proposal.identity.buyer.tenantId !== scope.tenantId
          ) {
            return yield* conflict();
          }
          const verified = yield* verify(
            {
              binding,
              commitmentCorrelationId: claimed.commitmentCorrelationId,
              mode: 'REVALIDATION',
              proposalHash,
              proposalRevisionRef: request.proposal.proposalRevisionRef,
              requestRef: request.requestRef,
            },
            scope,
          );
          return yield* Schema.decodeUnknownEffect(Schema.toType(PurchaseApprovalFinalBindingEvidenceSchema))({
            binding: verified.binding,
            observedAt: verified.observedAt,
            provenance: verified.provenance,
            validUntil: verified.validUntil,
          }).pipe(Effect.mapError(unavailable));
        },
      ),
    } satisfies PurchaseApprovalFinalBindingAuthorityService;
  }),
);
