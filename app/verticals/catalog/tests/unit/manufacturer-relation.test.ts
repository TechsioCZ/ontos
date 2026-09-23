import { Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  ManufacturerRelationHistorySchema,
  ManufacturerRelationRevisionSchema,
  currentManufacturerRelation,
} from '../../shared/domain/manufacturer-relation.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const otherTenantId = '99999999-9999-4999-8999-999999999999';
const product = {
  moduleId: 'commerce.catalog',
  resourceId: '22222222-2222-4222-8222-222222222222',
  resourceType: 'commerce.catalog.product',
  tenantId,
} as const;
const variant = {
  moduleId: 'commerce.catalog',
  resourceId: '33333333-3333-4333-8333-333333333333',
  resourceType: 'commerce.catalog.variant',
  tenantId,
} as const;
const party = {
  moduleId: 'party.registry',
  resourceId: 'external-maker',
  resourceType: 'party.registry.party',
  tenantId,
} as const;
const legalEntity = {
  moduleId: 'core.identity',
  resourceId: '44444444-4444-4444-8444-444444444444',
  resourceType: 'core.identity.legal-entity',
  tenantId,
} as const;
const first = {
  disposition: 'CONFIRMED',
  effectivePeriod: { effectiveFrom: '2026-09-01T00:00:00.000Z' },
  evidenceRefs: ['manufacturer-declaration'],
  reason: 'Declared for this exact Product',
  recordedAt: '2026-09-02T00:00:00.000Z',
  relationId: '55555555-5555-4555-8555-555555555555',
  revision: 1,
  subject: product,
  target: { kind: 'PARTY', partyRef: party },
} as const;
const decode = Schema.decodeUnknownSync(ManufacturerRelationRevisionSchema);
const decodeHistory = Schema.decodeUnknownSync(ManufacturerRelationHistorySchema);

describe('Catalog manufacturer relationship', () => {
  it('requires an explicit public Party or managed Legal Entity reference', () => {
    expect(decode(first).target).toEqual(first.target);
    expect(
      decode({ ...first, subject: variant, target: { kind: 'LEGAL_ENTITY', legalEntityRef: legalEntity } }).target,
    ).toEqual({
      kind: 'LEGAL_ENTITY',
      legalEntityRef: legalEntity,
    });
    expect(() => decode({ ...first, target: { kind: 'PARTY', name: 'Similar Maker' } })).toThrow();
    expect(() => decode({ ...first, target: { kind: 'UNKNOWN', partyRef: party } })).toThrow();
  });

  it('rejects cross-Tenant references and unsupported target types', () => {
    expect(() =>
      decode({ ...first, target: { kind: 'PARTY', partyRef: { ...party, tenantId: otherTenantId } } }),
    ).toThrow();
    expect(() =>
      decode({
        ...first,
        target: { kind: 'LEGAL_ENTITY', legalEntityRef: { ...legalEntity, tenantId: otherTenantId } },
      }),
    ).toThrow();
    expect(() => decode({ ...first, evidenceRefs: [] })).toThrow();
    expect(() =>
      decode({
        ...first,
        effectivePeriod: { effectiveFrom: '2026-10-01T00:00:00.000Z', effectiveTo: '2026-09-01T00:00:00.000Z' },
      }),
    ).toThrow();
  });

  it('preserves corrected identity and evidence without mutating prior history', () => {
    const corrected = {
      ...first,
      reason: 'Original target was misidentified',
      recordedAt: '2026-09-03T00:00:00.000Z',
      revision: 2,
      target: { kind: 'LEGAL_ENTITY', legalEntityRef: legalEntity },
    } as const;
    const history = decodeHistory([first, corrected]);
    expect(currentManufacturerRelation(history, '2026-09-04T00:00:00.000Z')?.target).toEqual(corrected.target);
    expect(history[0]?.target).toEqual(first.target);
    expect(() => decodeHistory([corrected, first])).toThrow();
    expect(() => decodeHistory([first, { ...corrected, subject: variant }])).toThrow();
  });

  it('keeps effective and retracted states distinct from missing identity', () => {
    const history = decodeHistory([first]);
    expect(currentManufacturerRelation(history, '2026-08-31T23:59:59.000Z')).toBeUndefined();
    expect(currentManufacturerRelation(history, '2026-09-01T00:00:00.000Z')?.target).toEqual(first.target);
    const ended = decodeHistory([
      { ...first, effectivePeriod: { ...first.effectivePeriod, effectiveTo: '2026-10-01T00:00:00.000Z' } },
    ]);
    expect(currentManufacturerRelation(ended, '2026-10-01T00:00:00.000Z')).toBeUndefined();
    const retracted = decodeHistory([
      first,
      { ...first, disposition: 'RETRACTED', recordedAt: '2026-09-03T00:00:00.000Z', revision: 2 },
    ]);
    expect(currentManufacturerRelation(retracted, '2026-09-04T00:00:00.000Z')).toBeUndefined();
  });
});
