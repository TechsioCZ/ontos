import { Context, Schema } from 'effect';
import type { Effect } from 'effect';

import type { PaymentGatewayProviderFamilySchema } from '../../../shared/domain/payment-vocabulary.ts';
import type { GatewayCredentialSecretRef } from '../../../shared/domain/psp-configuration.ts';
import type { GatewayProviderUnavailableError } from './psp-errors.ts';

/**
 * Provider credential material behind an opaque secret ref (#1155, plan D5). Material is read per
 * `resolve` call; a missing or malformed entry fails that resolve only, never another family.
 */

const secretText = Schema.Redacted(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4000)));

/** GoPay OAuth2 client identifier. Not a secret, but never shown outside the adapter either. */
export const GopayClientIdSchema = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)).pipe(
  Schema.brand('GopayClientId'),
);

export const ProviderCredentialMaterialSchema = Schema.Union([
  Schema.TaggedStruct('GOPAY', { clientId: GopayClientIdSchema, clientSecret: secretText }),
  Schema.TaggedStruct('STRIPE', { secretKey: secretText, webhookSigningSecret: secretText }),
  Schema.TaggedStruct('COMGATE', { secret: secretText }),
]);
export type ProviderCredentialMaterial = typeof ProviderCredentialMaterialSchema.Type;

export interface ProviderCredentialRequest {
  readonly family: typeof PaymentGatewayProviderFamilySchema.Type;
  readonly secretRef: GatewayCredentialSecretRef;
}

export interface ProviderCredentialStoreContract {
  /** Resolves only the requested ref; the material's tag always equals `family` on success. */
  readonly resolve: (
    request: ProviderCredentialRequest,
  ) => Effect.Effect<ProviderCredentialMaterial, GatewayProviderUnavailableError>;
}

export class ProviderCredentialStore extends Context.Service<
  ProviderCredentialStore,
  ProviderCredentialStoreContract
>()('@app/payment/integrations/psp/credentials/ProviderCredentialStore') {}
