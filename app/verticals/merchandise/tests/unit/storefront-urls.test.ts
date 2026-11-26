import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { Effect, Option, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

const StorefrontUrls = Schema.Struct({
  AKROS_STOREFRONT_ORIGIN: Schema.OptionFromUndefinedOr(Schema.String),
  SHOP_STOREFRONT_ORIGIN: Schema.OptionFromUndefinedOr(Schema.String),
});

/** Evaluate separate compiled modules, never mutable global build data. */
const load = Effect.fn('test.storefrontUrls')(function* loadStorefrontUrls(definitions: Record<string, string>) {
  const source = yield* Effect.promise(() =>
    readFile(new URL('../../shared/storefront-urls.ts', import.meta.url), 'utf-8'),
  );
  const lexicalDefinitions = Object.entries(definitions).map(([name, value]) => `const ${name} = ${value};`);
  const compiled = [...lexicalDefinitions, stripTypeScriptTypes(source)].join('\n');
  const url = `data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`;
  const loaded: unknown = yield* Effect.promise(() => import(url));
  return Schema.decodeUnknownSync(StorefrontUrls)(loaded);
});

it.effect('preserves both configured storefront origins byte for byte with lexical build values', () =>
  Effect.gen(function* configuredUrls() {
    for (const akros of ['https://ontos-stage-akros.web-revolution.cz', 'http://localhost:3070']) {
      const urls = yield* load({
        ULTRAMODERN_PUBLIC_URL_AKROS_STOREFRONT: JSON.stringify(akros),
        ULTRAMODERN_PUBLIC_URL_SHOP_STOREFRONT: JSON.stringify('https://ontos-stage-shop.web-revolution.cz'),
      });
      expect(urls).toMatchObject({
        AKROS_STOREFRONT_ORIGIN: Option.some(akros),
        SHOP_STOREFRONT_ORIGIN: Option.some('https://ontos-stage-shop.web-revolution.cz'),
      });
    }
  }),
);

const emptyOrigins = { AKROS_STOREFRONT_ORIGIN: Option.none(), SHOP_STOREFRONT_ORIGIN: Option.none() };

it.effect('publishes neither empty nor absent storefront origins', () =>
  Effect.gen(function* absentUrls() {
    for (const definition of ['""', 'undefined']) {
      const urls = yield* load({
        ULTRAMODERN_PUBLIC_URL_AKROS_STOREFRONT: definition,
        ULTRAMODERN_PUBLIC_URL_SHOP_STOREFRONT: definition,
      });
      expect(urls).toEqual(emptyOrigins);
    }
  }),
);

it.effect('evaluates safely in native tests with no injected build constants', () =>
  Effect.gen(function* nativeUrls() {
    const urls = yield* load({});
    expect(urls).toEqual(emptyOrigins);
  }),
);
