#!/usr/bin/env node
/** Public, read-only acceptance. Importing this module performs no I/O; it never creates records or accepts secrets. */
import { createRequire } from 'node:module';
import { NodeServices } from '@effect/platform-node';
import { Config, ConfigProvider, Console, Effect, Option, Predicate, Ref, Result, Schema, Stdio } from 'effect';
import { CliConfig, Command, Flag, GlobalFlag } from 'effect/cli';

const slug = Schema.String.check(Schema.isPattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u), Schema.isMaxLength(200));
const id = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/u)).pipe(
  Schema.brand('productId'),
);
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
  categorySlug: slug,
  galleryUrl: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1000)),
  locale: Schema.String.check(Schema.isPattern(/^[a-z]{2,3}$/u)),
  origin: originSchema,
  productId: id,
  productSlug: Schema.optionalKey(slug),
  sku: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u)),
  timeoutMs: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ maximum: 120_000, minimum: 1 }))),
});
export type SymmyStorefrontProofInput = typeof SymmyStorefrontProofInputSchema.Type;
const searchSchema = Schema.Struct({
  items: Schema.Array(
    Schema.Struct({
      imageSrc: Schema.NonEmptyString,
      name: Schema.NonEmptyString,
      productId: id,
      sku: Schema.optionalKey(Schema.String),
      slug,
    }),
  ),
  total: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
});

export class SymmyStorefrontProofFailure extends Schema.TaggedError<SymmyStorefrontProofFailure>()(
  'SymmyStorefrontProofFailure',
  { reason: Schema.String, stage: Schema.String },
) {}
const fail = (stage: string, reason: string) => new SymmyStorefrontProofFailure({ reason, stage });
const invalidContract = 'invalid-contract';
const contentType = 'content-type';
const mimeOrSignature = 'mime-or-signature';
const redirectedIdentity = 'redirected-identity';
const decoded = <A,>(result: Result.Result<A, Schema.SchemaError>, stage: string, reason = invalidContract): A =>
  Result.getOrThrowWith(result, () => fail(stage, reason));
const ensure = (condition: boolean, stage: string, reason: string): void => {
  decoded(Schema.decodeUnknownResult(Schema.Literal(true))(condition), stage, reason);
};
const required = <A,>(value: A | null | undefined, stage: string, reason: string): A =>
  Option.getOrThrowWith(Option.fromNullishOr(value), () => fail(stage, reason));
const FragmentSchema = Schema.declare<(source: string) => DocumentFragment>(
  (value): value is (source: string) => DocumentFragment => Predicate.isFunction(value),
);
const JsdomConstructorSchema = Schema.instanceOf(Function).check(
  Schema.makeFilter((value) => Predicate.hasProperty(value, 'fragment') && Schema.is(FragmentSchema)(value.fragment)),
);
const JsdomSchema = Schema.Struct({
  JSDOM: Schema.declare<{ readonly fragment: (source: string) => DocumentFragment }>(
    (value): value is { readonly fragment: (source: string) => DocumentFragment } =>
      Schema.is(JsdomConstructorSchema)(value),
  ),
});
// Resolve the parser shipped with the storefront workspace. Fragments do not execute scripts or load resources.
const storefrontRequire = createRequire(new URL('../../akros-storefront/package.json', import.meta.url));
const visiblePage = (html: string): DocumentFragment => {
  const { JSDOM } = decoded(Schema.decodeUnknownResult(JsdomSchema)(storefrontRequire('jsdom')), 'pages');
  const page = JSDOM.fragment(html);
  for (const node of page.querySelectorAll(
    'script, style, template, noscript, [hidden], aside, nav, [aria-labelledby="recommendations-title"]',
  )) {
    node.remove();
  }
  return page;
};
const textOf = (element: Element | null) => (element?.textContent ?? '').replaceAll(/\s+/gu, ' ').trim();

