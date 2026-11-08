import { ReadHandlerUnavailable, ReadPermissionDenied } from '@app/core-runtime';
import type { OwnerAccessFacts, ReadHandlerContext, ReadHandlerResult } from '@app/core-runtime';
import { Effect } from 'effect';
import { counterpartyOwnerFacts, retailOwnerFacts } from '../actions/owner-access-facts.ts';
import type {
  PurchaseResolutionContextClaim,
  PurchaseResolutionSubject,
  ResolutionTrustedScope,
} from '../../shared/domain/address-resolution.ts';
import type { AddressBookUnavailable } from '../../shared/domain/address-errors.ts';

type PurchaseResolutionReadInput = Readonly<{
  readonly purchasingContext: PurchaseResolutionContextClaim;
  readonly subject: PurchaseResolutionSubject;
}>;

/**
 * The owner-local facts of a purchase-resolution read (O67-Q1, O70): a profile subject is checked
 * against the counterparty's own grant or the Retail Portal profile capability, and a guest subject
 * needs no owner record. The v2 declaration gates the read itself.
 */
export const purchaseResolutionOwnerFacts = (input: PurchaseResolutionReadInput): OwnerAccessFacts => {
  const { subject } = input;
  if (subject.kind === 'GUEST') {
    return {};
  }
  return subject.profile.kind === 'COUNTERPARTY'
    ? counterpartyOwnerFacts(subject.profile.counterpartyRef.resourceId)
    : retailOwnerFacts(subject.profile.profileRef.resourceId, 'retail.address_book.use');
};

type PurchaseResolutionReadHandlerConfig<Input extends PurchaseResolutionReadInput, Resolution, Services> = Readonly<{
  readonly effectName: string;
  readonly resolutionLabel: string;
  readonly resolve: (
    input: Input,
    scope: ResolutionTrustedScope,
    services: Services,
  ) => Effect.Effect<Resolution, AddressBookUnavailable>;
}>;

// oxlint-disable-next-line effect-native/no-wide-factory-signature -- This exported factory intentionally accepts one cohesive config bag for its cross-file read-handler adapters.
export const makePurchaseResolutionReadHandler = <Input extends PurchaseResolutionReadInput, Resolution, Services>(
  config: PurchaseResolutionReadHandlerConfig<Input, Resolution, Services>,
) =>
  Effect.fn(config.effectName)(function* purchaseResolutionReadHandler(
    input: Input,
    context: ReadHandlerContext<Services>,
  ): Effect.fn.Return<
    ReadHandlerResult<{ readonly resolution: Resolution }>,
    ReadHandlerUnavailable | ReadPermissionDenied
  > {
    const { legalEntityId, principalId, tenantId, trustedStorefrontId: storefrontId } = context.scope;
    if (
      legalEntityId === undefined ||
      storefrontId === undefined ||
      input.purchasingContext.tenantId !== tenantId ||
      input.purchasingContext.sellingLegalEntityId !== legalEntityId ||
      input.purchasingContext.storefrontId !== storefrontId ||
      (input.subject.kind === 'PROFILE' && input.subject.profile.profileRef.tenantId !== tenantId)
    ) {
      return yield* new ReadPermissionDenied({
        code: 'read_permission_denied',
        reason: `The ${config.resolutionLabel} purchase context is outside trusted operation scope`,
      });
    }
    const resolution = yield* config
      .resolve(input, { legalEntityId, principalId, storefrontId, tenantId }, context.services)
      .pipe(
        Effect.mapError(
          (failure) =>
            new ReadHandlerUnavailable({
              code: 'read_handler_unavailable',
              reason: `${config.resolutionLabel} dependency unavailable: ${failure.dependency}`,
            }),
        ),
      );
    return { evidence: { resultCount: 1 }, result: { resolution } };
  });
