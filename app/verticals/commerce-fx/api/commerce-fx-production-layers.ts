import { Config, Effect, Layer, Schema } from 'effect';

import {
  CommercialFxCurrentContextPort,
  unavailableCommercialFxCurrentContextPort,
} from '../shared/domain/commercial-fx-conversion.ts';
import {
  CommercialFxDisclosurePolicy,
  redactCommercialFxEvidence,
  // eslint-disable-next-line anti-slop-effect/no-service-constructor-imports -- This production composition closes deployment-owned disclosure config over the pure policy constructor; expires: 2027-09-09.
  makePurchaseLimitCommercialFxDisclosurePolicy,
} from '../shared/domain/commercial-fx-disclosure.ts';

/** Explicit local/default adapter; production hosts provide a verified current-context Layer. */
export const unavailableCommercialFxCurrentContextPortLive = Layer.succeed(
  CommercialFxCurrentContextPort,
  unavailableCommercialFxCurrentContextPort,
);

/** Secure default: exact commercial evidence requires an explicit deployment policy. */
export const redactCommercialFxEvidenceLive = Layer.succeed(
  CommercialFxDisclosurePolicy,
  redactCommercialFxEvidence,
);

const grantId = (name: string) => Config.schema(Schema.String.check(Schema.isUUID()), name);
const grantStorefront = Config.schema(
  Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300)),
  'ONTOS_COMMERCE_FX_PURCHASE_LIMIT_STOREFRONT_ID',
);

const purchaseLimitDisclosureGrantConfiguration = Config.all({
  // The Purchase Limit caller is the owner-local Shell API-key credential.  Keep this explicit
  // in deployment configuration so a session/support credential can never inherit exact-disclosure
  // authority by omission or by matching the remaining scope coordinates.
  authMethod: Config.literals(['api_key'] as const, 'ONTOS_COMMERCE_FX_PURCHASE_LIMIT_AUTH_METHOD'),
  legalEntityId: grantId('ONTOS_COMMERCE_FX_PURCHASE_LIMIT_LEGAL_ENTITY_ID'),
  principalId: grantId('ONTOS_COMMERCE_FX_PURCHASE_LIMIT_PRINCIPAL_ID'),
  tenantId: grantId('ONTOS_COMMERCE_FX_PURCHASE_LIMIT_TENANT_ID'),
  trustedStorefrontId: grantStorefront,
});

/**
 * Production disclosure composition.  The exact Purchase Limit evidence grant is deployment
 * owned and only activates when every scope coordinate is configured.  A partially configured
 * deployment keeps the secure redacted policy, so credentials never imply disclosure authority.
 */
export const productionCommercialFxDisclosureLive = Layer.effect(
  CommercialFxDisclosurePolicy,
  purchaseLimitDisclosureGrantConfiguration.pipe(
    Effect.match({
      // eslint-disable-next-line effect-native/no-failure-discarding-error-callback -- Invalid or partial disclosure configuration intentionally degrades to redaction without exposing deployment configuration details; expires: 2027-09-09.
      onFailure: () => redactCommercialFxEvidence,
      onSuccess: (grant) =>
        makePurchaseLimitCommercialFxDisclosurePolicy({
          ...grant,
        }),
    }),
  ),
);
