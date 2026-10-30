import { Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  CatalogResourceRefSchema,
  CatalogRevisionInstantSchema,
  CatalogRevisionNumberSchema,
  CatalogSelectionRevisionSchema,
  CatalogSelectionSchema,
} from '../../src/index.ts';

const productRef = {
  moduleId: 'commerce.catalog',
  resourceId: '33333333-3333-4333-8333-333333333333',
  resourceType: 'commerce.catalog.product',
  tenantId: '11111111-1111-4111-8111-111111111111',
};
const variantRef = {
  ...productRef,
  resourceId: '44444444-4444-4444-8444-444444444444',
  resourceType: 'commerce.catalog.variant',
};
const selection = { productRef, variantRef };
const configuration = {
  choices: [],
  definition: {
    resourceRef: { ...productRef, resourceType: 'commerce.catalog.configuration-definition' },
    revision: 1,
  },
  productRef,
  variantRef,
};

it('accepts a minimal Selection without inventing optional configuration or package choices', () => {
  expect(Schema.decodeUnknownSync(CatalogSelectionSchema)(selection)).toEqual(selection);
});

it('rejects a Selection whose Variant belongs to another Tenant', () => {
  expect(() =>
    Schema.decodeUnknownSync(CatalogSelectionSchema)({
      ...selection,
      variantRef: { ...variantRef, tenantId: '22222222-2222-4222-8222-222222222222' },
    }),
  ).toThrow();
});

it('binds configuration to the exact selected Product and Variant', () => {
  expect(Schema.decodeUnknownSync(CatalogSelectionSchema)({ ...selection, configuration })).toEqual({
    ...selection,
    configuration,
  });
  expect(() =>
    Schema.decodeUnknownSync(CatalogSelectionSchema)({
      ...selection,
      configuration: { ...configuration, variantRef: { ...variantRef, resourceId: productRef.resourceId } },
    }),
  ).toThrow();
});

it('rejects duplicate configuration choice keys', () => {
  const choice = { choiceKey: 'finish', value: 'matte' };
  expect(() =>
    Schema.decodeUnknownSync(CatalogSelectionSchema)({
      ...selection,
      configuration: { ...configuration, choices: [choice, { ...choice, value: 'gloss' }] },
    }),
  ).toThrow();
});

it('requires the Package Option and its content revision to identify the same resource', () => {
  const optionRef = { ...productRef, resourceType: 'commerce.catalog.package-definition' };
  const packageOption = { contentRevision: { resourceRef: optionRef, revision: 2 }, optionRef };
  expect(Schema.decodeUnknownSync(CatalogSelectionSchema)({ ...selection, packageOption })).toEqual({
    ...selection,
    packageOption,
  });
  expect(() =>
    Schema.decodeUnknownSync(CatalogSelectionSchema)({
      ...selection,
      packageOption: {
        ...packageOption,
        contentRevision: { resourceRef: { ...optionRef, resourceId: variantRef.resourceId }, revision: 2 },
      },
    }),
  ).toThrow();
});

it('retains an owner-issued revision sequence without fabricating a revision ID', () => {
  const revision = { resourceRef: productRef, revision: 1 };
  expect(Schema.decodeUnknownSync(CatalogSelectionRevisionSchema)(revision)).toEqual(revision);
});

it.each([0, -1, 1.5, 2_147_483_648])('rejects invalid business revision %s', (revision) => {
  expect(() => Schema.decodeUnknownSync(CatalogRevisionNumberSchema)(revision)).toThrow();
});

it('rejects a foreign resource namespace', () => {
  expect(() =>
    Schema.decodeUnknownSync(CatalogResourceRefSchema)({ ...productRef, resourceType: 'commerce.pricing.product' }),
  ).toThrow();
});

it('accepts real UTC calendar instants and rejects normalized invalid dates or offsets', () => {
  expect(Schema.decodeUnknownSync(CatalogRevisionInstantSchema)('2024-02-29T12:00:00.123Z')).toBe(
    '2024-02-29T12:00:00.123Z',
  );
  for (const instant of ['2025-02-29T12:00:00.123Z', '2024-02-29T12:00:00+01:00']) {
    expect(() => Schema.decodeUnknownSync(CatalogRevisionInstantSchema)(instant)).toThrow();
  }
});
