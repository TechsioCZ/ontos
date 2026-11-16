import type { TrustedPrincipalContext } from '@app/core-runtime';
import {
  acquireDelegatedGatewayContext,
  GatewayDelegationSourceError,
} from '@app/shared-contracts/gateway-context-server';
import type { GatewayDelegationSubject } from '@app/shared-contracts/gateway-context-server';
import { computeCanonicalValueHash } from '@app/core-runtime/access/enforcement';
import {
  readVerifiedGatewayWorkload,
  readVerifiedGatewayRecovery,
  readVerifiedGatewayScopeAssertion,
} from '@app/core-runtime/auth/system-principal-context-provenance';
import type { executeSelectionEvidenceWithAuthorization } from '@app/catalog/api/client';
import type { CurrentMarketCatalogRequest } from '@app/commerce-market-catalog/api/client';
import { DateTime, Effect, Redacted, Schema } from 'effect';
import type { Crypto } from 'effect';

/**
 * Pricing's one outgoing owner call shape (DESIGN D2). Pricing acts for the verified subject of the
 * request it serves: the scope is the receiving request's own Core-verified principal context.
 */
export class OwnerGatewayConnectionError extends Schema.TaggedError<OwnerGatewayConnectionError>()(
  'OwnerGatewayConnectionError',
  {
    cause: Schema.optionalKey(Schema.Defect()),
    reason: Schema.String,
  },
) {}

type CatalogSelectionReadInput = Parameters<typeof executeSelectionEvidenceWithAuthorization>[0];
export const CatalogSelectionOperationRequirementSchema = Schema.Literals([
  'commerce.pricing.requirement.define-price-catalog',
  'commerce.pricing.requirement.manage-product-prices-bulk-catalog',
]);
export type CatalogSelectionOperationRequirement = typeof CatalogSelectionOperationRequirementSchema.Type;
export const CurrentMarketOperationRequirementSchema = Schema.Literals([
  'commerce.pricing.requirement.define-price-market',
  'commerce.pricing.requirement.manage-product-prices-bulk-market',
]);
export type CurrentMarketOperationRequirement = typeof CurrentMarketOperationRequirementSchema.Type;

/** Native factory-selected providers, never business-input declaration or lease claims. */
export type OwnerGatewayConditionalRead =
  | {
      readonly input: CatalogSelectionReadInput;
      readonly kind: 'CATALOG_SELECTION';
      readonly operationRequirementKey: CatalogSelectionOperationRequirement;
    }
  | {
      readonly input: CurrentMarketCatalogRequest;
      readonly kind: 'CURRENT_MARKET';
      readonly operationRequirementKey: CurrentMarketOperationRequirement;
    };

export interface OwnerGatewayConnectionInput {
  readonly audience: string;
  readonly compositionRevision: string;
  readonly conditionalRead?: OwnerGatewayConditionalRead;
  readonly legalEntityScope: 'subject' | 'tenant';
  readonly requestCorrelation: string;
  readonly scope: TrustedPrincipalContext;
}

export interface OwnerGatewayConnection {
  readonly baseUrl: URL;
  readonly credential: Redacted.Redacted;
}

/** A credential the Shell already expired is refused here rather than handed to the owner call. */
export const ownerCredentialIsLive = (expiresAt: number, now: DateTime.Utc): boolean =>
  expiresAt * 1000 > DateTime.toEpochMillis(now);

export type OwnerGatewayConnectionAcquire = (
  input: OwnerGatewayConnectionInput,
) => Effect.Effect<OwnerGatewayConnection, OwnerGatewayConnectionError>;

/** A credential is usable only for the active composition revision it was issued under. */
export const ownerConnectionForComposition = (
  issued: { readonly apiBaseUrl: string; readonly compositionRevision: string; readonly credential: Redacted.Redacted },
  compositionRevision: string,
): Effect.Effect<OwnerGatewayConnection, OwnerGatewayConnectionError> =>
  issued.compositionRevision === compositionRevision
    ? Effect.succeed({ baseUrl: new URL(issued.apiBaseUrl), credential: issued.credential })
    : Effect.fail(
        new OwnerGatewayConnectionError({ reason: 'Owner credential belongs to a different active composition' }),
      );

