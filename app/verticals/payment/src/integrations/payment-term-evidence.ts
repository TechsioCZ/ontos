import { GuestPaymentTermsResolutionApi } from '@app/commerce-customer-context/api/guest-payment-terms-resolution';
import type { GuestPaymentTermsResolutionRequest } from '@app/commerce-customer-context/api/guest-payment-terms-resolution';
import {
  PaymentTermsResolutionApi,
  PaymentTermsResolutionRequestSchema,
} from '@app/commerce-customer-context/api/payment-terms-resolution';
import type {
  PaymentTermsResolutionRequest,
  PaymentTermsResolutionResponse,
} from '@app/commerce-customer-context/api/payment-terms-resolution';
import { requireModuleOperation } from '@app/core-runtime';
import { PaymentTermRefSchema } from '@app/payment-term-catalog-contracts/resources/payment-term';
import { makeGovernedEffectBffClient } from '@app/shared-contracts/client-runtime';
import { acquireDelegatedGatewayContext } from '@app/shared-contracts/gateway-context-server';
import { Context, Crypto, DateTime, Effect, Layer, Match, Redacted, Schema } from 'effect';

import { PaymentPurchasingContextSchema } from '../../shared/domain/applicability-purchasing-context.ts';
import { sameAmount } from '../domain/money.ts';
import { computePaymentMaterialHash } from '../persistence/payment-aggregate-persistence.ts';
import { ownerEvidenceUnavailable } from '../ports/owner-evidence-unavailable.ts';
import { PaymentTermEvidencePort } from '../ports/payment-term-evidence-port.ts';
import type {
  PaymentTermEvidenceService,
  PaymentTermOwnerCall,
  PaymentTermUseEvidence,
} from '../ports/payment-term-evidence-port.ts';
import { PaymentPurchaseEvidencePort } from '../ports/purchase-evidence-port.ts';
import type { PaymentPurchaseEvidence } from '../ports/purchase-evidence-port.ts';

type VerifyInput = Parameters<PaymentTermEvidenceService['verifyTermUse']>[0];
type AuthorizedTermInput = Extract<PaymentTermsResolutionResponse, { readonly _tag: 'EXPLICIT_CHOICE' }>;

export const paymentTermRequirements = {
  APPLICABILITY: {
    GUEST: 'payment.core.requirement.applicability-guest-terms',
    PROFILE: 'payment.core.requirement.applicability-profile-terms',
  },
  CREATE: {
    GUEST: 'payment.core.requirement.create-guest-terms',
    PROFILE: 'payment.core.requirement.create-profile-terms',
  },
  ISSUE: { PROFILE: 'payment.core.requirement.issue-profile-terms' },
  VALIDATE: { PROFILE: 'payment.core.requirement.validate-profile-terms' },
} as const;

const samePurchasingContext = Schema.toEquivalence(PaymentPurchasingContextSchema);
const sameTermRef = Schema.toEquivalence(PaymentTermRefSchema);
const unavailable = (reason: string, cause?: unknown) => {
  const failure = ownerEvidenceUnavailable('PAYMENT_TERM_EVIDENCE', reason);
  if (cause !== undefined) {
    Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
  }
  return failure;
};

const ownerCallMatchesScope = (input: VerifyInput, call: PaymentTermOwnerCall): boolean =>
  call.operationScope.legalEntityId === input.scope.legalEntityId &&
  call.operationScope.tenantId === input.scope.tenantId &&
  call.operationScope.trustedStorefrontId !== undefined &&
  (call.consumer === 'APPLICABILITY' || call.purchaseCorrelationId !== undefined);

const purchaseMatches = (input: VerifyInput, call: PaymentTermOwnerCall, owner: PaymentPurchaseEvidence): boolean =>
  owner.tenantId === input.scope.tenantId &&
  owner.legalEntityId === input.scope.legalEntityId &&
  owner.principalId === call.operationScope.principalId &&
  owner.storefrontId === call.operationScope.trustedStorefrontId &&
  samePurchasingContext(owner.purchasingContext, input.purchase.purchasingContext) &&
  owner.customerConfigurationId === input.customerConfigurationId &&
  sameAmount(owner.payableAmount, call.payableAmount) &&
  sameTermRef(owner.paymentTermRef, input.paymentTermRef) &&
  (call.purchaseCorrelationId === undefined || owner.purchaseCorrelationId === call.purchaseCorrelationId);

