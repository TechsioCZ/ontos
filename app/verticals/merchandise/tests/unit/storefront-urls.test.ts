import { Effect } from 'effect';
import { afterEach, expect, it, rs } from 'effect-rstest';

const load = Effect.fn('test.storefrontUrls')(function* loadStorefrontUrls() {
  rs.resetModules();
  return yield* Effect.promise(() => import('../../shared/storefront-urls.ts'));
});
afterEach(() => {
  rs.unstubAllGlobals();
});

it.effect('uses the stage AKROS storefront URL', () =>
  Effect.gen(function* stageUrls() {
    rs.stubGlobal('ULTRAMODERN_PUBLIC_URL_AKROS_STOREFRONT', 'https://ontos-stage-akros.web-revolution.cz');
    const urls = yield* load();
    expect(urls.AKROS_STOREFRONT_ORIGIN).toBe('https://ontos-stage-akros.web-revolution.cz');
  }),
);

it.effect('does not publish localhost URLs from an unconfigured edge build', () =>
  Effect.gen(function* unconfiguredUrls() {
    rs.stubGlobal('ULTRAMODERN_PUBLIC_URL_AKROS_STOREFRONT', '');
    const urls = yield* load();
    expect(urls.AKROS_STOREFRONT_ORIGIN).toBeUndefined();
  }),
);

it.effect('uses the demo company e-shop URL and none where it is not deployed', () =>
  Effect.gen(function* shopUrls() {
    rs.stubGlobal('ULTRAMODERN_PUBLIC_URL_SHOP_STOREFRONT', 'https://ontos-stage-shop.web-revolution.cz');
    expect((yield* load()).SHOP_STOREFRONT_ORIGIN).toBe('https://ontos-stage-shop.web-revolution.cz');
    rs.stubGlobal('ULTRAMODERN_PUBLIC_URL_SHOP_STOREFRONT', '');
    expect((yield* load()).SHOP_STOREFRONT_ORIGIN).toBeUndefined();
  }),
);
