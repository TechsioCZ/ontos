import { describe, expect, it } from 'effect-rstest';
import { Effect, Schema } from 'effect';

import {
  canonicalizeProductTypeMeaning,
  ProductTypeMeaningClaimSchema,
  ProductTypeMeaningRejected,
  resolveCanonicalProductTypeMeaning,
  sameProductTypeMeaning,
} from '../../shared/domain/product-type-meaning.ts';
import { ProductTypeRulesRevisionSchema } from '../../shared/domain/product-type-rules.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const otherTenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const productTypeRef = {
  moduleId: 'commerce.catalog',
  resourceId: '33333333-3333-4333-8333-333333333333',
  resourceType: 'commerce.catalog.product-type',
  tenantId,
} as const;
const material = {
  moduleId: 'commerce.catalog',
  resourceId: '66666666-6666-4666-8666-666666666666',
  resourceType: 'commerce.catalog.attribute-definition',
  tenantId,
} as const;
const note = { ...material, resourceId: '77777777-7777-4777-8777-777777777777' } as const;
const productRef = {
  moduleId: 'commerce.catalog',
  resourceId: '22222222-2222-4222-8222-222222222222',
  resourceType: 'commerce.catalog.product',
  tenantId,
} as const;
const categoryRef = {
  ...material,
  resourceId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  resourceType: 'commerce.catalog.product-category',
} as const;
const packageDefinitionRef = {
  ...material,
  resourceId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  resourceType: 'commerce.catalog.package-definition',
} as const;

const decodeRevision = Schema.decodeUnknownSync(ProductTypeRulesRevisionSchema);
const revision = decodeRevision({
  productTypeRef,
  revision: 1,
  rules: [
    { attributeDefinitionRef: note, level: 'PRODUCT', required: false },
    { attributeDefinitionRef: material, level: 'PRODUCT', required: true },
  ],
});
const decodeClaim = Schema.decodeUnknownSync(ProductTypeMeaningClaimSchema);

describe('Product Type canonical meaning', () => {
  it('normalizes rule order so the same requirements compare equal', () => {
    const left = canonicalizeProductTypeMeaning(revision);
    const reordered = canonicalizeProductTypeMeaning(
      decodeRevision({
        productTypeRef,
        revision: 1,
        rules: [
          { attributeDefinitionRef: material, level: 'PRODUCT', required: true },
          { attributeDefinitionRef: note, level: 'PRODUCT', required: false },
        ],
      }),
    );
    expect(left.rules.map((rule) => rule.attributeDefinitionRef.resourceId)).toEqual([
      material.resourceId,
      note.resourceId,
    ]);
    expect(sameProductTypeMeaning(left, reordered)).toBe(true);
  });

  it('keeps the display name out of the meaning and separates identity, revision, and rules', () => {
    const base = canonicalizeProductTypeMeaning(revision);
    expect('name' in base).toBe(false);
    const changedRules = canonicalizeProductTypeMeaning(
      decodeRevision({
        productTypeRef,
        revision: 1,
        rules: [{ attributeDefinitionRef: material, level: 'PRODUCT', required: false }],
      }),
    );
    const changedIdentity = canonicalizeProductTypeMeaning(
      decodeRevision({
        productTypeRef: { ...productTypeRef, resourceId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' },
        revision: 1,
        rules: revision.rules,
      }),
    );
    const changedRevision = canonicalizeProductTypeMeaning(
      decodeRevision({ productTypeRef, revision: 2, rules: revision.rules }),
    );
    expect(sameProductTypeMeaning(base, changedRules)).toBe(false);
    expect(sameProductTypeMeaning(base, changedIdentity)).toBe(false);
    expect(sameProductTypeMeaning(base, changedRevision)).toBe(false);
  });

  it('refuses to build a meaning from a foreign Tenant rule', () => {
    expect(() =>
      decodeRevision({
        productTypeRef,
        revision: 1,
        rules: [{ attributeDefinitionRef: { ...material, tenantId: otherTenantId }, level: 'PRODUCT', required: true }],
      }),
    ).toThrow();
  });

  it.effect('resolves exactly one canonical meaning from an owner-qualified rules revision', () =>
    Effect.gen(function* canonicalMeaning() {
      const claim = decodeClaim({ kind: 'RULES_REVISION', revision });
      const meaning = yield* resolveCanonicalProductTypeMeaning(claim);
      expect(sameProductTypeMeaning(meaning, canonicalizeProductTypeMeaning(revision))).toBe(true);
    }),
  );

  it.effect('rejects a label, Category, sales channel, Set marker, and Package Option as a meaning', () =>
    Effect.gen(function* standIns() {
      const claims = [
        decodeClaim({ kind: 'FREE_TEXT_LABEL', label: 'Shelf' }),
        decodeClaim({ categoryRef, kind: 'CATEGORY' }),
        decodeClaim({ channelName: 'web', kind: 'SALES_CHANNEL' }),
        decodeClaim({ kind: 'SET_MARKER', productRef }),
        decodeClaim({ kind: 'PACKAGE_OPTION', packageDefinitionRef }),
      ];
      const rejected = yield* Effect.all(
        claims.map((claim) => resolveCanonicalProductTypeMeaning(claim).pipe(Effect.flip)),
      );
      expect(rejected.every((error) => Schema.is(ProductTypeMeaningRejected)(error))).toBe(true);
      expect(rejected.map((error) => error.standIn)).toEqual([
        'FREE_TEXT_LABEL',
        'CATEGORY',
        'SALES_CHANNEL',
        'SET_MARKER',
        'PACKAGE_OPTION',
      ]);
      expect(rejected.every((error) => error.reason.includes('owner-qualified rules'))).toBe(true);
    }),
  );
});