const useResolvedTerm = (input: VerifyInput, owner: PaymentPurchaseEvidence, resolved: AuthorizedTermInput) => {
  if (
    resolved.purchasingContextRevision !== owner.purchasingContext.contextRevision ||
    !sameTermRef(resolved.definition.paymentTermRef, input.paymentTermRef) ||
    resolved.definition.semantics.calculationRuleVersion !== 2
  ) {
    return Effect.fail(unavailable('Customer Context did not verify the exact Current Payment Term and purchase'));
  }
  // Derive a stable audit reference from the exact authoritative evidence. Observation time is not material.
  return computePaymentMaterialHash({
    customerPaymentTermsRevision: resolved.customerPaymentTermsRevision,
    entitlementRef: resolved.sourceEntitlementRef ?? null,
    policyRevision: resolved.policyRevision,
    policySource: resolved.policySource,
    purchaseEvidenceRef: owner.evidenceRef,
    purchasingContextRevision: resolved.purchasingContextRevision,
    semanticRevisionId: resolved.definition.semanticRevisionId,
  }).pipe(
    Effect.mapError((cause) => unavailable('The resolved Payment Term evidence could not be referenced', cause)),
    Effect.map((hash): PaymentTermUseEvidence => ({
      _tag: 'USABLE',
      entitlementEvidenceRef: `ccc:${hash}`,
      paymentTermRef: input.paymentTermRef,
      semanticSnapshot: resolved.definition,
    })),
  );
};

const notUsable = (
  paymentTermRef: VerifyInput['paymentTermRef'],
  reason: 'ENTITLEMENT_NOT_CURRENT' | 'POLICY_DENIED',
) => Effect.succeed<PaymentTermUseEvidence>({ _tag: 'NOT_USABLE', paymentTermRef, reason });

const termUse = (input: VerifyInput, owner: PaymentPurchaseEvidence, resolved: PaymentTermsResolutionResponse) =>
  Match.value(resolved).pipe(
    Match.tagsExhaustive({
      BROKEN_ENTITLEMENT: ({ reason }) =>
        reason === 'NOT_CURRENT'
          ? notUsable(input.paymentTermRef, 'ENTITLEMENT_NOT_CURRENT')
          : Effect.fail(unavailable('Customer Context could not establish the Payment Term entitlement')),
      BROKEN_PAYMENT_TERM_POLICY: () => Effect.fail(unavailable('The Current Payment Term policy is broken')),
      EXPLICIT_CHOICE: (term) => useResolvedTerm(input, owner, term),
      EXPLICIT_CHOICE_INVALID: () => notUsable(input.paymentTermRef, 'POLICY_DENIED'),
      INCONSISTENT_CONFIGURATION: () => Effect.fail(unavailable('The Current Payment Term configuration conflicts')),
      INCONSISTENT_PAYMENT_TERM_POLICY: () => Effect.fail(unavailable('The Current Payment Term policy conflicts')),
      MISSING_PAYMENT_TERM_POLICY: () => Effect.fail(unavailable('The Current Payment Term policy is missing')),
      NO_USABLE_PAYMENT_TERM: () => notUsable(input.paymentTermRef, 'ENTITLEMENT_NOT_CURRENT'),
      PAYMENT_TERM_POLICY_UNVERIFIABLE: () =>
        Effect.fail(unavailable('The Current Payment Term policy is unverifiable')),
      POLICY_FALLBACK: () => Effect.fail(unavailable('Customer Context did not verify the explicit Payment Term')),
      PREFERRED_ENTITLEMENT: () =>
        Effect.fail(unavailable('Customer Context did not verify the explicit Payment Term')),
    }),
  );

type AuthorizedTermCall = readonly [
  credential: string,
  requestCorrelation: string,
  target: { readonly baseUrl: string; readonly compositionRevision: string },
];
const ownerApiPrefix = '/commerce-customer-context-api';

const termOwnerTransport = Object.freeze({
  acquire: acquireDelegatedGatewayContext,
  executeGuest: (
    payload: GuestPaymentTermsResolutionRequest,
    ...[credential, requestCorrelation, target]: AuthorizedTermCall
  ) =>
    makeGovernedEffectBffClient(
      {
        api: GuestPaymentTermsResolutionApi,
        credential: Redacted.make(credential),
        defaultApiPrefix: ownerApiPrefix,
        requestCorrelation,
      },
      target,
    ).pipe(Effect.flatMap((client) => client.guestPaymentTermsResolution.execute({ payload }))),
  executeProfile: (
    payload: PaymentTermsResolutionRequest,
    ...[credential, requestCorrelation, target]: AuthorizedTermCall
  ) =>
    makeGovernedEffectBffClient(
      {
        api: PaymentTermsResolutionApi,
        credential: Redacted.make(credential),
        defaultApiPrefix: ownerApiPrefix,
        requestCorrelation,
      },
      target,
    ).pipe(Effect.flatMap((client) => client.paymentTermsResolution.execute({ payload }))),
});

