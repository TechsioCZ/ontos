import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { CatalogResourceRefSchema } from '../../shared/domain/catalog-revision-reference.ts';
import type { CatalogResourceRef } from '../../shared/domain/catalog-revision-reference.ts';
import { CatalogExternalSourceRecordRefSchema } from '../../shared/domain/external-identifier-boundary.ts';
import type { CatalogExternalSourceRecordRef } from '../../shared/domain/external-identifier-boundary.ts';
import {
  CatalogExternalCorrelationSchema,
  CatalogExternalDeterministicRuleSchema,
} from '../../shared/domain/external-target-resolution.ts';
import type {
  CatalogExternalCorrelation,
  CatalogExternalDeterministicRule,
  CatalogExternalTargetRequest,
} from '../../shared/domain/external-target-resolution.ts';
import { ExternalCorrelationAmbiguous } from '../../src/persistence/external-correlation-ambiguous.ts';
import { ExternalCorrelationMissingLink } from '../../src/persistence/external-correlation-missing-link.ts';
import { ExternalCorrelationTargetTypeMismatch } from '../../src/persistence/external-correlation-target-type-mismatch.ts';
import { ExternalCorrelationUnverifiable } from '../../src/persistence/external-correlation-unverifiable.ts';
import { makeExternalCorrelationResolver } from '../../src/persistence/external-correlation-resolver.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const otherTenantId = '99999999-9999-4999-8999-999999999999';
const productAId = '22222222-2222-4222-8222-222222222222';
const productBId = '33333333-3333-4333-8333-333333333333';
const variantAId = '44444444-4444-4444-8444-444444444444';

const decodeTarget = Schema.decodeUnknownSync(CatalogResourceRefSchema, { onExcessProperty: 'error' });
const decodeSource = Schema.decodeUnknownSync(CatalogExternalSourceRecordRefSchema, { onExcessProperty: 'error' });
const decodeCorrelation = Schema.decodeUnknownSync(CatalogExternalCorrelationSchema, { onExcessProperty: 'error' });
const decodeRule = Schema.decodeUnknownSync(CatalogExternalDeterministicRuleSchema, { onExcessProperty: 'error' });

const sourceRecord: CatalogExternalSourceRecordRef = decodeSource({
  issuerId: 'erp-a',
  issuerKind: 'EXTERNAL_BUSINESS_SYSTEM',
  recordId: '784',
  recordNamespace: 'product',
  tenantId,
});
const request: CatalogExternalTargetRequest = { recordMeaning: 'PRODUCT', sourceRecord };

const productTarget = (resourceId: string, tenant = tenantId): CatalogResourceRef =>
  decodeTarget({
    moduleId: 'commerce.catalog',
    resourceId,
    resourceType: 'commerce.catalog.product',
    tenantId: tenant,
  });

const correlation = (
  correlationId: string,
  target: CatalogResourceRef,
  declaredTargetKind: 'PRODUCT' | 'VARIANT' = 'PRODUCT',
): CatalogExternalCorrelation =>
  decodeCorrelation({ correlationId, declaredTargetKind, sourceRecord, state: 'CONFIRMED', target });

const skuRule: CatalogExternalDeterministicRule = decodeRule({
  acceptedMatchKinds: ['SKU'],
  issuerId: 'erp-a',
  issuerKind: 'EXTERNAL_BUSINESS_SYSTEM',
  recordMeaning: 'PRODUCT',
  recordNamespace: 'product',
  ruleId: 'rule-erp-a-product-sku',
});

