import { describe, expect, it } from 'effect-rstest';
import { Effect, Schema } from 'effect';
import { buildAkrosEncoded, buildSroubshopEncoded } from '../../verticals/merchandise/scripts/akros-catalog.mts';
import type { AkrosEncodedState } from '../../verticals/merchandise/scripts/akros-baseline.ts';
import { isSourceCatalogImage, neutralCatalogText } from '../../verticals/merchandise/scripts/akros-pseudonym.ts';
import { MerchandiseStateSchema } from '../../verticals/merchandise/shared/apis/records.ts';
import {
  Category,
  Product,
  categoryRepresentatives,
  categoryTextPatch,
  digest,
  galleryConsistent,
  productPhotoPlan,
  productTextPatch,
  protectedProduct,
} from './pseudonymize-akros-catalog-policy.mts';

const fixture = Effect.gen(function* catalogFixture() {
  const baseline = yield* buildAkrosEncoded();
  const demo = yield* buildSroubshopEncoded();
  const first = yield* Schema.decodeUnknownEffect(Product)({
    ...baseline.products[0],
    lowStock: false,
    stockOnHand: 0,
    stockValueMinor: 0,
  });
  return { baseline, demo, first };
});
const commercials = (products: AkrosEncodedState['products']) =>
  products.map(({ currentPriceMinor, id, priceTiers, sku, variants }) => ({
    currentPriceMinor,
    id,
    priceTiers,
    sku,
    variants: variants?.map(({ id: variantId, priceMinor, priceTiers: tiers, sku: variantSku }) => ({
      id: variantId,
      priceMinor,
      priceTiers: tiers,
      sku: variantSku,
    })),
  }));

const categoryNode = (id: string, parentId: string | null, position: number) =>
  Schema.decodeUnknownEffect(Category)({
    description: '',
    hasChildren: false,
    heading: '',
    id,
    imageAlt: '',
    imageSrc: '',
    longDescription: '',
    name: id,
    parentId,
    position,
    slug: id,
  });

