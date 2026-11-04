import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { MerchandisePermissionDenied } from '../../shared/actions/apply-command.ts';
import {
  N1_LEGAL_ENTITY_ID,
  assertStorefrontScope,
  isStorefrontServiceKey,
} from '../../shared/actions/command-guard.ts';
import { mediaReadAllowed } from '../../src/services/product-media.ts';

const ownImage = 'media:a973f79c-0f97-476f-a003-f6db822156fb';
const otherImage = 'media:38a013500-0000-4000-8000-000000000001';
const published = { active: true, images: [ownImage], published: true };

it('the N1 storefront API key is a storefront service key; sessions and other companies are not', () => {
  expect(isStorefrontServiceKey('api_key', N1_LEGAL_ENTITY_ID)).toBe(true);
  expect(isStorefrontServiceKey('session', N1_LEGAL_ENTITY_ID)).toBe(false);
  expect(isStorefrontServiceKey('api_key', '70000000-0000-4000-8000-000000000020')).toBe(false);
});

it.effect('the N1 storefront key may only place guest orders in the N1 company', () =>
  Effect.gen(function* n1Scope() {
    yield* assertStorefrontScope('api_key', N1_LEGAL_ENTITY_ID, 'PlaceStorefrontOrder');
    const denied = yield* Effect.flip(assertStorefrontScope('api_key', N1_LEGAL_ENTITY_ID, 'CreateProduct'));
    expect(Schema.is(MerchandisePermissionDenied)(denied)).toBe(true);
  }),
);

it("a storefront read serves a published product's own photo", () => {
  expect(mediaReadAllowed(published, ownImage, true)).toBe(true);
});

it('a storefront read is denied for media that is not a gallery image of the product (unrelated media)', () => {
  expect(mediaReadAllowed(published, otherImage, true)).toBe(false);
});

it('a storefront read is denied for an unpublished, inactive or archived product', () => {
  expect(mediaReadAllowed({ ...published, published: false }, ownImage, true)).toBe(false);
  expect(mediaReadAllowed({ ...published, active: false }, ownImage, true)).toBe(false);
  expect(mediaReadAllowed({ ...published, demoArchive: { at: 'x' } }, ownImage, true)).toBe(false);
});

it('staff reads keep their own rule: the product gallery decides, visibility does not', () => {
  expect(mediaReadAllowed({ ...published, published: false }, ownImage, false)).toBe(true);
  expect(mediaReadAllowed(published, otherImage, false)).toBe(false);
});
