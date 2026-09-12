import { ReadHandlerUnavailable, ReadPermissionDenied, defineReadConditionalPermission } from '@app/core-runtime';
import type {
  ReadConditionalPermissionDeclaration,
  ReadHandlerContext,
  ReadHandlerResult,
  ResolvedReadConditionalPermissionRequirement,
} from '@app/core-runtime';
import { Effect } from 'effect';
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

export const makePurchaseResolutionPermission = <Input extends PurchaseResolutionReadInput>(
  savedAddressRefFor: (input: Input) => ResourceReference | undefined,
): ReadConditionalPermissionDeclaration<Input> =>
  defineReadConditionalPermission<Input, PurchaseResolutionSubject>({
    branches: {
      GUEST: {
        requiredKinds: ['module'],
        resolve: () => [{ kind: 'module', moduleId: 'commerce.customer-context' }],
      },
      PROFILE: {
        requiredKinds: ['business_permission', 'resource_read'],
        resolve: (input, subject, scope) => {
          const { profile } = subject;
          const resources: ResolvedReadConditionalPermissionRequirement[] = [
            {
              kind: 'resource_read',
              permission: 'read',
              resource: {
                moduleId: profile.profileRef.moduleId,
                resourceId: profile.profileRef.resourceId,
                resourceType: profile.profileRef.resourceType,
              },
            },
          ];
          const savedAddressRef = savedAddressRefFor(input);
          if (savedAddressRef !== undefined) {
            resources.push({
              kind: 'resource_read',
              permission: 'read',
              resource: savedAddressRef,
            });
          }
          const businessPermission =
            profile.kind === 'COUNTERPARTY'
              ? {
                  permission: 'counterparty.address_book.use' as const,
                  target: {
                    counterpartyId: profile.counterpartyRef.resourceId,
                    kind: 'counterparty' as const,
                    legalEntityId: scope.legalEntityId ?? '',
                    tenantId: scope.tenantId,
                  },
                }
              : {
                  permission: 'retail.address_book.use' as const,
                  target: {
                    kind: 'retail_profile' as const,
                    legalEntityId: scope.legalEntityId ?? '',
                    profileId: profile.profileRef.resourceId,
                    tenantId: scope.tenantId,
                  },
                };
          return [{ businessPermission, kind: 'business_permission' as const }, ...resources];
        },
      },
    },
    permissionKey: 'module.access',
    select: ({ subject }) => subject,
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
