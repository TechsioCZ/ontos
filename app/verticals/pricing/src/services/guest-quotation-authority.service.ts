import { PricingQuotationBindingSchema } from '@app/pricing-contracts/domain/quotation';
import type { PricingQuotationBinding } from '@app/pricing-contracts/domain/quotation';
import { Context, Data, Effect, Option, Schema } from 'effect';

const stableReference = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300), Schema.isTrimmed());

const PricingGuestQuotationAuthorityRequestSchema = Schema.Struct({
  quotationRef: stableReference,
  quotedBinding: Schema.toType(PricingQuotationBindingSchema),
  requestedBinding: Schema.toType(PricingQuotationBindingSchema),
  requestOriginRef: Schema.optionalKey(stableReference),
});
type PricingGuestQuotationAuthorityRequest = typeof PricingGuestQuotationAuthorityRequestSchema.Type;

const PricingGuestPurchaseContextAuthorityVerifiedSchema = Schema.Struct({
  binding: Schema.toType(PricingQuotationBindingSchema),
  kind: Schema.Literal('GUEST_PURCHASE_CONTEXT_AUTHORITY_VERIFIED'),
});

type PricingGuestPurchaseContextAuthorityVerified = typeof PricingGuestPurchaseContextAuthorityVerifiedSchema.Type;

export const PricingGuestPurchaseContextRejected = Data.TaggedError('PricingGuestPurchaseContextRejected')<{
  readonly reason: 'SESSION_NOT_AUTHORIZED';
}>;
type PricingGuestPurchaseContextRejectedError = InstanceType<typeof PricingGuestPurchaseContextRejected>;

export const PricingGuestPurchaseContextUnavailable = Data.TaggedError('PricingGuestPurchaseContextUnavailable')<{
  readonly reason: 'OWNER_VERIFICATION_UNAVAILABLE';
  readonly retryable: true;
}>;
type PricingGuestPurchaseContextUnavailableError = InstanceType<typeof PricingGuestPurchaseContextUnavailable>;

export interface PricingGuestPurchaseContextAuthorityPort {
  /**
   * The Guest Purchase Context owner must verify the live session and permission. Schema-valid
   * references and knowledge of a Quotation reference are not authority.
   */
  readonly verifyGuestPurchaseContext: (input: {
    readonly binding: PricingQuotationBinding;
    readonly quotationRef: string;
  }) => Effect.Effect<
    PricingGuestPurchaseContextAuthorityVerified,
    PricingGuestPurchaseContextRejectedError | PricingGuestPurchaseContextUnavailableError
  >;
}

class PricingGuestPurchaseContextAuthority extends Context.Service<
  PricingGuestPurchaseContextAuthority,
  PricingGuestPurchaseContextAuthorityPort
>()('@app/pricing/services/guest-quotation-authority.service/PricingGuestPurchaseContextAuthority') {}

export const PricingGuestQuotationAuthorityRejected = Data.TaggedError('PricingGuestQuotationAuthorityRejected')<{
  readonly reason:
    | 'EXACT_GUEST_BINDING_MISMATCH'
    | 'GUEST_TO_AUTHENTICATED_TRANSITION'
    | 'INVALID_REQUEST'
    | 'OWNER_REJECTED'
    | 'QUOTATION_NOT_GUEST';
}>;
type PricingGuestQuotationAuthorityRejectedError = InstanceType<typeof PricingGuestQuotationAuthorityRejected>;

export const PricingGuestQuotationAuthorityUnavailable = Data.TaggedError('PricingGuestQuotationAuthorityUnavailable')<{
  readonly reason: 'OWNER_EVIDENCE_UNVERIFIABLE' | 'OWNER_VERIFICATION_UNAVAILABLE';
  readonly retryable: true;
}>;
type PricingGuestQuotationAuthorityUnavailableError = InstanceType<typeof PricingGuestQuotationAuthorityUnavailable>;

