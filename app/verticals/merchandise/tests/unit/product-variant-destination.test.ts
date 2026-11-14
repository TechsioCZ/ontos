import { Schema } from 'effect';
import { expect, test } from 'effect-rstest';

import type { ProductVariant } from '../../shared/domain/merchandise-model.ts';
import { VariantIdSchema } from '../../shared/domain/merchandise-model.ts';
import {
  productVariantIdFromSearch,
  resolveProductVariantDestination,
} from '../../src/routes/[lang]/provoz/produkty/product-variant-destination.ts';

const variantId = (value: string) => Schema.decodeUnknownSync(VariantIdSchema)(value);

const variant = (
  value: string,
  options: { readonly active?: boolean; readonly priceMinor?: number } = {},
): ProductVariant => ({
  active: options.active ?? true,
  attributes: '',
  id: variantId(value),
  name: value,
  priceMinor: options.priceMinor ?? 0,
  sku: value,
});

const record = (value: string, active = true, priceMinor = 0) => ({
  active,
  id: variantId(value),
  priceMinor,
});

const product = (variants: readonly ProductVariant[], records: readonly ReturnType<typeof record>[]) => ({
  variantRecords: records,
  variants,
});

test('no variantId means no target and no forced selection', () => {
  const missing: string | undefined = ['a'][1];
  expect(resolveProductVariantDestination(product([variant('a')], [record('a')]), missing)).toEqual({
    kind: 'none',
  });
});

test('an exact active priced variant selects its own row, including a zero price', () => {
  expect(
    resolveProductVariantDestination(
      product([variant('a', { priceMinor: 0 }), variant('b')], [record('a'), record('b')]),
      'a',
    ),
  ).toEqual({ draftKey: 'a', kind: 'selected', variantId: 'a' });
});

test('a missing or foreign variant is unavailable and never falls back to another row', () => {
  const source = product([variant('a')], [record('a')]);
  expect(resolveProductVariantDestination(source, 'foreign')).toEqual({
    kind: 'unavailable',
    variantId: 'foreign',
  });
  expect(resolveProductVariantDestination(source, '')).toEqual({ kind: 'unavailable', variantId: '' });
  expect(resolveProductVariantDestination(source, 'x'.repeat(301))).toMatchObject({ kind: 'unavailable' });
});

test('an inactive variant is unavailable even when another active row exists', () => {
  const source = product([variant('a'), variant('b')], [record('a', false), record('b')]);
  expect(resolveProductVariantDestination(source, 'a')).toEqual({ kind: 'unavailable', variantId: 'a' });
});

test('a real variant without a current record, or a legacy variant, is unavailable', () => {
  expect(resolveProductVariantDestination(product([variant('a')], []), 'a')).toEqual({
    kind: 'unavailable',
    variantId: 'a',
  });
  const legacy = { active: true, attributes: '', id: variantId('legacy'), name: 'Legacy', sku: 'legacy' };
  expect(resolveProductVariantDestination(product([legacy], [record('legacy')]), 'legacy')).toEqual({
    kind: 'unavailable',
    variantId: 'legacy',
  });
});

test('duplicate ids are ambiguous and unavailable', () => {
  const source = product([variant('a'), variant('a')], [record('a')]);
  expect(resolveProductVariantDestination(source, 'a')).toEqual({ kind: 'unavailable', variantId: 'a' });
});

test('the variant query is read as one opaque exact value, never guessed', () => {
  expect(productVariantIdFromSearch('?variantId=a&x=1')).toBe('a');
  expect(productVariantIdFromSearch('variantId=a')).toBe('a');
  expect(productVariantIdFromSearch('?x=1')).toBeUndefined();
  expect(productVariantIdFromSearch('?variantId=odd%20id')).toBe('odd id');
  expect(productVariantIdFromSearch('')).toBeUndefined();
});