describe('Catalog external correlation resolver', () => {
  it.effect('fails closed when the Connector Registry owner is unavailable', () =>
    Effect.gen(function* testUnavailable() {
      for (const tag of [
        'ExternalCorrelationRegistryUnavailableProblem',
        'ExternalCorrelationRegistryForbiddenProblem',
      ]) {
        const resolver = makeExternalCorrelationResolver({
          readCorrelations: () => Effect.fail({ _tag: tag }),
        });
        const failure = yield* Effect.flip(resolver.resolve(request));
        expect(Schema.is(ExternalCorrelationUnverifiable)(failure)).toBe(true);
      }
      const unconfigured = makeExternalCorrelationResolver();
      const failure = yield* Effect.flip(unconfigured.resolve(request));
      expect(Schema.is(ExternalCorrelationUnverifiable)(failure)).toBe(true);
    }),
  );

  it.effect('treats an owner not-found read as a missing link, never as a new identity', () =>
    Effect.gen(function* testNotFound() {
      const resolver = makeExternalCorrelationResolver({
        readCorrelations: () => Effect.fail({ _tag: 'ExternalCorrelationRegistryNotFoundProblem' }),
      });
      const failure = yield* Effect.flip(resolver.resolve(request));
      expect(Schema.is(ExternalCorrelationMissingLink)(failure)).toBe(true);
    }),
  );

  it.effect('resolves a confirmed owner correlation to the exact target', () =>
    Effect.gen(function* testResolved() {
      const target = productTarget(productAId);
      const resolver = makeExternalCorrelationResolver({
        readCorrelations: () => Effect.succeed([correlation('corr-a', target)]),
      });
      const resolved = yield* resolver.resolve(request);
      expect(resolved).toMatchObject({ capture: 'ALREADY_OWNER_CONFIRMED', target, targetKind: 'PRODUCT' });
    }),
  );

  it.effect('keeps ambiguous targets and a wrong target type as distinct failures', () =>
    Effect.gen(function* testDistinctFailures() {
      const ambiguous = makeExternalCorrelationResolver({
        readCorrelations: () =>
          Effect.succeed([
            correlation('corr-a', productTarget(productAId)),
            correlation('corr-b', productTarget(productBId)),
          ]),
      });
      const ambiguousFailure = yield* Effect.flip(ambiguous.resolve(request));
      expect(Schema.is(ExternalCorrelationAmbiguous)(ambiguousFailure)).toBe(true);

      const wrongType = makeExternalCorrelationResolver({
        readCorrelations: () =>
          Effect.succeed([
            correlation(
              'corr-variant',
              decodeTarget({
                moduleId: 'commerce.catalog',
                resourceId: variantAId,
                resourceType: 'commerce.catalog.variant',
                tenantId,
              }),
              'VARIANT',
            ),
          ]),
      });
      const mismatch = yield* Effect.flip(wrongType.resolve(request));
      expect(Schema.is(ExternalCorrelationTargetTypeMismatch)(mismatch)).toBe(true);

      const crossTenant = makeExternalCorrelationResolver({
        readCorrelations: () => Effect.succeed([correlation('corr-cross', productTarget(productAId, otherTenantId))]),
      });
      const crossTenantFailure = yield* Effect.flip(crossTenant.resolve(request));
      expect(Schema.is(ExternalCorrelationUnverifiable)(crossTenantFailure)).toBe(true);
    }),
  );

  it.effect('applies a pre-approved deterministic rule only after the owner has no link', () =>
    Effect.gen(function* testRule() {
      const resolver = makeExternalCorrelationResolver(
        { readCorrelations: () => Effect.fail({ _tag: 'ExternalCorrelationRegistryNotFoundProblem' }) },
        {
          deterministicCandidates: [{ matchedBy: 'SKU', matchValue: 'AB-12', target: productTarget(productAId) }],
          deterministicRules: [skuRule],
        },
      );
      const resolved = yield* resolver.resolve(request);
      expect(resolved).toMatchObject({ capture: 'REQUIRED_BEFORE_ACCEPTANCE', source: 'PRE_APPROVED_RULE' });

      const withoutRule = makeExternalCorrelationResolver({
        readCorrelations: () => Effect.fail({ _tag: 'ExternalCorrelationRegistryNotFoundProblem' }),
      });
      const failure = yield* Effect.flip(withoutRule.resolve(request));
      expect(Schema.is(ExternalCorrelationMissingLink)(failure)).toBe(true);
    }),
  );
});
