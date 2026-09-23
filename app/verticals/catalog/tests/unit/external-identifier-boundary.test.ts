import { describe, expect, it } from 'effect-rstest';
import { Schema } from 'effect';

import {
  CatalogExternalSourceEvidenceSchema,
  CatalogExternalSourceRecordRefSchema,
  sameCatalogExternalSourceRecord,
} from '../../shared/domain/external-identifier-boundary.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const otherTenantId = '99999999-9999-4999-8999-999999999999';
const source = {
  issuerId: 'erp-a',
  issuerKind: 'EXTERNAL_BUSINESS_SYSTEM',
  recordId: '784',
  recordNamespace: 'product',
  tenantId,
} as const;
const product = {
  moduleId: 'commerce.catalog',
  resourceId: '22222222-2222-4222-8222-222222222222',
  resourceType: 'commerce.catalog.product',
  tenantId,
} as const;

describe('Catalog external source references', () => {
  it('preserves exact source identifiers without treating equal literals as cross-system identity', () => {
    const decode = Schema.decodeUnknownSync(CatalogExternalSourceRecordRefSchema, { onExcessProperty: 'error' });
    const reference = decode(source);

    expect(reference.recordId).toBe('784');
    expect(sameCatalogExternalSourceRecord(reference, decode({ ...source }))).toBe(true);
    expect(sameCatalogExternalSourceRecord(reference, decode({ ...source, issuerId: 'erp-b' }))).toBe(false);
    expect(sameCatalogExternalSourceRecord(reference, decode({ ...source, recordNamespace: 'variant' }))).toBe(false);
    expect(sameCatalogExternalSourceRecord(reference, decode({ ...source, tenantId: otherTenantId }))).toBe(false);
    expect(() => decode({ ...source, sku: '784' })).toThrow();
    expect(() => decode({ ...source, recordId: ' 784 ' })).toThrow();
  });

  it('retains exact Catalog target kind and rejects cross-Tenant evidence', () => {
    const decode = Schema.decodeUnknownSync(CatalogExternalSourceEvidenceSchema, { onExcessProperty: 'error' });
    expect(decode({ observedTarget: product, sourceRecord: source }).observedTarget).toEqual(product);
    expect(() => decode({ observedTarget: { ...product, tenantId: otherTenantId }, sourceRecord: source })).toThrow();
    expect(() =>
      decode({
        observedTarget: { ...product, resourceType: 'commerce.catalog.variant' },
        sku: '784',
        sourceRecord: source,
      }),
    ).toThrow();
  });
});
