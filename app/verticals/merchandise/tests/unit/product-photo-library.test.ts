import { expect, it } from 'effect-rstest';
import { PRODUCT_PHOTO_LIBRARY_LIMIT, photoLibraryAfter } from '../../shared/domain/product-images.ts';

const gallery = 'https://www.akros.cz/data/product/banner.jpg';
const hook = 'https://www.akros.cz/data/product/hak-9822.jpg';
const uploaded = 'media:a973f79c-0f97-476f-a003-f6db822156fb';

it('a photo a variant switched away from stays in the library, the photos shown now last', () => {
  const before = { images: [gallery], variants: [{ imageSrc: hook }, { imageSrc: '' }] };
  const after = { images: [gallery], variants: [{ imageSrc: uploaded }, { imageSrc: '' }] };
  expect(photoLibraryAfter(before, after)).toEqual([hook, gallery, uploaded]);
});

it('a later write keeps every earlier photo, also one removed from the gallery', () => {
  const first = { images: [gallery, uploaded], photoLibrary: [hook] };
  expect(photoLibraryAfter(first, { images: [gallery], photoLibrary: [hook] })).toEqual([hook, uploaded, gallery]);
});

it('a new product starts with the photos it shows', () => {
  expect(photoLibraryAfter(undefined, { imageSrc: gallery, variants: [{ imageSrc: hook }] })).toEqual([gallery, hook]);
});

it('the library keeps the most recent photos within its limit', () => {
  const many = Array.from({ length: PRODUCT_PHOTO_LIBRARY_LIMIT + 5 }, (_, index) => `https://x.test/${index}.jpg`);
  const library = photoLibraryAfter({ photoLibrary: many }, { images: [gallery] });
  expect(library).toHaveLength(PRODUCT_PHOTO_LIBRARY_LIMIT);
  expect(library.at(-1)).toBe(gallery);
  expect(library).not.toContain(many[0]);
});
