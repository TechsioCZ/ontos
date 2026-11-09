import { CatalogSelectionSchema } from '@app/catalog/domain/catalog-selection-evidence';
import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import { computeCanonicalValueHash } from '@app/core-runtime/access/enforcement';
import {
  RegisteredGatewayRecoverySchema,
  RegisteredGatewayWorkloadSchema,
  readVerifiedGatewayWorkload,
  trustVerifiedGatewayPrincipalContext,
} from '@app/core-runtime/auth/system-principal-context-provenance';
import { GatewayDelegationSourceError } from '@app/shared-contracts/gateway-context-server';
import { NodeCrypto } from '@effect/platform-node';
import { ConfigProvider, Crypto, DateTime, Effect, Layer, Match, Redacted, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';
import {
  acquireOwnerGatewayConnection,
  pricingOwnerDelegationSubject,
} from '../../src/integrations/owner-gateway-connection.ts';
import type { OwnerGatewayConnectionInput } from '../../src/integrations/owner-gateway-connection.ts';
import { pricingManifest } from '../../vertical.manifest.ts';
import { verifiedTestScope } from '../support/owner-gateway-connection.fixture.ts';

const revision = 'a'.repeat(64);
const tenantId = 'e1400000-0000-4000-8000-000000000001';
const principalId = 'e1400000-0000-4000-8000-000000000002';
const legalEntityId = 'e1400000-0000-4000-8000-000000000003';
const selection = Schema.decodeSync(CatalogSelectionSchema)({
  productRef: {
    moduleId: 'commerce.catalog',
    resourceId: 'e1400000-0000-4000-8000-000000000004',
    resourceType: 'commerce.catalog.product',
    tenantId,
  },
  variantRef: {
    moduleId: 'commerce.catalog',
    resourceId: 'e1400000-0000-4000-8000-000000000005',
    resourceType: 'commerce.catalog.variant',
    tenantId,
  },
});
const catalogRead = { purpose: 'PRICING' as const, selection };
const recovery = Schema.decodeSync(RegisteredGatewayRecoverySchema)({
  originalActionInvocationId: 'e1400000-0000-4000-8000-000000000006',
  originalActionKey: 'commerce.pricing.define-price',
  originalAuthContextRef: 'job:internal-c14:run:original',
  originalIdempotencyKey: 'internal-c14-original',
  originalPrincipalId: principalId,
  originalRequestHash: 'b'.repeat(64),
  requestHash: 'c'.repeat(64),
});

/** Unit-only redeemed-provenance fixture. It deliberately supplies NO live conditional factory lease. */
const sourceScope = (recovering: boolean) =>
  Effect.gen(function* makeSourceScope() {
    const baseWorkload = {
      admissionInvocationId: 'e1400000-0000-4000-8000-000000000007',
      bindingIncarnation: 'e1400000-0000-4000-8000-000000000008',
      declarationKey: 'commerce.pricing.price.define',
      entrypointKey: 'commerce.pricing.define-price',
      jobKey: 'internal-c14-pricing',
      legalEntityId,
      legalEntityScope: 'required',
      originalOwnerBindingIncarnation: 'e1400000-0000-4000-8000-000000000009',
      originalPrincipalId: principalId,
      originalWorkloadBindingIncarnation: 'e1400000-0000-4000-8000-000000000010',
      originalWorkloadKey: 'integration.symmy-admit',
      runReference: 'e1400000-0000-4000-8000-000000000011',
      schemaVersion: '2',
      sourceAppId: 'symmy-integration',
      sourceBuildMarker: 'internal-unit-source',
      sourceMode: 'admission',
      workloadKey: 'commerce.pricing.source-write',
    };
    const workload = yield* Schema.decodeUnknownEffect(RegisteredGatewayWorkloadSchema)(
      recovering ? { ...baseWorkload, recovery } : baseWorkload,
    );
    const principal = yield* Schema.decodeUnknownEffect(TrustedPrincipalContextSchema)({
      authContextRef: 'job:internal-c14-pricing:run:original',
      authMethod: 'system',
      principalId,
      tenantId,
    });
    return trustVerifiedGatewayPrincipalContext(
      principal,
      revision,
      { assertion: Redacted.make('unit-only-redeemed-token'), audience: 'pricing' },
      undefined,
      workload,
    );
  });
const request = (scope: OwnerGatewayConnectionInput['scope']): OwnerGatewayConnectionInput => ({
  audience: 'catalog',
  compositionRevision: revision,
  conditionalRead: {
    input: catalogRead,
    kind: 'CATALOG_SELECTION',
    operationRequirementKey: 'commerce.pricing.requirement.define-price-catalog',
  },
  legalEntityScope: 'tenant',
  requestCorrelation: 'internal-c14-owner-call',
  scope,
});

const registeredFields = (subject: Effect.Success<ReturnType<typeof pricingOwnerDelegationSubject>>) =>
  Match.value(subject).pipe(
    Match.tag('RegisteredAssertion', (value) => value),
    Match.orElse(() => {}),
  );

describe('Pricing registered conditional owner delegation', () => {
  it.effect('preserves the ordinary human Assertion and the exact verified scope', () =>
    Effect.gen(function* human() {
      const scope = verifiedTestScope({ correlationId: 'human', legalEntityId, principalId, tenantId });
      const subject = yield* pricingOwnerDelegationSubject(request(scope));
      expect(
        Match.value(subject).pipe(
          Match.tag('Assertion', (value) => value.scope),
          Match.orElse(() => {}),
        ),
      ).toBe(scope);
      expect('scope' in subject ? subject.scope : undefined).toBe(scope);
    }),
  );

  it.effect('selects exact Catalog and Market RegisteredAssertion contracts without altering the source scope', () =>
    Effect.gen(function* source() {
      const scope = yield* sourceScope(false);
      const catalog = yield* pricingOwnerDelegationSubject(request(scope));
      expect(registeredFields(catalog)).toMatchObject({
        declarationKey: 'commerce.catalog.selection-evidence.read',
        operationRequirementKey: 'commerce.pricing.requirement.define-price-catalog',
      });
      expect('scope' in catalog ? catalog.scope : undefined).toBe(scope);
      expect(catalog).not.toHaveProperty('recoveryRequestHash');
      expect(
        pricingManifest.requirements?.operations.find(
          ({ key }) => key === 'commerce.pricing.requirement.define-price-catalog',
        )?.provider,
      ).toEqual({
        entrypointKey: 'commerce.catalog.api.selection-evidence',
        moduleId: 'commerce.catalog',
        schemaVersion: '1',
      });
      expect(
        pricingManifest.requirements?.operations.find(
          ({ key }) => key === 'commerce.pricing.requirement.define-price-market',
        )?.provider,
      ).toEqual({
        entrypointKey: 'commerce.market-catalog.api.current-market-catalog',
        moduleId: 'commerce.market-catalog',
        schemaVersion: '1',
      });

      const market = yield* pricingOwnerDelegationSubject({
        ...request(scope),
        audience: 'commerce-market-catalog',
        conditionalRead: {
          input: { at: DateTime.makeUnsafe('2026-11-07T10:00:00.000Z') },
          kind: 'CURRENT_MARKET',
          operationRequirementKey: 'commerce.pricing.requirement.define-price-market',
        },
        legalEntityScope: 'subject',
      });
      expect(registeredFields(market)).toMatchObject({
        declarationKey: 'commerce.market-catalog.market-catalog.read',
        operationRequirementKey: 'commerce.pricing.requirement.define-price-market',
      });
      expect('scope' in market ? market.scope : undefined).toBe(scope);
      expect(readVerifiedGatewayWorkload(scope)?.legalEntityId).toBe(legalEntityId);
    }),
  );

  it.effect('hashes the actual decoded nested Read input for recovery instead of copying the parent hash', () =>
    Effect.gen(function* recoveryInput() {
      const scope = yield* sourceScope(true);
      const subject = yield* pricingOwnerDelegationSubject(request(scope));
      expect(registeredFields(subject)).toMatchObject({
        recoveryRequestHash: computeCanonicalValueHash(catalogRead),
      });
      expect(subject).not.toMatchObject({ recoveryRequestHash: recovery.requestHash });
      const changedRead = {
        ...catalogRead,
        selection: {
          ...selection,
          variantRef: { ...selection.variantRef, resourceId: 'e1400000-0000-4000-8000-000000000099' },
        },
      };
      const changed = yield* pricingOwnerDelegationSubject({
        ...request(scope),
        conditionalRead: {
          input: changedRead,
          kind: 'CATALOG_SELECTION',
          operationRequirementKey: 'commerce.pricing.requirement.define-price-catalog',
        },
      });
      expect(changed).toMatchObject({ recoveryRequestHash: computeCanonicalValueHash(changedRead) });
      expect(changed).not.toEqual(subject);
    }),
  );

  it.effect('rejects copied provenance, missing conditional providers, and substituted destination scope', () =>
    Effect.gen(function* rejectInvalid() {
      const scope = yield* sourceScope(false);
      const { conditionalRead: _read, ...withoutProvider } = request(scope);
      for (const invalid of [
        { ...request(scope), scope: { ...scope } },
        withoutProvider,
        { ...request(scope), audience: 'privacy' },
        { ...request(scope), legalEntityScope: 'subject' as const },
      ]) {
        expect(
          Schema.is(GatewayDelegationSourceError)(yield* pricingOwnerDelegationSubject(invalid).pipe(Effect.flip)),
        ).toBe(true);
      }
    }),
  );
});

it.layer(
  Layer.mergeAll(
    NodeCrypto.layer,
    ConfigProvider.layer(
      ConfigProvider.fromUnknown({
        ONTOS_GATEWAY_MODULE_API_KEY: 'unit-only-module-key',
        ONTOS_SHELL_GATEWAY_BASE_URL: 'https://shell.internal.example/',
      }),
    ),
  ),
)('Pricing live conditional requirement enforcement', (suite) => {
  suite.effect('refuses registered delegation without the genuine current factory lease', () =>
    Effect.gen(function* noLease() {
      const scope = yield* sourceScope(false);
      const crypto = yield* Crypto.Crypto;
      const failure = yield* acquireOwnerGatewayConnection(request(scope), crypto).pipe(Effect.flip);
      expect(Schema.is(GatewayDelegationSourceError)(failure.cause)).toBe(true);
      expect(failure.cause).toMatchObject({
        reason: 'Conditional delegation requires its exact active operation lease',
      });
    }),
  );
});