describe('pseudonymous demo catalog', () => {
  it.effect('preserves every identity, price, variant, stock movement and category', () =>
    Effect.gen(function* preserveCatalog() {
      const { baseline, demo } = yield* fixture;
      expect(demo.products).toHaveLength(baseline.products.length);
      expect(demo.products.reduce((count, product) => count + (product.variants?.length ?? 0), 0)).toBe(
        baseline.products.reduce((count, product) => count + (product.variants?.length ?? 0), 0),
      );
      expect(demo.categories?.map(({ id, parentId, position, slug }) => ({ id, parentId, position, slug }))).toEqual(
        baseline.categories?.map(({ id, parentId, position, slug }) => ({ id, parentId, position, slug })),
      );
      expect(commercials(demo.products)).toEqual(commercials(baseline.products));
      expect(demo.movements.map(({ note: _note, ...movement }) => movement)).toEqual(
        baseline.movements.map(({ note: _note, ...movement }) => movement),
      );
    }),
  );
  it.effect('neutral demo has no source references and the real-AKROS builder is unchanged', () =>
    Effect.gen(function* neutralBaseline() {
      const { baseline, demo } = yield* fixture;
      const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(MerchandiseStateSchema))(
        yield* Schema.decodeUnknownEffect(MerchandiseStateSchema)(demo),
      );
      expect(encoded).not.toMatch(/akros/iu);
      expect(baseline.categories?.some(({ imageSrc }) => /akros/iu.test(imageSrc))).toBe(true);
      expect(baseline.products.some(({ images }) => (images ?? []).some(isSourceCatalogImage))).toBe(true);
    }),
  );
  it('rewrites Czech phrases with their correct case', () => {
    expect(neutralCatalogText('V sortimentu Akrosu najdete')).toBe('V našem sortimentu najdete');
    expect(neutralCatalogText('V nabídce AKROS.cz naleznete')).toBe('V naší nabídce naleznete');
    expect(neutralCatalogText('společně s Akrosem, z AKROSu, u Akrosu')).toBe(
      'společně se ŠroubShopem, z naší nabídky, u nás',
    );
    expect(neutralCatalogText('AKROS nabízí šrouby.')).toBe('Nabízíme šrouby.');
    expect(neutralCatalogText('Pokud hledáte L profil, AKROS nabízí výběr. Na webu Akros.cz najdete více.')).toBe(
      'Pokud hledáte L profil, nabízíme výběr. V našem obchodě najdete více.',
    );
    expect(neutralCatalogText('Výhody nákupu u AKROS: rychlost.​ V Akros nabídce je vše.')).toBe(
      'Výhody nákupu u nás: rychlost.​ V naší nabídce je vše.',
    );
    const once = neutralCatalogText('Akros šroub z nabídky Akrosu');
    expect(neutralCatalogText(once)).toBe(once);
  });
  it.effect('keeps main plus first nineteen distinct variant photos', () =>
    Effect.gen(function* photoCap() {
      const { first } = yield* fixture;
      const variants = Array.from({ length: 30 }, (_, index) => ({
        attributes: '',
        imageSrc: `${index}.jpg`,
        name: `M${index}`,
      }));
      const product = { ...first, images: ['main.jpg'], imageSrc: 'main.jpg', variants };
      const photos = productPhotoPlan(product);
      expect(photos.kept).toEqual(['main.jpg', ...Array.from({ length: 19 }, (_, index) => `${index}.jpg`)]);
      expect(photos.fallback).toBe(11);
      const unavailable = '3.jpg';
      expect(productPhotoPlan(product, new Set([unavailable])).kept).toContain('19.jpg');
      expect(productPhotoPlan(product, new Set([unavailable])).kept).not.toContain(unavailable);
    }),
  );
  it.effect('preserves staff-edited commercial fields while rewriting labels and parameters', () =>
    Effect.gen(function* staffEdits() {
      const { first } = yield* fixture;
      const edited = {
        ...first,
        description: 'V nabídce Akrosu najdete šrouby.',
        name: 'Akros šroub',
        parameters: [{ label: 'Dodavatel', unit: '', value: 'AKROS' }],
        variants: [{ ...first.variants?.[0], attributes: 'od Akrosu', name: 'Akros varianta' }],
      };
      const patch = productTextPatch(edited);
      expect(patch.name).toBe('ŠroubShop šroub');
      expect(patch.description).toBe('V naší nabídce najdete šrouby.');
      expect(patch.parameters?.[0]?.value).toBe('ŠroubShop');
      expect(patch.variants?.[0]?.name).toBe('ŠroubShop varianta');
      expect(digest(protectedProduct({ ...edited, ...patch }))).toBe(digest(protectedProduct(edited)));
    }),
  );
  it.effect('excludes unavailable placeholders and branded marketing graphics from uploads', () =>
    Effect.gen(function* excludedImages() {
      const { first } = yield* fixture;
      const images = [
        '/akros/products/image-unavailable.svg',
        'https://www.akros.cz/data/product/fve-konstrukce-banner-sekce.jpg',
      ];
      expect(productPhotoPlan({ ...first, images, imageSrc: images[0], variants: [] }).kept).toEqual([]);
    }),
  );
  it('downloads only fixed source-host image URLs', () => {
    expect(isSourceCatalogImage('https://www.akros.cz/data/product/a.jpg')).toBe(true);
    expect(isSourceCatalogImage('https://www.akros.cz@localhost/data/product/a.jpg')).toBe(false);
    expect(isSourceCatalogImage('http://127.0.0.1/data/product/a.jpg')).toBe(false);
    expect(isSourceCatalogImage('https://www.akros.cz/redirect?to=localhost')).toBe(false);
  });
  it('fingerprints ignore object key order but not array order', () => {
    const value = { a: 1, b: ['x', 'y'] };
    expect(digest(value)).toBe(
      digest(
        Object.fromEntries([
          ['b', value.b],
          ['a', value.a],
        ]),
      ),
    );
    expect(digest(value)).not.toBe(digest({ ...value, b: ['y', 'x'] }));
  });
  it.effect('rewrites category copy without changing identity or tree', () =>
    Effect.gen(function* categoryCopy() {
      const { baseline } = yield* fixture;
      const category = yield* Schema.decodeUnknownEffect(Category)(
        baseline.categories?.find(({ id }) => id === '1485'),
      );
      expect(categoryTextPatch(category).description).toContain('V naší nabídce');
    }),
  );
  it.effect('picks the first own eligible product, otherwise the first one in descendants by position', () =>
    Effect.gen(function* categoryRepresentative() {
      const { first } = yield* fixture;
      const categories = [
        yield* categoryNode('root', null, 0),
        yield* categoryNode('late', 'root', 2),
        yield* categoryNode('early', 'root', 1),
        yield* categoryNode('leaf', 'early', 0),
        yield* categoryNode('empty', null, 1),
      ];
      const product = (id: string, categoryId: string) => ({ ...first, categoryId, id });
      const products = [product('p-late', 'late'), product('p-hidden', 'leaf'), product('p-leaf', 'leaf')];
      const reps = categoryRepresentatives(products, categories, ({ id }) => id !== 'p-hidden');
      expect(reps.get('root')?.id).toBe('p-leaf');
      expect(reps.get('late')?.id).toBe('p-late');
      expect(reps.get('leaf')?.id).toBe('p-leaf');
      expect(reps.get('empty')).toBeUndefined();
    }),
  );
  it.effect('accepts only galleries whose main and variant photos are gallery photos', () =>
    Effect.gen(function* galleryReferences() {
      const { first } = yield* fixture;
      const variant = { ...first.variants?.[0], attributes: '', name: 'M' };
      const gallery = { ...first, images: ['media:a', 'media:b'], imageSrc: 'media:a' };
      expect(
        galleryConsistent({
          ...gallery,
          variants: [
            { ...variant, imageSrc: 'media:b' },
            { ...variant, imageSrc: '' },
          ],
        }),
      ).toBe(true);
      expect(galleryConsistent({ ...gallery, variants: [{ ...variant, imageSrc: 'media:c' }] })).toBe(false);
      expect(galleryConsistent({ ...gallery, imageSrc: 'media:b', variants: [] })).toBe(false);
    }),
  );
});
