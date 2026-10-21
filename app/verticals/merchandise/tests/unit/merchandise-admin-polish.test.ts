import { DateTime, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { staffCommandAllowed, AKROS_LEGAL_ENTITY_ID } from '../../shared/actions/command-guard.ts';
import { MerchandiseCommandSchema } from '../../shared/actions/apply-command.ts';
import { CatalogCategorySchema } from '../../shared/domain/merchandise-model.ts';
import type { CatalogCategory } from '../../shared/domain/merchandise-model.ts';
import { searchCategories } from '../../src/routes/[lang]/provoz/produkty/category-search.ts';
import { moveImage } from '../../src/routes/[lang]/provoz/produkty/product-images.ts';
import { isOrderScopedEdit } from '../../src/services/persistence.service.ts';

const category = (id: string, parentId: string | null, name: string, slug: string): CatalogCategory =>
  Schema.decodeUnknownSync(CatalogCategorySchema)({
    description: '',
    hasChildren: false,
    heading: name,
    id,
    imageAlt: name,
    imageSrc: '',
    longDescription: '',
    name,
    parentId,
    position: 0,
    slug,
  });

const categories = [
  category('root', null, 'Šrouby', 'srouby'),
  category('din912', 'root', 'DIN 912', 'din-912'),
  category('din933', 'root', 'DIN 933', 'din-933'),
  category('a2-912', 'din912', 'A 2', 'din-912-a2'),
  category('a2-933', 'din933', 'A 2', 'din-933-a2'),
];
const trails = new Map([
  ['root', 'Šrouby'],
  ['din912', 'Šrouby › DIN 912'],
  ['din933', 'Šrouby › DIN 933'],
  ['a2-912', 'Šrouby › DIN 912 › A 2'],
  ['a2-933', 'Šrouby › DIN 933 › A 2'],
]);

it('finds an ambiguous leaf category by its parent path, diacritics-insensitive', () => {
  expect(searchCategories(categories, trails, 'din 912 a 2').map((entry) => entry.id)).toEqual(['a2-912']);
  expect(searchCategories(categories, trails, 'srouby › din 933 › a 2').map((entry) => entry.id)).toEqual([
    'a2-933',
  ]);
  expect(searchCategories(categories, trails, 'a 2').map((entry) => entry.id).slice(0, 2)).toEqual([
    'a2-912',
    'a2-933',
  ]);
  expect(searchCategories(categories, trails, '   ')).toEqual([]);
});

it('reorders gallery images and makes any image the main one', () => {
  const images = ['a.jpg', 'b.jpg', 'c.jpg'];
  expect(moveImage(images, 2, 0)).toEqual(['c.jpg', 'a.jpg', 'b.jpg']);
  expect(moveImage(images, 0, 1)).toEqual(['b.jpg', 'a.jpg', 'c.jpg']);
  expect(moveImage(images, 1, 2)).toEqual(['a.jpg', 'c.jpg', 'b.jpg']);
  expect(moveImage(images, 0, -1)).toBe(images);
  expect(moveImage(images, 2, 3)).toBe(images);
});

it('lets only an AKROS administrator reset the demo data', () => {
  expect(staffCommandAllowed(AKROS_LEGAL_ENTITY_ID, true, 'ResetDemoData')).toBe(true);
  expect(staffCommandAllowed(AKROS_LEGAL_ENTITY_ID, false, 'ResetDemoData')).toBe(false);
  expect(staffCommandAllowed('71000000-0000-4000-8000-000000000020', true, 'ResetDemoData')).toBe(false);
  expect(() =>
    Schema.decodeUnknownSync(MerchandiseCommandSchema)({ _tag: 'ResetDemoData', confirmation: 'ANO', reason: 'Před ukázkou' }),
  ).toThrow();
});

it('scopes an order edit to its order only when the editor names the order version', () => {
  const id = '0123456789abcdef0123456789abcdef';
  const scoped = Schema.decodeUnknownSync(MerchandiseCommandSchema)({
    _tag: 'EditOrder',
    expectedUpdatedAt: '2026-10-21T08:00:00.000Z',
    id,
    note: 'Doplněno',
  });
  const unscoped = Schema.decodeUnknownSync(MerchandiseCommandSchema)({ _tag: 'EditOrder', id, note: 'Doplněno' });
  expect(isOrderScopedEdit(scoped)).toBe(true);
  expect(isOrderScopedEdit(unscoped)).toBe(false);
  expect(scoped._tag === 'EditOrder' && DateTime.isDateTime(scoped.expectedUpdatedAt)).toBe(true);
});
