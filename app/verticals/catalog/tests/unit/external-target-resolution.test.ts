import { Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { CatalogResourceRefSchema } from '../../shared/domain/catalog-revision-reference.ts';
import type { CatalogResourceRef } from '../../shared/domain/catalog-revision-reference.ts';
import { CatalogExternalSourceRecordRefSchema } from '../../shared/domain/external-identifier-boundary.ts';
import type { CatalogExternalSourceRecordRef } from '../../shared/domain/external-identifier-boundary.ts';
import {
  assessCatalogExternalCorrelationCapture,
  assessCatalogExternalFactAdmission,
  CatalogExternalCorrelationSchema,
  CatalogExternalDeterministicRuleSchema,
  resolveCatalogExternalTarget,
} from '../../shared/domain/external-target-resolution.ts';
import type {
  CatalogExternalCorrelation,
  CatalogExternalCorrelationState,
  CatalogExternalDeterministicCandidate,
  CatalogExternalDeterministicMatchKind,
  CatalogExternalDeterministicRule,
  CatalogExternalTargetKind,
  CatalogExternalTargetRequest,
} from '../../shared/domain/external-target-resolution.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const otherTenantId = '99999999-9999-4999-8999-999999999999';
const productAId = '22222222-2222-4222-8222-222222222222';
const productBId = '33333333-3333-4333-8333-333333333333';
const variantAId = '44444444-4444-4444-8444-444444444444';
const packageAId = '55555555-5555-4555-8555-555555555555';

const decodeTarget = Schema.decodeUnknownSync(CatalogResourceRefSchema, { onExcessProperty: 'error' });
const decodeSource = Schema.decodeUnknownSync(CatalogExternalSourceRecordRefSchema, { onExcessProperty: 'error' });
const decodeCorrelation = Schema.decodeUnknownSync(CatalogExternalCorrelationSchema, { onExcessProperty: 'error' });
const decodeRule = Schema.decodeUnknownSync(CatalogExternalDeterministicRuleSchema, { onExcessProperty: 'error' });

const target = (
  resourceType: 'commerce.catalog.package-definition' | 'commerce.catalog.product' | 'commerce.catalog.variant',
  resourceId: string,
  tenant = tenantId,
): CatalogResourceRef => decodeTarget({ moduleId: 'commerce.catalog', resourceId, resourceType, tenantId: tenant });

interface SourceOverrides {
  readonly issuerId?: string;
  readonly issuerKind?: 'EXTERNAL_BUSINESS_SYSTEM' | 'EXTERNAL_EVIDENCE_PROVIDER';
  readonly recordId?: string;
  readonly recordNamespace?: string;
  readonly tenantId?: string;
}

const sourceRecord = (overrides: SourceOverrides = {}): CatalogExternalSourceRecordRef =>
  decodeSource({
    issuerId: 'erp-a',
    issuerKind: 'EXTERNAL_BUSINESS_SYSTEM',
    recordId: '784',
    recordNamespace: 'product',
    tenantId,
    ...overrides,
  });

const correlation = (input: {
  readonly correlationId: string;
  readonly declaredTargetKind: CatalogExternalTargetKind;
  readonly sourceRecord: CatalogExternalSourceRecordRef;
  readonly state?: CatalogExternalCorrelationState;
  readonly target: CatalogResourceRef;
}): CatalogExternalCorrelation =>
  decodeCorrelation({
    correlationId: input.correlationId,
    declaredTargetKind: input.declaredTargetKind,
    sourceRecord: input.sourceRecord,
    state: input.state ?? 'CONFIRMED',
    target: input.target,
  });

const request = (
  source: CatalogExternalSourceRecordRef,
  recordMeaning: CatalogExternalTargetKind,
): CatalogExternalTargetRequest => ({ recordMeaning, sourceRecord: source });

interface RuleOverrides {
  readonly acceptedMatchKinds?: readonly CatalogExternalDeterministicMatchKind[];
  readonly issuerId?: string;
  readonly issuerKind?: 'EXTERNAL_BUSINESS_SYSTEM' | 'EXTERNAL_EVIDENCE_PROVIDER';
  readonly recordMeaning?: CatalogExternalTargetKind;
  readonly recordNamespace?: string;
  readonly ruleId?: string;
}

const skuRule = (overrides: RuleOverrides = {}): CatalogExternalDeterministicRule =>
  decodeRule({
    acceptedMatchKinds: ['SKU'],
    issuerId: 'erp-a',
    issuerKind: 'EXTERNAL_BUSINESS_SYSTEM',
    recordMeaning: 'PRODUCT',
    recordNamespace: 'product',
    ruleId: 'rule-erp-a-product-sku',
    ...overrides,
  });

const candidate = (
  matchedBy: CatalogExternalDeterministicMatchKind,
  matchedTarget: CatalogResourceRef,
): CatalogExternalDeterministicCandidate => ({ matchedBy, matchValue: 'AB-12', target: matchedTarget });

describe('Catalog external target resolution', () => {
  it('does not merge equal external numbers from different issuers, namespaces, or Tenants', () => {
    const fromErpA = correlation({
      correlationId: 'corr-erp-a',
      declaredTargetKind: 'PRODUCT',
      sourceRecord: sourceRecord(),
      target: target('commerce.catalog.product', productAId),
    });
    const fromErpB = correlation({
      correlationId: 'corr-erp-b',
      declaredTargetKind: 'PRODUCT',
      sourceRecord: sourceRecord({ issuerId: 'erp-b' }),
      target: target('commerce.catalog.product', productBId),
    });
    const fromVariantNamespace = correlation({
      correlationId: 'corr-ns',
      declaredTargetKind: 'VARIANT',
      sourceRecord: sourceRecord({ recordNamespace: 'variant' }),
      target: target('commerce.catalog.variant', variantAId),
    });
    const fromOtherTenant = correlation({
      correlationId: 'corr-tenant',
      declaredTargetKind: 'PRODUCT',
      sourceRecord: sourceRecord({ tenantId: otherTenantId }),
      target: target('commerce.catalog.product', productAId, otherTenantId),
    });
    const correlations = [fromErpA, fromErpB, fromVariantNamespace, fromOtherTenant];

    expect(resolveCatalogExternalTarget({ correlations, request: request(sourceRecord(), 'PRODUCT') })).toMatchObject({
      source: 'OWNER_CORRELATION',
      status: 'RESOLVED',
      target: { resourceId: productAId },
    });
    expect(
      resolveCatalogExternalTarget({ correlations, request: request(sourceRecord({ issuerId: 'erp-b' }), 'PRODUCT') }),
    ).toMatchObject({ status: 'RESOLVED', target: { resourceId: productBId } });
    expect(
      resolveCatalogExternalTarget({ correlations, request: request(sourceRecord({ issuerId: 'erp-c' }), 'PRODUCT') }),
    ).toMatchObject({ status: 'MISSING_LINK' });
    expect(
      resolveCatalogExternalTarget({
        correlations,
        request: request(sourceRecord({ recordNamespace: 'variant' }), 'VARIANT'),
      }),
    ).toMatchObject({ status: 'RESOLVED', target: { resourceId: variantAId } });
  });

  it('resolves only when the confirmed correlation type matches the source record meaning', () => {
    expect(
      resolveCatalogExternalTarget({
        correlations: [
          correlation({
            correlationId: 'corr-variant',
            declaredTargetKind: 'VARIANT',
            sourceRecord: sourceRecord({ recordNamespace: 'variant' }),
            target: target('commerce.catalog.variant', variantAId),
          }),
        ],
        request: request(sourceRecord({ recordNamespace: 'variant' }), 'VARIANT'),
      }),
    ).toMatchObject({ capture: 'ALREADY_OWNER_CONFIRMED', targetKind: 'VARIANT' });

    expect(
      resolveCatalogExternalTarget({
        correlations: [
          correlation({
            correlationId: 'corr-product',
            declaredTargetKind: 'PRODUCT',
            sourceRecord: sourceRecord(),
            target: target('commerce.catalog.product', productAId),
          }),
        ],
        request: request(sourceRecord(), 'VARIANT'),
      }),
    ).toMatchObject({ status: 'TARGET_TYPE_MISMATCH' });

    expect(
      resolveCatalogExternalTarget({
        correlations: [
          correlation({
            correlationId: 'corr-inconsistent',
            declaredTargetKind: 'PRODUCT',
            sourceRecord: sourceRecord(),
            target: target('commerce.catalog.variant', variantAId),
          }),
        ],
        request: request(sourceRecord(), 'PRODUCT'),
      }),
    ).toMatchObject({ status: 'UNVERIFIABLE' });

    expect(
      resolveCatalogExternalTarget({
        correlations: [
          correlation({
            correlationId: 'corr-unknown',
            declaredTargetKind: 'PRODUCT',
            sourceRecord: sourceRecord(),
            target: decodeTarget({
              moduleId: 'commerce.catalog',
              resourceId: packageAId,
              resourceType: 'commerce.catalog.widget',
              tenantId,
            }),
          }),
        ],
        request: request(sourceRecord(), 'PRODUCT'),
      }),
    ).toMatchObject({ status: 'UNVERIFIABLE' });

    expect(
      resolveCatalogExternalTarget({
        correlations: [
          correlation({
            correlationId: 'corr-cross',
            declaredTargetKind: 'PRODUCT',
            sourceRecord: sourceRecord(),
            target: target('commerce.catalog.product', productAId, otherTenantId),
          }),
        ],
        request: request(sourceRecord(), 'PRODUCT'),
      }),
    ).toMatchObject({ status: 'UNVERIFIABLE' });
  });

  it('distinguishes multiple confirmed targets from a disputed or retracted link without creating anything', () => {
    const toProductA = correlation({
      correlationId: 'corr-a',
      declaredTargetKind: 'PRODUCT',
      sourceRecord: sourceRecord(),
      target: target('commerce.catalog.product', productAId),
    });
    const toProductB = correlation({
      correlationId: 'corr-b',
      declaredTargetKind: 'PRODUCT',
      sourceRecord: sourceRecord(),
      target: target('commerce.catalog.product', productBId),
    });
    const ambiguous = resolveCatalogExternalTarget({
      correlations: [toProductA, toProductB],
      request: request(sourceRecord(), 'PRODUCT'),
    });
    expect(ambiguous).toMatchObject({ status: 'AMBIGUOUS' });
    expect(ambiguous.status === 'AMBIGUOUS' ? ambiguous.candidates : []).toHaveLength(2);

    expect(
      resolveCatalogExternalTarget({
        correlations: [{ ...toProductA, state: 'DISPUTED' }],
        request: request(sourceRecord(), 'PRODUCT'),
      }),
    ).toMatchObject({ status: 'UNVERIFIABLE' });

    expect(
      resolveCatalogExternalTarget({
        correlations: [{ ...toProductA, state: 'RETRACTED' }],
        request: request(sourceRecord(), 'PRODUCT'),
      }),
    ).toMatchObject({ status: 'MISSING_LINK' });

    expect(
      resolveCatalogExternalTarget({ correlations: [], request: request(sourceRecord(), 'PRODUCT') }),
    ).toMatchObject({ status: 'MISSING_LINK' });
  });

  it('uses a pre-approved deterministic rule only for an explicitly recognised exact code', () => {
    const productTarget = target('commerce.catalog.product', productAId);
    const otherTarget = target('commerce.catalog.product', productBId);

    expect(
      resolveCatalogExternalTarget({
        correlations: [],
        deterministicCandidates: [candidate('SKU', productTarget)],
        deterministicRules: [skuRule()],
        request: request(sourceRecord(), 'PRODUCT'),
      }),
    ).toMatchObject({
      capture: 'REQUIRED_BEFORE_ACCEPTANCE',
      source: 'PRE_APPROVED_RULE',
      status: 'RESOLVED',
      target: productTarget,
    });

    expect(
      resolveCatalogExternalTarget({
        correlations: [],
        deterministicCandidates: [candidate('GTIN', productTarget)],
        deterministicRules: [skuRule()],
        request: request(sourceRecord(), 'PRODUCT'),
      }),
    ).toMatchObject({ status: 'MISSING_LINK' });

    expect(
      resolveCatalogExternalTarget({
        correlations: [],
        deterministicCandidates: [candidate('SKU', productTarget)],
        deterministicRules: [skuRule({ acceptedMatchKinds: [] })],
        request: request(sourceRecord(), 'PRODUCT'),
      }),
    ).toMatchObject({ status: 'MISSING_LINK' });

    expect(
      resolveCatalogExternalTarget({
        correlations: [],
        deterministicCandidates: [candidate('SKU', productTarget), candidate('SKU', otherTarget)],
        deterministicRules: [skuRule()],
        request: request(sourceRecord(), 'PRODUCT'),
      }),
    ).toMatchObject({ status: 'AMBIGUOUS' });

    expect(
      resolveCatalogExternalTarget({
        correlations: [],
        deterministicCandidates: [candidate('SKU', productTarget)],
        deterministicRules: [skuRule(), skuRule({ ruleId: 'rule-second' })],
        request: request(sourceRecord(), 'PRODUCT'),
      }),
    ).toMatchObject({ status: 'UNVERIFIABLE' });

    expect(
      resolveCatalogExternalTarget({
        correlations: [],
        deterministicCandidates: [candidate('SKU', productTarget)],
        deterministicRules: [skuRule({ issuerId: 'erp-b' })],
        request: request(sourceRecord(), 'PRODUCT'),
      }),
    ).toMatchObject({ status: 'MISSING_LINK' });

    expect(
      resolveCatalogExternalTarget({
        correlations: [],
        deterministicCandidates: [candidate('SKU', productTarget)],
        deterministicRules: [skuRule({ recordMeaning: 'VARIANT' })],
        request: request(sourceRecord(), 'PRODUCT'),
      }),
    ).toMatchObject({ status: 'MISSING_LINK' });
  });

  it('captures a new safe assignment at the owner before dependent facts are admitted', () => {
    const proposed = correlation({
      correlationId: 'corr-new',
      declaredTargetKind: 'PRODUCT',
      sourceRecord: sourceRecord(),
      target: target('commerce.catalog.product', productAId),
    });
    const base = { proposed, request: request(sourceRecord(), 'PRODUCT') } as const;

    expect(assessCatalogExternalCorrelationCapture({ ...base, existing: [], registry: 'AVAILABLE' })).toEqual({
      correlationRef: 'corr-new',
      status: 'CAPTURE_REQUIRED',
    });
    expect(assessCatalogExternalCorrelationCapture({ ...base, existing: [proposed], registry: 'AVAILABLE' })).toEqual({
      correlationRef: 'corr-new',
      status: 'ALREADY_CAPTURED',
    });
    expect(
      assessCatalogExternalCorrelationCapture({
        ...base,
        existing: [
          correlation({
            correlationId: 'corr-other',
            declaredTargetKind: 'PRODUCT',
            sourceRecord: sourceRecord(),
            target: target('commerce.catalog.product', productBId),
          }),
        ],
        registry: 'AVAILABLE',
      }),
    ).toMatchObject({ status: 'CONFLICT' });
    expect(assessCatalogExternalCorrelationCapture({ ...base, existing: [], registry: 'UNAVAILABLE' })).toMatchObject({
      status: 'UNVERIFIABLE',
    });

    const ruleResolution = resolveCatalogExternalTarget({
      correlations: [],
      deterministicCandidates: [candidate('SKU', proposed.target)],
      deterministicRules: [skuRule()],
      request: request(sourceRecord(), 'PRODUCT'),
    });
    const fact = { factKey: 'description', ownership: 'EXTERNAL_SOURCE', target: proposed.target } as const;
    expect(
      assessCatalogExternalFactAdmission({
        captureConfirmed: false,
        fact,
        resolution: ruleResolution,
        sourceAuthority: 'VERIFIED',
      }),
    ).toMatchObject({ reason: 'CORRELATION_NOT_CAPTURED', status: 'HELD' });
    expect(
      assessCatalogExternalFactAdmission({
        captureConfirmed: true,
        fact,
        resolution: ruleResolution,
        sourceAuthority: 'VERIFIED',
      }),
    ).toMatchObject({ status: 'ADMISSIBLE' });
  });

  it('never lets a correct correlation alone change a locally-owned or unverifiable fact', () => {
    const productTarget = target('commerce.catalog.product', productAId);
    const resolved = resolveCatalogExternalTarget({
      correlations: [
        correlation({
          correlationId: 'corr-owner',
          declaredTargetKind: 'PRODUCT',
          sourceRecord: sourceRecord(),
          target: productTarget,
        }),
      ],
      request: request(sourceRecord(), 'PRODUCT'),
    });
    expect(resolved).toMatchObject({ factAuthority: 'TARGET_ONLY', status: 'RESOLVED' });

    expect(
      assessCatalogExternalFactAdmission({
        captureConfirmed: true,
        fact: { factKey: 'name', ownership: 'CATALOG_LOCAL', target: productTarget },
        resolution: resolved,
        sourceAuthority: 'VERIFIED',
      }),
    ).toMatchObject({ reason: 'LOCALLY_OWNED_FACT', status: 'HELD' });

    expect(
      assessCatalogExternalFactAdmission({
        captureConfirmed: true,
        fact: { factKey: 'name', ownership: 'EXTERNAL_SOURCE', target: productTarget },
        resolution: resolved,
        sourceAuthority: 'UNVERIFIED',
      }),
    ).toMatchObject({ reason: 'NO_SOURCE_AUTHORITY', status: 'HELD' });

    expect(
      assessCatalogExternalFactAdmission({
        captureConfirmed: true,
        fact: {
          factKey: 'name',
          ownership: 'EXTERNAL_SOURCE',
          target: target('commerce.catalog.variant', variantAId),
        },
        resolution: resolved,
        sourceAuthority: 'VERIFIED',
      }),
    ).toMatchObject({ reason: 'TARGET_MISMATCH', status: 'HELD' });

    expect(
      assessCatalogExternalFactAdmission({
        captureConfirmed: true,
        fact: { factKey: 'name', ownership: 'EXTERNAL_SOURCE', target: productTarget },
        resolution: { reason: 'no link', status: 'MISSING_LINK' },
        sourceAuthority: 'VERIFIED',
      }),
    ).toMatchObject({ factKey: 'name', reason: 'MISSING_LINK', status: 'HELD' });
  });

  it('lets a retry find the already-created target instead of creating a duplicate', () => {
    const created = target('commerce.catalog.product', productAId);
    const confirmed = correlation({
      correlationId: 'corr-created',
      declaredTargetKind: 'PRODUCT',
      sourceRecord: sourceRecord(),
      target: created,
    });

    expect(
      resolveCatalogExternalTarget({ correlations: [], request: request(sourceRecord(), 'PRODUCT') }),
    ).toMatchObject({ status: 'MISSING_LINK' });
    expect(
      resolveCatalogExternalTarget({ correlations: [confirmed], request: request(sourceRecord(), 'PRODUCT') }),
    ).toMatchObject({ capture: 'ALREADY_OWNER_CONFIRMED', status: 'RESOLVED', target: created });
    expect(
      resolveCatalogExternalTarget({ correlations: [confirmed], request: request(sourceRecord(), 'PRODUCT') }),
    ).toMatchObject({ status: 'RESOLVED', target: created });
  });
});
