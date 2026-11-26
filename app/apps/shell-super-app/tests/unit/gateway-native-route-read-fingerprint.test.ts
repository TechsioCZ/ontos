import { RegisteredGatewayRouteScopeSchema } from '@app/core-runtime/auth/system-principal-context-provenance';
import { GatewayActorClaimSchema, GatewayTrustedPrincipalContextSchema } from '@app/shared-contracts';
import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { fingerprintNativeRouteRead } from '../../api/auth/gateway-delegation-issuer.ts';

it.effect('keeps the persisted native-route read fingerprint byte order', () =>
  Effect.gen(function* nativeRouteFingerprint() {
    const principalId = '40000000-0000-4000-8000-000000000001';
    const tenantId = '50000000-0000-4000-8000-000000000001';
    const legalEntityId = '30000000-0000-4000-8000-000000000001';
    const actor = Schema.decodeUnknownSync(GatewayActorClaimSchema)({
      appId: 'symmy-integration',
      buildMarker: 'native-route-build',
      principalId: '60000000-0000-4000-8000-000000000001',
    });
    const principal = Schema.decodeUnknownSync(GatewayTrustedPrincipalContextSchema)({
      authBindingId: '10000000-0000-4000-8000-000000000001',
      authContextRef: 'better-auth-api-key:native-route-key',
      authMethod: 'api_key',
      legalEntityId,
      principalId,
      tenantId,
    });
    const routeScope = Schema.decodeUnknownSync(RegisteredGatewayRouteScopeSchema)({
      legalEntityId,
      nativeReadReceiver: {
        bindingIncarnation: '90000000-0000-4000-8000-000000000002',
        originalPrincipalId: principalId,
        originalWorkloadBindingIncarnation: '90000000-0000-4000-8000-000000000003',
        originalWorkloadKey: 'integration.symmy-admit',
        workloadKey: 'party.registry.read-receiver',
      },
      operations: [{ entrypointKey: 'party.registry.api.source-profile-export', schemaVersion: '1' }],
      principalId,
      routeId: '70000000-0000-4000-8000-000000000001',
      routeKey: 'adminCustomers',
      routeRevision: 'route-1',
      sourceRouteId: '80000000-0000-4000-8000-000000000001',
      sourceRouteRevision: 'source-1',
      tenantId,
    });
    const fingerprint = yield* fingerprintNativeRouteRead({
      actor,
      audience: 'party-registry',
      compositionRevision: 'a'.repeat(64),
      principal,
      requirementKey: 'symmy.party-registry.source-profile-export',
      routeScope,
    });
    // Computed from the issuer at a8bcea3a67 (routeScope before requirementKey).
    expect(fingerprint).toBe('ebd6157896303445dd66e92416533882f2bb286ca9721aeac87426f56e1215a2');
  }),
);
