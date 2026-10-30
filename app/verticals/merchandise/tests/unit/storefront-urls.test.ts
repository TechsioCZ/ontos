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
