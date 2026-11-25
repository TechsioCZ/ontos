#!/usr/bin/env node
/** Public, read-only acceptance. Importing this module performs no I/O; it never creates records or accepts secrets. */
import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';
import { Effect, Result, Schema } from 'effect';

const slug = Schema.String.check(Schema.isPattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u), Schema.isMaxLength(200));
const id = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/u));
const originSchema = Schema.String.check(
  Schema.makeFilter((value) => {
    const url = URL.parse(value);
    return url !== null &&
      url.protocol === 'https:' &&
      url.origin === value &&
      url.username === '' &&
      url.password === ''
      ? undefined
      : 'Expected a bare HTTPS origin';
  }),
);
export const SymmyStorefrontProofInputSchema = Schema.Struct({
  origin: originSchema,
  locale: Schema.String.check(Schema.isPattern(/^[a-z]{2,3}$/u)),
  sku: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u)),
  categorySlug: slug,
  productId: id,
  galleryUrl: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1000)),
  productSlug: Schema.optionalKey(slug),
  timeoutMs: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 120_000 }))),
});
export type SymmyStorefrontProofInput = typeof SymmyStorefrontProofInputSchema.Type;
const searchSchema = Schema.Struct({
  total: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  items: Schema.Array(
    Schema.Struct({
      productId: id,
      slug,
      name: Schema.NonEmptyString,
      imageSrc: Schema.NonEmptyString,
      sku: Schema.optionalKey(Schema.String),
    }),
  ),
});

export class SymmyStorefrontProofFailure extends Schema.TaggedError<SymmyStorefrontProofFailure>()(
  'SymmyStorefrontProofFailure',
  { stage: Schema.String, reason: Schema.String },
) {}
const fail = (stage: string, reason: string) => new SymmyStorefrontProofFailure({ stage, reason });
const ensure: (condition: unknown, stage: string, reason: string) => asserts condition = (condition, stage, reason) => {
  if (!condition) throw fail(stage, reason);
};

const decode = <S extends Schema.Top>(schema: S, value: unknown, stage: string): S['Type'] => {
  try {
    return Schema.decodeUnknownSync(schema)(value);
  } catch {
    throw fail(stage, 'invalid-contract');
  }
};
// Resolve the parser shipped with the storefront workspace. Fragments do not execute scripts or load resources.
const storefrontRequire = createRequire(new URL('../../akros-storefront/package.json', import.meta.url));
const visiblePage = (html: string): DocumentFragment => {
  const { JSDOM }: { JSDOM: { fragment(source: string): DocumentFragment } } = storefrontRequire('jsdom');
  const page = JSDOM.fragment(html);
  for (const node of page.querySelectorAll('script, style, template, noscript, [hidden], aside, nav, [aria-labelledby="recommendations-title"]')) node.remove();
  return page;
};
const textOf = (element: Element | null) => (element?.textContent ?? '').replace(/\s+/gu, ' ').trim();