const canonicalPath = (value: string, input: SymmyStorefrontProofInput): string => {
  const url = required(URL.parse(value, input.origin), 'configuration', 'foreign-url');
  ensure(url.origin === input.origin && url.username === '' && url.password === '', 'configuration', 'foreign-url');
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
  [...container.querySelectorAll('img')].some((img) => {
    const sources = [
      img.getAttribute('src') ?? '',
      ...(img.getAttribute('srcset') ?? '').split(',').map((entry) => entry.trim().split(/\s+/u)[0] ?? ''),
    ];
    return sources.filter(Boolean).some((source) => {
      const url = URL.parse(source, input.origin);
      if (url === null || url.origin !== input.origin) {
        return false;
      }
      const actual = url.pathname === '/_next/image' ? url.searchParams.get('url') : source;
      if (actual === null) {
        return false;
      }
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
  product: { readonly name: string; readonly slug: string },
  productHtml: string,
  categoryHtml: string,
) => {
  const detail = visiblePage(productHtml);
  const productTitle = detail.querySelector('h1#product-title');
  const overview = required(productTitle?.closest('section[aria-labelledby="product-title"]'), 'product', 'identity');
  ensure(textOf(productTitle) === product.name, 'product', 'identity');
  ensure(
    [...overview.querySelectorAll('dd')].some((dd) => textOf(dd) === input.sku),
    'product',
    'sku',
  );
  const expected = galleryPath(input);
  const gallery = required(overview.querySelector('.sf-product-detail__gallery'), 'product', 'gallery');
  ensure(includesImage(gallery, expected, input), 'product', 'gallery');

  const category = visiblePage(categoryHtml);
  const title = textOf(category.querySelector('h1#category-title'));
  ensure(title.length > 0, 'category', 'missing-category');
  const listing = required(
    [...category.querySelectorAll('section[aria-label]')].find(
      (section) => section.getAttribute('aria-label') === `Produkty: ${title}`,
    ),
    'category',
    'missing-product-listing',
  );
  const links = [...listing.querySelectorAll('article a.sf-catalog-product-card__image-link[href]')].filter((link) => {
    try {
      return canonicalPath(link.getAttribute('href') ?? '', input) === `/produkt/${product.slug}`;
    } catch {
      return false;
    }
  });
  ensure(links.length === 1, 'category', 'product-not-in-category');
  const link = required(links[0], 'category', 'product-not-in-category');
  ensure(includesImage(link, expected, input), 'category', 'gallery');
};

export const assertSymmyStorefrontImage = (mime: string, bytes: Uint8Array) => {
  const starts = (values: readonly number[], offset = 0) =>
    bytes.length >= offset + values.length && values.every((value, index) => bytes[offset + index] === value);
  const correct =
    (mime === 'image/png' && bytes.length >= 33 && starts([137, 80, 78, 71, 13, 10, 26, 10])) ||
    (mime === 'image/jpeg' && bytes.length >= 4 && starts([255, 216, 255])) ||
    (mime === 'image/webp' && bytes.length >= 20 && starts([82, 73, 70, 70]) && starts([87, 69, 66, 80], 8));
  ensure(correct, 'image', mimeOrSignature);
};

const request = (
  input: SymmyStorefrontProofInput,
  fetcher: typeof fetch,
  path: string,
  stage: string,
  limit: number,
  init: Omit<RequestInit, 'headers'> & { readonly headers?: Readonly<Record<string, string>> } = {},
) =>
  Effect.tryPromise({
    catch: (error) =>
      Schema.is(Schema.instanceOf(SymmyStorefrontProofFailure))(error) ? error : fail(stage, 'request-failed'),
    try: async () => {
      const method = init.method ?? 'GET';
      interface Reply {
        bytes: Uint8Array;
        mime: string;
        url: string;
      }
      const follow = async (url: URL, redirects: number): Promise<Reply> => {
        ensure(url.origin === input.origin && url.username === '' && url.password === '', stage, 'foreign-redirect');
        const response = await fetcher(url, {
          ...init,
          headers: { 'x-akros-market-locale': input.locale, ...init.headers },
          method,
          redirect: 'manual',
          signal: AbortSignal.timeout(input.timeoutMs ?? 30_000),
        });
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const location = response.headers.get('location');
          await response.body?.cancel();
          ensure(method === 'GET' && location !== null, stage, 'unexpected-redirect');
          const nextUrl = new URL(required(location, stage, 'unexpected-redirect'), url);
          ensure(redirects < 3, stage, 'too-many-redirects');
          return await follow(nextUrl, redirects + 1);
        }
        ensure(response.status === 200, stage, `http-${response.status}`);
        ensure(Number(response.headers.get('content-length') ?? 0) <= limit, stage, 'body-too-large');
        const chunks: Uint8Array[] = [];
        let length = 0;
        if (response.body !== null) {
          const reader = response.body.getReader();
          const read = async (): Promise<void> => {
            const next = await reader.read();
            if (next.done) {
              return;
            }
            length += next.value.length;
            ensure(length <= limit, stage, 'body-too-large');
            chunks.push(next.value);
            await read();
          };
          try {
            await read();
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
          mime: (response.headers.get(contentType) ?? '').split(';')[0]?.trim().toLowerCase() ?? '',
          url: url.toString(),
        };
      };
      return await follow(new URL(path, input.origin), 0);
    },
  });

export const proveSymmyStorefront = Effect.fn('SymmyStorefrontProof')(function* proof(
  raw: typeof SymmyStorefrontProofInputSchema.Encoded,
  options: { readonly fetch?: typeof fetch } = {},
) {
  const input = yield* Schema.decodeUnknownEffect(SymmyStorefrontProofInputSchema)(raw).pipe(
    Effect.mapError(() => fail('configuration', invalidContract)),
  );
  const imagePath = yield* Effect.try({
    catch: () => fail('configuration', 'not-native-product-media'),
    try: () => galleryPath(input),
  });
  const fetcher = options.fetch ?? globalThis.fetch;
  const search = yield* request(input, fetcher, '/api/ontos/search', 'search', 1_048_576, {
    body: Result.getOrThrow(
      Schema.encodeResult(Schema.fromJsonString(Schema.Struct({ q: Schema.String })))({ q: input.sku }),
    ),
    headers: { [contentType]: 'application/json' },
    method: 'POST',
  });
  const product = yield* Effect.try({
    catch: (error) =>
      Schema.is(Schema.instanceOf(SymmyStorefrontProofFailure))(error) ? error : fail('search', invalidContract),
    try: () => {
      ensure(search.mime === 'application/json', 'search', contentType);
      const body = decoded(
        Schema.decodeUnknownResult(Schema.fromJsonString(searchSchema))(new TextDecoder().decode(search.bytes)),
        'search',
      );
      const matches = body.items.filter((item) => item.productId === input.productId);
      ensure(matches.length === 1, 'search', 'missing-or-ambiguous-product');
      const item = required(matches[0], 'search', 'sku');
      ensure(item.sku === undefined || item.sku === input.sku, 'search', 'sku');
      ensure(input.productSlug === undefined || item.slug === input.productSlug, 'search', 'slug');
      ensure(canonicalPath(item.imageSrc, input) === imagePath, 'search', 'gallery');
      return item;
    },
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
    catch: (error) =>
      Schema.is(Schema.instanceOf(SymmyStorefrontProofFailure))(error) ? error : fail('pages', 'invalid-content'),
    try: () => {
      ensure(detail.mime === 'text/html' && category.mime === 'text/html', 'pages', contentType);
      ensure(canonicalPath(detail.url, input) === `/produkt/${product.slug}`, 'product', redirectedIdentity);
      ensure(canonicalPath(category.url, input) === `/kategorie/${input.categorySlug}`, 'category', redirectedIdentity);
      assertSymmyStorefrontPages(
        input,
        product,
        new TextDecoder().decode(detail.bytes),
        new TextDecoder().decode(category.bytes),
      );
    },
  });
  const image = yield* request(input, fetcher, new URL(input.galleryUrl, input.origin).toString(), 'image', 5_242_880);
  yield* Effect.try({
    catch: (error) =>
      Schema.is(Schema.instanceOf(SymmyStorefrontProofFailure))(error) ? error : fail('image', mimeOrSignature),
    try: () => {
      ensure(canonicalPath(image.url, input) === imagePath, 'image', redirectedIdentity);
      assertSymmyStorefrontImage(image.mime, image.bytes);
    },
  });
  return {
    categorySlug: input.categorySlug,
    categoryUrl: category.url,
    imageBytes: image.bytes.length,
    imageMime: image.mime,
    imageUrl: image.url,
    outcome: 'PASS' as const,
    productId: input.productId,
    productSlug: product.slug,
    productUrl: detail.url,
    sku: input.sku,
  };
});

const EnvironmentSchema = Schema.Struct({
  SYMMY_STOREFRONT_CATEGORY_SLUG: Schema.optionalKey(Schema.String),
  SYMMY_STOREFRONT_GALLERY_URL: Schema.optionalKey(Schema.String),
  SYMMY_STOREFRONT_LOCALE: Schema.optionalKey(Schema.String),
  SYMMY_STOREFRONT_ORIGIN: Schema.optionalKey(Schema.String),
  SYMMY_STOREFRONT_PRODUCT_ID: Schema.optionalKey(Schema.String),
  SYMMY_STOREFRONT_PRODUCT_SLUG: Schema.optionalKey(Schema.String),
  SYMMY_STOREFRONT_SKU: Schema.optionalKey(Schema.String),
  SYMMY_STOREFRONT_TIMEOUT_MS: Schema.optionalKey(Schema.String),
});
const proofFlags = {
  categorySlug: Flag.String('category-slug').pipe(Flag.optional),
  galleryUrl: Flag.String('gallery-url').pipe(Flag.optional),
  locale: Flag.String('locale').pipe(Flag.optional),
  origin: Flag.String('origin').pipe(Flag.optional),
  productId: Flag.String('product-id').pipe(Flag.optional),
  productSlug: Flag.String('product-slug').pipe(Flag.optional),
  sku: Flag.String('sku').pipe(Flag.optional),
  timeoutMs: Flag.String('timeout-ms').pipe(Flag.optional),
};
const command = Command.make('stage-symmy-storefront-proof', proofFlags);
// Keep only the original public help switch; do not add wizard, logging, version or completion options.
export const SymmyStorefrontProofCliLayer = CliConfig.layer({
  builtIns: [
    GlobalFlag.Action({
      flag: Flag.Boolean('help'),
      run: () =>
        Console.log(
          'Usage: node stage-symmy-storefront-proof.mts --sku <actual SKU> --category-slug <actual slug> --product-id <native ID> --gallery-url </obrazky/ID/asset> [--origin <HTTPS origin>] [--locale cs] [--product-slug <expected slug>] [--timeout-ms 30000]\nEnvironment alternatives: SYMMY_STOREFRONT_{ORIGIN,LOCALE,SKU,CATEGORY_SLUG,PRODUCT_ID,GALLERY_URL,PRODUCT_SLUG,TIMEOUT_MS}. No credentials; public reads only.',
        ),
    }),
  ],
});
const resolveInput = Effect.fn('SymmyStorefrontProofInput')(function* resolveInput(
  flags: Command.Command.Config.Infer<typeof proofFlags>,
) {
  const env = yield* Config.schema(EnvironmentSchema);
  const productSlug = Option.getOrUndefined(flags.productSlug) ?? env.SYMMY_STOREFRONT_PRODUCT_SLUG;
  const timeoutMs = yield* Schema.decodeUnknownEffect(Schema.NumberFromString)(
    Option.getOrUndefined(flags.timeoutMs) ?? env.SYMMY_STOREFRONT_TIMEOUT_MS ?? '30000',
  ).pipe(Effect.mapError(() => fail('configuration', invalidContract)));
  const raw = {
    categorySlug: Option.getOrUndefined(flags.categorySlug) ?? env.SYMMY_STOREFRONT_CATEGORY_SLUG,
    galleryUrl: Option.getOrUndefined(flags.galleryUrl) ?? env.SYMMY_STOREFRONT_GALLERY_URL,
    locale: Option.getOrUndefined(flags.locale) ?? env.SYMMY_STOREFRONT_LOCALE ?? 'cs',
    origin:
      Option.getOrUndefined(flags.origin) ??
      env.SYMMY_STOREFRONT_ORIGIN ??
      'https://ontos-stage-akros.web-revolution.cz',
    productId: Option.getOrUndefined(flags.productId) ?? env.SYMMY_STOREFRONT_PRODUCT_ID,
    sku: Option.getOrUndefined(flags.sku) ?? env.SYMMY_STOREFRONT_SKU,
    timeoutMs,
  };
  return yield* Schema.decodeUnknownEffect(SymmyStorefrontProofInputSchema)(
    productSlug === undefined ? raw : { ...raw, productSlug },
  ).pipe(Effect.mapError(() => fail('configuration', invalidContract)));
});

/** Flags override the closed, public-only environment contract. Parsing never performs proof traffic. */
export const readSymmyStorefrontProofInput = (args: readonly string[]) =>
  Effect.gen(function* readInput() {
    const captured = yield* Ref.make(Option.none<SymmyStorefrontProofInput>());
    yield* Command.runWith(
      command.pipe(
        Command.withHandler((flags) =>
          resolveInput(flags).pipe(Effect.flatMap((input) => Ref.set(captured, Option.some(input)))),
        ),
      ),
      { renderErrors: false, version: '1.0.0' },
    )(args);
    return yield* Option.match(yield* Ref.get(captured), {
      onNone: () => Effect.fail(fail('configuration', invalidContract)),
      onSome: Effect.succeed,
    });
  });

const ReportSchema = Schema.Struct({
  categorySlug: slug,
  categoryUrl: Schema.String,
  imageBytes: Schema.Int,
  imageMime: Schema.String,
  imageUrl: Schema.String,
  outcome: Schema.Literal('PASS'),
  productId: id,
  productSlug: slug,
  productUrl: Schema.String,
  sku: SymmyStorefrontProofInputSchema.fields.sku,
});
const proofCommand = command.pipe(
  Command.withHandler((flags) =>
    resolveInput(flags).pipe(
      Effect.flatMap((input) => proveSymmyStorefront(input)),
      Effect.flatMap(Schema.encodeEffect(Schema.fromJsonString(ReportSchema))),
      Effect.flatMap((report) => Console.log(report)),
    ),
  ),
);
if (import.meta.main) {
  const successful = await Effect.runPromise(
    Effect.gen(function* runCommand() {
      const stdio = yield* Stdio.Stdio;
      const args = yield* stdio.args;
      const informationRequest =
        args.length === 1 && /^(?:--(?:no-)?(?:help|version)|-[hvV])(?:=.*)?$/u.test(args[0] ?? '');
      const proofOptions = new Set([
        '--category-slug',
        '--gallery-url',
        '--locale',
        '--origin',
        '--product-id',
        '--product-slug',
        '--sku',
        '--timeout-ms',
      ]);
      // Scan every token, including value slots. Only proof-owned flags may accompany a proof;
      // this also rejects built-ins added by future Effect CLI versions before action dispatch.
      if (
        !informationRequest &&
        args.some((arg) => arg.startsWith('-') && !proofOptions.has(arg.split('=', 1)[0] ?? ''))
      ) {
        return yield* fail('configuration', 'invalid-input');
      }
      return yield* Command.runWith(proofCommand, { renderErrors: false, version: '1.0.0' })(args);
    }).pipe(
      Effect.matchEffect({
        onFailure: (error) => {
          const message = Schema.is(Schema.instanceOf(SymmyStorefrontProofFailure))(error)
            ? `${error.stage}:${error.reason}`
            : 'configuration:invalid-input';
          return Console.error(`FAIL storefront-proof:${message}`).pipe(Effect.as(false));
        },
        onSuccess: () => Effect.succeed(true),
      }),
      Effect.provide(NodeServices.layer),
      Effect.provide(SymmyStorefrontProofCliLayer),
      Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnv({ preserveEmptyStrings: true })),
    ),
  );
  if (!successful) {
    process.exitCode = 1;
  }
}
