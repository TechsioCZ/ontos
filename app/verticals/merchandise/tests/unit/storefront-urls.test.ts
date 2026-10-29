import { Effect } from 'effect';
import { afterEach, expect, it, rs } from 'effect-rstest';

const load = Effect.fn('test.storefrontUrls')(function* loadStorefrontUrls() {
  rs.resetModules();
  return yield* Effect.promise(() => import('../../shared/storefront-urls.ts'));
});
afterEach(() => {
  rs.unstubAllGlobals();
});

it.effect('uses the stage AKROS URL and leaves the undeployed cafe storefront absent', () =>
  Effect.gen(function* stageUrls() {
    rs.stubGlobal('ULTRAMODERN_PUBLIC_URL_AKROS_STOREFRONT', 'https://ontos-stage-akros.web-revolution.cz');
    rs.stubGlobal('ULTRAMODERN_PUBLIC_URL_ESHOP_STOREFRONT', '');
    const urls = yield* load();
    expect(urls.AKROS_STOREFRONT_ORIGIN).toBe('https://ontos-stage-akros.web-revolution.cz');
    expect(urls.STOREFRONT_ORIGIN).toBeUndefined();
  }),
);

it.effect('keeps the two local storefronts available with development build constants', () =>
  Effect.gen(function* localUrls() {
    rs.stubGlobal('ULTRAMODERN_PUBLIC_URL_AKROS_STOREFRONT', 'http://localhost:3070');
    rs.stubGlobal('ULTRAMODERN_PUBLIC_URL_ESHOP_STOREFRONT', 'http://localhost:3060');
    const urls = yield* load();
    expect(urls.AKROS_STOREFRONT_ORIGIN).toBe('http://localhost:3070');
    expect(urls.STOREFRONT_ORIGIN).toBe('http://localhost:3060');
  }),
);

it.effect('does not publish localhost URLs from an unconfigured edge build', () =>
  Effect.gen(function* unconfiguredUrls() {
    rs.stubGlobal('ULTRAMODERN_PUBLIC_URL_AKROS_STOREFRONT', '');
    rs.stubGlobal('ULTRAMODERN_PUBLIC_URL_ESHOP_STOREFRONT', '');
    const urls = yield* load();
    expect(urls.AKROS_STOREFRONT_ORIGIN).toBeUndefined();
    expect(urls.STOREFRONT_ORIGIN).toBeUndefined();
  }),
);