const canonicalPath = (value: string, input: SymmyStorefrontProofInput): string => {
  const url = URL.parse(value, input.origin);
  ensure(
    url !== null && url.origin === input.origin && url.username === '' && url.password === '',
    'configuration',
    'foreign-url',
  );
  return url.pathname.replace(new RegExp(`^/${input.locale}(?=/)`, 'u'), '');
};
const galleryPath = (input: SymmyStorefrontProofInput) => {
  const path = canonicalPath(input.galleryUrl, input);
  const prefix = `/obrazky/${input.productId}/`;
  ensure(
    path.startsWith(prefix) &&
      /^[\da-f]{8}-[\da-f]{4}-[1-8][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/u.test(path.slice(prefix.length)),
    'configuration',
    'not-native-product-media',
  );
  const url = new URL(input.galleryUrl, input.origin);
  ensure(url.search === '' && url.hash === '', 'configuration', 'image-url-query');
  return path;
};
const includesImage = (container: Element, expected: string, input: SymmyStorefrontProofInput) =>
  Array.from(container.querySelectorAll('img')).some((img) => {
    const sources = [
      img.getAttribute('src') ?? '',
      ...(img.getAttribute('srcset') ?? '')
        .split(',')
        .map((entry) => entry.trim().split(/\s+/u)[0] ?? ''),
    ];
    return sources.filter(Boolean).some((source) => {
      const url = URL.parse(source, input.origin);
      if (url === null || url.origin !== input.origin) return false;
      const actual = url.pathname === '/_next/image' ? url.searchParams.get('url') : source;
      if (actual === null) return false;
      try {
        return canonicalPath(actual, input) === expected;
      } catch {
        return false;
      }
    });
  });

/** Requires the product inside the category's actual listing, not a recommendation, sidebar, script or soft-404. */
export const assertSymmyStorefrontPages = (
  input: SymmyStorefrontProofInput,
  product: { readonly slug: string; readonly name: string },
  productHtml: string,
  categoryHtml: string,
) => {
  const detail = visiblePage(productHtml);
  const productTitle = detail.querySelector('h1#product-title');
  const overview = productTitle?.closest('section[aria-labelledby="product-title"]');
  ensure(overview && textOf(productTitle) === product.name, 'product', 'identity');
  ensure(Array.from(overview.querySelectorAll('dd')).some((dd) => textOf(dd) === input.sku), 'product', 'sku');
  const expected = galleryPath(input);
  const gallery = overview.querySelector('.sf-product-detail__gallery');
  ensure(gallery && includesImage(gallery, expected, input), 'product', 'gallery');

  const category = visiblePage(categoryHtml);
  const title = textOf(category.querySelector('h1#category-title'));
  ensure(title.length > 0, 'category', 'missing-category');
  const listing = Array.from(category.querySelectorAll('section[aria-label]')).find(
    (section) => section.getAttribute('aria-label') === `Produkty: ${title}`,
  );
  ensure(listing, 'category', 'missing-product-listing');
  const links = Array.from(listing.querySelectorAll('article a.sf-catalog-product-card__image-link[href]')).filter((link) => {
    try {
      return canonicalPath(link.getAttribute('href') ?? '', input) === `/produkt/${product.slug}`;
    } catch {
      return false;
    }
  });
  const [link] = links;
  ensure(links.length === 1 && link, 'category', 'product-not-in-category');
  ensure(includesImage(link, expected, input), 'category', 'gallery');
};

export const assertSymmyStorefrontImage = (mime: string, bytes: Uint8Array) => {
  const starts = (values: readonly number[], offset = 0) =>
    bytes.length >= offset + values.length && values.every((value, index) => bytes[offset + index] === value);
  const correct =
    (mime === 'image/png' && bytes.length >= 33 && starts([137, 80, 78, 71, 13, 10, 26, 10])) ||
    (mime === 'image/jpeg' && bytes.length >= 4 && starts([255, 216, 255])) ||
    (mime === 'image/webp' && bytes.length >= 20 && starts([82, 73, 70, 70]) && starts([87, 69, 66, 80], 8));
  ensure(correct, 'image', 'mime-or-signature');
};

const request = (
  input: SymmyStorefrontProofInput,
  fetcher: typeof fetch,
  path: string,
  stage: string,
  limit: number,
  init: RequestInit = {},
) =>
  Effect.tryPromise({
    try: async () => {
      let url = new URL(path, input.origin);
      const method = init.method ?? 'GET';
      for (let redirects = 0; redirects <= 3; redirects += 1) {
        ensure(url.origin === input.origin && url.username === '' && url.password === '', stage, 'foreign-redirect');
        const response = await fetcher(url, {
          ...init,
          method,
          redirect: 'manual',
          signal: AbortSignal.timeout(input.timeoutMs ?? 30_000),
          headers: { 'x-akros-market-locale': input.locale, ...init.headers },
        });
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const location = response.headers.get('location');
          await response.body?.cancel();
          ensure(location !== null && method === 'GET', stage, 'unexpected-redirect');
          url = new URL(location, url);
          continue;
        }
        ensure(response.status === 200, stage, `http-${response.status}`);
        ensure(Number(response.headers.get('content-length') ?? 0) <= limit, stage, 'body-too-large');
        const chunks: Uint8Array[] = [];
        let length = 0;
        if (response.body !== null) {
          const reader = response.body.getReader();
          try {
            for (;;) {
              const next = await reader.read();
              if (next.done) break;
              length += next.value.length;
              ensure(length <= limit, stage, 'body-too-large');
              chunks.push(next.value);
            }
          } finally {
            await reader.cancel();
            reader.releaseLock();
          }
        }
        const bytes = new Uint8Array(length);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.length;
        }
        return {
          bytes,
          mime: (response.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '',
          url: url.toString(),
        };
      }
      throw fail(stage, 'too-many-redirects');
    },
    catch: (error) => (error instanceof SymmyStorefrontProofFailure ? error : fail(stage, 'request-failed')),
  });