/** Transport boundary for the actual CCC public clients. Test fixtures replace only remote calls. */
export const PaymentTermOwnerTransport = Context.Reference<typeof termOwnerTransport>(
  '@app/payment/integrations/payment-term-evidence/PaymentTermOwnerTransport',
  { defaultValue: () => termOwnerTransport },
);

const requirementFor = (consumer: PaymentTermOwnerCall['consumer'], subject: 'PROFILE' | 'GUEST') => {
  const requirements = paymentTermRequirements[consumer];
  if (subject === 'PROFILE') {
    return requirements.PROFILE;
  }
  return 'GUEST' in requirements ? requirements.GUEST : undefined;
};

/** The actual Payment-to-CCC path. CCC resolves the reusable C15 semantics and its own Current policy. */
const makeGovernedPaymentTermEvidence = Effect.fn('PaymentTermEvidence.makeGoverned')(function* makeGoverned() {
  const crypto = yield* Crypto.Crypto;
  const purchasing = yield* PaymentPurchaseEvidencePort;
  const { acquire, executeGuest, executeProfile } = yield* PaymentTermOwnerTransport;
  const verifyTermUse = Effect.fn('PaymentTermEvidence.verifyTermUse')(function* verifyTermUse(input: VerifyInput) {
    const { ownerCall: call } = input;
    if (call === undefined || !ownerCallMatchesScope(input, call)) {
      return yield* unavailable('Trusted Purchase and Storefront scope is required to verify the Payment Term');
    }
    const owner = yield* purchasing.readCurrent({
      purchasingContext: input.purchase.purchasingContext,
      scope: call.operationScope,
    });
    if (!purchaseMatches(input, call, owner)) {
      return yield* unavailable('The requested Payment does not match the Current purchasing-owner evidence');
    }
    const { purchasingContext: purchase } = owner;
    const { subject } = purchase;
    if (
      input.method === 'DEFERRED_INVOICE' &&
      (subject.kind !== 'PROFILE' ||
        subject.profileRef.resourceType !== 'commerce.customer-context.counterparty-purchasing-profile')
    ) {
      return yield* notUsable(input.paymentTermRef, 'POLICY_DENIED');
    }
    const requirement = requirementFor(call.consumer, subject.kind);
    if (requirement === undefined) {
      return yield* unavailable('This operation cannot use Guest Payment Term evidence');
    }
    yield* requireModuleOperation(requirement).pipe(
      Effect.mapError((cause) =>
        unavailable('The Current Customer Context Payment Term operation is unavailable', cause),
      ),
    );
    const { operationScope } = call;
    const issued = yield* acquire(
      {
        audience: 'commerce-customer-context',
        legalEntityScope: 'subject',
        requestCorrelation: operationScope.correlationId,
        subject: { _tag: 'Assertion', scope: operationScope },
      },
      crypto,
    ).pipe(Effect.mapError((cause) => unavailable('The Customer Context delegation is unavailable', cause)));
    const options = { baseUrl: issued.apiBaseUrl, compositionRevision: issued.compositionRevision };
    const common = {
      at: DateTime.formatIso(yield* DateTime.now),
      explicitChoice: input.paymentTermRef,
      purchasingContext: {
        channelId: purchase.channelId,
        contextRevision: purchase.contextRevision,
        marketId: purchase.marketId,
        sellingLegalEntityId: owner.legalEntityId,
        storefrontId: owner.storefrontId,
      },
    };
    if (subject.kind === 'GUEST') {
      const result = yield* executeGuest(common, issued.authorization, operationScope.correlationId, options).pipe(
        Effect.mapError((cause) =>
          unavailable('Customer Context could not verify the Current Guest Payment Term', cause),
        ),
      );
      return yield* termUse(input, owner, result);
    }
    const member = yield* Schema.decodeUnknownEffect(PaymentTermsResolutionRequestSchema)({
      ...common,
      authorizationSubject: owner.authorizationSubject,
      profileRef: subject.profileRef,
    }).pipe(
      Effect.mapError((cause) =>
        unavailable('The purchase owner did not verify the exact member authorization subject', cause),
      ),
    );
    const result = yield* executeProfile(member, issued.authorization, operationScope.correlationId, options).pipe(
      Effect.mapError((cause) =>
        unavailable('Customer Context could not verify the Current member Payment Term', cause),
      ),
    );
    return yield* termUse(input, owner, result);
  });
  return { verifyTermUse } satisfies PaymentTermEvidenceService;
});

export const governedPaymentTermEvidenceLive = Layer.effect(PaymentTermEvidencePort, makeGovernedPaymentTermEvidence());