type PricingOwnerDelegationSubject = Extract<
  GatewayDelegationSubject,
  { readonly _tag: 'Assertion' | 'RegisteredAssertion' }
>;

/** Selects the existing issuer protocol from genuine redeemed provenance without copying the scope. */
export const pricingOwnerDelegationSubject = (
  input: OwnerGatewayConnectionInput,
): Effect.Effect<PricingOwnerDelegationSubject, GatewayDelegationSourceError> => {
  if (readVerifiedGatewayScopeAssertion(input.scope) === undefined) {
    return Effect.fail(
      new GatewayDelegationSourceError({ reason: 'Verified gateway scope is required to act for the requester' }),
    );
  }
  if (readVerifiedGatewayWorkload(input.scope) === undefined) {
    return Effect.succeed({ _tag: 'Assertion', scope: input.scope });
  }
  const read = input.conditionalRead;
  if (read === undefined) {
    return Effect.fail(
      new GatewayDelegationSourceError({ reason: 'A registered owner Read requires its exact conditional provider' }),
    );
  }
  const validRequirement =
    read.kind === 'CATALOG_SELECTION'
      ? Schema.is(CatalogSelectionOperationRequirementSchema)(read.operationRequirementKey)
      : Schema.is(CurrentMarketOperationRequirementSchema)(read.operationRequirementKey);
  if (!validRequirement) {
    return Effect.fail(
      new GatewayDelegationSourceError({ reason: 'The registered Read requires its native operation requirement' }),
    );
  }
  const destination =
    read.kind === 'CATALOG_SELECTION'
      ? { audience: 'catalog', declarationKey: 'commerce.catalog.selection-evidence.read', legalEntityScope: 'tenant' }
      : {
          audience: 'commerce-market-catalog',
          declarationKey: 'commerce.market-catalog.market-catalog.read',
          legalEntityScope: 'subject',
        };
  if (input.audience !== destination.audience || input.legalEntityScope !== destination.legalEntityScope) {
    return Effect.fail(
      new GatewayDelegationSourceError({ reason: 'The registered Read does not match its native provider and scope' }),
    );
  }
  const subject = {
    _tag: 'RegisteredAssertion' as const,
    declarationKey: destination.declarationKey,
    operationRequirementKey: read.operationRequirementKey,
    scope: input.scope,
  };
  return Effect.succeed(
    readVerifiedGatewayRecovery(input.scope) === undefined
      ? subject
      : { ...subject, recoveryRequestHash: computeCanonicalValueHash(read.input) },
  );
};

/** Requests a context for the owner module, acting for the subject of `input.scope` through the module credential. */
export const acquireOwnerGatewayConnection = (
  input: OwnerGatewayConnectionInput,
  crypto: Crypto.Crypto,
): Effect.Effect<OwnerGatewayConnection, OwnerGatewayConnectionError> =>
  pricingOwnerDelegationSubject(input).pipe(
    Effect.flatMap((subject) =>
      acquireDelegatedGatewayContext(
        {
          audience: input.audience,
          callingAppId: 'pricing',
          legalEntityScope: input.legalEntityScope,
          requestCorrelation: input.requestCorrelation,
          subject,
        },
        crypto,
      ),
    ),
    Effect.mapError((cause) => new OwnerGatewayConnectionError({ cause, reason: 'Owner gateway is unavailable' })),
    Effect.flatMap((issued) =>
      DateTime.now.pipe(
        Effect.flatMap((now) =>
          ownerCredentialIsLive(issued.expiresAt, now)
            ? ownerConnectionForComposition(
                {
                  apiBaseUrl: issued.apiBaseUrl,
                  compositionRevision: issued.compositionRevision,
                  credential: Redacted.make(issued.authorization),
                },
                input.compositionRevision,
              )
            : Effect.fail(new OwnerGatewayConnectionError({ reason: 'Owner credential expired before use' })),
        ),
      ),
    ),
  );