export const proveSymmyStorefront = Effect.fn('SymmyStorefrontProof')(function* proof(
  raw: SymmyStorefrontProofInput,
  options: { readonly fetch?: typeof fetch } = {},
) {
  const input = yield* Effect.try({
    try: () => decode(SymmyStorefrontProofInputSchema, raw, 'configuration'),
    catch: () => fail('configuration', 'invalid-contract'),
  });
  const imagePath = yield* Effect.try({
    try: () => galleryPath(input),
    catch: () => fail('configuration', 'not-native-product-media'),
  });
  const fetcher = options.fetch ?? globalThis.fetch;
  const search = yield* request(input, fetcher, '/api/ontos/search', 'search', 1_048_576, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ q: input.sku }),
  });
  const product = yield* Effect.try({
    try: () => {
      ensure(search.mime === 'application/json', 'search', 'content-type');
      const body = decode(searchSchema, JSON.parse(new TextDecoder().decode(search.bytes)), 'search');
      const matches = body.items.filter((item) => item.productId === input.productId);
      ensure(matches.length === 1, 'search', 'missing-or-ambiguous-product');
      const [item] = matches;
      ensure(item !== undefined && (item.sku === undefined || item.sku === input.sku), 'search', 'sku');
      ensure(input.productSlug === undefined || item.slug === input.productSlug, 'search', 'slug');
      ensure(canonicalPath(item.imageSrc, input) === imagePath, 'search', 'gallery');
      return item;
    },
    catch: (error) => (error instanceof SymmyStorefrontProofFailure ? error : fail('search', 'invalid-contract')),
  });
  const detail = yield* request(input, fetcher, `/${input.locale}/produkt/${product.slug}`, 'product', 8_388_608);
  const category = yield* request(
    input,
    fetcher,
    `/${input.locale}/kategorie/${input.categorySlug}`,
    'category',
    8_388_608,
  );
  yield* Effect.try({
    try: () => {
      ensure(detail.mime === 'text/html' && category.mime === 'text/html', 'pages', 'content-type');
      ensure(canonicalPath(detail.url, input) === `/produkt/${product.slug}`, 'product', 'redirected-identity');
      ensure(
        canonicalPath(category.url, input) === `/kategorie/${input.categorySlug}`,
        'category',
        'redirected-identity',
      );
      assertSymmyStorefrontPages(
        input,
        product,
        new TextDecoder().decode(detail.bytes),
        new TextDecoder().decode(category.bytes),
      );
    },
    catch: (error) => (error instanceof SymmyStorefrontProofFailure ? error : fail('pages', 'invalid-content')),
  });
  const image = yield* request(input, fetcher, new URL(input.galleryUrl, input.origin).toString(), 'image', 5_242_880);
  yield* Effect.try({
    try: () => {
      ensure(canonicalPath(image.url, input) === imagePath, 'image', 'redirected-identity');
      assertSymmyStorefrontImage(image.mime, image.bytes);
    },
    catch: (error) => (error instanceof SymmyStorefrontProofFailure ? error : fail('image', 'mime-or-signature')),
  });
  return {
    outcome: 'PASS' as const,
    sku: input.sku,
    productId: input.productId,
    productSlug: product.slug,
    categorySlug: input.categorySlug,
    productUrl: detail.url,
    categoryUrl: category.url,
    imageUrl: image.url,
    imageBytes: image.bytes.length,
    imageMime: image.mime,
  };
});

/** Flags override these non-secret environment values. No key, cookie, credential file or live-write option exists. */
export const readSymmyStorefrontProofInput = (
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
) => {
  const { values, positionals } = parseArgs({
    args: [...args],
    strict: true,
    allowPositionals: false,
    options: Object.fromEntries(
      ['origin', 'locale', 'sku', 'category-slug', 'product-id', 'gallery-url', 'product-slug', 'timeout-ms'].map(
        (key) => [key, { type: 'string' as const }],
      ),
    ),
  });
  ensure(positionals.length === 0, 'configuration', 'unexpected-argument');
  const pick = (flag: string, variable: string) => values[flag] ?? env[variable];
  const productSlug = pick('product-slug', 'SYMMY_STOREFRONT_PRODUCT_SLUG');
  return decode(
    SymmyStorefrontProofInputSchema,
    {
      origin: pick('origin', 'SYMMY_STOREFRONT_ORIGIN') ?? 'https://ontos-stage-akros.web-revolution.cz',
      locale: pick('locale', 'SYMMY_STOREFRONT_LOCALE') ?? 'cs',
      sku: pick('sku', 'SYMMY_STOREFRONT_SKU'),
      categorySlug: pick('category-slug', 'SYMMY_STOREFRONT_CATEGORY_SLUG'),
      productId: pick('product-id', 'SYMMY_STOREFRONT_PRODUCT_ID'),
      galleryUrl: pick('gallery-url', 'SYMMY_STOREFRONT_GALLERY_URL'),
      ...(productSlug === undefined ? {} : { productSlug }),
      timeoutMs: Number(pick('timeout-ms', 'SYMMY_STOREFRONT_TIMEOUT_MS') ?? 30_000),
    },
    'configuration',
  );
};

if (import.meta.main) {
  try {
    if (process.argv.length === 3 && process.argv[2] === '--help') {
      process.stdout.write(
        'Usage: node stage-symmy-storefront-proof.mts --sku <actual SKU> --category-slug <actual slug> --product-id <native ID> --gallery-url </obrazky/ID/asset> [--origin <HTTPS origin>] [--locale cs] [--product-slug <expected slug>] [--timeout-ms 30000]\nEnvironment alternatives: SYMMY_STOREFRONT_{ORIGIN,LOCALE,SKU,CATEGORY_SLUG,PRODUCT_ID,GALLERY_URL,PRODUCT_SLUG,TIMEOUT_MS}. No credentials; public reads only.\n',
      );
    } else {
      const result = await Effect.runPromise(
        proveSymmyStorefront(readSymmyStorefrontProofInput(process.argv.slice(2), process.env)).pipe(Effect.result),
      );
      if (Result.isFailure(result)) throw result.failure;
      process.stdout.write(`${JSON.stringify(result.success)}\n`);
    }
  } catch (error) {
    const message =
      error instanceof SymmyStorefrontProofFailure ? `${error.stage}:${error.reason}` : 'configuration:invalid-input';
    process.stderr.write(`FAIL storefront-proof:${message}\n`);
    process.exitCode = 1;
  }
}
