import { SupportedGatewayContextClaimsSchema } from '@app/shared-contracts';
import { issueApiKeyGatewayContext } from '@app/shared-contracts/server/gateway-context-api-key';
import { Config, Effect, Encoding, Redacted, Schema } from 'effect';
import { consentUnavailable } from './problems.ts';

export interface CustomerConsentScope {
  readonly compositionRevision: string;
  readonly legalEntityId: string;
  readonly partyId: string;
  readonly requestCorrelation: string;
  readonly tenantId: string;
}
const configuration = Config.all({
  apiKey: Config.Redacted('ONTOS_COMMERCE_CUSTOMER_CONTEXT_GATEWAY_API_KEY'),
  baseUrl: Config.String('ONTOS_SHELL_GATEWAY_BASE_URL'),
});

/** Single-use native assertions are never retained or reused between reads and commands. */
export const acquireCustomerPrivacyGateway = Effect.fn('CustomerConsent.acquirePrivacyGateway')(function* acquire(
  scope: CustomerConsentScope,
) {
  const configured = yield* configuration.pipe(Effect.mapError(consentUnavailable));
  const response = yield* issueApiKeyGatewayContext(
    {
      audience: 'privacy',
      compositionRevision: scope.compositionRevision,
      legalEntityId: scope.legalEntityId,
    },
    { apiKey: configured.apiKey, baseUrl: configured.baseUrl, requestCorrelation: scope.requestCorrelation },
  ).pipe(Effect.mapError(consentUnavailable));
  const [, payload] = response.token.split('.');
  if (payload === undefined || response.compositionRevision !== scope.compositionRevision) {
    return yield* Effect.fail(consentUnavailable());
  }
  // The native receiver verifies the signature. Here we cross-check the authenticated issuer response.
  const claims = yield* Effect.fromResult(Encoding.decodeBase64UrlString(payload)).pipe(
    Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(SupportedGatewayContextClaimsSchema))),
    Effect.mapError(consentUnavailable),
  );
  if (
    claims.aud !== 'privacy' ||
    claims.compositionRevision !== scope.compositionRevision ||
    claims.principal.tenantId !== scope.tenantId ||
    claims.principal.legalEntityId !== scope.legalEntityId ||
    claims.principal.authMethod !== 'api_key'
  ) {
    return yield* Effect.fail(consentUnavailable());
  }
  return {
    credential: Redacted.make(`Bearer ${response.token}`),
    options: {
      baseUrl: new URL(response.apiBaseUrl, configured.baseUrl),
      compositionRevision: scope.compositionRevision,
    },
    principalId: claims.principal.principalId,
  };
});
