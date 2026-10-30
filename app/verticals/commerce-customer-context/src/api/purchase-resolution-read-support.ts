import { ReadHandlerUnavailable, ReadPermissionDenied, defineReadConditionalPermission } from '@app/core-runtime';
import type { ReadConditionalPermissionDeclaration, ReadHandlerContext, ReadHandlerResult } from '@app/core-runtime';
import { Effect } from 'effect';
import type { AddressBookProfile } from '../../shared/domain/address-book.ts';
import { profileTarget } from './address-read-support.ts';
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

type ResourceReference = Readonly<{
  readonly moduleId: string;
  readonly resourceId: string;
  readonly resourceType: string;
}>;

type PurchaseResolutionPermissionSubject =
  | PurchaseResolutionSubject
  | Readonly<{
      readonly kind: 'PROFILE_SAVED_ADDRESS';
      readonly profile: AddressBookProfile;
      readonly savedAddressRef: ResourceReference;
    }>;

export const makePurchaseResolutionPermission = <Input extends PurchaseResolutionReadInput>(
  savedAddressRefFor: (input: Input) => ResourceReference | undefined,
): ReadConditionalPermissionDeclaration<Input> =>
  defineReadConditionalPermission<Input, PurchaseResolutionPermissionSubject>({
    branches: {
      GUEST: {
        requiredKinds: ['module'],
        resolve: () => [{ kind: 'module', moduleId: 'commerce.customer-context' }],
      },
      PROFILE: {
        requiredKinds: ['business_permission', 'resource_read'],
        resolve: (_input, { profile }, scope) => [
          profileTarget({ profile }, scope),
          { kind: 'resource_read', permission: 'read', resource: profile.profileRef },
        ],
      },
      PROFILE_SAVED_ADDRESS: {
        requiredKinds: ['business_permission', 'resource_read', 'resource_read'],
        resolve: (_input, { profile, savedAddressRef }, scope) => [
          profileTarget({ profile }, scope),
          { kind: 'resource_read', permission: 'read', resource: profile.profileRef },
          { kind: 'resource_read', permission: 'read', resource: savedAddressRef },
        ],
      },
    },
    permissionKey: 'module.access',
    select: (input) => {
      const { subject } = input;
      if (subject.kind === 'GUEST') {
        return subject;
      }
      const savedAddressRef = savedAddressRefFor(input);
      return savedAddressRef === undefined
        ? subject
        : { kind: 'PROFILE_SAVED_ADDRESS', profile: subject.profile, savedAddressRef };
    },
  });

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