interface PricingGuestQuotationAuthorityVerified {
  readonly binding: PricingQuotationBinding;
  readonly kind: 'PRICING_GUEST_QUOTATION_AUTHORITY_VERIFIED';
  readonly quotationRef: string;
}

export interface PricingGuestQuotationAuthorityService {
  readonly verify: (
    input: PricingGuestQuotationAuthorityRequest,
  ) => Effect.Effect<
    PricingGuestQuotationAuthorityVerified,
    PricingGuestQuotationAuthorityRejectedError | PricingGuestQuotationAuthorityUnavailableError
  >;
}

export class PricingGuestQuotationAuthority extends Context.Service<
  PricingGuestQuotationAuthority,
  PricingGuestQuotationAuthorityService
>()('@app/pricing/services/guest-quotation-authority.service/PricingGuestQuotationAuthority') {}

const sameBinding = Schema.toEquivalence(PricingQuotationBindingSchema);

const reject = (reason: PricingGuestQuotationAuthorityRejectedError['reason']) =>
  new PricingGuestQuotationAuthorityRejected({ reason });

const unavailable = (reason: PricingGuestQuotationAuthorityUnavailableError['reason']) =>
  new PricingGuestQuotationAuthorityUnavailable({ reason, retryable: true });

/**
 * Confirms Guest authority for one immutable exact Quotation binding. Storefront/request origin is
 * accepted only as audit context and is deliberately excluded from both monetary identity and the
 * owner verification request.
 */
export const makePricingGuestQuotationAuthorityService = (
  owner: PricingGuestPurchaseContextAuthorityPort,
): PricingGuestQuotationAuthorityService => {
  const purchaseContextAuthority = PricingGuestPurchaseContextAuthority.of(owner);
  return PricingGuestQuotationAuthority.of({
    verify: Effect.fn('PricingGuestQuotationAuthority.verify')(function* verifyGuestQuotationAuthority(input) {
      const requestOption = Schema.decodeOption(PricingGuestQuotationAuthorityRequestSchema, {
        onExcessProperty: 'error',
      })(input);
      if (Option.isNone(requestOption)) {
        return yield* reject('INVALID_REQUEST');
      }

      const { quotationRef, quotedBinding, requestedBinding } = requestOption.value;
      if (quotedBinding.subject.kind !== 'GUEST') {
        return yield* reject('QUOTATION_NOT_GUEST');
      }
      if (requestedBinding.subject.kind === 'AUTHENTICATED') {
        return yield* reject('GUEST_TO_AUTHENTICATED_TRANSITION');
      }
      if (!sameBinding(quotedBinding, requestedBinding)) {
        return yield* reject('EXACT_GUEST_BINDING_MISMATCH');
      }

      const ownerVerified = yield* purchaseContextAuthority
        .verifyGuestPurchaseContext({ binding: requestedBinding, quotationRef })
        .pipe(
          Effect.catchTags({
            PricingGuestPurchaseContextRejected: () => Effect.fail(reject('OWNER_REJECTED')),
            PricingGuestPurchaseContextUnavailable: () => Effect.fail(unavailable('OWNER_VERIFICATION_UNAVAILABLE')),
          }),
        );
      const ownerVerifiedOption = Schema.decodeOption(PricingGuestPurchaseContextAuthorityVerifiedSchema, {
        onExcessProperty: 'error',
      })(ownerVerified);
      if (
        Option.isNone(ownerVerifiedOption) ||
        ownerVerifiedOption.value.binding.subject.kind !== 'GUEST' ||
        !sameBinding(ownerVerifiedOption.value.binding, requestedBinding)
      ) {
        return yield* unavailable('OWNER_EVIDENCE_UNVERIFIABLE');
      }

      return {
        binding: quotedBinding,
        kind: 'PRICING_GUEST_QUOTATION_AUTHORITY_VERIFIED',
        quotationRef,
      };
    }),
  });
};
