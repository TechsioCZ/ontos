import { Option, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  CreateProductAuditEvidenceSchema,
  ProductAuditEvidenceSchema,
  ProductRevisionRecordSchema,
} from '../../shared/domain/product.ts';
import { CreateProductPayloadSchema } from '../../shared/actions/create-product.ts';

const previousProductRef = {
  moduleId: 'commerce.catalog',
  resourceId: '22222222-2222-4222-8222-222222222222',
  resourceType: 'commerce.catalog.product',
  tenantId: '11111111-1111-4111-8111-111111111111',
} as const;
const successor = {
  affectsOpenSelection: true,
  evidenceRefs: ['catalog:real-predecessor-review'],
  kind: 'NEW_PRODUCT',
  previousProductRef,
  reason: 'Different business identity',
} as const;

describe('independent Product create optional input', () => {
  it('accepts missing classification and reason without inventing either field', () => {
    expect(Schema.decodeUnknownSync(CreateProductPayloadSchema)({})).toEqual({});
    expect(
      Schema.decodeUnknownSync(CreateProductPayloadSchema)({ classification: { kind: 'INDEPENDENT_PRODUCT' } }),
    ).toEqual({ classification: { kind: 'INDEPENDENT_PRODUCT' } });
    expect(Schema.decodeUnknownSync(CreateProductPayloadSchema)({ reason: 'Real supplied reason' })).toEqual({
      reason: 'Real supplied reason',
    });
  });
  it('accepts a complete explicit successor and rejects incomplete successor intent', () => {
    expect(
      Schema.decodeUnknownSync(CreateProductPayloadSchema)({ classification: successor, reason: successor.reason }),
    ).toEqual({ classification: successor, reason: successor.reason });
    for (const classification of [successor, { ...successor, evidenceRefs: [] }, { kind: 'NEW_PRODUCT' }]) {
      expect(Option.isNone(Schema.decodeUnknownOption(CreateProductPayloadSchema)({ classification }))).toBe(true);
    }
  });
});

it('keeps absent create audit reason narrow and non-CREATED history strict', () => {
  expect(Schema.decodeUnknownSync(CreateProductAuditEvidenceSchema)({})).toEqual({});
  expect(Option.isNone(Schema.decodeUnknownOption(ProductAuditEvidenceSchema)({}))).toBe(true);
  const revision = {
    actionInvocationId: '33333333-3333-4333-8333-333333333333',
    changeKind: 'CREATED',
    evidenceRefs: [],
    lifecycle: 'DRAFT',
    productRef: previousProductRef,
    recordedAt: '2026-10-19T10:00:00.000Z',
    revision: 1,
    revisionReference: {
      resourceRef: previousProductRef,
      revision: 1,
      revisionId: '44444444-4444-4444-8444-444444444444',
    },
  };
  expect(Schema.decodeUnknownSync(ProductRevisionRecordSchema)(revision)).not.toHaveProperty('reason');
  for (const changeKind of ['UPDATED', 'COSMETIC_CORRECTION', 'LIFECYCLE']) {
    expect(Option.isNone(Schema.decodeUnknownOption(ProductRevisionRecordSchema)({ ...revision, changeKind }))).toBe(
      true,
    );
    expect(
      Schema.decodeUnknownSync(ProductRevisionRecordSchema)({
        ...revision,
        changeKind,
        reason: 'Real historical reason',
      }).reason,
    ).toBe('Real historical reason');
  }
});

it('does not discard explicit inconsistent independent classification fields', () => {
  expect(
    Option.isNone(
      Schema.decodeUnknownOption(CreateProductPayloadSchema)({
        classification: { kind: 'INDEPENDENT_PRODUCT', previousProductRef },
      }),
    ),
  ).toBe(true);
});
