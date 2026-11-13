import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import type { TrustedPrincipalContext } from '@app/core-runtime';
import {
  AuthenticationNamespaceRegistry,
  makeAuthenticationNamespaceRegistry,
} from '@app/core-runtime/auth/external-identity-admission';
import { AuthenticationNamespaceIdSchema } from '@app/core-runtime/auth/external-identity-contracts';
import {
  RegisteredGatewayRouteScopeSchema,
  trustVerifiedGatewayPrincipalContext,
} from '@app/core-runtime/auth/system-principal-context-provenance';
import type { RegisteredGatewayRouteScope } from '@app/core-runtime/auth/system-principal-context-provenance';
import { NodeCrypto } from '@effect/platform-node';
import { randomBytes } from 'node:crypto';
import { ConfigProvider, Layer, Schema } from 'effect';
import { Base64Url } from 'effect/encoding';

import { ProviderBindingRouteKeySchema } from '../../shared/apis/provider-binding-route.ts';
import type { PaymentGatewayProviderFamilySchema } from '../../shared/domain/payment-vocabulary.ts';
import { GatewayHttpsUrlSchema } from '../../shared/domain/psp-configuration.ts';
import {
  notificationUrlOf,
  PAYMENT_NOTIFICATION_BASE_URL_VARIABLE,
  PaymentNotificationRoutesLive,
} from '../../src/config/payment-notification-route-config.ts';
import type { PaymentNotificationRoute } from '../../src/config/payment-notification-route-config.ts';
import { PROVIDER_BINDING_ROUTE_SCOPE_KEY } from '../../src/persistence/psp-binding-route-persistence.ts';

/**
 * #1157 / #1153 test seam: an integration principal's context exactly as Core hands it to a Payment Action after
 * Shell signed a provider binding route scope (`S/api/auth/gateway-payment-route-scope.ts`) and the gateway
 * verified and redeemed it. The route names one binding as route and source route, its revision as a decimal
 * string and exactly one owner operation, as Shell issues it. Only the test constructs it; no fixture value is
 * a real credential.
 */

export const ROUTE_SCOPE_AUTHENTICATION_NAMESPACE = 'test.payment-route-scope.v1';
export const ROUTE_SCOPE_COMPOSITION_REVISION = 'e'.repeat(64);

/** The API-key namespace of the fixture integration principals, admitted without a provider round trip. */
export const RouteScopeNamespaceRegistryLive = Layer.succeed(
  AuthenticationNamespaceRegistry,
  makeAuthenticationNamespaceRegistry([
    {
      allowedAudiences: ['payment'],
      authenticationNamespaceId: AuthenticationNamespaceIdSchema.make(ROUTE_SCOPE_AUTHENTICATION_NAMESPACE),
      provider: 'route-scope-fixture',
      requiresOperationAdmission: false,
      reservationPrincipalKind: 'integration',
      subjectTypes: ['api_key'],
      trustedAttesterPrincipalIds: [],
    },
  ]),
);

export const CAPTURE_ROUTE_OPERATION = {
  entrypointKey: 'payment.core.capture-provider-notification',
  schemaVersion: '1',
} as const;
export const RECOVERY_ROUTE_OPERATION = {
  entrypointKey: 'payment.core.request-payment-operation-recovery',
  schemaVersion: '1',
} as const;

export interface RouteScopeIdentity {
  readonly legalEntityId: string;
  readonly principalId: string;
  readonly tenantId: string;
}

export interface RouteScopeInput {
  readonly bindingId: string;
  /** Defaults to the composition revision every route-scoped fixture context is signed for. */
  readonly compositionRevision?: string;
  readonly operation: typeof CAPTURE_ROUTE_OPERATION | typeof RECOVERY_ROUTE_OPERATION;
  /** Overrides of the signed route, for proofs that must not match. */
  readonly overrides?: Partial<Record<'routeId' | 'routeKey' | 'routeRevision' | 'sourceRouteRevision', string>>;
  readonly routeRevision?: number;
}

/** The integration principal of the relay or reconciliation workload, authenticated by its API key. */
export const apiKeyPrincipalOf = (identity: RouteScopeIdentity): TrustedPrincipalContext =>
  Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
    authBindingId: identity.principalId,
    authContextRef: `better-auth-api-key:${identity.principalId}`,
    authenticationNamespaceId: ROUTE_SCOPE_AUTHENTICATION_NAMESPACE,
    authMethod: 'api_key',
    legalEntityId: identity.legalEntityId,
    principalId: identity.principalId,
    tenantId: identity.tenantId,
  });

/** The route scope Shell signs for one binding route and one operation. */
export const bindingRouteScopeOf = (
  identity: RouteScopeIdentity,
  input: RouteScopeInput,
): RegisteredGatewayRouteScope => {
  const revision = String(input.routeRevision ?? 1);
  return Schema.decodeUnknownSync(RegisteredGatewayRouteScopeSchema)({
    legalEntityId: identity.legalEntityId,
    operations: [input.operation],
    principalId: identity.principalId,
    routeId: input.bindingId,
    routeKey: PROVIDER_BINDING_ROUTE_SCOPE_KEY,
    routeRevision: revision,
    sourceRouteId: input.bindingId,
    sourceRouteRevision: revision,
    tenantId: identity.tenantId,
    ...input.overrides,
  });
};

/** A verified and redeemed route-scoped context, as `readVerifiedGatewayRouteScope` reads it in the Action. */
export const routeScopedPrincipalOf = (identity: RouteScopeIdentity, input: RouteScopeInput): TrustedPrincipalContext =>
  trustVerifiedGatewayPrincipalContext(
    apiKeyPrincipalOf(identity),
    input.compositionRevision ?? ROUTE_SCOPE_COMPOSITION_REVISION,
    undefined,
    undefined,
    undefined,
    bindingRouteScopeOf(identity, input),
  );

/** The public Shell origin of the fixture deployment; not a real host. */
export const TEST_NOTIFICATION_ORIGIN = 'https://shell.example.test';

/** A fresh Payment-shaped route for persistence tests that create a binding directly. */
export const testNotificationRouteOf = (
  tenantId: string,
  family: typeof PaymentGatewayProviderFamilySchema.Type,
): PaymentNotificationRoute => {
  const routeKey = Schema.decodeUnknownSync(ProviderBindingRouteKeySchema)(Base64Url.encode(randomBytes(32)));
  return {
    notificationUrl: Schema.decodeUnknownSync(GatewayHttpsUrlSchema)(
      notificationUrlOf({ family, origin: TEST_NOTIFICATION_ORIGIN, routeKey, tenantId }),
    ),
    routeKey,
  };
};

const issuerOver = (configuration: Readonly<Record<string, string>>) =>
  Layer.merge(
    Layer.provide(PaymentNotificationRoutesLive, NodeCrypto.layer),
    ConfigProvider.layer(ConfigProvider.fromUnknown(configuration)),
  );

/** The production route issuer over Node's cryptographic random source, with the fixture origin configured. */
export const testNotificationRoutesLive = issuerOver({
  [PAYMENT_NOTIFICATION_BASE_URL_VARIABLE]: TEST_NOTIFICATION_ORIGIN,
});

/** The same issuer in a deployment that configures no public notification origin. */
export const unconfiguredNotificationRoutesLive = issuerOver({});
